/**
 * Credentials the dashboard injects at client construction. Distinct from the
 * persisted config because they're either build-time constants (Vite env) or
 * fetched after sign-in — not user-edited values that belong in `mapos.json`.
 */
export type ClientCredentials = {
  /** Root dir holding downloaded region packs, `<userData>/regions`. Used by
   *  offline mode to locate `<regionsDir>/<activeRegion>/geocode.sqlite`. */
  regionsDir?: string;
  /** Absolute path to the bundled coarse world geocode index (`world.sqlite`),
   *  the always-available offline search fallback when no pack covers a query. */
  worldGeocodePath?: string;
};
