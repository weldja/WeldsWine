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
| AI + email proxy | Cloudflare Worker (aged-union-8f0d) | Workers & Pages → aged-union-8f0d |
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
    └──► Cloudflare Worker (aged-union-8f0d)
              ├──► Anthropic Claude API  (label scanning)
              └──► Resend API            (welcome emails)

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

> **Note:** The A records point to GitHub's IPs, not Cloudflare Pages. The site is hosted on GitHub Pages — Cloudflare proxies in front of it for CDN and security. The MX, SPF, and DKIM records are managed automatically by Cloudflare Email Routing — do not add or edit them manually.

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

GitHub creates a `CNAME` file in the repo root containing `weldswine.co.uk`. **Do not delete this file** — it tells GitHub Pages to serve the site on your custom domain.

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
Or via GitHub UI: repo → Commits → find previous commit → browse files → copy `index.html`.

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

MX, SPF, and DKIM records are managed automatically — never edit them manually.

### Email Obfuscation (known issue)
Cloudflare automatically obfuscates `mailto:` links in HTML, replacing them with broken `/cdn-cgi/l/email-protection#...` URLs.

**Permanent fix:** Cloudflare → weldswine.co.uk → Security → Settings → Email Address Obfuscation → **Off**

If the contact link breaks after any deploy, this setting has been re-enabled. Turn it off and re-deploy.

---

## Cloudflare Worker — AI Scanning & Email Proxy

### Purpose
Secure server-side proxy so that API keys (Anthropic, Resend) never appear in the public `index.html`.

### Details
- **Worker name:** `aged-union-8f0d`
- **Worker URL:** `https://aged-union-8f0d.james-weld.workers.dev`
- **Location:** dash.cloudflare.com → Workers & Pages → `aged-union-8f0d`
- **Source file:** `cloudflare-worker.js` in the repo

