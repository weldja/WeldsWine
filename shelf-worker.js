/* ══════════════════════════════════════════════════════════════
   Welds Wine Wisdoms — Shelf Scanner worker
   ──────────────────────────────────────────────────────────────
   A separate Cloudflare worker, used only by shelf.html.
   It is completely independent of the main worker (worker.js):
   if this one breaks, the journal carries on as normal.

   What it does:
     POST /scan    Takes 1–6 photos of the same shelf, sends them to
                   Claude together, and returns every wine found, its
                   price, and the best-value picks.
     GET  /health  Says "ok" — handy to check it is deployed.

   Setup (one secret only):
     ANTHROPIC_API_KEY   your Claude API key
                         (Cloudflare → this worker → Settings → Variables
                          and Secrets → Add → type "Secret")

   Who can use it:
     Only signed-in Welds Wine members. While ADMIN_ONLY is true,
     only admins (profiles.is_admin = true). To open it up to every
     member later, change ADMIN_ONLY to false and redeploy.
   ══════════════════════════════════════════════════════════════ */

const ADMIN_ONLY = true;

// The model that reads the shelf. Sonnet reads small price tags far
// more reliably than Haiku, which matters here.
const MODEL = "claude-sonnet-4-6";

// Same Supabase project as the journal. The publishable key is public
// (it is already in index.html), so it is fine to keep it here.
const SUPABASE_URL = "https://phcnswuwrqarikzjvfqd.supabase.co";
const SUPABASE_KEY = "sb_publishable_6FvpnoWmZ8pSFy-GWZfFQw_ciawP5aA";

const MAX_PHOTOS = 6;
const MAX_PHOTO_BYTES = 4 * 1024 * 1024; // per photo, after base64 decoding (Claude's limit is 5 MB)

const ALLOWED_ORIGINS = [
  "https://weldswine.co.uk",
  "https://www.weldswine.co.uk",
  "https://james-weld.github.io",
  "http://localhost",
  "http://127.0.0.1"
];

/* ── Helpers ─────────────────────────────────────────────────── */

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const allowed = ALLOWED_ORIGINS.some((o) => origin === o || origin.startsWith(o + ":"));
  return {
    "Access-Control-Allow-Origin": allowed ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
    "Content-Type": "application/json"
  };
}

function originAllowed(request) {
  const origin = request.headers.get("Origin") || "";
  // No Origin header = not a browser page (e.g. a test from the command line).
  // Those still need a valid sign-in token, so they are safe to let through.
  if (!origin) return true;
  return ALLOWED_ORIGINS.some((o) => origin === o || origin.startsWith(o + ":"));
}

function reply(request, status, body) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders(request) });
}

// Who is calling? Checks the Supabase sign-in token, and (while ADMIN_ONLY)
// that the person is an admin. Returns { user } or { error, status }.
async function checkCaller(request) {
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return { error: "NOT_SIGNED_IN", status: 401 };

  let user;
  try {
    const res = await fetch(SUPABASE_URL + "/auth/v1/user", {
      headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + token }
    });
    if (!res.ok) return { error: "NOT_SIGNED_IN", status: 401 };
    user = await res.json();
  } catch (e) {
    return { error: "AUTH_CHECK_FAILED", status: 502 };
  }
  if (!user || !user.id) return { error: "NOT_SIGNED_IN", status: 401 };

  if (ADMIN_ONLY) {
    try {
      // Read the person's own profile using their own sign-in (the journal does the same)
      const res = await fetch(
        SUPABASE_URL + "/rest/v1/profiles?id=eq." + encodeURIComponent(user.id) + "&select=is_admin",
        { headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + token } }
      );
      const rows = res.ok ? await res.json() : [];
      if (!rows.length || rows[0].is_admin !== true) return { error: "ADMIN_ONLY", status: 403 };
    } catch (e) {
      return { error: "AUTH_CHECK_FAILED", status: 502 };
    }
  }
  return { user };
}

// Approximate size in bytes of a base64 string once decoded
function base64Bytes(b64) {
  const len = b64.length;
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((len * 3) / 4) - pad;
}

/* ── The instructions given to Claude ────────────────────────── */

