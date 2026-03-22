# Welds Wine Wisdoms — Admin & Maintenance Guide

**Site:** https://weldswine.co.uk  
**Repo:** https://github.com/weldja/WeldsWine  
**Last updated:** March 2026

---

## Overview

Welds Wine Wisdoms is a single-file HTML/CSS/JS app (`index.html`). There is no build system, no npm, no framework. To update the site, edit the file and push to GitHub — GitHub Pages serves the site automatically, with Cloudflare in front as DNS, CDN, and email proxy.

---

## Infrastructure at a Glance

| What | Service | Where to manage |
|------|---------|----------------|
| Code repository | GitHub (github.com/weldja) | github.com → WeldsWine repo |
| Hosting | GitHub Pages | GitHub repo → Settings → Pages |
| DNS, CDN & Email Routing | Cloudflare (free plan) | dash.cloudflare.com → weldswine.co.uk |
| AI + email proxy | Cloudflare Worker (aged-wave-00c3) | Workers & Pages → aged-wave-00c3 |
| Domain registrar | Namecheap | namecheap.com → Domain List |
| Database & Auth | Supabase (free tier) | supabase.com → phcnswuwrqarikzjvfqd |
| AI label scanning | Anthropic Claude API | console.anthropic.com |
| Transactional email | Resend | resend.com |
| Email forwarding | Cloudflare Email Routing | weldswine.co.uk → Email → Email Routing |
| Maps | OpenStreetMap / Leaflet | CDN — no account needed |
| Fonts | Google Fonts | CDN — no account needed |
| Reverse geocoding | BigDataCloud | Free API — no account needed |

---

## How It All Connects

```
User browser
    │
    ▼
Cloudflare (CDN + DNS proxy)
    │  weldswine.co.uk
    ▼
GitHub Pages (weldja.github.io)
    │  serves index.html
    │
    ├──► Supabase (database + auth)
    │       wines, shared_wines, auth.users
    │
    └──► Cloudflare Worker (aged-wave-00c3)
              ├──► Anthropic Claude API  (label scanning)
              └──► Resend API            (transactional email)

Inbound email:
    hello@weldswine.co.uk
        │
        ▼
    Cloudflare Email Routing
        │
        ▼
    james_weld@yahoo.com
```

---

## Domain & DNS

### Registrar
- **Domain:** `weldswine.co.uk`
- **Registered at:** Namecheap
- **Renewal date:** 17 March 2027
- **Auto-renew:** enabled

### Nameservers
The domain uses Cloudflare's nameservers. Set in **Namecheap → Domain List → weldswine.co.uk → Manage → Custom DNS**:

```
kate.ns.cloudflare.com
piotr.ns.cloudflare.com
```

> **Do not change these.** Changing nameservers will take the site offline until they propagate again (10–30 minutes).

### DNS Records
All DNS is managed at **dash.cloudflare.com → weldswine.co.uk → DNS → Records**.

| Type | Name | Value | Proxy | Purpose |
|------|------|-------|-------|---------|
| A | @ | 185.199.108.153 | ON | GitHub Pages |
| A | @ | 185.199.109.153 | ON | GitHub Pages |
| A | @ | 185.199.110.153 | ON | GitHub Pages |
| A | @ | 185.199.111.153 | ON | GitHub Pages |
| CNAME | www | weldja.github.io | ON | GitHub Pages www redirect |
| MX | @ | route1.mx.cloudflare.net (priority 48) | — | Cloudflare Email Routing |
| MX | @ | route2.mx.cloudflare.net (priority 32) | — | Cloudflare Email Routing |
| MX | @ | route3.mx.cloudflare.net (priority 20) | — | Cloudflare Email Routing |
| TXT | @ | v=spf1 include:_spf.mx.cloudflare.net ~all | — | Email SPF record |
| TXT | cf2024-1._domainkey | (long DKIM key — do not edit) | — | Email DKIM signing |
| TXT | _dmarc | v=DMARC1; p=none; rua=mailto:hello@weldswine.co.uk | — | DMARC reporting |

> **Note:** The A records point to GitHub's IPs. The site is hosted on GitHub Pages — Cloudflare proxies in front for CDN and security. Do not add or edit MX, SPF, or DKIM records manually.

---

## Hosting — GitHub Pages

### Repository
- **URL:** https://github.com/weldja/WeldsWine
- **Branch served:** `main`
- **File served:** `index.html` from root

