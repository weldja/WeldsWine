/**
 * Welds Wine Wisdoms — Cloudflare Worker Proxy
 * =============================================
 * SETUP (2 minutes, free, no card needed):
 *
 * 1. Get a free Anthropic API key:
 *    → https://console.anthropic.com/keys
 *
 * 2. Paste your key on the line below (between the quotes):
 */
const ANTHROPIC_API_KEY = 'PASTE_YOUR_KEY_HERE';
/**
 * 3. Go to https://dash.cloudflare.com → sign in free
 *
 * 4. Click "Workers & Pages" in the left sidebar
 *
 * 5. Click "Create" → then click "Create Worker"
 *    ⚠ If you see "Start with a template", pick the "Hello World" template
 *
 * 6. You'll see a code editor. Select ALL the code and DELETE it.
 *    Then paste this ENTIRE file.
 *
 * 7. Click "Deploy" (top right)
 *
 * 8. Copy the URL shown (e.g. https://wine-proxy.your-name.workers.dev)
 *
 * 9. In the app the Worker URL is already set — no further config needed.
 */

export default {
  async fetch(request) {

    const cors = {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Content-Type': 'application/json'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);

    // ── Geocoding endpoint (/geocode?lat=XX&lon=YY) ────────────
    // Proxies Nominatim with a proper User-Agent so it doesn't get blocked
    if (url.pathname.endsWith('/geocode')) {
      const lat = url.searchParams.get('lat');
      const lon = url.searchParams.get('lon');
      if (!lat || !lon) {
        return new Response(JSON.stringify({ error: 'lat and lon required' }), { status: 400, headers: cors });
      }
      try {
        const r = await fetch(
          `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&accept-language=en`,
          { headers: {
              'User-Agent':       'WeldsWineWisdoms/1.0 (personal wine journal app)',
              'Accept-Language':  'en',
              'Referer':          'https://weldswinewisdoms.app'
          }}
        );
        const data = await r.json();
        const a = data.address || {};
        const place = a.neighbourhood || a.suburb || a.village || a.town ||
                      a.city_district || a.city || a.county || a.state_district || a.state || '';
        const country = a.country || '';
        let label = '';
        if (place || country) {
          label = [place, country].filter(Boolean).join(', ');
        } else if (data.display_name) {
          // Trim to last 3 comma-parts for a readable fallback
          label = data.display_name.split(',').slice(-3).map(s => s.trim()).join(', ');
        }
        return new Response(JSON.stringify({ label, raw: data }), { status: 200, headers: cors });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: cors });
      }
    }

    // ── Label scan endpoint (POST /) ───────────────────────────
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'POST only' }), { status: 405, headers: cors });
    }

    if (!ANTHROPIC_API_KEY || ANTHROPIC_API_KEY === 'PASTE_YOUR_KEY_HERE') {
      return new Response(
        JSON.stringify({ error: 'NO_KEY_IN_WORKER' }),
        { status: 500, headers: cors }
      );
    }

    let body;
    try { body = await request.json(); }
    catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: cors }); }

    const { imageBase64, backImageBase64 = null, mimeType = 'image/jpeg' } = body;
    if (!imageBase64) {
      return new Response(JSON.stringify({ error: 'imageBase64 required' }), { status: 400, headers: cors });
    }

    const imageBlocks = [
      { type: 'image', source: { type: 'base64', media_type: mimeType, data: imageBase64 } }
    ];
    if (backImageBase64) {
      imageBlocks.push(
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: backImageBase64 } }
      );
    }

    const PROMPT = `Return ONLY a valid JSON object — no markdown, no explanation, nothing else.
Rules:
- Only include information clearly visible on the label — never guess
- "name" is the wine cuvée name (NOT the winery/producer)
- "winery" is the producer, domaine, château or bodega
- "vintage" must be a 4-digit integer or null
- "style" must be exactly: "Red","White","Rosé","Sparkling","Dessert","Fortified" or null
- "confidence" is your overall extraction confidence: "high","medium","low"
Return exactly:
{"name":null,"winery":null,"vintage":null,"country":null,"region":null,"appellation":null,"grape":null,"style":null,"classification":null,"alcohol":null,"vineyard":null,"confidence":null}`;

    const userText = backImageBase64
      ? 'First image = FRONT label, second = BACK label. Use both.\n\n' + PROMPT
      : 'Examine this wine label carefully.\n\n' + PROMPT;

    let anthropicResp;
    try {
      anthropicResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model:      'claude-haiku-4-5-20251001',
          max_tokens: 800,
          messages: [{
            role: 'user',
            content: [...imageBlocks, { type: 'text', text: userText }]
          }]
        })
      });
    } catch (e) {
      return new Response(
        JSON.stringify({ error: 'Failed to reach Anthropic: ' + e.message }),
        { status: 502, headers: cors }
      );
    }

    if (!anthropicResp.ok) {
      const errBody = await anthropicResp.json().catch(() => ({}));
      const status  = anthropicResp.status;
      if (status === 401) return new Response(JSON.stringify({ error: 'INVALID_KEY' }),  { status: 401, headers: cors });
      if (status === 429) return new Response(JSON.stringify({ error: 'RATE_LIMIT' }),   { status: 429, headers: cors });
      return new Response(
        JSON.stringify({ error: errBody?.error?.message || `Anthropic error ${status}` }),
        { status, headers: cors }
      );
    }

    const data    = await anthropicResp.json();
    const rawText = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const cleaned = rawText.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
    const match   = cleaned.match(/\{[\s\S]*\}/);

    let parsed;
    try { parsed = JSON.parse(match ? match[0] : cleaned); }
    catch {
      return new Response(
        JSON.stringify({ error: 'PARSE_ERROR', raw: rawText }),
        { status: 422, headers: cors }
      );
    }

    return new Response(JSON.stringify(parsed), { status: 200, headers: cors });
  }
};
