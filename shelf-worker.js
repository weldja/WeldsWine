/* ══════════════════════════════════════════════════════════════
   Welds Wine Wisdoms — Shelf Scanner worker
   ──────────────────────────────────────────────────────────────
   A separate Cloudflare worker, used only by shelf.html.
   It is completely independent of the main worker (worker.js):
   if this one breaks, the journal carries on as normal.

   What it does:
     POST /scan    Takes 1–6 photos of the same shelf, sends them to
                   Claude together, and returns every wine found, its
                   price, and the best-value picks. The page can
                   ask for one colour only ("want": red, white or
                   rose), and then the picks only come from that colour.
     GET  /health  Says "ok" — handy to check it is deployed.

   Setup (secrets: Cloudflare → this worker → Settings → Variables
   and Secrets → Add → type "Secret"):
     ANTHROPIC_API_KEY     your Claude API key
     SUPABASE_SERVICE_KEY  the same service key the main worker uses;
                           needed for usage tracking and scan limits

   Who can use it:
     Only signed-in Welds Wine members. While ADMIN_ONLY is true,
     only admins (profiles.is_admin = true). To open it up to every
     member later, change ADMIN_ONLY to false and redeploy.
   ══════════════════════════════════════════════════════════════ */

const ADMIN_ONLY = false;

// The model that reads the shelf. Sonnet reads small price tags far
// more reliably than Haiku, which matters here.
const MODEL = "claude-sonnet-5-5";

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

/* ── AI usage tracking and per-user limits ───────────────────────
   Same tables as the journal (supabase-usage-limits.sql). Needs the
   SUPABASE_SERVICE_KEY secret on this worker. Without it, or if
   Supabase can't be reached, scans are allowed and not recorded. */

// US dollars per million tokens (estimates; keep in step with worker.js)
const AI_PRICES = {
  "claude-sonnet-5-5": { in: 2, out: 10, cacheRead: 0.1 },
  "claude-sonnet-5": { in: 2, out: 10 }
};
const WEB_SEARCH_PRICE = 0.01;

