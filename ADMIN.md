\# Welds Wine — Admin \& Maintenance Guide



\*\*Site:\*\* https://weldswine.co.uk  

\*\*Last updated:\*\* March 2026



\---



\## Overview



The site is a single-file HTML/CSS/JS app (`index.html`). There is no build system, no npm, no framework. To update the site you edit the file and push to Git — Cloudflare Pages deploys automatically.



\---



\## Infrastructure at a Glance



| What | Service | Where to manage |

|------|---------|----------------|

| Hosting \& CDN | Cloudflare Pages | dash.cloudflare.com → Pages |

| Domain \& DNS | Cloudflare | dash.cloudflare.com → DNS |

| Database \& Auth | Supabase | supabase.com → your project |

| AI label scanning | Anthropic Claude (via Cloudflare Worker) | console.anthropic.com |

| Maps | OpenStreetMap / Leaflet (no account needed) | — |

| Fonts | Google Fonts (no account needed) | — |

| Reverse geocoding | BigDataCloud (free tier, no account) | — |



\---



\## Deployments



\### How to deploy a change



```bash

\# Edit index.html, then:

git add index.html

git commit -m "Description of change"

git push

```



Cloudflare Pages picks up the push and deploys within \~60 seconds. No build step needed.



\### Rollback



In Cloudflare Pages dashboard → your project → Deployments → click any previous deployment → \*\*Rollback to this deployment\*\*.



\---



\## Services \& Credentials



\### 1. Supabase (database + authentication)



\*\*What it does:\*\* Stores all wine records, user accounts, photos, and handles login.



\*\*Where:\*\* supabase.com → Project: `phcnswuwrqarikzjvfqd`



\*\*Key credentials in `index.html`:\*\*

```js

const SUPABASE\_URL = 'https://your-project.supabase.co';

const SUPABASE\_ANON\_KEY = 'your-anon-key';

```



\*\*Routine tasks:\*\*

\- \*\*Monitor usage:\*\* Supabase dashboard → Usage. Free tier allows 500MB storage and 50,000 monthly active users.

\- \*\*Backups:\*\* Supabase auto-backs up on paid plans. On free tier, export manually: Table Editor → Export as CSV.

\- \*\*Auth settings:\*\* Authentication → Settings. Email confirmations and password resets are configured here.

\- \*\*If users can't log in:\*\* Check Authentication → Logs for errors.



\*\*Free tier limits to watch:\*\*

\- 500MB database storage

\- 1GB file storage (wine label photos)

\- 50,000 monthly active users



If you approach limits, upgrade to Supabase Pro (\~$25/month) or delete old photo data.



\---



\### 2. Cloudflare (hosting, DNS, CDN)



\*\*What it does:\*\* Hosts the site, manages the domain, provides CDN caching, and runs the AI scanning Worker.



\*\*Where:\*\* dash.cloudflare.com



\*\*Pages deployment:\*\*

\- Project name: `weldswine` (or similar)

\- Branch: `main`

\- Build command: \*(none — static file)\*

\- Publish directory: `/` or root



\*\*DNS:\*\*

\- The domain `weldswine.co.uk` points to Cloudflare Pages via a CNAME record.

\- Do not delete or change the `CNAME` pointing to `\*.pages.dev`.



\*\*Email obfuscation (known issue):\*\*

Cloudflare automatically obfuscates email addresses in HTML. This breaks the contact link. If it breaks again:

\- Option A: Go to \*\*Cloudflare → Scrape Shield → Email Address Obfuscation → Off\*\*

\- Option B: Re-deploy `index.html` with the plain `mailto:james\_weld@yahoo.com` link



\---



\### 3. Cloudflare Worker (AI label scanning)



\*\*What it does:\*\* Acts as a secure proxy between the app and Anthropic's Claude API. The Anthropic API key lives in the Worker, not in the public HTML.



\*\*Worker URL:\*\* `https://aged-union-8f0d.james-weld.workers.dev`



\*\*Where:\*\* dash.cloudflare.com → Workers \& Pages → `aged-union-8f0d`



\*\*To update the Anthropic API key:\*\*

1\. Go to the Worker in the Cloudflare dashboard

2\. Edit `cloudflare-worker.js`

