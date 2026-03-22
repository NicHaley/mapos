/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly MAIN_VITE_ANTHROPIC_API_KEY: string;
  readonly MAIN_VITE_MAPBOX_ACCESS_TOKEN: string;
  readonly RENDERER_VITE_PROTOMAPS_KEY: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
