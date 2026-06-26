# Y and Z

Collaboratively modify any web page.

`Y and Z` is a browser extension that lets anyone modify any web page.

Replace text, swap images, restyle, annotate, and draw freehand on any page, then save your changes as a new **version**. Each version is scoped by its creator to a single **page**, a whole **site**, or **globally** (every site).

Other users discover versions in scoped feeds, **opt in** to the ones they want, and those activated versions auto-apply on matching pages from then on. Many can layer at once — globals under site versions under page versions — and an "applied here" bar lets you toggle or remove each. The community votes on, discusses, and forks every version, creating a truly living Web.

## Disclaimer

> ⚠️ **Trust & safety model** Y and Z replays user-authored DOM changes in other people's browsers on third-party sites. That is inherently a content-injection surface. We mitigate it by design:
>
> - **No arbitrary HTML injection** — only a fixed set of typed, whitelisted operations.
> - **Sanitization on save (server) and before apply (client)** via DOMPurify + an attribute/CSS whitelist.
> - **One-time global consent + per-version opt-in** — pages are never silently modified:
>   the user grants consent once before Y and Z applies anything anywhere, and then
>   explicitly activates each version they want applied (nothing auto-applies on its own).
> - **Moderation hooks** — author/date/lineage audit trail, reporting, rate limiting, and image re-hosting through our own storage.
>
> Operating this publicly still carries real legal/abuse exposure (defacement, phishing, defamation, IP/DMCA). A Terms of Service, takedown flow, and active moderation are prerequisites for launch.

---

## How it works

```
 Edit (pick element → choose op,          Visit a page (after consent)
       set scope: page/site/global)               │
        │                                          ▼
        ▼                              GET /me/activations?url=…  (your active
 fingerprint element                    versions relevant to this page:
 build typed Patch  ── POST /versions ─▶ all globals + matching site + matching page)
 (sanitized)              │                        │
                          ▼                        ▼
                     MongoDB (metadata)    content script LAYERS their patches
                     MinIO/S3 (images)     (global < site < page) via the
                                           multi-strategy matcher (+ MutationObserver)
```

A **Patch** targets a DOM element by a _multi-strategy fingerprint_ (CSS selector →
XPath → attribute fingerprint → text fingerprint → DOM path) so it survives page
changes and SPAs. A **Version** is an ordered patch set with a **scope** (`page` /
`site` / `global`) chosen by its creator; forking clones a version and records its
parent for attribution.

**Activation** is a per-user opt-in: a viewer activates the versions they want, and the
content script applies every activated version relevant to the page they're on, layered
by scope. A viewer can have many active versions of each scope; the "applied here" bar
pauses or removes any of them. (`GET /pages?url=…` still serves a page's versions for
discovery and the floating-icon count.)

## Architecture

Monorepo with three npm workspaces:

| Workspace    | Stack                          | Responsibility                                                                                                                                           |
| ------------ | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/`    | TypeScript                     | Patch schema + sanitization whitelist, ranking math. Pure, 100%-covered.                                                                                 |
| `server/`    | Express · Mongoose · Socket.IO | REST API, auth, versions/votes/comments, social graph, presigned uploads, push fan-out, realtime rooms.                                                  |
| `extension/` | WXT · React · TypeScript       | One shared codebase building for **Chromium (MV3)** and **Firefox**. Content script (patch engine, floating icon, picker), background SW, side panel UI. |

- **Element targeting:** `@medv/finder` (dynamic-class-stripped) + custom matcher cascade.
- **Drawing & annotations:** `perfect-freehand` on an SVG overlay, anchored to a page element (positions stored as percentages so they track the element on scroll/resize). **Icons:** `lucide-react`.
- **Feeds:** four tabs — **Latest** (page modifications everywhere), **This page**, **This site**, **Global** — each with All / Following / Mine / Bookmarked filters and a **Your feed** / **Latest** sort.
- **Ranking:** "Your feed" blends Wilson vote-quality + a per-viewer follow-boost + bounded recency; "Latest" is strictly chronological. Applied within whichever scope feed you're viewing.
- **Cross-browser:** a single shim, [`extension/lib/browser-surface.ts`](extension/lib/browser-surface.ts), isolates the only real divergence (Chromium `sidePanel` vs Firefox `sidebar_action`, push availability). No per-browser forks.

## Prerequisites

- **Node 20+**
- A running **MongoDB** (a local instance is fine; we use an isolated database).
- A running **MinIO** (S3-compatible) for dev image storage.
- **Chrome/Brave/Edge** or **Firefox**.
- A **Google OAuth client ID** (optional, for Google sign-in) and **VAPID keys**
  (optional, for push): `npx web-push generate-vapid-keys`.

## Development install

```bash
npm install                       # installs all workspaces

# 1. Configure the server (local Mongo + local MinIO, isolated DB/bucket)
cp server/.env.development.example server/.env.development
#   edit MONGO_URI / S3_* as needed

