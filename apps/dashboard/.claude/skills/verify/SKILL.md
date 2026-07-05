---
name: verify
description: Build, launch, and drive the MapOS dashboard app to verify renderer/main changes end-to-end via CDP.
---

# Verifying apps/dashboard changes

## Launch with a CDP handle

```bash
cd apps/dashboard && pnpm exec electron-vite dev --remoteDebuggingPort 9223
```

- `--remoteDebuggingPort` is electron-vite's own flag; `-- --remote-debugging-port=…` is misparsed as the project root and produces broken builds.
- Vite is pinned to port 5173 with `strictPort` (localStorage is origin-keyed). If 5173 is busy, another dev instance is running — **check with the user before killing it; they may be actively using it.** Killing the electron-vite node process also kills its Electron child.
- Dev vault: `/Users/nicholashaley/MapOS Test/MapOS Vault`.

## Drive via CDP

- Targets: `curl http://127.0.0.1:9223/json/list`, connect to the `page` target.
- Use `ws` from node_modules (CommonJS — `import wsPkg from '.../ws/index.js'; const { WebSocket } = wsPkg;`).
- `Emulation.setDeviceMetricsOverride` to widen the viewport (dev window is small; `Browser.setWindowBounds` unsupported). Overrides reset when the CDP socket closes.
- Use trusted `Input.dispatchMouseEvent` / `dispatchKeyEvent` — synthetic DOM events don't reach pointer handlers or ProseMirror.
- `Page.captureScreenshot` for evidence; `Runtime.evaluate` with `returnByValue` for DOM/layout assertions.

## Gotchas

- **The app window is visible on the user's desktop and they may interact with it concurrently** — a chat send or click you observe may be theirs, not yours. Before assuming your automation caused something, check timestamps against your script runs, and announce/coordinate before long drives.
- The chat composer autofocuses; stray Enter dispatches will send the drafted message (real API spend). The Stop and Send buttons occupy the same spot in the composer.
- Clicking "New Note" opens an in-memory draft; no file is written until edited, closing the tab discards it.
- UI-over-map compositing: chrome layers over the WebGL canvas; check `contain: layout` wrapper (app.tsx content wrapper) stays transform-free — a `transform` there re-introduces the hover/scroll flicker.
