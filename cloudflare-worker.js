/**
 * Welds Wine Wisdoms — Cloudflare Worker
 * =======================================
 * Endpoints:
 *   POST /          — AI label scan (Anthropic)
 *   GET  /geocode   — Reverse geocoding proxy
 *   POST /email     — Transactional email via Resend
 *
 * SECRETS — paste below OR set as encrypted env vars in Cloudflare dashboard:
 *   ANTHROPIC_API_KEY  → console.anthropic.com/keys
 *   RESEND_API_KEY     → resend.com/api-keys  (free: 3000 emails/month)
 */

const ANTHROPIC_API_KEY = 'PASTE_YOUR_ANTHROPIC_KEY_HERE';
const RESEND_API_KEY    = 'PASTE_YOUR_RESEND_KEY_HERE';

const EMAIL_FROM = 'Welds Wine Wisdoms <onboarding@resend.dev>';
const APP_NAME   = 'Welds Wine Wisdoms';
const APP_URL    = 'https://james-weld.github.io/WeldsWine';

// ── Email templates ───────────────────────────────────────────

function baseEmail(content) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#F5EFE6;font-family:Georgia,serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F5EFE6;padding:40px 20px">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#FFFEF9;border-radius:8px;overflow:hidden;box-shadow:0 4px 24px rgba(44,20,36,.12)">
<tr><td style="background:#4A1424;padding:28px 32px;text-align:center">
  <div style="font-size:2rem;margin-bottom:8px">🍷</div>
  <div style="font-family:Georgia,serif;font-size:1.25rem;font-weight:600;color:#F5EFE6;letter-spacing:.05em">${APP_NAME}</div>
  <div style="font-family:Georgia,serif;font-size:.7rem;color:#C4788A;letter-spacing:.14em;text-transform:uppercase;font-style:italic;margin-top:3px">Personal Wine Journal</div>
</td></tr>
<tr><td style="padding:32px">${content}</td></tr>
<tr><td style="padding:16px 32px 28px;text-align:center;border-top:1px solid #E8DDD6">
  <p style="font-family:Georgia,serif;font-size:.72rem;color:#6B5D58;font-style:italic;margin:0">If you didn't request this, you can safely ignore it.</p>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

function btn(url, label) {
  return `<table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0">
<tr><td align="center">
<a href="${url}" style="display:inline-block;background:#6B2737;color:#FFFEF9;text-decoration:none;padding:13px 32px;border-radius:4px;font-family:Georgia,serif;font-size:.95rem;font-weight:600;letter-spacing:.04em">${label}</a>
</td></tr></table>
<p style="font-family:Georgia,serif;font-size:.78rem;color:#6B5D58;font-style:italic;margin:0">Or copy: <span style="color:#6B2737;word-break:break-all">${url}</span></p>`;
}

const templates = {
  magic_link: (url) => ({
    subject: `Sign in to ${APP_NAME}`,
    html: baseEmail(`
      <p style="font-family:Georgia,serif;font-size:1rem;color:#2C2420;line-height:1.6;margin:0 0 8px">Your sign-in link — expires in 1 hour, single use.</p>
      ${btn(url, 'Sign In to My Journal')}`)
  }),
  reset_password: (url) => ({
    subject: `Reset your ${APP_NAME} password`,
    html: baseEmail(`
      <p style="font-family:Georgia,serif;font-size:1rem;color:#2C2420;line-height:1.6;margin:0 0 8px">Reset your password — link expires in 1 hour.</p>
      ${btn(url, 'Reset My Password')}`)
  }),
  welcome: () => ({
    subject: `Welcome to ${APP_NAME} 🍷`,
    html: baseEmail(`
      <p style="font-family:Georgia,serif;font-size:1rem;color:#2C2420;line-height:1.6;margin:0 0 12px">Welcome to ${APP_NAME} — your personal wine journal.</p>
      <p style="font-family:Georgia,serif;font-size:.92rem;color:#6B5D58;line-height:1.7;margin:0 0 24px">Scan labels, track tastings, build your collection. Every bottle tells a story.</p>
      ${btn(APP_URL, 'Open My Journal')}`)
  })
};

// ── Resend sender ─────────────────────────────────────────────

async function sendEmail(env, { to, subject, html }) {
  const key = env?.RESEND_API_KEY || RESEND_API_KEY;
  if (!key || key === 'PASTE_YOUR_RESEND_KEY_HERE') throw new Error('RESEND_KEY_NOT_SET');
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({ from: EMAIL_FROM, to, subject, html })
  });
  if (!r.ok) { const e = await r.json().catch(()=>({})); throw new Error(e?.message || `Resend ${r.status}`); }
  return r.json();
}

// ── Worker ────────────────────────────────────────────────────

