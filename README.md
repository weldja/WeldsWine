# Welds Wine Wisdoms 🍷

A personal wine tasting journal with AI label scanning.
Hosted free on GitHub Pages. AI scanning via Cloudflare Worker (free tier).

---

## One-time Setup

### Step 1 — Add your Cloudflare Worker URL to index.html

Open `index.html` in any text editor and find this line (around line 630):

```js
const WORKER_URL = 'PASTE_WORKER_URL_HERE';
```

Replace `PASTE_WORKER_URL_HERE` with your Worker URL:

```js
const WORKER_URL = 'https://wine-scan.yourname.workers.dev';
```

Save the file.

---

### Step 2 — Push to GitHub and enable GitHub Pages

```bash
# Create a new repo at github.com (call it anything, e.g. "wine-wisdoms")
# Then in this folder:

git init
git add .
git commit -m "Initial deploy"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/wine-wisdoms.git
git push -u origin main
```

Then on GitHub:
- Go to your repo → **Settings** → **Pages**
- Source: **Deploy from a branch**
- Branch: **main** → folder: **/ (root)**
- Click **Save**

Your app will be live at: `https://YOUR_USERNAME.github.io/wine-wisdoms/`

---

## Cloudflare Worker (AI Proxy)

The `cloudflare-worker.js` file is the AI proxy. It's already deployed — 
you just need to put its URL in `index.html` as shown above.

If you need to redeploy it:
1. Open `cloudflare-worker.js`, make sure your Anthropic key is on line ~11
2. Go to dash.cloudflare.com → Workers & Pages → your worker → Edit code
3. Paste the updated file → Deploy

---

## Costs

- **GitHub Pages**: Free forever
- **Cloudflare Worker**: Free (100,000 requests/day)
- **Anthropic API**: ~£0.01 per label scan

---

## For Visitors

Visitors to the app get full functionality including AI label scanning.
All wine data is stored in each visitor's own browser (localStorage) —
there's no shared database, so each person has their own private journal.
