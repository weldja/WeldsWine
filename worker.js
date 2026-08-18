var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var __defProp2 = Object.defineProperty;
var __name2 = /* @__PURE__ */ __name((target, value) => __defProp2(target, "name", { value, configurable: true }), "__name");
var ANTHROPIC_API_KEY = "";
var RESEND_API_KEY = "";
var EMAIL_FROM = "Welds Wine Wisdoms <hello@weldswine.co.uk>";
var APP_NAME = "Welds Wine Wisdoms";
var APP_URL = "https://weldswine.co.uk";
var SUPABASE_URL = "https://phcnswuwrqarikzjvfqd.supabase.co";
var VAPID_SUBJECT = "mailto:james_weld@yahoo.com";
function b64u_decode(str) {
  const pad = "=".repeat((4 - str.length % 4) % 4);
  const b64 = (str + pad).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
__name(b64u_decode, "b64u_decode");
function b64u_encode(buf) {
  let str = "";
  new Uint8Array(buf).forEach((b) => str += String.fromCharCode(b));
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
__name(b64u_encode, "b64u_encode");
function concat_bufs(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}
__name(concat_bufs, "concat_bufs");
async function vapid_jwt(env, endpoint) {
  const pub = env.VAPID_PUBLIC_KEY;
  const priv = env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) throw new Error("VAPID keys not configured in Worker secrets");
  const { origin } = new URL(endpoint);
  const header = b64u_encode(new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = b64u_encode(new TextEncoder().encode(JSON.stringify({
    aud: origin,
    exp: Math.floor(Date.now() / 1e3) + 43200,
    // 12 hours
    sub: VAPID_SUBJECT
  })));
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
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, sigKey, sigData);
  return `${header}.${payload}.${b64u_encode(sig)}`;
}
__name(vapid_jwt, "vapid_jwt");
async function encrypt_push(subscription, body) {
  const enc = new TextEncoder();
  const p256dh = b64u_decode(subscription.keys.p256dh);
  const auth = b64u_decode(subscription.keys.auth);
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const uaPub = await crypto.subtle.importKey(
    "raw",
    p256dh,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
  const secret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaPub }, eph.privateKey, 256)
  );
  const ephPub = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const keyInfo = concat_bufs(enc.encode("WebPush: info\0"), p256dh, ephPub);
  const secretKey = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]);
  const ikm = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: auth, info: keyInfo },
    secretKey,
    256
  ));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const ikmKey = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const cek = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: enc.encode("Content-Encoding: aes128gcm\0") },
    ikmKey,
    128
  ));
  const nonce = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: enc.encode("Content-Encoding: nonce\0") },
    ikmKey,
    96
  ));
  const cekKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const plaintext = concat_bufs(enc.encode(typeof body === "string" ? body : JSON.stringify(body)), new Uint8Array([2]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, cekKey, plaintext));
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096, false);
  return concat_bufs(salt, rs, new Uint8Array([ephPub.length]), ephPub, ciphertext);
}
__name(encrypt_push, "encrypt_push");
async function send_push(env, subscription, payload) {
  const endpoint = subscription.endpoint;
  let jwt, body;
  try {
    jwt = await vapid_jwt(env, endpoint);
    body = await encrypt_push(subscription, payload);
  } catch (e) {
    console.error("push crypto failed:", e.message);
    return { status: 500, expired: false };
  }
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `vapid t=${jwt},k=${env.VAPID_PUBLIC_KEY}`,
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      TTL: "86400"
    },
    body
  });
  return { status: res.status, expired: res.status === 410 || res.status === 404 };
}
__name(send_push, "send_push");
function origin_ok(request) {
  const origin = request.headers.get("Origin") || "";
  const allowedOrigins = [
    "https://weldswine.co.uk",
    "https://www.weldswine.co.uk",
    "https://james-weld.github.io",
    "http://localhost",
    "http://127.0.0.1"
  ];
  return allowedOrigins.some((o) => origin.startsWith(o)) || origin === "";
}
__name(origin_ok, "origin_ok");
async function gather_subs(env, cellar_id, exclude_endpoint) {
  const [subRows, memberRows] = await Promise.all([
    sb_fetch(env, "/push_subscriptions?cellar_id=eq." + cellar_id + "&select=subscription", { prefer: "return=representation" }),
    sb_fetch(env, "/cellar_members?cellar_id=eq." + cellar_id + "&select=user_id", { prefer: "return=representation" })
  ]);
  const memberIds = (memberRows || []).map((r) => r.user_id);
  let nullCellarRows = [];
  if (memberIds.length) {
    nullCellarRows = await sb_fetch(
      env,
      "/push_subscriptions?cellar_id=is.null&user_id=in.(" + memberIds.join(",") + ")&select=subscription",
      { prefer: "return=representation" }
    ) || [];
  }
  const seen = /* @__PURE__ */ new Set();
  const subscriptions = [];
  for (const row of [...subRows || [], ...nullCellarRows]) {
    const s = row.subscription;
    if (!s || !s.endpoint || seen.has(s.endpoint)) continue;
    if (exclude_endpoint && s.endpoint === exclude_endpoint) continue;
    seen.add(s.endpoint);
    subscriptions.push(s);
  }
  return subscriptions;
}
__name(gather_subs, "gather_subs");
async function dispatch_pushes(env, subscriptions, payload) {
  let sent = 0;
  for (const sub of subscriptions) {
    const result = await send_push(env, sub, payload);
    if (result.expired) {
      console.warn("push subscription expired:", sub.endpoint.slice(-20));
      await sb_fetch(env, "/push_subscriptions?endpoint=eq." + encodeURIComponent(sub.endpoint), { method: "DELETE" }).catch(() => {
      });
    } else if (result.status >= 200 && result.status < 300) {
      sent++;
    } else {
      console.warn("push send failed: status", result.status);
    }
  }
  return sent;
}
__name(dispatch_pushes, "dispatch_pushes");
function comment_notification({ wine_id, wine_name, winery, grape, style, rating, comment_body, author_name }) {
  const wineLine = [winery, wine_name].filter(Boolean).join(" \xB7 ") || "a wine";
  const author = author_name || "Someone";
  const isSB = /sauvignon\s*blanc/i.test([grape, style, wine_name].filter(Boolean).join(" "));
  const isIncident = /^\u2623/.test(comment_body || "");
  let title;
  if (isIncident || isSB) {
    title = "\u2623\uFE0F Incident report on the Sauvignon Blanc";
  } else if (rating != null && rating >= 9) {
    title = "\u{1F525} Verdict in on a landmark wine";
  } else if (rating != null && rating > 0 && rating <= 3) {
    title = "\u{1F5E3} Someone's defending the undrinkable";
  } else {
    const pool = [
      "\u{1F4AC} Cellar chatter",
      "\u{1F5E3} " + author + " has opinions",
      "\u{1F377} Tasting notes incoming",
      "\u{1F4DC} A verdict has been filed"
    ];
    title = pool[Math.floor(Math.random() * pool.length)];
  }
  const quote = (comment_body || "").slice(0, 120);
  const body = quote ? author + " on " + wineLine + ": \u201C" + quote + "\u201D" : author + " commented on " + wineLine;
  return { title, body };
}
__name(comment_notification, "comment_notification");
async function sb_fetch(env, path, opts = {}) {
  const key = env.SUPABASE_SERVICE_KEY;
  console.log("sb_fetch: key present=", !!key, "first10=", key ? key.slice(0, 10) : "null", "env keys=", Object.keys(env || {}).join(","));
  if (!key) throw new Error("SUPABASE_SERVICE_KEY not set in Worker secrets");
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method: opts.method || "GET",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: opts.prefer || "return=minimal",
      ...opts.headers || {}
    },
    body: opts.body ? JSON.stringify(opts.body) : void 0
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Supabase ${res.status}: ${err.message || res.statusText}`);
  }
  if (opts.method === "DELETE" || (opts.prefer || "return=minimal") === "return=minimal") return null;
  return res.json();
}
__name(sb_fetch, "sb_fetch");
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
__name2(baseEmail, "baseEmail");
function btn(url, label) {
  return `<table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0">