### Endpoints
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/` | Proxies label scan images to Anthropic Claude API |
| POST | `/email` | Proxies welcome email requests to Resend API |

### Secrets
These are stored in the Worker only — never in `index.html`.

| Variable | Purpose | Where to get a new one |
|----------|---------|----------------------|
| `ANTHROPIC_API_KEY` | Anthropic Claude vision API | console.anthropic.com → API Keys |
| `RESEND_API_KEY` | Resend transactional email | resend.com → API Keys |

**To update a secret:**
1. dash.cloudflare.com → Workers & Pages → `aged-union-8f0d`
2. Settings → Variables and Secrets → edit → Save
3. Takes effect immediately — no redeployment needed

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
- `shared_wines` — **must be readable by the `anon` role** (unauthenticated) so share links work for all visitors regardless of login status. If share links return "Wine not found", check this policy.

### Authentication URL Configuration
**Path:** Supabase → Authentication → URL Configuration

| Setting | Value |
|---------|-------|
| Site URL | https://weldswine.co.uk |
| Redirect URLs | https://weldswine.co.uk/** |

The `/**` wildcard is required — without it, password reset and email confirmation links with query strings are rejected by Supabase.

Email confirmation is **enabled** — new users must verify their email before they can sign in.

### Managing Users
- **List users:** Supabase → Authentication → Users
- **Delete a user:** three-dot menu → Delete user
- **Use the dashboard, not raw SQL** — deleting from `auth.users` via SQL leaves orphaned rows in `wines` and `shared_wines`

### Free Tier Limits
| Resource | Limit |
|----------|-------|
| Database storage | 500MB |
| File storage (photos) | 1GB |
| Monthly active users | 50,000 |

Upgrade to Supabase Pro (~$25/month) if approaching limits.

### Manual Backup (free tier has no auto-backup)
Supabase → Table Editor → select table → Export as CSV. Do this monthly for `wines` and `shared_wines`.

---

## Anthropic — AI Label Scanning

- **Console:** console.anthropic.com
- **API key location:** Cloudflare Worker secret `ANTHROPIC_API_KEY`
- **Cost:** Pay-per-use, a few pence per label scan
- **Monitor:** console.anthropic.com → Usage (check monthly)

**Key rotation:**
1. console.anthropic.com → API Keys → Create new key
2. Update `ANTHROPIC_API_KEY` in Cloudflare Worker secrets
3. Delete old key from Anthropic console

---

## Resend — Transactional Email

- **Dashboard:** resend.com
- **API key location:** Cloudflare Worker secret `RESEND_API_KEY`
- **Free tier:** 3,000 emails/month, 100/day
- **Sending domain:** weldswine.co.uk (verified via DKIM in Cloudflare DNS)

**Emails sent:**
| Trigger | Recipient | Purpose |
|---------|-----------|---------|
| New user registration | New user's email | Welcome email |

**Key rotation:**
1. resend.com → API Keys → Create new key
2. Update `RESEND_API_KEY` in Cloudflare Worker secrets
3. Delete old key from Resend

---

## External Libraries (no accounts needed)

| Library | Version | Purpose |
|---------|---------|---------|
| Supabase JS | `@2` (latest v2) | Database & auth client |
| Leaflet | `1.9.4` | Interactive wine origin map |
| Google Fonts | — | Lora + Inter typefaces |
| BigDataCloud | — | GPS coordinates → place name |

**To update Leaflet**, change both references in `index.html`:
```html
<!-- In <head>: -->
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.5/dist/leaflet.css"/>
<!-- In JS (search "unpkg.com/leaflet"): -->
s.src = 'https://unpkg.com/leaflet@1.9.5/dist/leaflet.js';
```

---

## File Structure

```
index.html              — entire app (HTML + CSS + JS, ~4,300 lines)
cloudflare-worker.js    — AI scanning + email proxy (deployed to Cloudflare Workers)
CNAME                   — GitHub Pages custom domain (do not delete)
ADMIN.md                — this guide
```

---

## How to Reproduce This Setup from Scratch

Follow these steps in order to rebuild the full infrastructure.

### Step 1 — GitHub repository
1. Create repo (e.g. `WeldsWine`) on github.com
2. Add `index.html`, `cloudflare-worker.js`, `CNAME` (containing `weldswine.co.uk`), `ADMIN.md`
3. Push to `main`
4. Repo → Settings → Pages → Source: `main`, root
5. Custom domain: `weldswine.co.uk`, enforce HTTPS

### Step 2 — Supabase
1. Create new project at supabase.com
2. Create tables: `wines`, `shared_wines`
3. Enable RLS on both tables
4. Add anon SELECT policy on `shared_wines`: allow all reads for role `anon`
5. Authentication → URL Configuration:
   - Site URL: `https://weldswine.co.uk`
   - Redirect URLs: `https://weldswine.co.uk/**`
6. Copy project URL and anon key into `index.html`

### Step 3 — Anthropic
1. Create API key at console.anthropic.com → API Keys
2. Keep it for the Worker in step 5

### Step 4 — Resend
1. Create account at resend.com
2. Add sending domain: `weldswine.co.uk`
3. Create API key — keep it for the Worker

### Step 5 — Cloudflare Worker
1. dash.cloudflare.com → Workers & Pages → Create Worker
2. Paste `cloudflare-worker.js` → Deploy
3. Settings → Variables and Secrets → add `ANTHROPIC_API_KEY` and `RESEND_API_KEY`
4. Note the Worker URL (e.g. `https://xxx.workers.dev`)
5. Update the `WORKER_URL` constant in `index.html`

### Step 6 — Cloudflare DNS zone
1. dash.cloudflare.com → Add a site → `weldswine.co.uk` → Free plan
2. Add DNS records:

```
Type: A      Name: @    Value: 185.199.108.153   Proxy: ON
Type: A      Name: @    Value: 185.199.109.153   Proxy: ON
Type: A      Name: @    Value: 185.199.110.153   Proxy: ON
Type: A      Name: @    Value: 185.199.111.153   Proxy: ON
Type: CNAME  Name: www  Value: weldja.github.io  Proxy: ON
```

3. Note the two nameservers Cloudflare provides

### Step 7 — Namecheap nameservers
1. namecheap.com → Domain List → weldswine.co.uk → Manage
2. Nameservers → Custom DNS → enter both Cloudflare nameservers
3. Save — propagation takes 10–30 minutes

### Step 8 — Cloudflare Email Routing
1. dash.cloudflare.com → weldswine.co.uk → Email → Email Routing → Enable
2. Delete the conflicting Namecheap SPF TXT record when prompted
3. Let Cloudflare add MX, SPF, and DKIM records automatically
4. Add routing rule: `hello@weldswine.co.uk` → `james_weld@yahoo.com`
5. Confirm forwarding address via verification email

### Step 9 — Disable email obfuscation
Cloudflare → weldswine.co.uk → Security → Settings → Email Address Obfuscation → **Off**

### Step 10 — Verify everything
- [ ] Site loads at https://weldswine.co.uk
- [ ] HTTPS padlock shows
- [ ] Login and signup work
- [ ] Signup shows "check your email" message (not "signed in")
- [ ] Email confirmation link works and lands on the app
- [ ] Password reset email arrives and redirects correctly
- [ ] Wine label scanning works
- [ ] Welcome email arrives on registration
- [ ] Contact link opens mail client to `hello@weldswine.co.uk`
- [ ] Share links work for logged-in and logged-out users
- [ ] Map view loads

---

## Routine Maintenance Checklist

### Monthly
- [ ] Check Supabase usage — Storage and Auth → Usage
- [ ] Check Anthropic API usage and cost — console.anthropic.com → Usage
- [ ] Check Resend sending logs — resend.com → Logs
- [ ] Verify site loads and login works
- [ ] Check contact link is not broken (Cloudflare obfuscation)
- [ ] Manual CSV export of `wines` and `shared_wines` (free tier has no auto-backup)

### Quarterly
- [ ] Rotate Anthropic API key
- [ ] Rotate Resend API key
- [ ] Review Supabase database and storage size
- [ ] Delete orphaned photos in Supabase Storage if storage is high
- [ ] Check Supabase JS library for updates

### Annually
- [ ] Renew domain on Namecheap (due 17 March 2027)
- [ ] Review Supabase plan vs actual usage
- [ ] Check Leaflet for security updates
- [ ] Review Cloudflare plan

---

## Common Issues & Fixes

| Problem | Likely cause | Fix |
|---------|-------------|-----|
| Contact link gives 404 | Cloudflare re-obfuscated the email | Security → Settings → Email Obfuscation → Off; re-deploy |
| Share links say "Wine not found" | Supabase RLS blocking anon reads on `shared_wines` | Add anon SELECT policy to `shared_wines` table |
| Share links work incognito but not logged in | Same RLS issue | Same fix as above |
| Label scanning not working | Worker down or bad Anthropic key | Check Worker in Cloudflare; verify key at console.anthropic.com |
| Welcome email not received | Bad Resend key or Worker error | Check resend.com → Logs; verify `RESEND_API_KEY` in Worker |
| Users can't log in | Supabase auth issue | Supabase → Authentication → Logs |
| Password reset link rejected | Missing wildcard in Supabase redirect URLs | Add `https://weldswine.co.uk/**` to Supabase Auth URL Configuration |
| Site not updating after push | Cloudflare cache | Cloudflare → Caching → Purge Everything |
| Map not showing | Leaflet CDN issue | Check browser console; Leaflet loads lazily on first map open |
| Photos not saving | Supabase storage full | Supabase → Storage → delete orphaned files |
| DNS not resolving | Nameservers reverted on Namecheap | Namecheap → Manage → confirm nameservers still show Cloudflare's |
| Email forwarding broken | MX records missing or changed | Cloudflare → Email → Email Routing → check status |

---

## Taking the Site Offline

**Quickest — swap in a maintenance page:**
```bash
# Replace index.html content with a holding page, then:
git add index.html
git commit -m "Maintenance mode"
git push

# Restore:
git checkout HEAD~1 -- index.html
git add index.html
git commit -m "Restore site"
git push
```

**Alternative — disable in Cloudflare:**
Cloudflare → Workers & Pages → your Pages project → Settings → Disable project

---

## Git Quick Reference

```bash
git status                          # see what's changed
git add index.html
git commit -m "Description"
git push                            # live in ~60 seconds

git log --oneline -10               # recent commit history
git diff index.html                 # see uncommitted changes

# Emergency rollback one commit
git checkout HEAD~1 -- index.html
git add index.html
git commit -m "Rollback"
git push
```

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
| Cloudflare Worker | dash.cloudflare.com → Workers & Pages → aged-union-8f0d |
