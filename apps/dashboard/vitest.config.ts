import { defineConfig } from "vitest/config";

// Kept separate from electron.vite.config.ts: that file builds three bundles
// (main/preload/renderer) and none of its entry points are relevant here.
//
// `environment: "node"` because the modules under test are main-process code.
// Nothing here may import Electron or better-sqlite3 — the native binding is
// compiled for Electron's ABI and won't load in plain Node, so main-process
// modules that reach the database (e.g. geo-compute.ts, which imports ./db)
// need that seam mocked before they can be tested this way.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"]
  }
});
