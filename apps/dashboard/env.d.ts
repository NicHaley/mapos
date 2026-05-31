/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly MAIN_VITE_ANTHROPIC_API_KEY: string;
  /** Public base URL of the R2 bucket holding region packs + manifest.json. */
  readonly MAIN_VITE_R2_PUBLIC_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