async function sbService(env, path, method, body) {
  const key = env && env.SUPABASE_SERVICE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_KEY not set on the shelf worker");
  const res = await fetch(SUPABASE_URL + "/rest/v1" + path, {
    method,
    headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json", Prefer: "return=representation" },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) throw new Error("Supabase " + res.status + ": " + (await res.text().catch(() => "")).slice(0, 200));
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Returns { allowed, id, used, limit, resets_at }, or { allowed: true } if the check couldn't run
async function claimUsage(env, userId, feature) {
  try {
    const r = await sbService(env, "/rpc/claim_usage", "POST", { p_user: userId, p_feature: feature });
    if (r && typeof r.allowed === "boolean") return r;
  } catch (e) {
    console.error("claimUsage: check failed, allowing the scan:", e.message);
  }
  return { allowed: true, id: null };
}

async function finishUsage(env, claim, data, ok) {
  if (!claim || !claim.id) return;
  try {
    const u = (data && data.usage) || {};
    const model = (data && data.model) || MODEL;
    const p = AI_PRICES[model] || AI_PRICES[MODEL];
    const n = {
      model,
      input_tokens: u.input_tokens || 0,
      output_tokens: u.output_tokens || 0,
      cache_read_tokens: u.cache_read_input_tokens || 0,
      cache_write_tokens: u.cache_creation_input_tokens || 0,
      web_searches: (u.server_tool_use && u.server_tool_use.web_search_requests) || 0
    };
    const tokenCost = (n.input_tokens * p.in + n.output_tokens * p.out +
      n.cache_read_tokens * (p.cacheRead != null ? p.cacheRead : p.in / 10) +
      n.cache_write_tokens * p.in * 1.25) / 1e6;
    n.cost_usd = Math.round((tokenCost + n.web_searches * WEB_SEARCH_PRICE) * 1e6) / 1e6;
    n.status = ok ? "ok" : "failed";
    await sbService(env, "/api_usage?id=eq." + encodeURIComponent(claim.id), "PATCH", n);
  } catch (e) {
    console.error("finishUsage: could not record usage:", e.message);
  }
}

// Approximate size in bytes of a base64 string once decoded
function base64Bytes(b64) {
  const len = b64.length;
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((len * 3) / 4) - pad;
}

/* ── The instructions given to Claude ────────────────────────── */

// The colours the page can ask for, and how to name them in the prompt
const WANT_WORDS = { red: "red", white: "white", rose: "rosé" };

// What kind of pick the person wants. "value" is the default.
const MODES = ["value", "budget", "treat"];

// Picks must be at least this good (quality_score), unless no wine
// that could be picked reaches it. Stops a cheap but dull wine winning.
const QUALITY_FLOOR = 6;

// How to choose the picks, for each mode
function pickRules(mode, budget, priceWord) {
  if (mode === "budget") return `
   - The person has a budget of £${budget} a bottle. Only pick wines whose ${priceWord} is £${budget} or less.
   - Among those, pick the wines with the most quality for the money, as described for value above. Do not just pick the cheapest wines under the budget: a wine near the top of the budget that drinks well above its price is a better pick than a cheaper, plainer one.
   - If no wine with a readable price is within the budget, leave "picks" empty.`;
  if (mode === "treat") return `
   - The person wants a treat: the best wine on this shelf for a special occasion. Pick the wines with the highest quality, best first.
   - Price still matters a little: between two wines of similar quality, prefer the one that is fairer value, and avoid wines whose price is mostly for a famous name or fancy packaging.
   - Your reason should say what makes the wine special.`;
  return `
   - Pick the wines that give the most quality per pound. Best value is NOT the lowest price.`;
}

function buildPrompt(photoCount, hasLoyaltyCard, shop, want, mode, budget) {
  const w = WANT_WORDS[want];   // undefined means any colour
  const priceWord = hasLoyaltyCard ? "loyalty price (or normal price if there is no loyalty price)" : "normal price";
  const colourRule = w ? `
   - IMPORTANT: the person only wants a ${w} wine today. Your picks and your poor-value wines must ALL be ${w} wines ("style": "${w === "rosé" ? "Rosé" : w[0].toUpperCase() + w.slice(1)}"). Do not pick any other style, and do not pick a wine if you cannot tell whether it is ${w}. If no ${w} wine has a readable price, leave "picks" empty.
   - Still list EVERY wine on the shelf in "wines", whatever its colour, and still give every wine a quality score and a value score.` : "";
  const pickHeading = mode === "treat" ? "Pick the best wine for a treat." : mode === "budget" ? `Pick the best value within the budget of £${budget}.` : "Pick the best value.";
  const scoreOrderRule = mode === "value"
    ? `
   - Your picks must have the highest value scores on the shelf, in order: pick 1 the highest, then pick 2, then pick 3. Your poor-value wines must have the lowest scores.`
    : `
   - Your poor-value wines must have the lowest value scores. (Your picks are chosen by the rules in task 5, so they need not have the highest value scores.)`;
  return `You are helping a wine lover in a UK shop find the best value wine on a shelf.

You have been given ${photoCount} photo${photoCount === 1 ? "" : "s"} of the SAME shelf, labelled Photo 1 to Photo ${photoCount}. They may overlap: one may be a wide shot and others close-ups of particular rows. ${shop ? `The shop is: ${shop}.` : `The shop was not given. Only fill in "shop" if you can see clear proof in the photos, such as the shop's name or logo on a sign, a price tag or an offer ticket. Do NOT guess the shop from the wines, the shelving, the style of the tags or the prices. If there is no clear proof, set "shop" to null.`}

YOUR TASKS

1. Read every wine you can see across all the photos.
   - The same wine often appears in more than one photo, and there are often several bottles of the same wine side by side. List each different wine ONCE.
   - Where a wine or its price appears in more than one photo, use the clearest reading, and record every photo it appears in.
   - Number the shelves from the top: the top shelf is 1.
   - Give each wine a "style". Use the colour of the wine and the glass, the grape, the label and what you know of the wine. Sparkling wines are "Sparkling" (not White or Rosé), sweet wines are "Dessert", and port, sherry and similar are "Fortified". If you cannot tell, use null.

2. Match each wine to its price tag.
   - Price tags usually sit on the shelf edge directly below the bottles, but not always exactly under them. Use the wide photo to work out which tag belongs to which bottles, and the close-ups to read the numbers.
   - Many UK shops show a normal price and a loyalty-card price (Tesco Clubcard, Sainsbury's Nectar and so on), or an offer price with the old price shown. Record the normal price in "price" and any loyalty or offer price in "loyalty_price".
   - NEVER guess or invent a price. If you cannot see a tag for a wine, or cannot read it, set the prices to null and say why in "note".

3. Judge your confidence for each wine:
   - "high": wine and price clearly readable, and the tag clearly belongs to that wine (ideally seen in more than one photo).
   - "medium": readable, but the tag-to-bottle match or a detail is a reasonable judgement.
   - "low": partly hidden, blurred, glare, or the match is a guess. Explain in "note" what the person should check.

4. Judge how good each wine is, BEFORE you think about its price here.
   - "quality_score" is a whole number from 1 to 10 for how good the wine in the bottle is, ignoring the price on this shelf completely: 10 = exceptional, 8 = very good, 6 = good, 4 = ordinary, 2 = poor.
   - Base it on what you know: the producer's reputation, the region and appellation (and its classification, e.g. Cru, Reserva, DOCG), the grape, the vintage, critics' and wine writers' views, and whether it is a mass-market brand made to a price or a wine made with care.
   - Mass-market brands and basic supermarket own-labels are usually 3 to 5. Do not raise a score because the wine is cheap or on offer, and do not lower it because it is expensive.
   - If you can identify the wine, always give a score, even if you have to judge from the region, grape and style. If you cannot tell what the wine is, set it to null.

5. ${pickHeading}
   - The person ${hasLoyaltyCard ? "HAS" : "does NOT have"} a loyalty card${hasLoyaltyCard ? ", so use loyalty prices where shown" : ", so use normal prices, not loyalty prices"}.
   - Value means quality compared with the price here. A £12 wine that drinks like a £20 wine is better value than a £5 wine that drinks like a £5 wine. Use your quality scores and your knowledge of these wines' usual UK prices.
   - A discount only makes a wine good value if the wine is good at its normal price. A dull wine on offer is still a dull wine.
   - Mass-market brands and the very cheapest wines are rarely the best value, even when on offer.${pickRules(mode, budget, priceWord)}
   - Only pick wines with a price you could read. Prefer high or medium confidence wines.
   - Do not pick a wine with a quality score below ${QUALITY_FLOOR} unless no wine you could pick reaches ${QUALITY_FLOOR}.
   - Choose up to 3 picks, best first, each with a short reason (1 or 2 plain sentences, British English, no hype) that says why the wine is good, not just that it is cheap. Mention it if the price is worth double-checking.
   - Also list up to 3 wines that are poor value (for example, paying for a brand name), each with a short reason.
   - If you are not familiar with a wine, say so honestly in the reason rather than inventing facts about it.${colourRule}

6. Give every wine a value score.
   - "value_score" is a whole number from 1 to 10 for how good value the wine is at the price YOU would pay here, judged as quality for the money: 10 = outstanding value, 7 = good value, 5 = fair, 3 = poor, 1 = very poor value. A cheap, ordinary wine is fair value at best, not good value.${scoreOrderRule}
   - If no price could be read for a wine, set "value_score" to null.

7. Say where each wine is in the photos, so it can be marked on a picture of the shelf.
   - Choose the "overview_photo": the photo that shows the most of the shelf (usually the wide shot).
   - For each wine, give "locations": a list of boxes, ONE box for EACH photo the wine can be seen in. Each box goes around that wine's front-facing bottles in that photo (all of its bottles side by side, not the price tag).
   - Every photo is shown to the person, one under another, so mark each wine in every photo where it appears, not just one. Never give two boxes for the same photo.
   - Give the box as fractions of that photo's width and height, measured from its top-left corner: "x" and "y" are the top-left corner of the box, "w" and "h" its width and height. All four are between 0 and 1. For example, a wine in the top-left quarter of the photo might be {"photo": 1, "x": 0.05, "y": 0.02, "w": 0.2, "h": 0.22}.
   - Boxes for different wines must not overlap: neighbouring wines on the same shelf should sit side by side, each box ending where the next wine's bottles begin.
   - Be as accurate as you can. Leave out any photo where you cannot tell where the wine is. If you cannot place it in any photo, give an empty list.

8. Write a one-sentence summary of the shelf.

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
      "quality_score": 7 or null,
      "value_score": 7 or null,
      "locations": [ { "photo": 1, "x": 0.05, "y": 0.02, "w": 0.2, "h": 0.22 }, { "photo": 3, "x": 0.4, "y": 0.1, "w": 0.3, "h": 0.5 } ],
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

// Turn whatever the AI wrote for "style" into one of six labels (or null)
function cleanStyle(v) {
  const s = String(v || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (!s) return null;
  if (s.includes("sparkl") || s.includes("champagne") || s.includes("prosecco") || s.includes("cava")) return "Sparkling";
  if (s.includes("rose") || s.includes("blush")) return "Rosé";
  if (s.includes("fortif") || s.includes("port") || s.includes("sherry")) return "Fortified";
  if (s.includes("dessert") || s.includes("sweet")) return "Dessert";
  if (s.includes("red")) return "Red";
  if (s.includes("white")) return "White";
  return null;
}
// The same, as the short key the page uses: red, white, rose …
function styleKey(style) {
  return { Red: "red", White: "white", "Rosé": "rose" }[style] || null;
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

function cleanResult(raw, photoCount, want, mode, budget, loyaltyCard) {
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
    const quality = parseInt(w.quality_score, 10);
    // Where the wine is: one box per photo it appears in. (Older answers
    // gave a single "location", so that is accepted too.)
    const rawLocs = Array.isArray(w.locations) ? w.locations : (w.location ? [w.location] : []);
    const locations = [];
    rawLocs.forEach((l) => {
      const c = cleanLocation(l, photoCount);
      if (c && !locations.some((x) => x.photo === c.photo)) locations.push(c);
    });
    locations.sort((a, b) => a.photo - b.photo);
    out.wines.push({
      id,
      name: str(w.name, 120) || "Unnamed wine",
      producer: str(w.producer, 80),
      grape: str(w.grape, 80),
      country: str(w.country, 40),
      region: str(w.region, 80),
      style: cleanStyle(w.style),
      vintage: vintage >= 1900 && vintage <= 2100 ? vintage : null,
      shelf: shelf >= 1 && shelf <= 20 ? shelf : null,
      price,
      loyalty_price: loyalty,
      photos: [...new Set(photos)].sort((a, b) => a - b),
      confidence: conf,
      quality_score: quality >= 1 && quality <= 10 ? quality : null,
      value_score: price && score >= 1 && score <= 10 ? score : null,
      locations,
      // Kept for older pages: the box on the overview photo, or the first one
      location: locations.find((l) => l.photo === out.overview_photo) || locations[0] || null,
      note: str(w.note, 200)
    });
  });
  const known = new Set(out.wines.map((w) => w.id));
  const used = new Set();
  // Keep only known wines, each wine once (and never both a pick and poor value)
  // If only one colour was wanted, never let a wine of another colour
  // through as a pick or poor-value wine (a safety net in case the AI
  // forgets). Wines with no style are kept: the AI was told not to pick
  // a wine unless it was sure of its colour.
  const byId = new Map(out.wines.map((w) => [w.id, w]));
  const wrongColour = (id) => want && byId.get(id).style && styleKey(byId.get(id).style) !== want;
  // The price this person would pay
  const payPrice = (w) => (loyaltyCard && w.loyalty_price) || w.price;
  // On a budget, a pick must be within it (a safety net, as above)
  const overBudget = (id) => mode === "budget" && budget && !(payPrice(byId.get(id)) <= budget);
  // Quality floor: picks must score at least QUALITY_FLOOR for quality,
  // unless no wine that could be picked (right colour, readable price,
  // within budget) reaches it, in which case there is no floor.
  const couldPick = out.wines.filter((w) => w.price && !wrongColour(w.id) && !overBudget(w.id));
  const floorOn = couldPick.some((w) => w.quality_score >= QUALITY_FLOOR);
  const belowFloor = (id) => floorOn && !(byId.get(id).quality_score >= QUALITY_FLOOR);
  const cleanList = (list, max, isPicks) => {
    const outList = [];
    for (const p of (Array.isArray(list) ? list : [])) {
      if (outList.length >= max) break;
      const id = p && String(p.wine_id);
      if (!id || !known.has(id) || used.has(id) || wrongColour(id)) continue;
      if (isPicks && (overBudget(id) || belowFloor(id))) continue;
      used.add(id);
      outList.push({ wine_id: id, reason: str(p.reason, 400) || "" });
    }
    return outList;
  };
  out.picks = cleanList(raw.picks, 3, true);
  out.poor_value = cleanList(raw.poor_value, 3, false);
  return out;
}

/* ── The scan itself ─────────────────────────────────────────── */

async function handleScan(request, env, ctx) {
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
  // Which colour the person is after: "red", "white", "rose", or null for any
  const want = WANT_WORDS[body.want] ? body.want : null;
  // What kind of pick: best value (default), best under a budget, or a treat
  let mode = MODES.includes(body.mode) ? body.mode : "value";
  const budgetNum = Number(body.budget);
  const budget = mode === "budget" && budgetNum >= 3 && budgetNum <= 500 ? Math.round(budgetNum * 100) / 100 : null;
  if (mode === "budget" && !budget) mode = "value";   // no sensible budget given
  content.push({ type: "text", text: buildPrompt(photos.length, body.loyaltyCard === true, shop, want, mode, budget) });

  // Within this person's monthly shelf-scan limit?
  const claim = await claimUsage(env, caller.user.id, "shelf");
  // trial: a visitor on the free trial; reason "trial_busy" = the daily cap for all trial visitors was hit
  if (!claim.allowed) return reply(request, 429, { error: "USAGE_LIMIT", used: claim.used, limit: claim.limit, resets_at: claim.resets_at, trial: !!claim.trial, reason: claim.reason || "limit" });
  const record = (d, ok) => { const p = finishUsage(env, claim, d, ok); if (ctx && ctx.waitUntil) ctx.waitUntil(p); return p; };

  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01", "anthropic-beta": "server-side-fallback-2026-07-01" },
      // Sonnet 5.5 thinks before answering and that thinking shares max_tokens,
      // so allow plenty of room. "high" effort gives it time to judge each
      // wine's quality properly, which costs a little more per scan.
      // If the AI declines a request, "fallbacks" lets the API retry it on another model.
      body: JSON.stringify({ model: MODEL, max_tokens: 20000, output_config: { effort: "high" }, fallbacks: "default", messages: [{ role: "user", content }] })
    });
  } catch (e) {
    record(null, false);
    return reply(request, 502, { error: "AI_UNREACHABLE" });
  }
  if (!res.ok) {
    record(null, false);
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
    record(data, false);
    console.error("shelf scan: could not read AI answer:", text.slice(0, 500));
    return reply(request, 422, { error: "UNREADABLE_ANSWER" });
  }
  record(data, true);

  const result = cleanResult(parsed, photos.length, want, mode, budget, body.loyaltyCard === true);
  result.photo_count = photos.length;
  result.loyalty_card = body.loyaltyCard === true;
  // If the person chose the shop, always show their choice. Otherwise mark the AI's answer as a guess.
  if (shop) { result.shop = shop; result.shop_guessed = false; }
  else { result.shop_guessed = !!result.shop; }
  result.want = want;
  result.mode = mode;
  result.budget = budget;
  result.scanned_at = new Date().toISOString();
  return reply(request, 200, result);
}

/* ── Entry point ─────────────────────────────────────────────── */

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });
    if (!originAllowed(request)) return reply(request, 403, { error: "ORIGIN_NOT_ALLOWED" });

    const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
    if (request.method === "GET" && (path === "/health" || path === "/")) {
      return reply(request, 200, { ok: true, service: "shelf-scanner", admin_only: ADMIN_ONLY, key_set: !!(env && env.ANTHROPIC_API_KEY), usage_tracking: !!(env && env.SUPABASE_SERVICE_KEY) });
    }
    if (request.method === "POST" && path === "/scan") {
      try { return await handleScan(request, env, ctx); }
      catch (e) {
        console.error("shelf scan: unexpected error", e && e.stack || e);
        return reply(request, 500, { error: "UNEXPECTED" });
      }
    }
    return reply(request, 404, { error: "NOT_FOUND" });
  }
};