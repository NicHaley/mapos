# MapOS — Developer Guide

Guidance for working on the **MapOS codebase** (this repo). This file is loaded into Claude Code's context, so it's about *building* MapOS.

> The embedded Pi-SDK chat agent has been removed. MapOS is driven over **MCP**: any
> MCP-capable chat client connects to a local, in-process MCP server the app hosts. The tool
> implementations + system prompt live, Pi-free, in `apps/dashboard/src/main/mcp-server.ts`
> (`buildMaposSystemPrompt`, `buildMaposCustomTools`); the server that exposes them is under
> `apps/dashboard/src/main/mcp/`. See [The MCP server](#the-mcp-server) below.

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
| `apps/dashboard` | The Electron desktop app — the product. Main / preload / renderer. Hosts the spatial index, map services, and the file watcher. |
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
- `mcp-server.ts` — **the agent's tools and system prompt** (large file), Pi-free (`tool-defs.ts` holds the local `ToolDefinition`/`defineTool`). `buildMaposCustomTools` returns the tool set; `buildMaposSystemPrompt` the instructions. Covers spatial queries, geocoding/routing wrappers, vault file I/O + targeted edits, app awareness (active file / open tabs / current location), region-pack management, and presentation tools.
- `mcp/` — the runtime that serves those tools. `manager.ts` (in-process Streamable-HTTP listener on `127.0.0.1`, bound once, tool set re-targeted per active vault), `bridge.ts` (maps `ToolDefinition`s onto the MCP `Server`), `auth.ts` (bearer-token gate). `mcp-ipc.ts` + the `mcp` block of `mapos.json` (enable/port/token) configure it.
- `db.ts` — spatial index (better-sqlite3 + Drizzle). Schema is canonical-string + hash-based drop/recreate migration; rtree bbox virtual table. **Only derived data** — never config.
- `watcher.ts` — chokidar watch over the vault; parses YAML frontmatter (`gray-matter`), extracts WKT geometry, keeps the index in sync.
- `wkt.ts` / `geo-compute.ts` / `bbox.ts` — WKT↔GeoJSON (`wellknown`) and Turf.js geometry ops.
- `services/` — service-mode resolution. `offline/` holds local Photon (geocode SQLite from region packs) and Valhalla (N-API addon, `@valhallajs/valhallajs`) routing; cloud mode proxies to `apps/server`.
- `mapos-config.ts` / `mapos-ipc.ts` — app-level `mapos.json` in Electron userData (vault registry, active vault, services mode) and vault management.
- `vault-config.ts` — shared allowlisted read/merge/write for `.mapos/*.json` intent files. `appearance.ts` is a thin domain wrapper.
- `region-packs.ts` / `region-protocol.ts` — download/manage region packs; `mapos://` protocol.

**`src/preload/index.ts`** — exposes a namespaced `window.api` (`places.*`, `map.*`, `nav.*`, `geo.*`, `fs.*`, `regions.*`, …). All payloads are plain JSON. The MCP tools drive the app through these: `map.*` (overlay/pan) and `nav.*` (open-file) are main→renderer commands; `map.*` viewport, `nav.*` state, and `geo.*` locate-reply flow renderer→main so tools like `get_viewport` / `get_active_file` / `get_current_location` can read the live app state.

**`src/renderer/`** — React client (`app.tsx` orchestrates the MapView + chat sidebar). Uses `@mapos/ui` and `maplibre-gl`.

**`src/shared/`** — types shared across main/renderer (`PlaceRecord`, overlay types, AI model/provider types, property inference).

---

## The MCP server

MapOS has **no built-in chat UI** — the agent experience is whatever MCP client the user connects (Claude Code, Claude Desktop, etc.). The app hosts a local MCP server so those clients can drive it.

- **Transport / lifecycle** — in-process Streamable-HTTP on `127.0.0.1:<port>/mcp`, bearer-token gated, stateless (a fresh `Server` + transport per request). The HTTP listener is bound once for the app's lifetime (`mcpManager.start`), so a connected client survives vault switches; the *tool set* is vault-scoped and rebuilt by `setActiveVault` / emptied by `clearActiveVault`.
- **Tools** — built by `buildMaposCustomTools(places, vaultRoot, appStateDir, …)`. Each carries advisory MCP `annotations` (`readOnlyHint` / `destructiveHint` / `openWorldHint` / `idempotentHint`), surfaced via `bridge.ts` — defense-in-depth over the real gate, never the primary control.
- **Write safety** — the main process is the gatekeeper, not the client. Paths are confined to the vault via `vault-path.ts` (`resolveInVault` rejects `..`/absolute/symlink escapes; `.mapos/` is denylisted); writes are no-clobber by default; edits snapshot previous content. Prefer the *targeted* edit tools (`write_frontmatter_property` / `write_place_body`) over full rewrites.
- **Instructions** — `buildMaposSystemPrompt(vaultRoot)` is delivered as the MCP `instructions` field. It's **advisory** — a shell-capable client (like Claude Code) may still prefer its own `bash`/`read` over the vault tools; the tools primarily backfill shell-less clients.
- **Clients without their own filesystem** get read/list/search over the vault (`read_vault_file`, `list_vault_files`, `search_vault_files`); the built-in names (`read`, `bash`, `grep`, `find`, `ls`) are assumed client-supplied and are *not* registered.

---

## Build / dev / check

```bash
pnpm dev            # run the dashboard (electron-vite dev)
pnpm dev:web        # run the web app
pnpm build          # turbo build all
pnpm typecheck      # tsc --noEmit across the workspace
pnpm test           # vitest (dashboard main-process logic only — see below)
pnpm lint           # biome lint
pnpm check          # biome check --write (lint + format fix)
pnpm release        # cut a release (bump + changelog + publish + tag) — see apps/dashboard/RELEASING.md
pnpm changelog:preview   # what the next release's CHANGELOG.md section would say
```

- **After any code change, run `pnpm typecheck` and `pnpm lint`** before considering it done.
- **Git hooks** (husky, wired up by the root `prepare` script on install): `pre-commit` runs biome over staged files via lint-staged, `commit-msg` enforces Conventional Commits (`commitlint.config.mjs`), `pre-push` runs `pnpm typecheck`. Bypass a single commit with `--no-verify`.
- **Tests are vitest, and deliberately narrow.** `pnpm test` (turbo) or `pnpm --filter @mapos/dashboard test:watch`. Coverage is pure main-process logic only: `vault-path.ts` (the write-safety boundary for every agent tool), `wkt.ts`, `bbox.ts`. There is no renderer, IPC, or end-to-end coverage, so **passing tests are a floor, not proof a change works** — verify UI and main/renderer changes in the running app.
- **A test may not import Electron or `better-sqlite3`.** The native binding is compiled for Electron's ABI and won't load in plain Node, so any main-process module that reaches the database (e.g. `geo-compute.ts`, which imports `./db`) needs that seam mocked before it can be tested.
- Native modules: `better-sqlite3` is rebuilt for Electron via the dashboard `postinstall` (`electron-rebuild`). The pnpm build-script allowlist lives in `pnpm-workspace.yaml` (`onlyBuiltDependencies`).
- Packaging: `electron-vite build` then `electron-builder` (`build:mac` / `build:win` / `build:linux`).

---

## Conventions

- **Geometry is WKT** in place-file frontmatter (`geometry: "POINT(lng lat)"`), converted to GeoJSON for queries/render. Point, LineString, Polygon. Use Turf for computation — there are no spatial SQL `ST_*` functions. `geometry` and `color` are reserved frontmatter keys (special meaning to the renderer).
- **Files are the source of truth.** `index.db` is a derived cache (sync-excluded, rebuildable). Per-vault user intent lives in `.mapos/` JSON files; machine identity in Electron userData. Never persist canonical state only in the index.
- **All vault mutations go through the file-write path** so the index stays in sync — the agent tools use `write_vault_file` / `delete_vault_file` / `rename_vault_file`, never raw writes.
- **Persisted state follows the Obsidian model — three tiers.** See [`.mapos/` layout](#mapos-layout) below.
- **Style is Biome-enforced** — don't hand-format; run `pnpm check`.
- **Commits are Conventional Commits** (`feat:`, `fix:`, `perf:`, `refactor:`, `docs:`, plus `wip:` for partial work and `release:` for the release script). The type decides whether a commit appears in `CHANGELOG.md` — see `cliff.toml`. Subjects are sentence-case, which is why `subject-case` is disabled in `commitlint.config.mjs`.
- **Scopes mark the exceptions, not the norm.** `mcp`, `web`, `pipeline`. **An unscoped commit means the desktop app** — most commits are dashboard work, so scoping it would add a prefix to nearly every changelog line and tell the reader nothing. Scope by intent, not by which files changed: an MCP commit usually also touches renderer/preload, and it's still `mcp`. Unlisted scopes warn rather than fail, so the list can grow.
- **Local vs cloud services** is a config mode (`services.mode`). Local needs downloaded region packs; cloud proxies to `apps/server`. Keep both paths working when touching `services/`.
- Code style: match the surrounding file. Comments are sparse and reserved for non-obvious logic.

### `.mapos/` layout

Mirrors Obsidian's `.obsidian/`: domain JSON files under the vault, created **lazily** on first write (never empty stubs at vault init). One file ≈ one settings surface / sync unit. Shared IO lives in `vault-config.ts` (allowlisted basenames + opaque merge; unknown keys survive round-trips).

**Where does a setting go?**

| Kind | Where | Examples |
|---|---|---|
| Machine identity / secrets | Electron `userData/` | Vault registry (`mapos.json`), services mode |
| Canonical vault intent (sync/git with the vault) | `.mapos/<domain>.json` | Appearance, hotkeys, vault emoji |
| Ephemeral workspace (noisy, device-ish) | Vault-scoped localStorage today; `.mapos/workspace.json` later if needed | Open tabs, map viewport, pane widths |
| Rebuildable cache | `.mapos/` but sync-excluded | `index.db` |

**Reserved basenames** (only create when the feature writes):

| File | Role |
|---|---|
| `appearance.json` | Look — accent, map colour, theme |
| `app.json` | General vault prefs (e.g. workspace emoji) — when built |
| `hotkeys.json` | Custom shortcuts — when built |
| `workspace.json` | Layout snapshot — only if tier-2 graduates off localStorage |
| `index.db` | Spatial index (derived) |

**Rules:** secrets never enter `.mapos/`. UI locale stays app-global (don't flip language on vault switch). Prefer a new domain file over growing a kitchen-sink blob. Tier-2 localStorage keys are `` `base:${vaultRoot}` `` via `useVaultRoot()` — persistence waits until the root resolves so state doesn't leak across vaults.
