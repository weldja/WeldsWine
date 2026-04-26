var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var ANTHROPIC_API_KEY = "";
var RESEND_API_KEY = "";
var EMAIL_FROM = "Welds Wine Wisdoms <hello@weldswine.co.uk>";
var APP_NAME = "Welds Wine Wisdoms";
var APP_URL = "https://weldswine.co.uk";

// Supabase (URL is public; service key comes from env secret SUPABASE_SERVICE_KEY)
var SUPABASE_URL = "https://swkaswlzzqzjiuujyupg.supabase.co";

// Phase 1: only notify James
var PUSH_WHITELIST = ["0c21cdcd-9963-405e-b231-00b8f65dee9e"];
var VAPID_SUBJECT  = "mailto:james_weld@yahoo.com";

/* ══════════════════════════════════════════════════════════
   Web Push helpers (VAPID + aes128gcm payload encryption)
   All crypto uses the Web Crypto API — no Node.js deps needed.
══════════════════════════════════════════════════════════ */

function b64u_decode(str) {
  const pad = "=".repeat((4 - (str.length % 4)) % 4);
  const b64 = (str + pad).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

function b64u_encode(buf) {
  let str = "";
  new Uint8Array(buf).forEach(b => (str += String.fromCharCode(b)));
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function concat_bufs(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out   = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

// Build a VAPID JWT signed with ES256 using the VAPID private key
async function vapid_jwt(env, endpoint) {
  const pub  = env.VAPID_PUBLIC_KEY;
  const priv = env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) throw new Error("VAPID keys not configured in Worker secrets");

  const { origin } = new URL(endpoint);

  const header  = b64u_encode(new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = b64u_encode(new TextEncoder().encode(JSON.stringify({
    aud: origin,
    exp: Math.floor(Date.now() / 1000) + 43200, // 12 hours
    sub: VAPID_SUBJECT
  })));

  // Reconstruct JWK from raw base64url keys
  // VAPID public key is uncompressed P-256 point: 0x04 + x(32) + y(32) = 65 bytes
  const pubBytes = b64u_decode(pub);
  const x = b64u_encode(pubBytes.slice(1, 33));
  const y = b64u_encode(pubBytes.slice(33, 65));

  const sigKey = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", d: priv, x, y, key_ops: ["sign"] },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );

  const sigData = new TextEncoder().encode(`${header}.${payload}`);
  const sig     = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, sigKey, sigData);

  return `${header}.${payload}.${b64u_encode(sig)}`;
}

// Encrypt a push payload using RFC 8291 (key derivation) + RFC 8188 (aes128gcm encoding)
async function encrypt_push(subscription, body) {
  const enc    = new TextEncoder();
  const p256dh = b64u_decode(subscription.keys.p256dh); // 65-byte uncompressed P-256 point
  const auth   = b64u_decode(subscription.keys.auth);   // 16-byte auth secret

  // 1. Generate an ephemeral ECDH key pair
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);

  // 2. Import the UA (browser) public key
  const uaPub = await crypto.subtle.importKey(
    "raw", p256dh,
    { name: "ECDH", namedCurve: "P-256" },
    false, []
  );

  // 3. ECDH shared secret (256 bits)
  const secret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaPub }, eph.privateKey, 256)
  );

  // 4. Export ephemeral public key (uncompressed, 65 bytes)
  const ephPub = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));

  // 5. RFC 8291 IKM derivation
  //    key_info = "WebPush: info\x00" + ua_public (65) + as_public (65)
  //    IKM = HKDF-SHA-256(salt=auth, ikm=secret, info=key_info, L=32)
  const keyInfo   = concat_bufs(enc.encode("WebPush: info\x00"), p256dh, ephPub);
  const secretKey = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]);
  const ikm       = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: auth, info: keyInfo },
    secretKey, 256
  ));

  // 6. Random 16-byte content-encoding salt
  const salt   = crypto.getRandomValues(new Uint8Array(16));
  const ikmKey = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);

  // 7. Derive CEK (16 bytes) and NONCE (12 bytes) via RFC 8188
  const cek = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: enc.encode("Content-Encoding: aes128gcm\x00") },
    ikmKey, 128
  ));
  const nonce = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: enc.encode("Content-Encoding: nonce\x00") },
    ikmKey, 96
  ));

  // 8. AES-128-GCM encrypt: plaintext + 0x02 padding delimiter
  const cekKey    = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const plaintext = concat_bufs(enc.encode(typeof body === "string" ? body : JSON.stringify(body)), new Uint8Array([2]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, cekKey, plaintext));

  // 9. Build aes128gcm body: salt(16) + rs(4,BE) + idlen(1) + ephPub(65) + ciphertext
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096, false); // record size = 4096

  return concat_bufs(salt, rs, new Uint8Array([ephPub.length]), ephPub, ciphertext);
}