function buildPrompt(photoCount, hasLoyaltyCard, shop) {
  return `You are helping a wine lover in a UK shop find the best value wine on a shelf.

You have been given ${photoCount} photo${photoCount === 1 ? "" : "s"} of the SAME shelf, labelled Photo 1 to Photo ${photoCount}. They may overlap: one may be a wide shot and others close-ups of particular rows. ${shop ? `The shop is: ${shop}.` : "The shop was not given; work it out from the tags if you can."}

YOUR TASKS

1. Read every wine you can see across all the photos.
   - The same wine often appears in more than one photo, and there are often several bottles of the same wine side by side. List each different wine ONCE.
   - Where a wine or its price appears in more than one photo, use the clearest reading, and record every photo it appears in.
   - Number the shelves from the top: the top shelf is 1.

2. Match each wine to its price tag.
   - Price tags usually sit on the shelf edge directly below the bottles, but not always exactly under them. Use the wide photo to work out which tag belongs to which bottles, and the close-ups to read the numbers.
   - Many UK shops show a normal price and a loyalty-card price (Tesco Clubcard, Sainsbury's Nectar and so on), or an offer price with the old price shown. Record the normal price in "price" and any loyalty or offer price in "loyalty_price".
   - NEVER guess or invent a price. If you cannot see a tag for a wine, or cannot read it, set the prices to null and say why in "note".

3. Judge your confidence for each wine:
   - "high": wine and price clearly readable, and the tag clearly belongs to that wine (ideally seen in more than one photo).
   - "medium": readable, but the tag-to-bottle match or a detail is a reasonable judgement.
   - "low": partly hidden, blurred, glare, or the match is a guess. Explain in "note" what the person should check.

4. Pick the best value.
   - The person ${hasLoyaltyCard ? "HAS" : "does NOT have"} a loyalty card${hasLoyaltyCard ? ", so use loyalty prices where shown" : ", so use normal prices, not loyalty prices"}.
   - Value means how good the wine usually is compared with what it costs here. Use your knowledge of these producers and wines, and of their usual UK prices. A wine that is on offer below its usual price is good value.
   - Only pick wines with a price you could read. Prefer high or medium confidence wines.
   - Choose up to 3 best-value picks, best first, each with a short reason (1 or 2 plain sentences, British English, no hype). Mention it if the price is worth double-checking.
   - Also list up to 3 wines that are poor value (for example, paying for a brand name), each with a short reason.
   - If you are not familiar with a wine, say so honestly in the reason rather than inventing facts about it.

5. Give every wine a value score.
   - "value_score" is a whole number from 1 to 10 for how good value the wine is at the price YOU would pay here: 10 = outstanding value, 7 = good value, 5 = fair, 3 = poor, 1 = very poor value.
   - Your best-value picks must have the highest scores on the shelf, in order: pick 1 the highest, then pick 2, then pick 3. Your poor-value wines must have the lowest scores.
   - If no price could be read for a wine, set "value_score" to null.

6. Say where each wine is in the photos, so it can be marked on a picture of the shelf.
   - Choose the "overview_photo": the photo that shows the most of the shelf (usually the wide shot).
   - For each wine, give "location": a box around that wine's front-facing bottles (all of its bottles side by side, not the price tag) in ONE photo.
   - Use the overview photo whenever the wine can be seen in it, so the whole shelf can be shown on one picture. Otherwise use the photo where the wine is clearest.
   - Give the box as fractions of that photo's width and height, measured from its top-left corner: "x" and "y" are the top-left corner of the box, "w" and "h" its width and height. All four are between 0 and 1. For example, a wine in the top-left quarter of the photo might be {"photo": 1, "x": 0.05, "y": 0.02, "w": 0.2, "h": 0.22}.
   - Boxes for different wines must not overlap: neighbouring wines on the same shelf should sit side by side, each box ending where the next wine's bottles begin.
   - Be as accurate as you can. If you cannot tell where a wine is, set "location" to null.

7. Write a one-sentence summary of the shelf.

Return ONLY a valid JSON object — no markdown fences, no explanation — exactly in this shape:
{
  "shop": "shop name or null",
  "summary": "one sentence",
  "overview_photo": 1,
  "wines": [
    {
      "id": "w1",
      "name": "wine name as you would ask for it in a shop",
      "producer": "producer or null",
      "grape": "grape or blend or null",
      "country": "country or null",
      "region": "region or null",
      "style": "Red, White, Rosé, Sparkling, Dessert, Fortified or null",
      "vintage": 2021 or null,
      "shelf": 1 or null,
      "price": 8.5 or null,
      "loyalty_price": 7.5 or null,
      "photos": [1, 3],
      "confidence": "high, medium or low",
      "value_score": 7 or null,
      "location": { "photo": 1, "x": 0.05, "y": 0.02, "w": 0.2, "h": 0.22 } or null,
      "note": "short note on anything to check, or null"
    }
  ],
  "picks": [ { "wine_id": "w1", "reason": "..." } ],
  "poor_value": [ { "wine_id": "w2", "reason": "..." } ]
}

Prices are numbers in pounds (8.5 means £8.50). Give each wine a unique id ("w1", "w2" and so on) and use those ids in "picks" and "poor_value".`;
}

