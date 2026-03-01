/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly MAIN_VITE_ANTHROPIC_API_KEY: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