<tr><td align="center">
<a href="${url}" style="display:inline-block;background:#6B2737;color:#FFFEF9;text-decoration:none;padding:13px 32px;border-radius:4px;font-family:Georgia,serif;font-size:.95rem;font-weight:600;letter-spacing:.04em">${label}</a>
</td></tr></table>
<p style="font-family:Georgia,serif;font-size:.78rem;color:#6B5D58;font-style:italic;margin:0">Or copy: <span style="color:#6B2737;word-break:break-all">${url}</span></p>`;
}
__name(btn, "btn");
__name2(btn, "btn");
var templates = {
  magic_link: /* @__PURE__ */ __name2((url) => ({
    subject: `Sign in to ${APP_NAME}`,
    html: baseEmail(`
      <p style="font-family:Georgia,serif;font-size:1rem;color:#2C2420;line-height:1.6;margin:0 0 8px">Your sign-in link \u2014 expires in 1 hour, single use.</p>
      ${btn(url, "Sign In to My Journal")}`)
  }), "magic_link"),
  reset_password: /* @__PURE__ */ __name2((url) => ({
    subject: `Reset your ${APP_NAME} password`,
    html: baseEmail(`
      <p style="font-family:Georgia,serif;font-size:1rem;color:#2C2420;line-height:1.6;margin:0 0 8px">Reset your password \u2014 link expires in 1 hour.</p>
      ${btn(url, "Reset My Password")}`)
  }), "reset_password"),
  welcome: /* @__PURE__ */ __name2(() => ({
    subject: `Welcome to ${APP_NAME} \u{1F377}`,
    html: baseEmail(`
      <p style="font-family:Georgia,serif;font-size:1rem;color:#2C2420;line-height:1.6;margin:0 0 12px">Welcome to ${APP_NAME} \u2014 your personal wine journal.</p>
      <p style="font-family:Georgia,serif;font-size:.92rem;color:#6B5D58;line-height:1.7;margin:0 0 24px">Scan labels, track tastings, build your collection. Every bottle tells a story.</p>
      ${btn(APP_URL, "Open My Journal")}`)
  }), "welcome"),
  invite: /* @__PURE__ */ __name2((url, name) => ({
    subject: `You're invited to ${APP_NAME} \u{1F377}`,
    html: baseEmail(`
      <p style="font-family:Georgia,serif;font-size:1rem;color:#2C2420;line-height:1.6;margin:0 0 12px">${name ? "Hi " + name + "! You've" : "You've"} been invited to join ${APP_NAME}.</p>
      <p style="font-family:Georgia,serif;font-size:.92rem;color:#6B5D58;line-height:1.7;margin:0 0 24px">Click below to set your password and start tracking wines with friends.</p>
      ${btn(url, "Set Up My Account")}`)
  }), "invite"),
  access_request_notify: /* @__PURE__ */ __name2((name, email, message) => ({
    subject: `\u{1F514} New access request: ${name}`,
    html: baseEmail(`
      <p style="font-family:Georgia,serif;font-size:1rem;color:#2C2420;line-height:1.6;margin:0 0 12px"><strong>${name}</strong> has requested access to ${APP_NAME}.</p>
      <p style="font-family:Georgia,serif;font-size:.92rem;color:#6B5D58;line-height:1.7;margin:0 0 8px"><strong>Email:</strong> ${email}</p>
      ${message ? `<p style="font-family:Georgia,serif;font-size:.92rem;color:#6B5D58;line-height:1.7;margin:0 0 24px;padding:12px;background:#F5EFE6;border-radius:6px;font-style:italic">\u201C${message}\u201D</p>` : ""}
      ${btn(APP_URL, "Open Admin Panel")}`)
  }), "access_request_notify")
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
__name2(sendEmail, "sendEmail");
/* ═══════════════════════════════════════════════════════════════
   ADMIN HELPERS
   ═══════════════════════════════════════════════════════════════ */