# 2. Run backend + extension dev builds
npm run dev:server                # Express + Socket.IO on :4000
npm run dev:ext                   # WXT dev build (Chromium)
npm run dev:ext:firefox           # WXT dev build (Firefox)
```

Then load the unpacked extension:

- **Chromium (Chrome/Brave/Edge):** `chrome://extensions` → enable _Developer mode_ →
  **Load unpacked** → select `extension/output/chrome-mv3` (dev build:
  `chrome-mv3-dev`).
- **Firefox:** `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** →
  pick `extension/output/firefox-mv2/manifest.json` (or use `web-ext run`).

Dev resources are isolated from anything else sharing your local servers:
**Mongo database** `yandz_dev`, **MinIO bucket** `yandz-assets`.

## Dev mode (live reload)

For day-to-day development, run the WXT dev server instead of rebuilding by hand.
WXT watches your source and pushes updates into the browser automatically, so you
load the extension **once**.

```bash
# 1. (optional) Seed the dev DB with mock data on real sites.
npm run seed --workspace=server     # 5 users (password: password123); page/site/global
                                    # versions across real pages; follows, votes,
                                    # bookmarks, and a few activations
# One-off: migrate legacy per-patch scope → per-version scope (dev DBs only).
npm run migrate:scope --workspace=server

# 2. Start the API (auto-restarts on change via tsx watch).
npm run dev:server                  # http://localhost:4000

# 3. Start the extension dev server (HMR + auto-reload).
npm run dev:ext                     # Chromium   → extension/output/chrome-mv3-dev
npm run dev:ext:firefox             # Firefox     → extension/output/firefox-mv2-dev
```

Load the **dev** build once (note the `-dev` suffix):

- **Chromium:** `chrome://extensions` → _Developer mode_ → **Load unpacked** →
  `extension/output/chrome-mv3-dev`.
- **Firefox:** `npm run dev:ext:firefox` opens a browser with the add-on loaded
  automatically (via `web-ext`); no manual step needed.

> ⚠️ Don't load the production `output/chrome-mv3` folder for development — it isn't
> watched, so every change would require a rebuild + manual reload. Use the `-dev`
> build.

What reloads automatically once the dev server is running:

| You change…                                                      | What happens                                                                                                 |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Side panel / React UI**                                        | Hot Module Replacement — updates live, no reload (React state is preserved).                                 |
| **Content script** (engine, picker, overlay)                     | WXT reloads the extension; **refresh the web page** so the new content script re-injects.                    |
| **Background service worker**                                    | WXT reloads the extension automatically.                                                                     |
| **`shared/` code**                                               | Bundled into the extension — picked up by the watcher like any source.                                       |
| **API / `server/` code**                                         | `tsx watch` restarts the server; no extension reload needed.                                                 |
| **`wxt.config.ts` / manifest** (permissions, entrypoints, icons) | Needs a **manual reload** in `chrome://extensions` (the ↻ button), and occasionally a fresh _Load unpacked_. |

The dev server keeps `VITE_API_BASE` pointed at `http://localhost:4000`; override it
(and `VITE_GOOGLE_CLIENT_ID` / `VITE_VAPID_PUBLIC_KEY` for Google sign-in and push) in
an `extension/.env` file if needed. The editor **auto-saves** the current version,
debounced by `VITE_AUTOSAVE_DEBOUNCE_MS` (default `1500`) — edits made within that
window of each other coalesce into the same version.

## Production install

```bash
cp server/.env.production.example server/.env.production   # real secrets via your secrets manager
npm run build                     # builds shared, server, and the Chromium extension
npm run build:firefox  --workspace=@yandz/extension
npm run zip            --workspace=@yandz/extension        # store-ready zips
```

- Server points at managed MongoDB (`yandz`) + **AWS S3 + CloudFront** (set
  `S3_PUBLIC_BASE_URL` to the CloudFront URL; leave `S3_ENDPOINT` unset for AWS).
- End users install from the **Chrome Web Store** / **AMO** / **Edge Add-ons** listings.

The dev↔prod switch is a single source of truth: [`server/src/config.ts`](server/src/config.ts)
reads `NODE_ENV` + env vars; the same S3 client code targets MinIO or AWS.

## Configuration reference

See `server/.env.development.example` and `server/.env.production.example` for every
variable (Mongo URI/DB, S3 endpoint/region/bucket/keys/public URL, JWT secret, Google
client ID, VAPID keys, CORS origins). The extension reads `VITE_API_BASE` (defaults to
`http://localhost:4000`).

## Testing

```bash
npm test                          # all workspaces: unit + integration
npm run test:coverage --workspaces

# Targeted:
npm run test --workspace=shared              # pure schema + ranking (100% coverage)
npm run test --workspace=server              # API integration (in-memory Mongo)
npm run test --workspace=@yandz/extension    # patch engine + diff (jsdom)

# Full-stack live tier (real server + live MongoDB + live MinIO):
docker compose -f docker-compose.test.yml up -d
npm run test:live --workspace=server

# End-to-end (Playwright drives a real Chromium with the extension loaded):
npm run test:e2e
```

The suite spans **front-end** (engine/UI), **back-end** (API/services), an
**integrated full-stack** tier against live MongoDB + MinIO, and **Playwright e2e**.
Coverage thresholds are enforced in CI (see each workspace's `vitest.config.ts`).