/* ── Tidy up Claude's answer so the page can trust its shape ── */

function str(v, max = 200) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}
function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 && n < 10000 ? Math.round(n * 100) / 100 : null;
}

// A box on a photo, as fractions (0–1) of the photo's width and height
function cleanLocation(loc, photoCount) {
  if (!loc || typeof loc !== "object") return null;
  const photo = parseInt(loc.photo, 10);
  if (!(photo >= 1 && photo <= photoCount)) return null;
  const f = (v) => { const n = typeof v === "number" ? v : parseFloat(v); return Number.isFinite(n) ? n : null; };
  let x = f(loc.x), y = f(loc.y), w = f(loc.w), h = f(loc.h);
  if (x === null || y === null || w === null || h === null) return null;
  // Some answers use percentages (0–100) instead of fractions
  if (Math.max(x, y, w, h) > 1.5) { x /= 100; y /= 100; w /= 100; h /= 100; }
  x = Math.min(Math.max(x, 0), 0.98); y = Math.min(Math.max(y, 0), 0.98);
  w = Math.min(Math.max(w, 0.01), 1 - x); h = Math.min(Math.max(h, 0.01), 1 - y);
  const r = (n) => Math.round(n * 1000) / 1000;
  return { photo, x: r(x), y: r(y), w: r(w), h: r(h) };
}

function cleanResult(raw, photoCount) {
  const overview = parseInt(raw.overview_photo, 10);
  const out = {
    shop: str(raw.shop, 60), summary: str(raw.summary, 400),
    overview_photo: overview >= 1 && overview <= photoCount ? overview : 1,
    wines: [], picks: [], poor_value: []
  };
  const ids = new Set();
  (Array.isArray(raw.wines) ? raw.wines : []).slice(0, 80).forEach((w, i) => {
    if (!w || typeof w !== "object") return;
    let id = str(w.id, 20) || "w" + (i + 1);
    while (ids.has(id)) id = id + "x";
    ids.add(id);
    const conf = ["high", "medium", "low"].includes(String(w.confidence).toLowerCase())
      ? String(w.confidence).toLowerCase() : "medium";
    const vintage = parseInt(w.vintage, 10);
    const shelf = parseInt(w.shelf, 10);
    const photos = (Array.isArray(w.photos) ? w.photos : [])
      .map((p) => parseInt(p, 10))
      .filter((p) => p >= 1 && p <= photoCount);
    let price = num(w.price), loyalty = num(w.loyalty_price);
    if (!price && loyalty) { price = loyalty; loyalty = null; }        // only one price seen
    if (loyalty && price && loyalty >= price) loyalty = null;            // not actually a discount
    const score = parseInt(w.value_score, 10);
    out.wines.push({
      id,
      name: str(w.name, 120) || "Unnamed wine",
      producer: str(w.producer, 80),
      grape: str(w.grape, 80),
      country: str(w.country, 40),
      region: str(w.region, 80),
      style: str(w.style, 20),
      vintage: vintage >= 1900 && vintage <= 2100 ? vintage : null,
      shelf: shelf >= 1 && shelf <= 20 ? shelf : null,
      price,
      loyalty_price: loyalty,
      photos: [...new Set(photos)].sort((a, b) => a - b),
      confidence: conf,
      value_score: price && score >= 1 && score <= 10 ? score : null,
      location: cleanLocation(w.location, photoCount),
      note: str(w.note, 200)
    });
  });
  const known = new Set(out.wines.map((w) => w.id));
  const used = new Set();
  // Keep only known wines, each wine once (and never both a pick and poor value)
  const cleanList = (list, max) => {
    const outList = [];
    for (const p of (Array.isArray(list) ? list : [])) {
      if (outList.length >= max) break;
      const id = p && String(p.wine_id);
      if (!id || !known.has(id) || used.has(id)) continue;
      used.add(id);
      outList.push({ wine_id: id, reason: str(p.reason, 400) || "" });
    }
    return outList;
  };
  out.picks = cleanList(raw.picks, 3);
  out.poor_value = cleanList(raw.poor_value, 3);
  return out;
}

