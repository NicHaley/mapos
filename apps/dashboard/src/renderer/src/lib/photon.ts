/**
 * Thin adapter over the shared map-services layer. Preserved so existing
 * renderer imports (`searchPhoton`, `PhotonSearchResult`) keep working while
 * the module migrates to `@shared/map-services`. New code should import from
 * `@shared/map-services` directly.
 */

import { forwardGeocode, type GeocodeResult, PHOTON_BASE } from "@shared/map-services";

export type PhotonSearchResult = GeocodeResult;
export type SearchPhotonOptions = Parameters<typeof forwardGeocode>[1];

export const PHOTON_API_BASE = PHOTON_BASE;

export const searchPhoton = forwardGeocode;