### GitHub Pages settings
GitHub repo → Settings → Pages:
- Source: Deploy from branch → `main` → `/ (root)`
- Custom domain: `weldswine.co.uk`
- Enforce HTTPS: enabled

GitHub creates a `CNAME` file in the repo root containing `weldswine.co.uk`. **Do not delete this file.**

### Deploying a change
```bash
git add index.html
git commit -m "Description of change"
git push
```
Live within ~60 seconds. No build step.

### Rollback
```bash
git checkout HEAD~1 -- index.html
git add index.html
git commit -m "Rollback to previous version"
git push
```

---

## Cloudflare Configuration

### Zone
- **Domain:** `weldswine.co.uk`
- **Plan:** Free
- **DNS type:** Full (Cloudflare is authoritative)

### Email Routing
**Path:** dash.cloudflare.com → weldswine.co.uk → Email → Email Routing

| From | Action | Destination | Status |
|------|--------|-------------|--------|
| hello@weldswine.co.uk | Forward | james_weld@yahoo.com | Active |
| Catch-all | Drop | — | Disabled |

> **Known issue:** Yahoo occasionally rejects forwarded mail with "Relay access denied". This is a Yahoo restriction and cannot be fixed on our end. If persistent, change forwarding destination to Gmail.

### Email Obfuscation (known issue)
Cloudflare automatically obfuscates `mailto:` links in HTML. The contact link in `index.html` uses `mailto:hello@weldswine.co.uk` — if it breaks after a deploy, Cloudflare has re-enabled obfuscation.

**Fix:** Cloudflare → weldswine.co.uk → Security → Settings → Email Address Obfuscation → **Off**

---

## Cloudflare Worker — AI Scanning & Email Proxy

### Purpose
Secure server-side proxy so that API keys (Anthropic, Resend) never appear in the public `index.html`.

### Details
- **Worker name:** `aged-wave-00c3`
- **Worker URL:** `https://aged-wave-00c3.james-weld.workers.dev`
- **Location:** dash.cloudflare.com → Workers & Pages → `aged-wave-00c3`
- **Source file:** `cloudflare-worker.js` in the repo (for reference only)

> **CRITICAL:** Do NOT connect this Worker to GitHub via Git. When connected, Cloudflare treats the whole repo as static assets and the Worker stops functioning entirely. Always deploy Worker changes manually via **Edit Code** in the Cloudflare dashboard.

### Endpoints
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/` | Proxies label scan images to Anthropic Claude API |
| GET | `/geocode` | Proxies reverse geocoding to OpenStreetMap Nominatim |
| POST | `/email` | Proxies transactional email requests to Resend API |

### Allowed Origins
The Worker only accepts requests from:
- `https://weldswine.co.uk`
- `https://www.weldswine.co.uk`
- `https://james-weld.github.io`
- `http://localhost` / `http://127.0.0.1`

If scanning stops working after a domain change, check this list in `cloudflare-worker.js`.

### Secrets
Set at: Workers & Pages → aged-wave-00c3 → Settings → Variables and Secrets.

| Variable | Purpose | Where to get a new one |
|----------|---------|----------------------|
| `ANTHROPIC_API_KEY` | Anthropic Claude vision API | console.anthropic.com → API Keys |
| `RESEND_API_KEY` | Resend transactional email | resend.com → API Keys |

**To update a secret:**
1. dash.cloudflare.com → Workers & Pages → `aged-wave-00c3`
2. Settings → Variables and Secrets → edit → Save
3. Takes effect immediately — no redeployment needed

### Deploying Worker changes
1. Cloudflare → Workers & Pages → `aged-wave-00c3` → **Edit Code**
2. Make changes directly in the browser editor
3. Click **Deploy**

Do NOT use `git push` to deploy Worker changes.

---

## Supabase — Database & Authentication

### Project
- **Project ID:** `phcnswuwrqarikzjvfqd`
- **URL:** `https://phcnswuwrqarikzjvfqd.supabase.co`
- **Plan:** Free tier

### Credentials in index.html
```js
const SUPABASE_URL = 'https://phcnswuwrqarikzjvfqd.supabase.co';
const SUPABASE_KEY = 'eyJhbGci...'; // anon/public key — safe to be in HTML
```
The anon key is intentionally public. Row Level Security (RLS) policies enforce what each user can access.

### Database Tables
| Table | Purpose |
|-------|---------|
| `wines` | All wine entries per user |
| `shared_wines` | Public copies of wines shared via link |