3\. Replace the value of `PASTE\_YOUR\_KEY\_HERE` with your new key from console.anthropic.com

4\. Save and deploy



\*\*If scanning stops working:\*\*

\- Check the Worker is deployed and active (dash.cloudflare.com → Workers)

\- Check the Anthropic API key is valid (console.anthropic.com → API Keys)

\- Check Anthropic usage limits haven't been hit (console.anthropic.com → Usage)



\---



\### 4. Anthropic (AI label scanning)



\*\*What it does:\*\* Powers the wine label photo scanning feature.



\*\*Where:\*\* console.anthropic.com



\*\*Routine tasks:\*\*

\- Monitor API usage and costs monthly

\- Rotate API keys periodically (update in the Cloudflare Worker after rotating)

\- Current model used: Claude (via the Worker proxy)



\*\*Costs:\*\* Pay-per-use. Label scanning uses vision tokens. Typical cost is a few pence per scan. Monitor at console.anthropic.com → Usage.



\---



\### 5. External libraries (CDN-loaded, no account needed)



These load automatically — no maintenance required unless you want to pin versions.



| Library | Version | Used for |

|---------|---------|----------|

| Supabase JS | `@2` (latest v2) | Database client |

| Leaflet | `1.9.4` | Interactive wine map |

| Google Fonts | — | Lora + Inter fonts |

| BigDataCloud | — | Reverse geocoding (location names) |



\*\*To update Leaflet\*\* (if a security fix is needed):

In `index.html`, change both lines:

```html

<!-- from -->

<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>

<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>

<!-- to -->

<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.5/dist/leaflet.css"/>

```

Check the \[Leaflet changelog](https://leafletjs.com/2022/09/21/leaflet-1.9.0.html) before upgrading.



\---



\## Routine Maintenance Checklist



\### Monthly

\- \[ ] Check Supabase usage (storage and auth limits)

\- \[ ] Check Anthropic API usage and costs

\- \[ ] Verify the site loads and login works

\- \[ ] Check the contact link works (Cloudflare may re-obfuscate it)



\### Quarterly

\- \[ ] Review Supabase database size — delete orphaned photos if storage is high

\- \[ ] Rotate the Anthropic API key as a precaution

\- \[ ] Check for Supabase JS library updates (change `@2` to a specific version if needed)



\### Annually

\- \[ ] Renew domain registration (via Cloudflare Registrar or your registrar)

\- \[ ] Review Supabase plan — check if free tier still covers usage

\- \[ ] Check Leaflet for security updates



\---



\## Common Issues \& Fixes



| Problem | Likely cause | Fix |

|---------|-------------|-----|

| Contact link gives 404 | Cloudflare re-obfuscated the email | Re-deploy with plain `mailto:` link, or turn off Email Obfuscation in Cloudflare Scrape Shield |

| Label scanning not working | Worker down or bad API key | Check Worker status in Cloudflare dashboard; verify Anthropic key |

| Users can't log in | Supabase auth issue | Check Supabase → Authentication → Logs |

| Site not updating after push | Cloudflare cache | Purge cache: Cloudflare → Caching → Purge Everything |

| Map not showing | Leaflet CDN issue | Check browser console; Leaflet loads lazily only when Map view is opened |

| Photos not saving | Supabase storage full | Check storage usage in Supabase dashboard |



\---



\## File Structure



The entire site is a \*\*single file\*\*:



```

index.html        — the whole app (HTML + CSS + JS, \~4,200 lines)

cloudflare-worker.js  — the AI scanning proxy (deployed separately to Cloudflare Workers)

```



All changes to the site are made in `index.html`. The Worker is only touched when updating the Anthropic API key.



\---



\## Git Repository



```bash

\# Check current status

git status



\# Deploy a change

git add index.html

git commit -m "Brief description"

git push



\# See recent history

git log --oneline -10

```



\---



\## Emergency Contacts \& Links



| Service | URL |

|---------|-----|

| Cloudflare dashboard | https://dash.cloudflare.com |

| Supabase dashboard | https://supabase.com/dashboard |

| Anthropic console | https://console.anthropic.com |

| Cloudflare Workers | https://dash.cloudflare.com → Workers \& Pages |

| Site | https://weldswine.co.uk |

