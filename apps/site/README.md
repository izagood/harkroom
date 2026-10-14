# apps/site — the Harkroom landing page

A single static page in two languages: English at `/` and Korean at `/ko/`. No framework, no
dependencies, no external requests (no web fonts, no analytics) — the nginx CSP enforces that.

```
build.mjs      one template + the English/Korean copy → dist/
src/           site.css · site.js (first-visit language redirect, copy button) · favicon · robots.txt
nginx.conf     port 8080, /healthz, CSP and cache headers
Dockerfile     node (build) → nginx-unprivileged (serve)
```

```sh
node apps/site/build.mjs && npx serve apps/site/dist      # preview
docker build -t harkroom-site apps/site && docker run --rm -p 8080:8080 harkroom-site
```

## Image

`.github/workflows/site-image.yml` builds on every pull request that touches this folder (build +
smoke test only) and pushes `ghcr.io/izagood/harkroom-site` on main:

| | |
|---|---|
| Tags | `:sha-<7>` per commit (pin this), `:main` |
| Platforms | `linux/amd64`, `linux/arm64` |
| Port | `8080` (non-root, uid 101) |
| Health | `GET /healthz` → `200 ok` |

Changes here do not trigger an app release (`release.yml` ignores `apps/site/**`).

## Language redirect

The first visit to `/` from a browser whose first language is Korean goes to `/ko/`. The choice
is stored in `localStorage` (`harkroom-lang`) — automatically on that first visit, or when the
visitor clicks the language link — and the page never redirects again. If storage is blocked the
page never redirects, so the English page stays reachable.
