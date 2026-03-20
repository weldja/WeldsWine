# Welds Wine — Admin & Maintenance Guide

**Site:** https://weldswine.co.uk  
**Last updated:** March 2026

---

## Overview

The site is a single-file HTML/CSS/JS app (`index.html`). There is no build system, no npm, no framework. To update the site you edit the file and push to Git — Cloudflare Pages deploys automatically.

---

## Infrastructure at a Glance

| What | Service | Where to manage |
|------|---------|----------------|
| Hosting & CDN | Cloudflare Pages | dash.cloudflare.com → Pages |
| Domain & DNS | Cloudflare | dash.cloudflare.com → DNS |
| Database & Auth | Supabase | supabase.com → your project |
| AI label scanning | Anthropic Claude (via Cloudflare Worker) | console.anthropic.com |
| Transactional email | Resend (via Cloudflare Worker) | resend.com |
| Maps | OpenStreetMap / Leaflet (no account needed) | — |
| Fonts | Google Fonts (no account needed) | — |
| Reverse geocoding | BigDataCloud (free tier, no account) | — |

---

## Deployments

### How to deploy a change

```bash
# Edit index.html, then:
git add index.html
git commit -m "Description of change"
git push
```

Cloudflare Pages picks up the push and deploys within ~60 seconds. No build step needed.

### Rollback

In Cloudflare Pages dashboard → your project → Deployments → click any previous deployment → **Rollback to this deployment**.

---

## Services & Credentials

### 1. Supabase (database + authentication)

**What it does:** Stores all wine records, user accounts, photos, and handles login.

**Where:** supabase.com → Project: `phcnswuwrqarikzjvfqd`

**Key credentials in `index.html`:**
```js
const SUPABASE_URL = 'https://your-project.supabase.co';
const SUPABASE_ANON_KEY = 'your-anon-key';
```

**Routine tasks:**
- **Monitor usage:** Supabase dashboard → Usage. Free tier allows 500MB storage and 50,000 monthly active users.
- **Backups:** Supabase auto-backs up on paid plans. On free tier, export manually: Table Editor → Export as CSV.
- **Auth settings:** Authentication → Settings. Email confirmations and password resets are configured here.
- **If users can't log in:** Check Authentication → Logs for errors.

**Free tier limits to watch:**
- 500MB database storage
- 1GB file storage (wine label photos)
- 50,000 monthly active users

If you approach limits, upgrade to Supabase Pro (~$25/month) or delete old photo data.

---

### 2. Cloudflare (hosting, DNS, CDN)

**What it does:** Hosts the site, manages the domain, provides CDN caching, and runs the AI scanning + email Worker.

**Where:** dash.cloudflare.com

**Pages deployment:**
- Branch: `main`
- Build command: *(none — static file)*
- Publish directory: `/` or root

**DNS:**
- The domain `weldswine.co.uk` points to Cloudflare Pages via a CNAME record.
- Do not delete or change the CNAME pointing to `*.pages.dev`.

**Email obfuscation (known issue):**
Cloudflare automatically obfuscates email addresses in HTML. This breaks the contact link on every deploy. Fix options:
- **Option A:** Cloudflare → Scrape Shield → Email Address Obfuscation → **Off** (permanent fix)
- **Option B:** Re-deploy `index.html` with the plain `mailto:james_weld@yahoo.com` link each time

---

### 3. Cloudflare Worker (AI scanning + email proxy)

**What it does:** Acts as a secure proxy for both the Anthropic API (label scanning) and Resend (transactional email). Both API keys live in the Worker, not in the public HTML file.

**Worker URL:** `https://aged-union-8f0d.james-weld.workers.dev`

**Where:** dash.cloudflare.com → Workers & Pages → `aged-union-8f0d`

**Endpoints the Worker handles:**
- `POST /` — label scanning (proxies to Anthropic Claude)
- `POST /email` — transactional email (proxies to Resend)

**Secrets stored in the Worker:**
| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Anthropic Claude API key for label scanning |
| `RESEND_API_KEY` | Resend API key for sending emails |

**To update a key:**
1. dash.cloudflare.com → Workers & Pages → `aged-union-8f0d` → Settings → Variables and Secrets
2. Edit the relevant secret
3. Save — takes effect immediately, no redeployment needed

**If scanning stops working:**
- Check the Worker is active in the Cloudflare dashboard
- Verify the Anthropic key at console.anthropic.com → API Keys

**If emails stop sending:**
- Check the Resend key at resend.com → API Keys
- Check Resend sending logs at resend.com → Logs

---

### 4. Anthropic (AI label scanning)

**What it does:** Powers the wine label photo scanning feature via Claude's vision API.

**Where:** console.anthropic.com

**Routine tasks:**
- Monitor API usage and costs monthly at console.anthropic.com → Usage
- Rotate API keys periodically — update in the Cloudflare Worker after rotating (see section 3)

