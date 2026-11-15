# Cloudflare frontend (Worker + static assets)

The storefront can also be served from **Cloudflare**, with Google Apps Script and Google
Sheets staying the backend. The Apps Script website keeps working the whole time. Both sites
use the same backend code, the same Products and Orders tabs and the same order pipeline.

The Cloudflare project is a **Worker with static assets**, deployed by Cloudflare's Git
integration (Workers Builds), which runs `npx wrangler deploy` on each push. It is served
on a temporary `*.workers.dev` address only. Nothing here connects `theredclothes.com` or
changes DNS; see [Custom domain](#custom-domain-later-not-part-of-this-step).

---

## How it fits together

```text
Browser ── https://theredclothes.<your-subdomain>.workers.dev ─────────────────────────┐
  /, /styles.css, /app.js, /logic.js, /api.js, /assets/*  → static assets (cloudflare/public)
  GET  /api/config   ─┐                                                                │
  GET  /api/products ─┼─ Worker (cloudflare/worker.js → cloudflare/api/*.js) ───────────┘
  POST /api/orders   ─┘        │  server-side only: APPS_SCRIPT_URL, WEBHOOK_SECRET
                               ▼
              Apps Script web app (/exec)   doGet ?action=config|products, doPost
                               │  302 → script.googleusercontent.com (followed by hand,
                               ▼        Google hosts only)
              Products / Orders tabs, MailApp notification (unchanged)
```

| Browser call | Worker handler | Apps Script | Same code as the Apps Script site |
|---|---|---|---|
| `GET /api/config` | `cloudflare/api/config.js` | `doGet?action=config` | `getPublicConfig_()` (what the Apps Script page embeds) |
| `GET /api/products` | `cloudflare/api/products.js` | `doGet?action=products` | `getProducts()` |
| `POST /api/orders` | `cloudflare/api/orders.js` | `doPost` | `processOrder_()` (validation, sheet prices and stock, lock, idempotency, order ID, email) |

What the Worker adds on top of the backend's own checks:

- The Apps Script URL and the shared secret live only in Cloudflare secrets. The browser
  only ever talks to `/api/...` on its own site.
- Only the configured `APPS_SCRIPT_URL` is called (it must be a `script.google.com/.../exec`
  URL). Redirects are followed by hand and only to `https://script.googleusercontent.com` or
  `https://script.google.com`. A POST is never re-sent.
- Only a JSON answer from Google with the expected shape is accepted. HTML (Google sign-in
  or error pages), empty or opaque answers, and malformed JSON are refused. Only known
  fields are passed to the browser.
- An order reference is shown only when the backend answered `success: true` with a
  five-digit `orderId` and a numeric `total`. If the answer is lost or unclear, the
  customer gets "could not confirm — press Reserve Order again". The retry carries the
  same idempotency key, so it returns the original order instead of saving a second one.
- Orders must come from the site itself (`Origin` check), as JSON, at most 32 KB, and with
  a valid idempotency key. A `secret` sent by a client is discarded; the real one is
  added server-side.

### Files

```text
wrangler.jsonc               Worker config: name, main, build command, static assets dir
package.json                 pins wrangler; npm scripts (build, dev, check, test, deploy)
tools/build_cloudflare.mjs   builds cloudflare/public/ from src/ (plain Node, no dependencies)
cloudflare/
├── worker.js                entry point: /api/* → handlers, everything else → static assets
├── api/                     config.js, products.js, orders.js (the API handlers)
├── lib/                     shared server code (Apps Script client, config helpers)
├── web/api.js               browser StoreApi (fetch adapter)
├── web/_headers             security headers (CSP etc.) and asset caching
└── public/                  BUILD OUTPUT, git-ignored, regenerated on every deploy
```

The static files are **generated** from `src/` (`Index.html`, `Styles.html`, `Logic.html`,
`Scripts.html`, `Logo.html` and `assets/`), so there is one copy of the UI. Only the backend
adapter differs: `src/Api.html` uses `google.script.run`, and `cloudflare/web/api.js` uses
`fetch('/api/...')`. `wrangler deploy` runs the build itself (the `build.command` in
`wrangler.jsonc`), so a fresh clone deploys without any manual step.

---

## Environment variables

### Cloudflare (Worker → Settings → Variables and Secrets, type **Secret**)

| Name | Required | Value |
|---|---|---|
| `APPS_SCRIPT_URL` | Yes | The `/exec` URL of the Apps Script **API deployment** (step 1.3), e.g. `https://script.google.com/macros/s/AKfy…/exec` |
| `WEBHOOK_SECRET` | Yes | A long random string (at least 16 characters; 64 hex characters recommended). Must equal the Apps Script property below. Without it, `/api/orders` refuses orders ("Ordering is temporarily unavailable"). |

Use type **Secret**, not plain text: secrets are encrypted and survive every `wrangler deploy`.
They are never in the repository or the browser. For `npx wrangler dev`, put them in
`.dev.vars` at the repository root (git-ignored):

```ini
APPS_SCRIPT_URL=https://script.google.com/macros/s/…/exec
WEBHOOK_SECRET=…
```

### Apps Script (Project Settings → Script Properties)

| Property | Change |
|---|---|
| `WEBHOOK_SECRET` | **New**: the same value as the Cloudflare secret. `doPost` then refuses any order without it. The Apps Script website is not affected (it uses `google.script.run`, not `doPost`). |
| `NOTIFICATION_EMAIL`, `SPREADSHEET_ID` | Unchanged |

Generate a secret with either of:

```bash
openssl rand -hex 32
python3 -c "import secrets; print(secrets.token_hex(32))"
```

---

## Deploy

### 1. Apps Script backend (the existing site keeps running)

1. **Update `Code.gs`** in the Apps Script editor with the version in `src/Code.gs`. It is the
   only backend file that changed:
   - `doGet` answers `?action=config` with the public config (the same object the page
     already embeds). All other requests behave as before.
   - `doPost` compares `WEBHOOK_SECRET` in constant time.

   Save. Saving alone does not change any deployment.
2. **Add the script property** `WEBHOOK_SECRET` (see above).
3. **Create a separate API deployment**: **Deploy → New deployment** → type **Web app** →
   *Execute as*: **Me**, *Who has access*: **Anyone** → **Deploy**. Copy the new
   `/exec` URL; this is `APPS_SCRIPT_URL`.

   Do **not** edit or delete the existing deployment. Its URL and version stay exactly as
   they are, so the current Apps Script website is untouched.
4. Check it: open `<new URL>?action=config` and `<new URL>?action=products` in a private
   browser window. Both should show JSON starting with `{"success":true`.

### 2. Cloudflare Worker (Git integration)

Check the Worker's settings in the dashboard (**Workers & Pages → your Worker → Settings →
Build**):