### Row Level Security (RLS)
- `wines` — users can only read/write their own rows
- `shared_wines` — **must be readable by the `anon` role** so share links work for all visitors. If share links return "Wine not found", check this policy.

### Authentication URL Configuration
**Path:** Supabase → Authentication → URL Configuration

| Setting | Value |
|---------|-------|
| Site URL | https://weldswine.co.uk |
| Redirect URLs | https://weldswine.co.uk/** |

The `/**` wildcard is required — without it, password reset and email confirmation links are rejected.

### Email Confirmation
Email confirmation is **enabled** — new users must verify their email before signing in. The app shows "Please check your email and click the confirmation link to sign in." Only the Supabase confirmation email is sent — no separate welcome email.

### Managing Users
- **List users:** Supabase → Authentication → Users
- **Delete a user:** three-dot menu → Delete user
- **Use the dashboard, not raw SQL** — deleting from `auth.users` via SQL leaves orphaned rows

### Free Tier Limits
| Resource | Limit |
|----------|-------|
| Database storage | 500MB |
| File storage (photos) | 1GB |
| Monthly active users | 50,000 |

### Manual Backup
Supabase → Table Editor → select table → Export as CSV. Do monthly for `wines` and `shared_wines`.

---

## Anthropic — AI Label Scanning

- **Console:** console.anthropic.com
- **API key location:** Cloudflare Worker secret `ANTHROPIC_API_KEY`
- **Model used:** `claude-haiku-4-5-20251001`
- **Cost:** Pay-per-use, a few pence per label scan

**Key rotation:**
1. console.anthropic.com → API Keys → Create new key
2. Update `ANTHROPIC_API_KEY` in Worker secrets (aged-wave-00c3)
3. Delete old key

---

## Resend — Transactional Email

- **Dashboard:** resend.com
- **API key location:** Cloudflare Worker secret `RESEND_API_KEY`
- **Free tier:** 3,000 emails/month, 100/day
- **Sending domain:** `weldswine.co.uk` (verified)
- **From address:** `hello@weldswine.co.uk`

> No welcome email is sent on signup — Supabase handles the confirmation email. Resend is configured but currently unused for user-facing emails.

**Key rotation:**
1. resend.com → API Keys → Create new key
2. Update `RESEND_API_KEY` in Worker secrets (aged-wave-00c3)
3. Delete old key

---

## External Libraries (no accounts needed)

| Library | Version | Purpose |
|---------|---------|---------|
| Supabase JS | `@2` (latest v2) | Database & auth client |
| Leaflet | `1.9.4` | Interactive wine origin map |
| Google Fonts | — | Lora + Inter typefaces |
| BigDataCloud | — | GPS coordinates → place name |

---

## File Structure

```
index.html              — entire app (HTML + CSS + JS, ~4,400 lines)
cloudflare-worker.js    — AI scanning + email proxy (reference copy; deploy via Cloudflare Edit Code)
CNAME                   — GitHub Pages custom domain (do not delete)
ADMIN.md                — this guide
```

---

## How to Reproduce This Setup from Scratch

### Step 1 — GitHub repository
1. Create repo `WeldsWine` on github.com
2. Add `index.html`, `cloudflare-worker.js`, `CNAME` (containing `weldswine.co.uk`), `ADMIN.md`
3. Push to `main`
4. Repo → Settings → Pages → Source: `main`, root
5. Custom domain: `weldswine.co.uk`, enforce HTTPS

### Step 2 — Supabase
1. Create new project at supabase.com
2. Create tables: `wines`, `shared_wines`
3. Enable RLS on both tables
4. Add anon SELECT policy on `shared_wines`
5. Authentication → URL Configuration: Site URL + Redirect URLs as above
6. Copy project URL and anon key into `index.html`

### Step 3 — Anthropic
1. Create API key at console.anthropic.com → API Keys

### Step 4 — Resend
1. Create account at resend.com
2. Add sending domain: `weldswine.co.uk`
3. Add DNS records Resend provides in Cloudflare DNS
4. Verify domain, create API key

### Step 5 — Cloudflare Worker
1. dash.cloudflare.com → Workers & Pages → Create → **Start with Hello World**
2. Replace code with `cloudflare-worker.js` → Deploy
3. Settings → Variables and Secrets → add `ANTHROPIC_API_KEY` and `RESEND_API_KEY`
4. Update `WORKER_URL` in `index.html` with new Worker URL
5. **Never connect to Git**