// Send one push notification; returns { status, expired }
async function send_push(env, subscription, payload) {
  const endpoint = subscription.endpoint;
  let jwt, body;
  try {
    jwt  = await vapid_jwt(env, endpoint);
    body = await encrypt_push(subscription, payload);
  } catch (e) {
    console.error("push crypto failed:", e.message);
    return { status: 500, expired: false };
  }
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization:      `vapid t=${jwt},k=${env.VAPID_PUBLIC_KEY}`,
      "Content-Type":     "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      TTL:                "86400"
    },
    body
  });
  return { status: res.status, expired: res.status === 410 || res.status === 404 };
}

// Minimal Supabase REST helper — uses service role key to bypass RLS
async function sb_fetch(env, path, opts = {}) {
  const key = env.SUPABASE_SERVICE_KEY;
  console.log("sb_fetch: key present=", !!key, "first10=", key ? key.slice(0, 10) : "null", "env keys=", Object.keys(env || {}).join(","));
  if (!key) throw new Error("SUPABASE_SERVICE_KEY not set in Worker secrets");
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method: opts.method || "GET",
    headers: {
      apikey:        key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer:        opts.prefer || "return=minimal",
      ...(opts.headers || {})
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Supabase ${res.status}: ${err.message || res.statusText}`);
  }
  if (opts.method === "DELETE" || (opts.prefer || "return=minimal") === "return=minimal") return null;
  return res.json();
}

/* ══════════════════════════════════════════════════════════
   Email templates (unchanged)
══════════════════════════════════════════════════════════ */
function baseEmail(content) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#F5EFE6;font-family:Georgia,serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F5EFE6;padding:40px 20px">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#FFFEF9;border-radius:8px;overflow:hidden;box-shadow:0 4px 24px rgba(44,20,36,.12)">
<tr><td style="background:#4A1424;padding:28px 32px;text-align:center">
  <div style="font-size:2rem;margin-bottom:8px">\u{1F377}</div>
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
__name(baseEmail, "baseEmail");

function btn(url, label) {
  return `<table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0">
<tr><td align="center">
<a href="${url}" style="display:inline-block;background:#6B2737;color:#FFFEF9;text-decoration:none;padding:13px 32px;border-radius:4px;font-family:Georgia,serif;font-size:.95rem;font-weight:600;letter-spacing:.04em">${label}</a>
</td></tr></table>
<p style="font-family:Georgia,serif;font-size:.78rem;color:#6B5D58;font-style:italic;margin:0">Or copy: <span style="color:#6B2737;word-break:break-all">${url}</span></p>`;
}
__name(btn, "btn");

var templates = {
  magic_link: /* @__PURE__ */ __name((url) => ({
    subject: `Sign in to ${APP_NAME}`,
    html: baseEmail(`
      <p style="font-family:Georgia,serif;font-size:1rem;color:#2C2420;line-height:1.6;margin:0 0 8px">Your sign-in link \u2014 expires in 1 hour, single use.</p>
      ${btn(url, "Sign In to My Journal")}`)
  }), "magic_link"),
  reset_password: /* @__PURE__ */ __name((url) => ({
    subject: `Reset your ${APP_NAME} password`,
    html: baseEmail(`
      <p style="font-family:Georgia,serif;font-size:1rem;color:#2C2420;line-height:1.6;margin:0 0 8px">Reset your password \u2014 link expires in 1 hour.</p>
      ${btn(url, "Reset My Password")}`)
  }), "reset_password"),
  welcome: /* @__PURE__ */ __name(() => ({
    subject: `Welcome to ${APP_NAME} \u{1F377}`,
    html: baseEmail(`
      <p style="font-family:Georgia,serif;font-size:1rem;color:#2C2420;line-height:1.6;margin:0 0 12px">Welcome to ${APP_NAME} \u2014 your personal wine journal.</p>
      <p style="font-family:Georgia,serif;font-size:.92rem;color:#6B5D58;line-height:1.7;margin:0 0 24px">Scan labels, track tastings, build your collection. Every bottle tells a story.</p>
      ${btn(APP_URL, "Open My Journal")}`)
  }), "welcome")
};

async function sendEmail(env, { to, subject, html }) {
  const key = env?.RESEND_API_KEY || RESEND_API_KEY;
  if (!key || key === "PASTE_YOUR_RESEND_KEY_HERE") throw new Error("RESEND_KEY_NOT_SET");
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ from: EMAIL_FROM, to, subject, html })
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e?.message || `Resend ${r.status}`);
  }
  return r.json();
}
__name(sendEmail, "sendEmail");

/* ══════════════════════════════════════════════════════════
   Main fetch handler
══════════════════════════════════════════════════════════ */
var worker_default = {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin":  "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Content-Type":                 "application/json"
    };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);

    // ── /geocode ───────────────────────────────────────────────
    if (url.pathname.endsWith("/geocode")) {
      const lat = url.searchParams.get("lat"), lon = url.searchParams.get("lon");
      if (!lat || !lon) return new Response(JSON.stringify({ error: "lat and lon required" }), { status: 400, headers: cors });
      try {
        const r = await fetch(
          `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&accept-language=en`,
          { headers: { "User-Agent": "WeldsWineWisdoms/1.0", "Accept-Language": "en" } }
        );
        const d = await r.json();
        const a = d.address || {};
        const place = a.neighbourhood || a.suburb || a.village || a.town || a.city_district || a.city || a.county || a.state || "";
        const label = [place, a.country].filter(Boolean).join(", ") || (d.display_name ? d.display_name.split(",").slice(-3).map(s => s.trim()).join(", ") : "");
        return new Response(JSON.stringify({ label }), { status: 200, headers: cors });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: cors });
      }
    }

    // ── /email ─────────────────────────────────────────────────
    if (url.pathname.endsWith("/email")) {
      if (request.method !== "POST") return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers: cors });
      const origin = request.headers.get("Origin") || "";
      const allowedOrigins = [
        "https://weldswine.co.uk",
        "https://www.weldswine.co.uk",
        "https://james-weld.github.io",
        "http://localhost",
        "http://127.0.0.1"
      ];
      if (!allowedOrigins.some(o => origin.startsWith(o)) && origin !== "") {
        return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: cors });
      }
      let body2;
      try { body2 = await request.json(); }
      catch { return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: cors }); }
      const { type, email, url: linkUrl } = body2;
      if (!type || !email) return new Response(JSON.stringify({ error: "type and email required" }), { status: 400, headers: cors });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return new Response(JSON.stringify({ error: "Invalid email" }), { status: 400, headers: cors });
      if (!templates[type]) return new Response(JSON.stringify({ error: `Unknown type: ${type}` }), { status: 400, headers: cors });
      if ((type === "magic_link" || type === "reset_password") && !linkUrl) return new Response(JSON.stringify({ error: "url required" }), { status: 400, headers: cors });
      try {
        const { subject, html } = templates[type](linkUrl);
        await sendEmail(env, { to: email, subject, html });
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: cors });
      } catch (e) {
        const msg = e.message || "";
        if (msg === "RESEND_KEY_NOT_SET") return new Response(JSON.stringify({ error: "Email service not configured" }), { status: 500, headers: cors });
        return new Response(JSON.stringify({ error: msg }), { status: 502, headers: cors });
      }
    }

    // ── /notify-wine-added ─────────────────────────
    if (url.pathname.endsWith("/notify-wine-added")) {
      if (request.method !== "POST") return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers: cors });

      const origin = request.headers.get("Origin") || "";
      const allowedOrigins = [
        "https://weldswine.co.uk",
        "https://www.weldswine.co.uk",
        "https://james-weld.github.io",
        "http://localhost",
        "http://127.0.0.1"
      ];
      if (!allowedOrigins.some(o => origin.startsWith(o)) && origin !== "") {
        return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: cors });
      }

      let body3;
      try { body3 = await request.json(); }
      catch { return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: cors }); }

      const { cellar_id, exclude_endpoint, wine_name, winery, added_by_name } = body3;

      if (!cellar_id) {
        return new Response(JSON.stringify({ error: "cellar_id required" }), { status: 400, headers: cors });
      }

      try {
        // Fetch subscriptions server-side using service role key (bypasses RLS)
        const [subRows, memberRows] = await Promise.all([
          sb_fetch(env, "/push_subscriptions?cellar_id=eq." + cellar_id + "&select=subscription", { prefer: "return=representation" }),
          sb_fetch(env, "/cellar_members?cellar_id=eq."      + cellar_id + "&select=user_id",      { prefer: "return=representation" })
        ]);

        // Also catch subs saved with cellar_id=null whose user is still a cellar member
        const memberIds = (memberRows || []).map(r => r.user_id);
        let nullCellarRows = [];
        if (memberIds.length) {
          nullCellarRows = await sb_fetch(env,
            "/push_subscriptions?cellar_id=is.null&user_id=in.(" + memberIds.join(",") + ")&select=subscription",
            { prefer: "return=representation" }
          ) || [];
        }

        // Dedupe by endpoint, exclude the sending device
        const seen = new Set();
        const subscriptions = [];
        for (const row of [...(subRows || []), ...nullCellarRows]) {
          const s = row.subscription;
          if (!s || !s.endpoint || seen.has(s.endpoint)) continue;
          if (exclude_endpoint && s.endpoint === exclude_endpoint) continue;
          seen.add(s.endpoint);
          subscriptions.push(s);
        }

        if (!subscriptions.length) {
          return new Response(JSON.stringify({ ok: true, sent: 0, total: 0 }), { status: 200, headers: cors });
        }

        const title    = "🍷 New wine in the cellar";
        const wineLine = [winery, wine_name].filter(Boolean).join(" · ") || "A new wine";
        const bodyText = added_by_name ? (added_by_name + " added " + wineLine) : wineLine;
        const payload  = JSON.stringify({ title, body: bodyText, url: APP_URL + "/" });

        let sent = 0;
        for (const sub of subscriptions) {
          const result = await send_push(env, sub, payload);
          if (result.expired) {
            console.warn("push subscription expired:", sub.endpoint.slice(-20));
            await sb_fetch(env, "/push_subscriptions?endpoint=eq." + encodeURIComponent(sub.endpoint), { method: "DELETE" }).catch(() => {});
          } else if (result.status >= 200 && result.status < 300) {
            sent++;
          } else {
            console.warn("push send failed: status", result.status);
          }
        }
        return new Response(JSON.stringify({ ok: true, sent, total: subscriptions.length }), { status: 200, headers: cors });
      } catch (e) {
        console.error("notify-wine-added error:", e.message);
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
      }
    }

    // ── /scan (Anthropic label scanning — default route) ───────
    if (request.method !== "POST") return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers: cors });

    const anthropicKey = env?.ANTHROPIC_API_KEY || ANTHROPIC_API_KEY;
    if (!anthropicKey || anthropicKey === "PASTE_YOUR_ANTHROPIC_KEY_HERE") return new Response(JSON.stringify({ error: "NO_KEY_IN_WORKER" }), { status: 500, headers: cors });

    let body;
    try { body = await request.json(); }
    catch { return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: cors }); }

    const { imageBase64, backImageBase64 = null, mimeType = "image/jpeg" } = body;
    if (!imageBase64) return new Response(JSON.stringify({ error: "imageBase64 required" }), { status: 400, headers: cors });

    const imageBlocks = [{ type: "image", source: { type: "base64", media_type: mimeType, data: imageBase64 } }];
    if (backImageBase64) imageBlocks.push({ type: "image", source: { type: "base64", media_type: mimeType, data: backImageBase64 } });

    const PROMPT = `Return ONLY a valid JSON object \u2014 no markdown, no explanation, nothing else.
Rules:
- Only include information clearly visible on the label \u2014 never guess
- "name" is the wine cuv\xE9e name (NOT the winery/producer)
- "winery" is the producer, domaine, ch\xE2teau or bodega
- "vintage" must be a 4-digit integer or null
- "style" must be exactly: "Red","White","Ros\xE9","Sparkling","Dessert","Fortified" or null
- "confidence" is your overall extraction confidence: "high","medium","low"
Return exactly:
{"name":null,"winery":null,"vintage":null,"country":null,"region":null,"appellation":null,"grape":null,"style":null,"classification":null,"alcohol":null,"vineyard":null,"confidence":null}`;

    let anthropicResp;
    try {
      anthropicResp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": anthropicKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 800, messages: [{ role: "user", content: [...imageBlocks, { type: "text", text: (backImageBase64 ? "First image = FRONT, second = BACK. Use both.\n\n" : "Examine carefully.\n\n") + PROMPT }] }] })
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: "Failed to reach Anthropic: " + e.message }), { status: 502, headers: cors });
    }

    if (!anthropicResp.ok) {
      const errBody = await anthropicResp.json().catch(() => ({}));
      const status  = anthropicResp.status;
      if (status === 401) return new Response(JSON.stringify({ error: "INVALID_KEY" }), { status: 401, headers: cors });
      if (status === 429) return new Response(JSON.stringify({ error: "RATE_LIMIT" }), { status: 429, headers: cors });
      return new Response(JSON.stringify({ error: errBody?.error?.message || `Anthropic error ${status}` }), { status, headers: cors });
    }

    const data    = await anthropicResp.json();
    const rawText = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    const cleaned = rawText.replace(/```json\s*/gi, "").replace(/```\s*/gi, "").trim();
    const match   = cleaned.match(/\{[\s\S]*\}/);
    let parsed;
    try {
      parsed = JSON.parse(match ? match[0] : cleaned);
    } catch {
      return new Response(JSON.stringify({ error: "PARSE_ERROR", raw: rawText }), { status: 422, headers: cors });
    }
    return new Response(JSON.stringify(parsed), { status: 200, headers: cors });
  }
};
export { worker_default as default };