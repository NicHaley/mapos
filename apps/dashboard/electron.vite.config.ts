import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    build: {
      // Two entries: the main bundle, plus the offline-geocode worker thread it spawns
      // at runtime. The worker must be its own file for `new Worker(path)` to load it,
      // and lands beside index.js in out/main/ (which is how geocoding.ts locates it,
      // relative to import.meta.url — same layout in dev and inside the asar).
      rollupOptions: {
        input: {
          index: resolve("src/main/index.ts"),
          "geocode-worker": resolve("src/main/services/offline/geocode-worker.ts")
        }
      },
      externalizeDeps: {
        exclude: [
          "chokidar",
          "is-glob",
          "is-extglob",
          "glob-parent",
          "readdirp",
          "anymatch",
          "picomatch",
          "braces",
          "fill-range",
          "to-regex-range",
          "@mapos/contracts",
          "@mapos/service-adapters"
        ]
      }
    }
  },
  preload: {
    build: {
      externalizeDeps: {
        exclude: ["@mapos/contracts", "@mapos/service-adapters"]
      }
    }
  },
  renderer: {
    // Pin the dev server to a fixed port. localStorage is keyed by origin
    // (http://localhost:<port>), so if Vite silently rolls to a free port when
    // 5173 is taken, the origin changes and every persisted renderer setting —
    // theme, open tabs, viewport, panel widths — reads back empty. strictPort
    // makes a port collision fail loudly instead of silently orphaning state.
    server: {
      port: 5173,
      strictPort: true
    },
    resolve: {
      alias: {
        "@renderer": resolve("src/renderer/src"),
        "@": resolve("src/renderer/src"),
        "@shared": resolve("src/shared")
      }
    },
    plugins: [tailwindcss(), react()],
    optimizeDeps: {
      include: ["maplibre-gl"]
    }
  }
});