/* ── The scan itself ─────────────────────────────────────────── */

async function handleScan(request, env) {
  const apiKey = env && env.ANTHROPIC_API_KEY;
  if (!apiKey) return reply(request, 500, { error: "NO_KEY_IN_WORKER" });

  const caller = await checkCaller(request);
  if (caller.error) return reply(request, caller.status, { error: caller.error });

  let body;
  try { body = await request.json(); }
  catch { return reply(request, 400, { error: "BAD_REQUEST" }); }

  const photos = Array.isArray(body.photos) ? body.photos : [];
  if (!photos.length) return reply(request, 400, { error: "NO_PHOTOS" });
  if (photos.length > MAX_PHOTOS) return reply(request, 400, { error: "TOO_MANY_PHOTOS" });

  const content = [];
  for (let i = 0; i < photos.length; i++) {
    let b64 = String(photos[i] || "");
    let mediaType = "image/jpeg";
    const m = b64.match(/^data:(image\/(?:jpeg|png|webp));base64,/);
    if (m) { mediaType = m[1]; b64 = b64.slice(m[0].length); }
    if (!/^[A-Za-z0-9+/=]+$/.test(b64)) return reply(request, 400, { error: "BAD_PHOTO" });
    if (base64Bytes(b64) > MAX_PHOTO_BYTES) return reply(request, 413, { error: "PHOTO_TOO_BIG" });
    content.push({ type: "text", text: "Photo " + (i + 1) + ":" });
    content.push({ type: "image", source: { type: "base64", media_type: mediaType, data: b64 } });
  }
  const shop = str(body.shop, 60);
  content.push({ type: "text", text: buildPrompt(photos.length, body.loyaltyCard === true, shop) });

  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 8000, messages: [{ role: "user", content }] })
    });
  } catch (e) {
    return reply(request, 502, { error: "AI_UNREACHABLE" });
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.error("shelf scan: Anthropic error", res.status, JSON.stringify(err));
    if (res.status === 401) return reply(request, 500, { error: "INVALID_KEY" });
    if (res.status === 429 || res.status === 529) return reply(request, 429, { error: "BUSY" });
    return reply(request, 502, { error: "AI_ERROR", detail: (err.error && err.error.message) || ("status " + res.status) });
  }

  const data = await res.json();
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  const cleaned = text.replace(/```json\s*/gi, "").replace(/```\s*/gi, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  let parsed;
  try { parsed = JSON.parse(match ? match[0] : cleaned); }
  catch {
    console.error("shelf scan: could not read AI answer:", text.slice(0, 500));
    return reply(request, 422, { error: "UNREADABLE_ANSWER" });
  }

  const result = cleanResult(parsed, photos.length);
  result.photo_count = photos.length;
  result.loyalty_card = body.loyaltyCard === true;
  result.scanned_at = new Date().toISOString();
  return reply(request, 200, result);
}

/* ── Entry point ─────────────────────────────────────────────── */

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });
    if (!originAllowed(request)) return reply(request, 403, { error: "ORIGIN_NOT_ALLOWED" });

    const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
    if (request.method === "GET" && (path === "/health" || path === "/")) {
      return reply(request, 200, { ok: true, service: "shelf-scanner", admin_only: ADMIN_ONLY, key_set: !!(env && env.ANTHROPIC_API_KEY) });
    }
    if (request.method === "POST" && path === "/scan") {
      try { return await handleScan(request, env); }
      catch (e) {
        console.error("shelf scan: unexpected error", e && e.stack || e);
        return reply(request, 500, { error: "UNEXPECTED" });
      }
    }
    return reply(request, 404, { error: "NOT_FOUND" });
  }
};