export default {
  async fetch(request, env) {

    const cors = {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Content-Type': 'application/json'
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);

    // ── GET /geocode ───────────────────────────────────────────
    if (url.pathname.endsWith('/geocode')) {
      const lat = url.searchParams.get('lat'), lon = url.searchParams.get('lon');
      if (!lat || !lon) return new Response(JSON.stringify({ error: 'lat and lon required' }), { status: 400, headers: cors });
      try {
        const r = await fetch(
          `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&accept-language=en`,
          { headers: { 'User-Agent': 'WeldsWineWisdoms/1.0', 'Accept-Language': 'en' } }
        );
        const d = await r.json(); const a = d.address || {};
        const place = a.neighbourhood||a.suburb||a.village||a.town||a.city_district||a.city||a.county||a.state||'';
        const label = [place, a.country].filter(Boolean).join(', ') ||
                      (d.display_name ? d.display_name.split(',').slice(-3).map(s=>s.trim()).join(', ') : '');
        return new Response(JSON.stringify({ label }), { status: 200, headers: cors });
      } catch(e) { return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: cors }); }
    }

    // ── POST /email ────────────────────────────────────────────
    if (url.pathname.endsWith('/email')) {
      if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'POST only' }), { status: 405, headers: cors });

      // Restrict to known app origins to prevent email abuse
      const origin = request.headers.get('Origin') || '';
      const allowedOrigins = [APP_URL, 'http://localhost', 'http://127.0.0.1'];
      const originAllowed = allowedOrigins.some(o => origin.startsWith(o)) || origin === '';
      if (!originAllowed) {
        return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: cors });
      }
      let body;
      try { body = await request.json(); } catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: cors }); }

      const { type, email, url: linkUrl } = body;
      if (!type || !email) return new Response(JSON.stringify({ error: 'type and email required' }), { status: 400, headers: cors });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return new Response(JSON.stringify({ error: 'Invalid email' }), { status: 400, headers: cors });
      if (!templates[type]) return new Response(JSON.stringify({ error: `Unknown type: ${type}` }), { status: 400, headers: cors });
      if ((type === 'magic_link' || type === 'reset_password') && !linkUrl) return new Response(JSON.stringify({ error: 'url required' }), { status: 400, headers: cors });

      try {
        const { subject, html } = templates[type](linkUrl);
        await sendEmail(env, { to: email, subject, html });
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: cors });
      } catch(e) {
        const msg = e.message || '';
        if (msg === 'RESEND_KEY_NOT_SET') return new Response(JSON.stringify({ error: 'Email service not configured' }), { status: 500, headers: cors });
        return new Response(JSON.stringify({ error: msg }), { status: 502, headers: cors });
      }
    }

    // ── POST / — AI label scan ─────────────────────────────────
    if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'POST only' }), { status: 405, headers: cors });

    const anthropicKey = env?.ANTHROPIC_API_KEY || ANTHROPIC_API_KEY;
    if (!anthropicKey || anthropicKey === 'PASTE_YOUR_ANTHROPIC_KEY_HERE') return new Response(JSON.stringify({ error: 'NO_KEY_IN_WORKER' }), { status: 500, headers: cors });

    let body;
    try { body = await request.json(); } catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: cors }); }

    const { imageBase64, backImageBase64 = null, mimeType = 'image/jpeg' } = body;
    if (!imageBase64) return new Response(JSON.stringify({ error: 'imageBase64 required' }), { status: 400, headers: cors });

    const imageBlocks = [{ type: 'image', source: { type: 'base64', media_type: mimeType, data: imageBase64 } }];
    if (backImageBase64) imageBlocks.push({ type: 'image', source: { type: 'base64', media_type: mimeType, data: backImageBase64 } });

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

    let anthropicResp;
    try {
      anthropicResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 800, messages: [{ role: 'user', content: [...imageBlocks, { type: 'text', text: (backImageBase64 ? 'First image = FRONT, second = BACK. Use both.\n\n' : 'Examine carefully.\n\n') + PROMPT }] }] })
      });
    } catch(e) { return new Response(JSON.stringify({ error: 'Failed to reach Anthropic: ' + e.message }), { status: 502, headers: cors }); }

    if (!anthropicResp.ok) {
      const errBody = await anthropicResp.json().catch(()=>({}));
      const status = anthropicResp.status;
      if (status === 401) return new Response(JSON.stringify({ error: 'INVALID_KEY' }), { status: 401, headers: cors });
      if (status === 429) return new Response(JSON.stringify({ error: 'RATE_LIMIT' }), { status: 429, headers: cors });
      return new Response(JSON.stringify({ error: errBody?.error?.message || `Anthropic error ${status}` }), { status, headers: cors });
    }

    const data = await anthropicResp.json();
    const rawText = (data.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
    const cleaned = rawText.replace(/```json\s*/gi,'').replace(/```\s*/gi,'').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    let parsed;
    try { parsed = JSON.parse(match ? match[0] : cleaned); }
    catch { return new Response(JSON.stringify({ error: 'PARSE_ERROR', raw: rawText }), { status: 422, headers: cors }); }

    return new Response(JSON.stringify(parsed), { status: 200, headers: cors });
  }
};
