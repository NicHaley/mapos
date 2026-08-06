# @mapos/dashboard

The MapOS desktop app. Electron, with a three-process split (main / preload / renderer)
behind a context-isolated IPC bridge.

Start with the [root README](../../README.md) for what MapOS is and how to run the
workspace. This file covers the app package specifically.

## Commands

Run these from the repo root as `pnpm dev`, or from here directly.

```sh
pnpm dev              # electron-vite dev
pnpm typecheck        # tsc -b --noEmit
pnpm test             # vitest, main-process logic only
pnpm test:watch

pnpm build:mac        # packages for Apple Silicon
pnpm build:win
pnpm build:linux
```

`build:*` runs `fetch:assets` first, which downloads the basemap glyphs and sprites into
`resources/basemap-assets/` (gitignored). It also requires `world.pmtiles` to already be
there, and fails loudly if it isn't, because the app would otherwise ship with no
low-zoom backdrop. That file comes from the region-pack pipeline, which is a separate
project.

Signing and notarization need Apple credentials in `.env` (see `.env.example`). Without
them, `build:mac` produces an unsigned build. `build:unpack` skips packaging entirely and
is the fastest way to check a packaged layout.

## Layout

**`src/main/`** (Node)

| File | Role |
|---|---|
| `index.ts` | App entry: window, session and CSP policy, IPC registration, watcher, updater. |
| `mcp-server.ts` | The MCP tool set and system prompt. `buildMaposCustomTools` returns the tools, `buildMaposSystemPrompt` the instructions. |
| `mcp/` | The runtime serving those tools: `manager.ts` (in-process Streamable HTTP listener), `bridge.ts` (tool definitions onto the MCP `Server`), `auth.ts` (bearer-token gate). |
| `db.ts` | Spatial index (better-sqlite3 + Drizzle). Derived data only, never config. |
| `watcher.ts` | Chokidar watch over the vault. Parses frontmatter, extracts WKT geometry, keeps the index in sync. |
| `services/` | Service-mode resolution. `offline/` holds local Photon geocoding and Valhalla routing; cloud mode proxies to `apps/server`. |
| `vault-path.ts` | The write-safety boundary. Confines every agent tool's paths to the vault. |
| `wkt.ts`, `geo-compute.ts`, `bbox.ts` | WKT to GeoJSON conversion and Turf.js geometry ops. |

**`src/preload/index.ts`** exposes a namespaced `window.api` (`places.*`, `map.*`,
`nav.*`, `geo.*`, `fs.*`, `regions.*`). All payloads are plain JSON. The MCP tools drive
the app through it.

**`src/renderer/`** is the React client. `app.tsx` orchestrates the map view and panels.

**`src/shared/`** holds types used by both sides.

## Things that will bite you

- **Offline geocoding must not run on the main thread.** `better-sqlite3` is synchronous,
  and ranking a broad FTS prefix match over a metro-sized pack takes 1 to 3 seconds, which
  freezes every window. `geocode-query.ts` runs inside `geocode-worker.ts`;
  `geocoding.ts` is only the main-thread client. Importing `geocode-query.ts` from the
  main bundle puts the freeze back.
- **The main process builds two entries, not one.** `electron.vite.config.ts` declares an
  explicit `rollupOptions.input`: `index` plus `geocode-worker`, which has to be its own
  file for `new Worker(path)` to load it. Adding a main entry means adding it here.
- **A test may not import Electron or `better-sqlite3`.** The native binding is compiled
  for Electron's ABI and won't load in plain Node, so any module reaching the database
  needs that seam mocked.
- **Worker-thread and native-module paths only resolve for real in a packaged build**, and
  CI never packages. A change touching `out/main/` layout, `asarUnpack`, or the geocode
  worker needs a manual `pnpm build:mac` and a check in the packaged app.

## Releasing

See [RELEASING.md](./RELEASING.md).