**Costs:** Pay-per-use. Label scanning uses vision tokens. Typical cost is a few pence per scan.

---

### 5. Resend (transactional email)

**What it does:** Sends transactional emails from the site. Currently used to send a welcome email when a new user registers. The Resend API key is stored securely in the Cloudflare Worker — it does not appear anywhere in `index.html`.

**Where:** resend.com

**Free tier:** 3,000 emails/month, 100/day — more than sufficient for this site.

**Routine tasks:**
- **Check sending logs:** resend.com → Logs — shows all sent emails, delivery status, and any failures
- **Rotate API key:** resend.com → API Keys → create new key → update `RESEND_API_KEY` in Cloudflare Worker secrets (see section 3)

**If welcome emails stop arriving:**
1. Check resend.com → Logs for delivery errors
2. Verify `RESEND_API_KEY` in the Cloudflare Worker is still valid
3. Check Worker logs in Cloudflare dashboard for errors on the `/email` endpoint

**Emails currently sent:**

| Trigger | Recipient | Purpose |
|---------|-----------|---------|
| New user registration | New user's email | Welcome email |

---

### 6. External libraries (CDN-loaded, no account needed)

These load automatically — no maintenance required unless a security fix is released.

| Library | Version | Used for |
|---------|---------|----------|
| Supabase JS | `@2` (latest v2) | Database client |
| Leaflet | `1.9.4` | Interactive wine map |
| Google Fonts | — | Lora + Inter fonts |
| BigDataCloud | — | Reverse geocoding (place names from GPS) |

**To update Leaflet**, change both references in `index.html`:
```html
<!-- In <head>: -->
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.5/dist/leaflet.css"/>
<!-- In JS (search for unpkg.com/leaflet): -->
s.src = 'https://unpkg.com/leaflet@1.9.5/dist/leaflet.js';
```

---

## Routine Maintenance Checklist

### Monthly
- [ ] Check Supabase usage (storage and auth limits)
- [ ] Check Anthropic API usage and costs
- [ ] Check Resend sending logs for delivery failures
- [ ] Verify the site loads and login works
- [ ] Check the contact link works (Cloudflare may have re-obfuscated it)

### Quarterly
- [ ] Review Supabase database size — delete orphaned photos if storage is high
- [ ] Rotate the Anthropic API key (update in Cloudflare Worker)
- [ ] Rotate the Resend API key (update in Cloudflare Worker)
- [ ] Check for Supabase JS library updates

### Annually
- [ ] Renew domain registration
- [ ] Review Supabase plan against actual usage
- [ ] Check Leaflet for security updates

---

## Common Issues & Fixes

| Problem | Likely cause | Fix |
|---------|-------------|-----|
| Contact link gives 404 | Cloudflare re-obfuscated the email | Re-deploy with plain `mailto:` link, or turn off Email Obfuscation in Scrape Shield |
| Label scanning not working | Worker down or bad Anthropic key | Check Worker in Cloudflare; verify key at console.anthropic.com |
| Welcome email not received | Bad Resend key or Worker error | Check resend.com → Logs; verify `RESEND_API_KEY` in Worker secrets |
| Users can't log in | Supabase auth issue | Check Supabase → Authentication → Logs |
| Site not updating after push | Cloudflare cache | Cloudflare → Caching → Purge Everything |
| Map not showing | Leaflet CDN issue | Check browser console; Leaflet loads lazily on first Map view open |
| Photos not saving | Supabase storage full | Check storage in Supabase dashboard |

---

## Taking the Site Offline

**Quickest — maintenance page:**

Replace `index.html` with a holding page and push:

```bash
git add index.html
git commit -m "Maintenance mode"
git push
```

Restore the real site:
```bash
git checkout HEAD~1 -- index.html
git add index.html
git commit -m "Restore site"
git push
```

**Alternative — disable in Cloudflare:**
> Cloudflare → Pages → your project → Settings → Disable project

---

## File Structure

```
index.html              — the whole app (HTML + CSS + JS, ~4,200 lines)
cloudflare-worker.js    — AI scanning + email proxy (deployed separately to Cloudflare Workers)
ADMIN.md                — this guide
```

All changes to the site are made in `index.html`. The Worker is only touched when rotating API keys.

---

## Git Quick Reference

```bash
git status                        # see what's changed
git add index.html
git commit -m "Description"
git push                          # deploys in ~60 seconds

git log --oneline -10             # recent history

# Emergency rollback
git checkout HEAD~1 -- index.html
git add index.html
git commit -m "Rollback"
git push
```

---

## All Admin Links

| Service | URL |
|---------|-----|
| Site | https://weldswine.co.uk |
| Cloudflare dashboard | https://dash.cloudflare.com |
| Supabase dashboard | https://supabase.com/dashboard |
| Anthropic console | https://console.anthropic.com |
| Resend dashboard | https://resend.com |
| Cloudflare Worker | dash.cloudflare.com → Workers & Pages → aged-union-8f0d |