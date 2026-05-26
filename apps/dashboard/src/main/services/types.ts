/**
 * Credentials the dashboard injects at client construction. Distinct from the
 * persisted config because they're either build-time constants (Vite env) or
 * fetched after sign-in — not user-edited values that belong in `mapos.json`.
 */
export type ClientCredentials = {
  /** Protomaps API key for community tiles. Sourced from MAIN_VITE_PROTOMAPS_KEY. */
  protomapsApiKey?: string;
};
