import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    build: {
      externalizeDeps: {
        exclude: ['chokidar', 'is-glob', 'is-extglob', 'glob-parent', 'readdirp', 'anymatch', 'picomatch', 'braces', 'fill-range', 'to-regex-range']
      }
    }
  },
  preload: {},
  renderer: {
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
