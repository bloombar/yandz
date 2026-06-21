# Y and Z

**Collaboratively remix any web page.** Y and Z is a browser extension that lets
anyone visually modify the front-end of any web page — replace text, swap images,
override CSS, change attributes, draw freehand, and annotate/highlight — and save
those changes as structured **patches**. When another user with the extension visits
the same URL, the patches are re-applied to their view. Many users can modify the same
page, producing multiple ranked **versions** you can fork, vote on, and discuss.

> ⚠️ **Trust & safety model — read this first.** Y and Z replays user-authored DOM
> changes in other people's browsers on third-party sites. That is inherently a
> content-injection surface. We mitigate it by design:
> - **No arbitrary HTML injection** — only a fixed set of typed, whitelisted operations.
> - **Sanitization on save (server) and before apply (client)** via DOMPurify + an
>   attribute/CSS whitelist.
> - **One-time per-site consent** — pages are never silently modified on first visit;
>   the user opts in per origin before the top version auto-applies.
> - **Moderation hooks** — author/date/lineage audit trail, reporting, rate limiting,
>   and image re-hosting through our own storage.
>
> Operating this publicly still carries real legal/abuse exposure (defacement,
> phishing, defamation, IP/DMCA). A Terms of Service, takedown flow, and active
> moderation are prerequisites for launch.

---

## How it works

```
 Edit (pick element → choose op)         Visit a modified page
        │                                        │
        ▼                                        ▼
 fingerprint element                    GET /pages?url=…  (block-filtered,
 build typed Patch  ── POST /versions ─▶  ranked for viewer)
 (sanitized)              │                       │
                          ▼                       ▼
                     MongoDB (metadata)    content script applies the top
                     MinIO/S3 (images)     version's patches via the
                                           multi-strategy matcher (+ MutationObserver)
```

A **Patch** targets a DOM element by a *multi-strategy fingerprint* (CSS selector →
XPath → attribute fingerprint → text fingerprint → DOM path) so it survives page
changes and SPAs. A **Version** is an ordered patch set; forking clones a version and
records its parent for attribution.

## Architecture

Monorepo with three npm workspaces:

| Workspace | Stack | Responsibility |
|-----------|-------|----------------|
| `shared/` | TypeScript | Patch schema + sanitization whitelist, ranking math. Pure, 100%-covered. |
| `server/` | Express · Mongoose · Socket.IO | REST API, auth, versions/votes/comments, social graph, presigned uploads, push fan-out, realtime rooms. |
| `extension/` | WXT · React · TypeScript | One shared codebase building for **Chromium (MV3)** and **Firefox**. Content script (patch engine, floating icon, picker), background SW, side panel UI. |

- **Element targeting:** `@medv/finder` (dynamic-class-stripped) + custom matcher cascade.
- **Drawing:** `perfect-freehand` on an SVG overlay. **Icons:** `lucide-react`.
- **Ranking:** Reddit "hot" (net votes + recency) **+ a per-viewer follow-boost**; Wilson score for the "Top" tab.
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

- **Chromium (Chrome/Brave/Edge):** `chrome://extensions` → enable *Developer mode* →
  **Load unpacked** → select `extension/.output/chrome-mv3` (dev build:
  `chrome-mv3-dev`).
- **Firefox:** `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** →
  pick `extension/.output/firefox-mv2/manifest.json` (or use `web-ext run`).

Dev resources are isolated from anything else sharing your local servers:
**Mongo database** `yandz_dev`, **MinIO bucket** `yandz-assets`.

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
