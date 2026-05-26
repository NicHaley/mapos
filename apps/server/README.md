# @mapos/server

HTTP server exposing the `@mapos/contracts` service surface (geocoding, routing, isochrones, tiles) over a versioned JSON API. Same Hono app runs on Cloudflare Workers (`api.mapos.md`) and as a self-hosted Node binary.

## Wire surface

All endpoints are POST + JSON unless noted, prefixed with `/v1`:

| Endpoint                      | Body                       | Response             |
| ----------------------------- | -------------------------- | -------------------- |
| `POST /v1/geocoding/forward`  | `GeocodeForwardRequest`    | `GeocodeResult[]`    |
| `POST /v1/geocoding/reverse`  | `GeocodeReverseRequest`    | `GeocodeResult[]`    |
| `POST /v1/routing/directions` | `RouteDirectionsRequest`   | `Route`              |
| `POST /v1/routing/matrix`     | `RouteMatrixRequest`       | `Matrix`             |
| `POST /v1/isochrones`         | `IsochroneRequest`         | `Isochrone`          |
| `POST /v1/tiles/style-url`    | `TileStyleRequest`         | `{ url: string }`    |
| `GET  /v1/tiles/style.json`   | `?variant=light\|dark`     | MapLibre style JSON  |
| `GET  /v1/tiles/{z}/{x}/{y}.pbf` | —                       | Vector tile bytes    |
| `GET  /v1/healthz`            | —                          | `{ ok: true }`       |

All errors follow the `ErrorResponse` envelope from `@mapos/contracts`.

## Local development

```bash
cp .env.example .env             # then fill in PROTOMAPS_API_KEY
pnpm --filter @mapos/server dev  # wrangler dev on :8787
```

Wrangler 4 reads `.env` natively (same precedence as Cloudflare's older `.dev.vars`). The same `.env` file works for the Node self-hosted path too — `process.env` exposes the same shape that `c.env` does on Workers.

Point the dashboard at `http://localhost:8787` by setting its `services.self_hosted.baseUrl` in `mapos.json`.

## Production

### Cloudflare (managed)

```bash
wrangler secret put PROTOMAPS_API_KEY
pnpm --filter @mapos/server deploy
```

### Self-hosted Node

```bash
pnpm --filter @mapos/server build:node
PROTOMAPS_API_KEY=... pnpm --filter @mapos/server start:node
```

Put Caddy or another reverse proxy in front for TLS. Don't expose this server's port directly.

## Auth

There is no auth in v1. Deploy publicly only with a reverse proxy and IP-based rate limiting; otherwise use it behind a VPN or on localhost.