async function verifyAdmin(env, request) {
  const authHeader = request.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) { console.log("verifyAdmin: no token"); return { user: null, reason: "no_token" }; }
  const key = env.SUPABASE_SERVICE_KEY;
  if (!key) { console.log("verifyAdmin: no service key"); return { user: null, reason: "no_service_key" }; }
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: key, Authorization: `Bearer ${token}` }
    });
    if (!res.ok) {
      console.log("verifyAdmin: auth/user failed status=" + res.status);
      return { user: null, reason: "token_invalid_" + res.status };
    }
    const user = await res.json();
    if (!user || !user.id) { console.log("verifyAdmin: no user in response"); return { user: null, reason: "no_user" }; }
    console.log("verifyAdmin: user=" + user.id + " email=" + user.email);
    // Check is_admin flag in profiles
    const profileRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=is_admin`,
      { headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" } }
    );
    if (!profileRes.ok) {
      const pErr = await profileRes.text().catch(() => "");
      console.log("verifyAdmin: profile query failed status=" + profileRes.status + " body=" + pErr);
      return { user: null, reason: "profile_query_failed" };
    }
    const profiles = await profileRes.json();
    console.log("verifyAdmin: profiles=" + JSON.stringify(profiles));
    if (!profiles || !profiles.length) {
      return { user: null, reason: "no_profile_found" };
    }
    if (!profiles[0].is_admin) {
      return { user: null, reason: "not_admin" };
    }
    return { user, reason: null };
  } catch (e) {
    console.error("verifyAdmin error:", e.message);
    return { user: null, reason: "exception: " + e.message };
  }
}
__name(verifyAdmin, "verifyAdmin");

/* ═══════════════════════════════════════════════════════════════
   PUBLIC WINE PAGE RENDERERS
   ═══════════════════════════════════════════════════════════════ */
function esc(s) { return (s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
__name(esc, "esc");

function wine_meta_desc(w) {
  const parts = [w.winery, w.name, w.vintage].filter(Boolean).join(" ");
  const extra = [w.grape, w.region, w.country].filter(Boolean).join(", ");
  const r = w.rating != null ? ` Rated ${w.rating}/10.` : "";
  return esc((parts + (extra ? " — " + extra : "") + "." + r).slice(0, 160));
}
__name(wine_meta_desc, "wine_meta_desc");

function wine_title(w) {
  return esc([w.winery, w.name, w.vintage].filter(Boolean).join(" · ") || "Wine");
}
__name(wine_title, "wine_title");

function style_colour(style) {
  const m = { Red: "#8B2439", White: "#C9A34A", "Rosé": "#D4849A", Sparkling: "#B8A44C", Dessert: "#D4A574", Fortified: "#6B3A2A" };
  return m[style] || "#8B2439";
}
__name(style_colour, "style_colour");

function render_wine_page(w) {
  const title = wine_title(w);
  const desc = wine_meta_desc(w);
  const pageUrl = APP_URL + "/wine/" + encodeURIComponent(w.id);
  const accent = style_colour(w.style);
  const photoHtml = (w.photo_front || w.photo_back) ? `<div class="photos">${w.photo_front ? `<img src="${esc(w.photo_front)}" alt="${esc((w.winery||"")+" "+(w.name||""))} front label" loading="lazy"/>` : ""}${w.photo_back ? `<img src="${esc(w.photo_back)}" alt="${esc((w.winery||"")+" "+(w.name||""))} back label" loading="lazy"/>` : ""}</div>` : "";
  const details = [
    w.grape   ? ["Grape", w.grape] : null,
    w.region  ? ["Region", w.region] : null,
    w.country ? ["Country", w.country] : null,
    w.vintage ? ["Vintage", w.vintage] : null,
    w.style   ? ["Style", w.style] : null
  ].filter(Boolean).map(([l,v]) => `<div class="detail"><span class="detail-label">${esc(l)}</span><span class="detail-value">${esc(String(v))}</span></div>`).join("");
  const ratingHtml = w.rating != null ? `<div class="rating"><span class="rating-num">${w.rating}</span><span class="rating-of">/10</span></div>` : "";
  const notesHtml = w.notes ? `<div class="notes"><h2>Tasting Notes</h2><p>${esc(w.notes)}</p></div>` : "";
  const schema = JSON.stringify({
    "@context": "https://schema.org", "@type": "Product", "name": [w.winery, w.name].filter(Boolean).join(" "),
    "description": desc.replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"'),
    "brand": w.winery ? { "@type": "Brand", "name": w.winery } : undefined,
    "image": w.photo_front || undefined, "url": pageUrl,
    ...(w.rating != null ? { "review": { "@type": "Review", "reviewRating": { "@type": "Rating", "ratingValue": w.rating, "bestRating": 10 }, "author": { "@type": "Organization", "name": "Welds Wine Wisdoms" } } } : {})
  });

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title} — Welds Wine Wisdoms</title>
<meta name="description" content="${desc}"/>
<meta name="robots" content="index, follow"/>
<link rel="canonical" href="${esc(pageUrl)}"/>
<meta property="og:type" content="article"/><meta property="og:site_name" content="Welds Wine Wisdoms"/>
<meta property="og:title" content="${title}"/><meta property="og:description" content="${desc}"/>
<meta property="og:url" content="${esc(pageUrl)}"/><meta property="og:locale" content="en_GB"/>
${w.photo_front ? `<meta property="og:image" content="${esc(w.photo_front)}"/>` : `<meta property="og:image" content="${APP_URL}/og-image.png"/>`}
<meta name="twitter:card" content="summary_large_image"/><meta name="twitter:title" content="${title}"/>
<meta name="twitter:description" content="${desc}"/>
${w.photo_front ? `<meta name="twitter:image" content="${esc(w.photo_front)}"/>` : ""}
<script type="application/ld+json">${schema}</script>
<link rel="icon" href="/favicon.ico" sizes="32x32"/>
<link href="https://fonts.googleapis.com/css2?family=Lora:wght@500;600&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#F9F5F0;color:#2C2420;font-family:Inter,system-ui,sans-serif;min-height:100vh}
.topbar{background:#2C0A16;padding:14px 20px;display:flex;align-items:center;justify-content:space-between}
.topbar a{color:#F5EDE2;text-decoration:none;font-family:Lora,Georgia,serif;font-size:1rem;font-weight:600;letter-spacing:.03em}
.topbar-cta{background:#C9A34A;color:#2C0A16;padding:7px 16px;border-radius:6px;font-size:.8rem;font-weight:600;text-decoration:none;font-family:Inter,sans-serif}
.accent{height:4px;background:${accent}}
.container{max-width:640px;margin:0 auto;padding:24px 20px 60px}
.photos{display:flex;gap:12px;margin-bottom:24px;overflow-x:auto;scroll-snap-type:x mandatory}
.photos img{width:100%;max-width:300px;border-radius:10px;object-fit:cover;scroll-snap-align:start;max-height:400px;border:1px solid rgba(0,0,0,.08)}
.wine-header{margin-bottom:20px}
.wine-winery{font-family:Inter,sans-serif;font-size:.78rem;letter-spacing:.1em;text-transform:uppercase;color:#C9A34A;margin-bottom:4px;font-weight:600}
.wine-name{font-family:Lora,Georgia,serif;font-size:1.6rem;font-weight:600;color:#2C0A16;line-height:1.25}
.wine-vintage{font-family:Lora,Georgia,serif;font-size:1.1rem;color:#8B7355;margin-left:6px;font-weight:500}
.rating{display:inline-flex;align-items:baseline;gap:2px;background:#2C0A16;color:#F5EDE2;padding:8px 16px;border-radius:8px;margin:12px 0 20px}
.rating-num{font-family:Lora,Georgia,serif;font-size:1.6rem;font-weight:600}
.rating-of{font-family:Inter,sans-serif;font-size:.8rem;color:#C9A34A}
.details{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:24px}
.detail{background:#fff;border-radius:8px;padding:12px 14px;border:1px solid rgba(0,0,0,.06)}
.detail-label{display:block;font-size:.68rem;letter-spacing:.1em;text-transform:uppercase;color:#8B7355;margin-bottom:3px;font-weight:600}
.detail-value{font-size:.92rem;font-weight:500;color:#2C0A16}
.notes{margin-top:24px;padding-top:20px;border-top:1px solid rgba(0,0,0,.08)}
.notes h2{font-family:Lora,Georgia,serif;font-size:1rem;font-weight:600;color:#2C0A16;margin-bottom:8px}
.notes p{font-size:.92rem;line-height:1.7;color:#5A4E44}
.cta-box{margin-top:32px;background:#2C0A16;border-radius:12px;padding:24px;text-align:center}
.cta-box p{color:#F5EDE2;font-family:Lora,Georgia,serif;font-size:1rem;margin-bottom:14px}
.cta-btn{display:inline-block;background:#C9A34A;color:#2C0A16;padding:12px 28px;border-radius:8px;font-weight:600;text-decoration:none;font-size:.92rem}
.footer{text-align:center;margin-top:40px;font-size:.75rem;color:#8B7355}
.footer a{color:#8B2439;text-decoration:none}
.back{display:inline-flex;align-items:center;gap:4px;color:#8B2439;text-decoration:none;font-size:.85rem;margin-bottom:16px;font-weight:500}
@media(max-width:480px){.photos img{max-width:85vw}.wine-name{font-size:1.3rem}}
</style></head><body>
<div class="topbar"><a href="${APP_URL}">🍷 Welds Wine Wisdoms</a><a class="topbar-cta" href="${APP_URL}">Open App</a></div>
<div class="accent"></div>
<div class="container">
<a class="back" href="${APP_URL}/wines">← All wines</a>
<div class="wine-header">
${w.winery ? `<div class="wine-winery">${esc(w.winery)}</div>` : ""}
<span class="wine-name">${esc(w.name || "Unnamed Wine")}</span>${w.vintage ? `<span class="wine-vintage">${esc(String(w.vintage))}</span>` : ""}
</div>
${ratingHtml}
${photoHtml}
<div class="details">${details}</div>
${notesHtml}
<div class="cta-box">
<p>Scan wine labels with AI and build your personal wine journal</p>
<a class="cta-btn" href="${APP_URL}">Try Welds Wine Wisdoms — Free</a>
</div>
<div class="footer"><a href="${APP_URL}">weldswine.co.uk</a> · Free AI-powered wine journal</div>
</div></body></html>`;
}
__name(render_wine_page, "render_wine_page");