### Step 6 — Cloudflare DNS zone
1. dash.cloudflare.com → Add a site → `weldswine.co.uk` → Free plan
2. Add A records (×4) and CNAME for GitHub Pages
3. Note the two nameservers Cloudflare provides

### Step 7 — Namecheap nameservers
1. namecheap.com → Domain List → weldswine.co.uk → Custom DNS
2. Enter both Cloudflare nameservers → Save

### Step 8 — Cloudflare Email Routing
1. weldswine.co.uk → Email → Email Routing → Enable
2. Add routing rule: `hello@weldswine.co.uk` → forwarding destination
3. Verify forwarding address

### Step 9 — Disable email obfuscation
Cloudflare → Security → Settings → Email Address Obfuscation → **Off**

### Step 10 — Verify everything
- [ ] Site loads at https://weldswine.co.uk
- [ ] HTTPS padlock shows
- [ ] Login and signup work
- [ ] Signup shows "check your email" (not "signed in")
- [ ] Password reset works
- [ ] Label scanning works
- [ ] Contact link opens `mailto:hello@weldswine.co.uk`
- [ ] Share links work for logged-in and logged-out users
- [ ] Map view loads

---

## Routine Maintenance Checklist

### Monthly
- [ ] Check Supabase usage
- [ ] Check Anthropic API usage and cost
- [ ] Check Resend logs
- [ ] Verify site and login work
- [ ] Check contact link not broken
- [ ] CSV export of `wines` and `shared_wines`

### Quarterly
- [ ] Rotate Anthropic API key
- [ ] Rotate Resend API key
- [ ] Review Supabase database size

### Annually
- [ ] Renew domain on Namecheap (due 17 March 2027)
- [ ] Review Supabase plan vs usage
- [ ] Check Leaflet for updates

---

## Common Issues & Fixes

| Problem | Likely cause | Fix |
|---------|-------------|-----|
| Contact link gives 404 | Cloudflare re-obfuscated the email | Security → Settings → Email Obfuscation → Off |
| Share links say "Wine not found" | Supabase RLS blocking anon reads | Add anon SELECT policy to `shared_wines` |
| Scanning says "could not reach proxy" | Wrong Worker URL or origin mismatch | Check `WORKER_URL` in `index.html` matches `aged-wave-00c3`; check allowed origins in worker |
| Scanning says "key missing" | API key not set | Check `ANTHROPIC_API_KEY` in Worker secrets |
| Worker shows "static assets only" | Worker was connected to Git | Disconnect Git in Worker Settings; redeploy via Edit Code |
| Save button stuck disabled on iPhone | iOS error during save | Fixed in code — try/catch/finally ensures button re-enables |
| Duplicate emails on signup | — | Fixed — welcome email removed; only Supabase confirmation sent |
| ERR_QUIC_PROTOCOL_ERROR | QUIC/HTTP3 conflict | chrome://flags/#enable-quic → Disabled |
| Users can't log in | Supabase auth issue | Supabase → Authentication → Logs |
| Password reset rejected | Missing wildcard redirect URL | Add `https://weldswine.co.uk/**` in Supabase Auth config |
| Site not updating after push | Cloudflare cache | Cloudflare → Caching → Purge Everything |
| DNS not resolving | Nameservers reverted | Namecheap → confirm Cloudflare nameservers still set |
| Email forwarding broken | MX records changed | Cloudflare → Email → Email Routing → check status |

---

## Git Quick Reference

```bash
git status
git add index.html
git commit -m "Description"
git push                    # index.html live in ~60 seconds

git log --oneline -10       # recent history
git diff index.html         # uncommitted changes

# Rollback one commit
git checkout HEAD~1 -- index.html
git add index.html
git commit -m "Rollback"
git push
```

> `git push` only deploys `index.html` via GitHub Pages. Worker changes must be deployed via Cloudflare Edit Code.

---

## All Admin Links

| Service | URL |
|---------|-----|
| Live site | https://weldswine.co.uk |
| GitHub repo | https://github.com/weldja/WeldsWine |
| Cloudflare dashboard | https://dash.cloudflare.com |
| Supabase dashboard | https://supabase.com/dashboard/project/phcnswuwrqarikzjvfqd |
| Anthropic console | https://console.anthropic.com |
| Resend dashboard | https://resend.com |
| Namecheap | https://namecheap.com (domain renewal only) |
| Cloudflare Worker | dash.cloudflare.com → Workers & Pages → aged-wave-00c3 |
