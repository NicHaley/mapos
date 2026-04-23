/**
 * Endpoints for external map services. Kept as plain consts so moving to a
 * self-hosted instance is a one-line change. No env-var indirection until we
 * actually need per-environment configuration.
 */

export const PHOTON_BASE = "https://photon.komoot.io";
export const VALHALLA_BASE = "https://valhalla1.openstreetmap.de";

export const USER_AGENT = "MapOS/1.0 (+https://github.com/mapos)";

export const DEFAULT_TIMEOUT_MS = 15_000;
