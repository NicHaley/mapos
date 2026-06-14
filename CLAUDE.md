# MapOS — Developer Guide

Guidance for working on the **MapOS codebase** (this repo). This file is loaded into Claude Code's context, so it's about *building* MapOS — not the runtime behavior of the in-app agent.

> The in-app agent's system prompt and tools are **not** here. They live in code:
> `apps/dashboard/src/main/mcp-server.ts` (`buildMaposSystemPrompt`, `buildMaposCustomTools`).
> If you change how the shipped agent behaves, edit that file — not this one.

---

## What MapOS is

A local-first, map-first Electron app. The map is the primary interface to a user's
personal files, saved places, and spatial data. Everything runs on the user's machine;
**files in the vault are the source of truth**, and a local SQLite spatial index is a
rebuildable cache over them. The vault (`~/MapOS/`) is also a valid Obsidian vault —
app state lives in `.mapos/`, mirroring Obsidian's `.obsidian/` convention.

---

## Monorepo layout

pnpm + Turbo workspace (`apps/*`, `packages/*`).

| Path | What it is |
|---|---|
| `apps/dashboard` | The Electron desktop app — the product. Main / preload / renderer. Hosts the spatial index, the AI chat agent, map services, and the file watcher. |
| `apps/server` | Hono API proxy for map services (geocode, routing, isochrone, tiles, web search). Runs on Node or as a Cloudflare Worker. Backs the app's **cloud** services mode. |
| `apps/web` | Next.js web client. Early/minimal. |
| `packages/contracts` | Shared Zod schemas for service requests/responses (GeocodeResult, Route, Isochrone, …). |
| `packages/service-adapters` | Pluggable service implementations (Photon, Valhalla, Tavily, MapOS API) behind a common adapter interface. |
| `packages/ui` | Shared React + Tailwind components/hooks, consumed by `apps/dashboard` and `apps/web`. |
| `pipeline/` | Standalone build pipeline that turns Geofabrik OSM extracts into downloadable **region packs** (`.pmtiles`, Valhalla tiles, geocode SQLite) and a manifest on R2. Separate workspace; driven by a `Makefile` + `scripts/`. |

---

## apps/dashboard internals

Electron three-process split with a context-isolated IPC bridge.

**`src/main/`** (Node):
- `index.ts` — app entry: window, session/CSP policy, IPC registration, watcher, updater.
- `chat.ts` — the AI agent loop. Built on the **Pi SDK** (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`) for model resolution + streaming. Owns session state, the undo stack, and wires in the tools/prompt from `mcp-server.ts`.
- `mcp-server.ts` — **the in-app agent's tools and system prompt** (large file). Spatial queries, geocoding/routing wrappers, vault file I/O tools, presentation tools.
- `db.ts` — spatial index (better-sqlite3 + Drizzle). Schema is canonical-string + hash-based drop/recreate migration; rtree bbox virtual table. **Only derived data** — never conversations/undo/config.
- `watcher.ts` — chokidar watch over the vault; parses YAML frontmatter (`gray-matter`), extracts WKT geometry, keeps the index in sync.
- `wkt.ts` / `geo-compute.ts` / `bbox.ts` — WKT↔GeoJSON (`wellknown`) and Turf.js geometry ops.
- `ai.ts` / `ai-auth.ts` / `ai-ipc.ts` — AI provider/model config, secret storage (Electron `safeStorage`), OAuth.
- `services/` — service-mode resolution. `offline/` holds local Photon (geocode SQLite from region packs) and Valhalla (N-API addon, `@valhallajs/valhallajs`) routing; cloud mode proxies to `apps/server`.
- `mapos-config.ts` / `mapos-ipc.ts` — `.mapos/config.json` (canonical user intent) and vault management.
- `region-packs.ts` / `region-protocol.ts` — download/manage region packs; `mapos://` protocol.

**`src/preload/index.ts`** — exposes a namespaced `window.api` (`places.*`, `map.*`, `fs.*`, `chat.*`, `ai.*`, `regions.*`). All payloads are plain JSON.

**`src/renderer/`** — React client (`app.tsx` orchestrates the MapView + chat sidebar). Uses `@mapos/ui` and `maplibre-gl`.

**`src/shared/`** — types shared across main/renderer (`PlaceRecord`, overlay types, AI model/provider types, property inference).

---

## Build / dev / check

```bash
pnpm dev            # run the dashboard (electron-vite dev)
pnpm dev:web        # run the web app
pnpm build          # turbo build all
pnpm typecheck      # tsc --noEmit across the workspace
pnpm lint           # biome lint
pnpm check          # biome check --write (lint + format fix)
```

- **After any code change, run `pnpm typecheck` and `pnpm lint`** before considering it done.
- **No test runner is configured** (no vitest/jest). Typecheck + lint is the gate. Don't claim tests pass — there aren't any.
- Native modules: `better-sqlite3` is rebuilt for Electron via the dashboard `postinstall` (`electron-rebuild`). The pnpm build-script allowlist lives in `pnpm-workspace.yaml` (`onlyBuiltDependencies`).
- Packaging: `electron-vite build` then `electron-builder` (`build:mac` / `build:win` / `build:linux`).

---

## Conventions

- **Geometry is WKT** in place-file frontmatter (`geometry: "POINT(lng lat)"`), converted to GeoJSON for queries/render. Point, LineString, Polygon. Use Turf for computation — there are no spatial SQL `ST_*` functions. `geometry` and `color` are reserved frontmatter keys (special meaning to the renderer).
- **Files are the source of truth.** `index.db` is a derived cache (sync-excluded, rebuildable). User intent lives in `.mapos/config.json`; conversations/undo in `.mapos/conversations/`. Never persist canonical state only in the index.
- **All vault mutations go through the file-write path** so the index and undo stack stay in sync — the in-app agent uses `write_vault_file` / `delete_vault_file` / `rename_vault_file`, never raw writes.
- **Style is Biome-enforced** — don't hand-format; run `pnpm check`.
- **Local vs cloud services** is a config mode (`services.mode`). Local needs downloaded region packs; cloud proxies to `apps/server`. Keep both paths working when touching `services/`.
- Code style: match the surrounding file. Comments are sparse and reserved for non-obvious logic.