| Setting | Value |
|---|---|
| Git repository | `ahmedemad9/theredclothes`, branch `main` |
| Root directory | `/` (empty) |
| Build command | empty, or `npm run build` (both work; `wrangler deploy` builds anyway) |
| Deploy command | `npx wrangler deploy` |

The Worker's **name in the dashboard must equal `"name"` in `wrangler.jsonc`**
(`theredclothes`). If yours is different, change that one line; otherwise the build fails
with a name mismatch.

Then:

1. Add the two **secrets** under **Settings → Variables and Secrets**. If the Worker does
   not exist yet, add them after the first successful build. Until then, the site loads
   but shows "catalog unavailable".
2. **Push to `main`.** Every push to `main` triggers a build and deploy. The build log shows
   `[custom build] Running: node tools/build_cloudflare.mjs`, then `Read 12 files from the
   assets directory`, then the `workers.dev` address.

From your own computer instead (optional):

```bash
npm install
npx wrangler login
npx wrangler secret put APPS_SCRIPT_URL
npx wrangler secret put WEBHOOK_SECRET
npm run check      # wrangler deploy --dry-run: builds and validates, uploads nothing
npm run deploy     # wrangler deploy
```

> Do not upload the folder by drag-and-drop in the dashboard. That would skip the Worker
> code, so `/api/*` would not exist.