function render_wine_list(wines) {
  const cards = wines.map(w => {
    const accent = style_colour(w.style);
    const rating = w.rating != null ? `<span class="card-rating">${w.rating}</span>` : "";
    const sub = [w.grape, w.region, w.vintage].filter(Boolean).join(" · ");
    const photo = w.photo_front ? `<img src="${esc(w.photo_front)}" alt="${esc((w.winery||"")+" "+(w.name||""))}" loading="lazy"/>` : `<div class="card-nophoto" style="background:${accent}20;color:${accent}">🍷</div>`;
    return `<a class="card" href="${APP_URL}/wine/${encodeURIComponent(w.id)}">
<div class="card-photo">${photo}</div>
<div class="card-body"><div class="card-accent" style="background:${accent}"></div>
<div class="card-winery">${esc(w.winery || "")}</div>
<div class="card-name">${esc(w.name || "Unnamed")}</div>
<div class="card-sub">${esc(sub)}</div>
${rating}</div></a>`;
  }).join("");

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Wine Collection — Welds Wine Wisdoms</title>
<meta name="description" content="Browse ${wines.length} wines in our collection. Scan wine labels with AI, rate bottles, and build your personal wine journal. Free wine app."/>
<meta name="robots" content="index, follow"/>
<link rel="canonical" href="${APP_URL}/wines"/>
<meta property="og:type" content="website"/><meta property="og:site_name" content="Welds Wine Wisdoms"/>
<meta property="og:title" content="Wine Collection — Welds Wine Wisdoms"/>
<meta property="og:url" content="${APP_URL}/wines"/>
<meta property="og:image" content="${APP_URL}/og-image.png"/>
<meta name="twitter:card" content="summary_large_image"/>
<link rel="icon" href="/favicon.ico" sizes="32x32"/>
<link href="https://fonts.googleapis.com/css2?family=Lora:wght@500;600&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#F9F5F0;color:#2C2420;font-family:Inter,system-ui,sans-serif;min-height:100vh}
.topbar{background:#2C0A16;padding:14px 20px;display:flex;align-items:center;justify-content:space-between}
.topbar a{color:#F5EDE2;text-decoration:none;font-family:Lora,Georgia,serif;font-size:1rem;font-weight:600;letter-spacing:.03em}
.topbar-cta{background:#C9A34A;color:#2C0A16;padding:7px 16px;border-radius:6px;font-size:.8rem;font-weight:600;text-decoration:none;font-family:Inter,sans-serif}
.container{max-width:720px;margin:0 auto;padding:28px 20px 60px}
h1{font-family:Lora,Georgia,serif;font-size:1.6rem;font-weight:600;color:#2C0A16;margin-bottom:4px}
.count{font-size:.85rem;color:#8B7355;margin-bottom:24px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px}
.card{display:flex;background:#fff;border-radius:10px;overflow:hidden;text-decoration:none;color:inherit;border:1px solid rgba(0,0,0,.06);transition:box-shadow .15s}
.card:hover{box-shadow:0 4px 16px rgba(44,20,36,.1)}
.card-photo{width:80px;min-height:100px;flex-shrink:0;overflow:hidden;display:flex;align-items:center;justify-content:center;background:#f4f0eb}
.card-photo img{width:100%;height:100%;object-fit:cover}
.card-nophoto{width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:1.6rem}
.card-body{flex:1;padding:12px 14px;position:relative;padding-left:18px}
.card-accent{position:absolute;left:0;top:8px;bottom:8px;width:3px;border-radius:2px}
.card-winery{font-size:.68rem;letter-spacing:.1em;text-transform:uppercase;color:#C9A34A;font-weight:600}
.card-name{font-family:Lora,Georgia,serif;font-size:.95rem;font-weight:600;color:#2C0A16;margin:2px 0 4px;line-height:1.3}
.card-sub{font-size:.78rem;color:#8B7355;line-height:1.4}
.card-rating{display:inline-block;background:#2C0A16;color:#F5EDE2;padding:2px 8px;border-radius:4px;font-size:.75rem;font-weight:600;margin-top:6px}
.footer{text-align:center;margin-top:40px;font-size:.75rem;color:#8B7355}
.footer a{color:#8B2439;text-decoration:none}
.cta-box{margin-top:32px;background:#2C0A16;border-radius:12px;padding:24px;text-align:center}
.cta-box p{color:#F5EDE2;font-family:Lora,Georgia,serif;font-size:1rem;margin-bottom:14px}
.cta-btn{display:inline-block;background:#C9A34A;color:#2C0A16;padding:12px 28px;border-radius:8px;font-weight:600;text-decoration:none;font-size:.92rem}
@media(max-width:480px){.grid{grid-template-columns:1fr}h1{font-size:1.3rem}}
</style></head><body>
<div class="topbar"><a href="${APP_URL}">🍷 Welds Wine Wisdoms</a><a class="topbar-cta" href="${APP_URL}">Open App</a></div>
<div class="container">
<h1>Wine Collection</h1>
<p class="count">${wines.length} wine${wines.length===1?"":"s"} in our cellar</p>
<div class="grid">${cards}</div>
<div class="cta-box">
<p>Scan wine labels with AI and build your own wine journal</p>
<a class="cta-btn" href="${APP_URL}">Try Welds Wine Wisdoms — Free</a>
</div>
<div class="footer"><a href="${APP_URL}">weldswine.co.uk</a> · Free AI-powered wine journal</div>
</div></body></html>`;
}
__name(render_wine_list, "render_wine_list");

function render_sitemap(wines) {
  const today = new Date().toISOString().slice(0, 10);
  const entries = wines.map(w => {
    const lastmod = w.created_at ? w.created_at.slice(0, 10) : today;
    return `  <url><loc>${APP_URL}/wine/${encodeURIComponent(w.id)}</loc><lastmod>${lastmod}</lastmod><changefreq>monthly</changefreq><priority>0.7</priority></url>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${APP_URL}/</loc><lastmod>${today}</lastmod><changefreq>monthly</changefreq><priority>1.0</priority></url>
  <url><loc>${APP_URL}/wines</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>0.9</priority></url>
${entries}
</urlset>`;
}
__name(render_sitemap, "render_sitemap");

function render_404() {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Wine not found — Welds Wine Wisdoms</title>
<meta name="robots" content="noindex"/>
<link rel="icon" href="/favicon.ico" sizes="32x32"/>
<link href="https://fonts.googleapis.com/css2?family=Lora:wght@600&family=Inter:wght@400;500&display=swap" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#F9F5F0;font-family:Inter,system-ui,sans-serif;display:flex;flex-direction:column;min-height:100vh}
.topbar{background:#2C0A16;padding:14px 20px}.topbar a{color:#F5EDE2;text-decoration:none;font-family:Lora,Georgia,serif;font-size:1rem;font-weight:600}
.content{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 24px;text-align:center}
h1{font-family:Lora,Georgia,serif;font-size:1.8rem;color:#2C0A16;margin:16px 0 8px}
p{color:#8B7355;font-size:.95rem;margin-bottom:20px}
a.btn{background:#8B2439;color:#F5EDE2;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:.9rem}</style>
</head><body><div class="topbar"><a href="${APP_URL}">🍷 Welds Wine Wisdoms</a></div>
<div class="content"><div style="font-size:3rem">🍷</div><h1>Wine not found</h1><p>This bottle may have been drunk or removed from the cellar.</p>
<a class="btn" href="${APP_URL}/wines">Browse all wines</a></div></body></html>`;
}
__name(render_404, "render_404");
/* ═══════════════════════════════════════════════════════════════ */

var worker_default = {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "POST, GET, DELETE, PATCH, OPTIONS",
      "Content-Type": "application/json"
    };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);

    /* ═══════════════════════════════════════════════════════════
       PUBLIC WINE PAGES (SEO)
       Remove or comment out this block to disable public pages.
       ═══════════════════════════════════════════════════════════ */
    const htmlHeaders = { "Content-Type": "text/html;charset=UTF-8", "Cache-Control": "public, max-age=3600, s-maxage=86400" };
    const CELLAR_ID = "8c1f5417-b9c7-49e3-915d-f9239cf48ff2";
    const PUBLIC_WINE_FIELDS = "id,name,winery,vintage,country,region,grape,style,rating,notes,photo_front,photo_back,created_at";

    // ── GET /robots.txt ──────────────────────────────────────
    if (url.pathname === "/robots.txt" && request.method === "GET") {
      return new Response("User-agent: *\nAllow: /\n\nSitemap: https://weldswine.co.uk/sitemap.xml\n", { headers: { "Content-Type": "text/plain", "Cache-Control": "public, max-age=86400" } });
    }

    // ── GET /wine/:id — individual wine page ───────────────
    const wineMatch = url.pathname.match(/^\/wine\/([^/]+)$/);
    if (wineMatch && request.method === "GET") {
      const wineId = decodeURIComponent(wineMatch[1]);
      try {
        const rows = await sb_fetch(env,
          "/wines?id=eq." + encodeURIComponent(wineId) + "&cellar_id=eq." + CELLAR_ID + "&select=" + PUBLIC_WINE_FIELDS,
          { prefer: "return=representation" });
        if (!rows || !rows.length) return new Response(render_404(), { status: 404, headers: htmlHeaders });
        const w = rows[0];
        return new Response(render_wine_page(w), { status: 200, headers: htmlHeaders });
      } catch (e) {
        console.error("public wine page error:", e.message);
        return new Response(render_404(), { status: 500, headers: htmlHeaders });
      }
    }

    // ── GET /wines — wine listing page ─────────────────────
    if (url.pathname === "/wines" && request.method === "GET") {
      try {
        const wines = await sb_fetch(env,
          "/wines?cellar_id=eq." + CELLAR_ID + "&select=" + PUBLIC_WINE_FIELDS + "&order=created_at.desc",
          { prefer: "return=representation" });
        return new Response(render_wine_list(wines || []), { status: 200, headers: htmlHeaders });
      } catch (e) {
        console.error("public wine list error:", e.message);
        return new Response(render_wine_list([]), { status: 200, headers: htmlHeaders });
      }
    }

    // ── GET /sitemap.xml — dynamic sitemap ─────────────────
    if (url.pathname === "/sitemap.xml" && request.method === "GET") {
      try {
        const wines = await sb_fetch(env,
          "/wines?cellar_id=eq." + CELLAR_ID + "&select=id,created_at&order=created_at.desc",
          { prefer: "return=representation" });
        return new Response(render_sitemap(wines || []), { status: 200, headers: { "Content-Type": "application/xml;charset=UTF-8", "Cache-Control": "public, max-age=3600, s-maxage=86400" } });
      } catch (e) {
        console.error("sitemap error:", e.message);
        return new Response(render_sitemap([]), { status: 200, headers: { "Content-Type": "application/xml;charset=UTF-8" } });
      }
    }
    /* ═══════════════════════════════════════════════════════════
       END PUBLIC WINE PAGES
       ═══════════════════════════════════════════════════════════ */

    /* ═══════════════════════════════════════════════════════════
       ACCESS REQUEST (public, no auth)
       ═══════════════════════════════════════════════════════════ */
    if (url.pathname.endsWith("/api/access-request") && request.method === "POST") {
      if (!origin_ok(request)) return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: cors });
      let body;
      try { body = await request.json(); } catch { return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: cors }); }
      const { name, email, message } = body || {};
      if (!name || !email) return new Response(JSON.stringify({ error: "name and email required" }), { status: 400, headers: cors });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return new Response(JSON.stringify({ error: "Invalid email" }), { status: 400, headers: cors });
      try {
        await sb_fetch(env, "/access_requests", {
          method: "POST",
          body: { name, email, message: message || null, status: "pending" },
          prefer: "return=minimal",
          headers: { Prefer: "return=minimal" }
        });
        // Notify admin via push (to all admin subscriptions)
        try {
          // Find admin user IDs
          const admins = await sb_fetch(env, "/profiles?is_admin=eq.true&select=id", { prefer: "return=representation" });
          if (admins && admins.length) {
            for (const admin of admins) {
              const adminSubs = await sb_fetch(env, "/push_subscriptions?user_id=eq." + admin.id + "&select=subscription", { prefer: "return=representation" }) || [];
              const payload = JSON.stringify({
                title: "\u{1F514} New access request",
                body: name + " (" + email + ") wants to join",
                url: APP_URL + "/?admin=requests",
                tag: "access-request"
              });
              for (const row of adminSubs) {
                if (row.subscription) await send_push(env, row.subscription, payload).catch(() => {});
              }
            }
          }
        } catch (e) { console.warn("access-request push notify failed:", e.message); }
        // Also try email notify
        try {
          const admins = await sb_fetch(env, "/profiles?is_admin=eq.true&select=id", { prefer: "return=representation" });
          if (admins && admins.length) {
            const adminUsers = [];
            for (const a of admins) {
              const uRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${a.id}`, {
                headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` }
              });
              if (uRes.ok) { const u = await uRes.json(); if (u.email) adminUsers.push(u.email); }
            }
            for (const adminEmail of adminUsers) {
              const { subject, html } = templates.access_request_notify(name, email, message);
              await sendEmail(env, { to: adminEmail, subject, html }).catch(() => {});
            }
          }
        } catch (e) { console.warn("access-request email notify failed:", e.message); }
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: cors });
      } catch (e) {
        console.error("access-request error:", e.message);
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
      }
    }

    /* ═══════════════════════════════════════════════════════════
       ADMIN API — all routes require verified admin
       ═══════════════════════════════════════════════════════════ */

    // ── GET /api/admin/requests — list pending access requests ──
    if (url.pathname.endsWith("/api/admin/requests") && request.method === "GET") {
      const { user: admin, reason: _authReason } = await verifyAdmin(env, request);
      if (!admin) return new Response(JSON.stringify({ error: "Unauthorized", reason: _authReason }), { status: 401, headers: cors });
      try {
        const rows = await sb_fetch(env, "/access_requests?status=eq.pending&order=created_at.desc&select=id,name,email,message,created_at", { prefer: "return=representation" });
        return new Response(JSON.stringify(rows || []), { status: 200, headers: cors });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
      }
    }

    // ── DELETE /api/admin/requests/:id — dismiss a request ──────
    if (url.pathname.match(/\/api\/admin\/requests\/[^/]+$/) && request.method === "DELETE") {
      const { user: admin, reason: _authReason } = await verifyAdmin(env, request);
      if (!admin) return new Response(JSON.stringify({ error: "Unauthorized", reason: _authReason }), { status: 401, headers: cors });
      const reqId = url.pathname.split("/").pop();
      try {
        await sb_fetch(env, "/access_requests?id=eq." + encodeURIComponent(reqId), {
          method: "PATCH",
          body: { status: "dismissed" },
          prefer: "return=minimal",
          headers: { Prefer: "return=minimal" }
        });
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: cors });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
      }
    }

    // ── POST /api/admin/create-user — create user + optional cellar ─
    if (url.pathname.endsWith("/api/admin/create-user") && request.method === "POST") {
      const { user: admin, reason: _authReason } = await verifyAdmin(env, request);
      if (!admin) return new Response(JSON.stringify({ error: "Unauthorized", reason: _authReason }), { status: 401, headers: cors });
      let body;
      try { body = await request.json(); } catch { return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: cors }); }
      const { email, display_name, cellar_id, dismiss_request_id } = body || {};
      if (!email) return new Response(JSON.stringify({ error: "email required" }), { status: 400, headers: cors });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return new Response(JSON.stringify({ error: "Invalid email" }), { status: 400, headers: cors });
      try {
        // Create user via Supabase Admin API (inviteUserByEmail equivalent)
        const createRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
          method: "POST",
          headers: {
            apikey: env.SUPABASE_SERVICE_KEY,
            Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            email,
            email_confirm: false,
            user_metadata: { full_name: display_name || email.split("@")[0] }
          })
        });
        if (!createRes.ok) {
          const err = await createRes.json().catch(() => ({}));
          // Check if user already exists
          if (err.msg && err.msg.includes("already been registered")) {
            return new Response(JSON.stringify({ error: "A user with that email already exists" }), { status: 409, headers: cors });
          }
          throw new Error(err.msg || err.message || `Supabase Admin ${createRes.status}`);
        }
        const newUser = await createRes.json();
        const userId = newUser.id;

        // Create profile
        await sb_fetch(env, "/profiles", {
          method: "POST",
          body: { id: userId, display_name: display_name || email.split("@")[0] },
          prefer: "return=minimal",
          headers: { Prefer: "return=minimal" }
        }).catch(e => console.warn("profile create:", e.message));

        // Assign to cellar if specified
        if (cellar_id) {
          await sb_fetch(env, "/cellar_members", {
            method: "POST",
            body: { cellar_id, user_id: userId, role: "member" },
            prefer: "return=minimal",
            headers: { Prefer: "return=minimal" }
          }).catch(e => console.warn("cellar assign:", e.message));
        }

        // Generate password reset link (acts as invite)
        const resetRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}/factors`, {
          headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` }
        }).catch(() => null);
        // Use generate_link to create an invite/magic link
        const linkRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
          method: "POST",
          headers: {
            apikey: env.SUPABASE_SERVICE_KEY,
            Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            type: "invite",
            email,
            options: { redirectTo: APP_URL + "/?type=recovery" }
          })
        });
        let inviteUrl = APP_URL;
        if (linkRes.ok) {
          const linkData = await linkRes.json();
          // The action_link is the full invite URL
          if (linkData.action_link) inviteUrl = linkData.action_link;
        } else {
          console.warn("generate_link failed:", await linkRes.text().catch(() => ""));
        }

        // Send invite email
        try {
          const { subject, html } = templates.invite(inviteUrl, display_name);
          await sendEmail(env, { to: email, subject, html });
        } catch (e) { console.warn("invite email failed:", e.message); }

        // Dismiss the access request if linked
        if (dismiss_request_id) {
          await sb_fetch(env, "/access_requests?id=eq." + encodeURIComponent(dismiss_request_id), {
            method: "PATCH",
            body: { status: "dismissed" },
            prefer: "return=minimal",
            headers: { Prefer: "return=minimal" }
          }).catch(() => {});
        }

        return new Response(JSON.stringify({ ok: true, user_id: userId }), { status: 200, headers: cors });
      } catch (e) {
        console.error("create-user error:", e.message);
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
      }
    }

    // ── GET /api/admin/cellars — list all cellars with members ──
    if (url.pathname.endsWith("/api/admin/cellars") && request.method === "GET") {
      const { user: admin, reason: _authReason } = await verifyAdmin(env, request);
      if (!admin) return new Response(JSON.stringify({ error: "Unauthorized", reason: _authReason }), { status: 401, headers: cors });
      try {
        const cellars = await sb_fetch(env, "/cellars?select=id,name,owner_id,created_at&order=created_at.asc", { prefer: "return=representation" });
        const result = [];
        for (const c of (cellars || [])) {
          const members = await sb_fetch(env, "/cellar_members?cellar_id=eq." + c.id + "&select=user_id,role", { prefer: "return=representation" }) || [];
          // Get profiles for members
          const memberDetails = [];
          for (const m of members) {
            const profile = await sb_fetch(env, "/profiles?id=eq." + m.user_id + "&select=display_name,is_admin", { prefer: "return=representation" });
            const p = profile && profile[0];
            // Get email from auth
            let email = "";
            try {
              const uRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${m.user_id}`, {
                headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` }
              });
              if (uRes.ok) { const u = await uRes.json(); email = u.email || ""; }
            } catch (_) {}
            memberDetails.push({
              user_id: m.user_id,
              role: m.role,
              display_name: p?.display_name || "Member",
              is_admin: p?.is_admin || false,
              email
            });
          }
          // Count wines
          const wineCount = await sb_fetch(env, "/wines?cellar_id=eq." + c.id + "&select=id", { prefer: "return=representation" }) || [];
          result.push({ ...c, members: memberDetails, wine_count: wineCount.length });
        }
        return new Response(JSON.stringify(result), { status: 200, headers: cors });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
      }
    }

    // ── POST /api/admin/cellars — create a new cellar ──────────
    if (url.pathname.endsWith("/api/admin/cellars") && request.method === "POST") {
      const { user: admin, reason: _authReason } = await verifyAdmin(env, request);
      if (!admin) return new Response(JSON.stringify({ error: "Unauthorized", reason: _authReason }), { status: 401, headers: cors });
      let body;
      try { body = await request.json(); } catch { return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: cors }); }
      const { name } = body || {};
      if (!name) return new Response(JSON.stringify({ error: "name required" }), { status: 400, headers: cors });
      try {
        const created = await sb_fetch(env, "/cellars", {
          method: "POST",
          body: { name, owner_id: admin.id },
          prefer: "return=representation",
          headers: { Prefer: "return=representation" }
        });
        // Add admin as owner member
        if (created && created[0]) {
          await sb_fetch(env, "/cellar_members", {
            method: "POST",
            body: { cellar_id: created[0].id, user_id: admin.id, role: "owner" },
            prefer: "return=minimal",
            headers: { Prefer: "return=minimal" }
          }).catch(() => {});
        }
        return new Response(JSON.stringify(created ? created[0] : {}), { status: 200, headers: cors });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
      }
    }

    // ── DELETE /api/admin/cellars/:id — delete a cellar ─────────
    if (url.pathname.match(/\/api\/admin\/cellars\/[^/]+$/) && request.method === "DELETE" && !url.pathname.includes("/members/")) {
      const { user: admin, reason: _authReason } = await verifyAdmin(env, request);
      if (!admin) return new Response(JSON.stringify({ error: "Unauthorized", reason: _authReason }), { status: 401, headers: cors });
      const cellarId = url.pathname.split("/").pop();
      try {
        // Remove all members first
        await sb_fetch(env, "/cellar_members?cellar_id=eq." + encodeURIComponent(cellarId), { method: "DELETE" }).catch(() => {});
        // Unlink wines (set cellar_id to null, not delete)
        const key = env.SUPABASE_SERVICE_KEY;
        await fetch(`${SUPABASE_URL}/rest/v1/wines?cellar_id=eq.${encodeURIComponent(cellarId)}`, {
          method: "PATCH",
          headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify({ cellar_id: null })
        }).catch(() => {});
        // Delete cellar
        await sb_fetch(env, "/cellars?id=eq." + encodeURIComponent(cellarId), { method: "DELETE" });
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: cors });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
      }
    }

    // ── POST /api/admin/cellars/:id/members — add member ────────
    if (url.pathname.match(/\/api\/admin\/cellars\/[^/]+\/members$/) && request.method === "POST") {
      const { user: admin, reason: _authReason } = await verifyAdmin(env, request);
      if (!admin) return new Response(JSON.stringify({ error: "Unauthorized", reason: _authReason }), { status: 401, headers: cors });
      const parts = url.pathname.split("/");
      const cellarId = parts[parts.length - 2];
      let body;
      try { body = await request.json(); } catch { return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: cors }); }
      const { user_id } = body || {};
      if (!user_id) return new Response(JSON.stringify({ error: "user_id required" }), { status: 400, headers: cors });
      try {
        // Check user isn't already in this cellar
        const existing = await sb_fetch(env, "/cellar_members?cellar_id=eq." + encodeURIComponent(cellarId) + "&user_id=eq." + encodeURIComponent(user_id) + "&select=user_id", { prefer: "return=representation" });
        if (existing && existing.length) return new Response(JSON.stringify({ error: "User is already in this cellar" }), { status: 409, headers: cors });
        // Remove from any existing cellar first (user can only be in one)
        await sb_fetch(env, "/cellar_members?user_id=eq." + encodeURIComponent(user_id), { method: "DELETE" }).catch(() => {});
        // Add to new cellar
        await sb_fetch(env, "/cellar_members", {
          method: "POST",
          body: { cellar_id: cellarId, user_id, role: "member" },
          prefer: "return=minimal",
          headers: { Prefer: "return=minimal" }
        });
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: cors });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
      }
    }

    // ── DELETE /api/admin/cellars/:cellarId/members/:userId — remove member
    if (url.pathname.match(/\/api\/admin\/cellars\/[^/]+\/members\/[^/]+$/) && request.method === "DELETE") {
      const { user: admin, reason: _authReason } = await verifyAdmin(env, request);
      if (!admin) return new Response(JSON.stringify({ error: "Unauthorized", reason: _authReason }), { status: 401, headers: cors });
      const parts = url.pathname.split("/");
      const userId = parts.pop();
      parts.pop(); // skip "members"
      const cellarId = parts.pop();
      try {
        await sb_fetch(env, "/cellar_members?cellar_id=eq." + encodeURIComponent(cellarId) + "&user_id=eq." + encodeURIComponent(userId), { method: "DELETE" });
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: cors });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
      }
    }

    // ── GET /api/admin/users — list all users (for member search) ─
    if (url.pathname.endsWith("/api/admin/users") && request.method === "GET") {
      const { user: admin, reason: _authReason } = await verifyAdmin(env, request);
      if (!admin) return new Response(JSON.stringify({ error: "Unauthorized", reason: _authReason }), { status: 401, headers: cors });
      try {
        const profiles = await sb_fetch(env, "/profiles?select=id,display_name,is_admin&order=display_name.asc", { prefer: "return=representation" }) || [];
        // Enrich with emails
        const result = [];
        for (const p of profiles) {
          let email = "";
          try {
            const uRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${p.id}`, {
              headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` }
            });
            if (uRes.ok) { const u = await uRes.json(); email = u.email || ""; }
          } catch (_) {}
          result.push({ ...p, email });
        }
        return new Response(JSON.stringify(result), { status: 200, headers: cors });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
      }
    }

    /* ═══════════════════════════════════════════════════════════
       END ADMIN API
       ═══════════════════════════════════════════════════════════ */

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
        const label = [place, a.country].filter(Boolean).join(", ") || (d.display_name ? d.display_name.split(",").slice(-3).map((s) => s.trim()).join(", ") : "");
        return new Response(JSON.stringify({ label }), { status: 200, headers: cors });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: cors });
      }
    }
    if (url.pathname.endsWith("/email")) {
      if (request.method !== "POST") return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers: cors });
      if (!origin_ok(request)) {
        return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: cors });
      }
      let body2;
      try {
        body2 = await request.json();
      } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: cors });
      }
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
    if (url.pathname.endsWith("/notify-wine-added")) {
      if (request.method !== "POST") return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers: cors });
      if (!origin_ok(request)) {
        return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: cors });
      }
      let body3;
      try {
        body3 = await request.json();
      } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: cors });
      }
      const { cellar_id, exclude_endpoint, wine_id, wine_name, winery, added_by_name } = body3;
      if (!cellar_id) {
        return new Response(JSON.stringify({ error: "cellar_id required" }), { status: 400, headers: cors });
      }
      try {
        const subscriptions = await gather_subs(env, cellar_id, exclude_endpoint);
        if (!subscriptions.length) {
          return new Response(JSON.stringify({ ok: true, sent: 0, total: 0 }), { status: 200, headers: cors });
        }
        const title = "\u{1F377} New wine in the cellar";
        const wineLine = [winery, wine_name].filter(Boolean).join(" \xB7 ") || "A new wine";
        const bodyText = added_by_name ? added_by_name + " added " + wineLine : wineLine;
        const payload = JSON.stringify({
          title,
          body: bodyText,
          url: wine_id ? APP_URL + "/?open=" + encodeURIComponent(wine_id) : APP_URL + "/",
          tag: wine_id ? "wine-" + wine_id : void 0,
          wineId: wine_id || null
        });
        const sent = await dispatch_pushes(env, subscriptions, payload);
        return new Response(JSON.stringify({ ok: true, sent, total: subscriptions.length }), { status: 200, headers: cors });
      } catch (e) {
        console.error("notify-wine-added error:", e.message);
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
      }
    }
    if (url.pathname.endsWith("/notify-wine-commented")) {
      if (request.method !== "POST") return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers: cors });
      if (!origin_ok(request)) {
        return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: cors });
      }
      let body4;
      try {
        body4 = await request.json();
      } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: cors });
      }
      const { cellar_id, exclude_endpoint, wine_id, wine_name, winery, grape, style, rating, comment_body, author_name } = body4;
      if (!cellar_id) {
        return new Response(JSON.stringify({ error: "cellar_id required" }), { status: 400, headers: cors });
      }
      try {
        const subscriptions = await gather_subs(env, cellar_id, exclude_endpoint);
        if (!subscriptions.length) {
          return new Response(JSON.stringify({ ok: true, sent: 0, total: 0 }), { status: 200, headers: cors });
        }
        const { title, body: bodyText } = comment_notification({
          wine_id,
          wine_name,
          winery,
          grape,
          style,
          rating: rating != null ? Number(rating) : null,
          comment_body: String(comment_body || "").slice(0, 160),
          author_name
        });
        const payload = JSON.stringify({
          title,
          body: bodyText,
          url: wine_id ? APP_URL + "/?open=" + encodeURIComponent(wine_id) : APP_URL + "/",
          tag: wine_id ? "comment-" + wine_id : "cellar-comment",
          renotify: true,
          wineId: wine_id || null
        });
        const sent = await dispatch_pushes(env, subscriptions, payload);
        return new Response(JSON.stringify({ ok: true, sent, total: subscriptions.length }), { status: 200, headers: cors });
      } catch (e) {
        console.error("notify-wine-commented error:", e.message);
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
      }
    }
    if (url.pathname.endsWith("/enrich")) {
      if (request.method !== "POST") return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers: cors });
      if (!origin_ok(request)) return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: cors });
      const enrichKey = env?.ANTHROPIC_API_KEY || ANTHROPIC_API_KEY;
      if (!enrichKey) return new Response(JSON.stringify({ error: "NO_KEY" }), { status: 500, headers: cors });
      let ebody;
      try { ebody = await request.json(); } catch { return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: cors }); }
      const { wine_id, name, winery, grape, region, country, vintage, style, photoBase64 } = ebody || {};
      if (!wine_id) return new Response(JSON.stringify({ error: "wine_id required" }), { status: 400, headers: cors });
      const refresh = url.searchParams.get("refresh") === "1";
      console.log("enrich: wine_id=", wine_id, "refresh=", refresh);

      // If refresh requested, delete existing row first
      if (refresh) {
        try {
          const sbKey = env.SUPABASE_SERVICE_KEY;
          await fetch(`${SUPABASE_URL}/rest/v1/wine_enrichments?wine_id=eq.${encodeURIComponent(wine_id)}`, {
            method: "DELETE",
            headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` }
          });
          console.log("enrich: deleted existing row for refresh", wine_id);
        } catch (e) { console.warn("enrich: refresh delete failed:", e.message); }
      }

      // Check if enrichment already exists (skip if refreshing)
      if (!refresh) {
        try {
          const existing = await sb_fetch(env, "/wine_enrichments?wine_id=eq." + encodeURIComponent(wine_id) + "&select=wine_id,summary,producer_name,producer_desc,blend,tasting_notes,food_pairings,critic_scores,region_context,price_context", { prefer: "return=representation" });
          if (existing && existing.length > 0) {
            return new Response(JSON.stringify(existing[0]), { status: 200, headers: cors });
          }
        } catch (e) { console.warn("enrich: existing check failed:", e.message); }
      }

      const wineParts = [name, winery, grape, region, country, vintage, style].filter(Boolean);
      if (wineParts.length < 2) return new Response(JSON.stringify({ error: "Not enough wine info to research" }), { status: 400, headers: cors });

      const enrichPromptText = `You are a wine research assistant. ${photoBase64 ? "I have attached an image of the wine's front label — use it together with the metadata below to identify the exact wine and producer." : "Given the wine details below, identify the wine and producer."}

Use web search to find information about this specific wine.

Wine name: ${name || "Unknown"}
Winery/Producer: ${winery || "Unknown"}
Grape: ${grape || "Unknown"}
Region: ${region || "Unknown"}
Country: ${country || "Unknown"}
Vintage: ${vintage || "Unknown"}
Style: ${style || "Unknown"}

Search for this wine. Return ONLY a valid JSON object with no markdown or explanation:
{
  "summary": "2-3 sentence overview of this wine and what makes it notable",
  "producer_name": "Full producer or winery name (or brand if supermarket own-label)",
  "producer_desc": "1-2 sentence description of the producer",
  "blend": "Grape blend details if found, e.g. '90% Cabernet Sauvignon, 10% Merlot', or null if unknown",
  "tasting_notes": "Typical tasting notes from critics or the producer, 1-2 sentences",
  "food_pairings": ["pairing1", "pairing2", "pairing3", "pairing4"],
  "critic_scores": [{"source": "critic name", "score": "score", "label": "medal or descriptor"}],
  "region_context": "1-2 sentences about this wine region",
  "price_context": "Typical retail price if known, or null"
}

Rules:
- Only include information you found via search — never fabricate scores or reviews
- If you cannot find information for a field, set it to null (or empty array for arrays)
- Food pairings: include 3-5 suggestions with an emoji prefix, e.g. "🥩 Steak"
- Critic scores: only include real published scores you found`;

      // Build message content — include photo if available
      const enrichContent = [];
      if (photoBase64) {
        enrichContent.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: photoBase64 } });
      }
      enrichContent.push({ type: "text", text: enrichPromptText });

      try {
        const enrichResp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": enrichKey,
            "anthropic-version": "2023-06-01"
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-6",
            max_tokens: 1500,
            tools: [{ type: "web_search_20250305", name: "web_search" }],
            messages: [{ role: "user", content: enrichContent }]
          })
        });
        if (!enrichResp.ok) {
          const errB = await enrichResp.json().catch(() => ({}));
          console.error("enrich: Anthropic error", enrichResp.status, JSON.stringify(errB));
          return new Response(JSON.stringify({ error: errB?.error?.message || `Anthropic ${enrichResp.status}` }), { status: enrichResp.status, headers: cors });
        }
        const enrichData = await enrichResp.json();
        const rawText2 = (enrichData.content || []).filter(b => b.type === "text").map(b => b.text).join("");
        const cleaned2 = rawText2.replace(/```json\s*/gi, "").replace(/```\s*/gi, "").trim();
        const match2 = cleaned2.match(/\{[\s\S]*\}/);
        let enrichParsed;
        try { enrichParsed = JSON.parse(match2 ? match2[0] : cleaned2); }
        catch { return new Response(JSON.stringify({ error: "PARSE_ERROR", raw: rawText2.slice(0, 500) }), { status: 422, headers: cors }); }

        // Normalise arrays
        if (typeof enrichParsed.food_pairings === "string") try { enrichParsed.food_pairings = JSON.parse(enrichParsed.food_pairings); } catch { enrichParsed.food_pairings = []; }
        if (typeof enrichParsed.critic_scores === "string") try { enrichParsed.critic_scores = JSON.parse(enrichParsed.critic_scores); } catch { enrichParsed.critic_scores = []; }
        if (!Array.isArray(enrichParsed.food_pairings)) enrichParsed.food_pairings = [];
        if (!Array.isArray(enrichParsed.critic_scores)) enrichParsed.critic_scores = [];

        // Strip web-search citation tags from all string fields
        const stripCites = s => typeof s === "string" ? s.replace(/<\/?cite[^>]*>/gi, "").replace(/\s{2,}/g, " ").trim() : s;
        for (const k of Object.keys(enrichParsed)) {
          if (typeof enrichParsed[k] === "string") enrichParsed[k] = stripCites(enrichParsed[k]);
          else if (Array.isArray(enrichParsed[k])) {
            enrichParsed[k] = enrichParsed[k].map(item => {
              if (typeof item === "string") return stripCites(item);
              if (item && typeof item === "object") {
                for (const ik of Object.keys(item)) { if (typeof item[ik] === "string") item[ik] = stripCites(item[ik]); }
              }
              return item;
            });
          }
        }

        // Write to Supabase
        const enrichRow = {
          wine_id: wine_id,
          summary: enrichParsed.summary || null,
          producer_name: enrichParsed.producer_name || null,
          producer_desc: enrichParsed.producer_desc || null,
          blend: enrichParsed.blend || null,
          tasting_notes: enrichParsed.tasting_notes || null,
          food_pairings: enrichParsed.food_pairings,
          critic_scores: enrichParsed.critic_scores,
          region_context: enrichParsed.region_context || null,
          price_context: enrichParsed.price_context || null,
          model_used: "claude-sonnet-4-6"
        };
        // Await the write — Cloudflare Workers kill unawaited promises on Response return
        try {
          const sbKey = env.SUPABASE_SERVICE_KEY;
          const writeRes = await fetch(`${SUPABASE_URL}/rest/v1/wine_enrichments?on_conflict=wine_id`, {
            method: "POST",
            headers: {
              apikey: sbKey,
              Authorization: `Bearer ${sbKey}`,
              "Content-Type": "application/json",
              Prefer: "resolution=merge-duplicates"
            },
            body: JSON.stringify(enrichRow)
          });
          if (!writeRes.ok) {
            const wErr = await writeRes.json().catch(() => ({}));
            console.error("enrich: DB write failed", writeRes.status, JSON.stringify(wErr));
          } else {
            console.log("enrich: DB write OK for wine_id", wine_id);
          }
        } catch (wEx) { console.error("enrich: DB write exception", wEx.message); }

        enrichParsed.wine_id = wine_id;
        return new Response(JSON.stringify(enrichParsed), { status: 200, headers: cors });
      } catch (e) {
        console.error("enrich: exception", e.message);
        return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: cors });
      }
    }
    // No API route matched — pass non-POST requests through to static origin (Cloudflare Pages)
    if (request.method !== "POST") return fetch(request);
    const anthropicKey = env?.ANTHROPIC_API_KEY || ANTHROPIC_API_KEY;
    if (!anthropicKey || anthropicKey === "PASTE_YOUR_ANTHROPIC_KEY_HERE") return new Response(JSON.stringify({ error: "NO_KEY_IN_WORKER" }), { status: 500, headers: cors });
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: cors });
    }
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
      const status = anthropicResp.status;
      if (status === 401) return new Response(JSON.stringify({ error: "INVALID_KEY" }), { status: 401, headers: cors });
      if (status === 429) return new Response(JSON.stringify({ error: "RATE_LIMIT" }), { status: 429, headers: cors });
      return new Response(JSON.stringify({ error: errBody?.error?.message || `Anthropic error ${status}` }), { status, headers: cors });
    }
    const data = await anthropicResp.json();
    const rawText = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    const cleaned = rawText.replace(/```json\s*/gi, "").replace(/```\s*/gi, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    let parsed;
    try {
      parsed = JSON.parse(match ? match[0] : cleaned);
    } catch {
      return new Response(JSON.stringify({ error: "PARSE_ERROR", raw: rawText }), { status: 422, headers: cors });
    }
    return new Response(JSON.stringify(parsed), { status: 200, headers: cors });
  }
};
export {
  worker_default as default
};