### 3. Check the workers.dev site

1. Products load, category filters work, colour bubbles switch images, sizes follow the
   colour, the second image shows in the product popup, and the cart survives a reload.
2. Both the desktop and the mobile background play (resize the window or use the phone).
3. Open `https://<your workers.dev address>/api/products`. It should show JSON with your
   products.
4. Placing a real order is up to you. It goes into the same Orders tab and sends the
   normal email. If you place one to test, set its status to `Cancelled` afterwards.

Logs: open the Worker's **Logs** tab in the dashboard, or run `npx wrangler tail`. They
show backend problems, such as a wrong URL or a secret mismatch.

---

## Day-to-day changes

| You change | Apps Script website | Cloudflare site |
|---|---|---|
| Products / stock in the sheet | immediate | immediate (never cached) |
| `Config.gs` (theme, categories, contact, …) | new version of the **website** deployment | new version of the **API** deployment |
| Other `.gs` files | new version of the **website** deployment | new version of the **API** deployment |
| `Index/Styles/Logic/Scripts.html`, `assets/` | new version of the **website** deployment | push to `main` (rebuilt from `src/`) |

"New version" means **Deploy → Manage deployments → (pick the deployment) → Edit → Version:
New version → Deploy**.

Differences between the two sites:

- **Cart.** It is kept per website address (browser storage), so a cart started on the Apps
  Script site does not appear on the Cloudflare site, and the reverse.
- **Tab icon and title.** The Cloudflare site uses `assets/favicon.png`, not
  `FAVICON_URL`. Its title uses `STORE_NAME` at build time.
- **Backgrounds.** Empty `CONFIG.BACKGROUND` entries use the GIFs deployed with the site
  (`assets/`). Links you put there are used instead.

---

## Tests

All of these run offline. No Google service is contacted and no real order is placed.

```bash
npm run check                                         # build + wrangler config validation
.venv/bin/python tests/run_tests.py                   # backend + frontend logic (V8)
npm test                                              # Worker routing, API handlers, fetch adapter
.venv/bin/python tests/ui_test.py                     # browser tests, Apps Script preview
.venv/bin/python tests/ui_test.py --cloudflare        # same browser tests, Cloudflare build
```

`tests/cloudflare/google-sim.mjs` runs the real `.gs` files on the mock spreadsheet behind a
fake Google that answers like Apps Script does (302 to a one-time
`script.googleusercontent.com` link). The `--cloudflare` browser run sends every request
through the real `worker.js` and applies `_headers`, so the Content-Security-Policy is
tested as well.

---

## Rollback

Customers keep using the Apps Script site until you choose otherwise, so rollback is simple.

- **Cloudflare site**: in the dashboard, go to **Workers & Pages → theredclothes →
  Deployments** and roll back to an earlier version (or run `npx wrangler rollback`). To
  stop automatic deploys, disconnect the repository under **Settings → Build**. No domain
  or DNS is involved.
- **Apps Script API deployment**: open **Deploy → Manage deployments**, select the API
  deployment and choose **Archive**. Its `/exec` URL stops working; the website deployment
  is not affected.
- **`Code.gs`**: the change only adds behaviour, so the old website deployment does not
  need it. To restore the previous file, run
  `git show c7aeee3:src/Code.gs` and paste the result into the editor.
- **`WEBHOOK_SECRET` property**: you can leave it; nothing else uses `doPost`.

---

## Custom domain later (not part of this step)

When the workers.dev site has been checked, `theredclothes.com` can be attached in the
Worker's **Settings → Domains & Routes → Add → Custom domain**. Cloudflare then adds the DNS
record itself. This has deliberately **not** been done or configured here.
