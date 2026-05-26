import * as geocoding from "./geocoding";
import * as isochrone from "./isochrone";
import * as routing from "./routing";
import { styleUrl } from "./tiles";
import * as webSearch from "./web-search";

/**
 * The MapOS v1 server adapter. Implements every capability by POSTing contract
 * requests to the MapOS server and parsing the response. The `Endpoint.url`
 * should be the server's origin (e.g. "https://api.mapos.md" or
 * "http://localhost:8787"); per-route paths are appended internally.
 *
 * `Endpoint.auth` (when set to `type: "bearer"`) is forwarded as an
 * `Authorization: Bearer` header. Bearer is the only auth shape this adapter
 * understands; the server is the source of truth for whether the token is
 * required.
 */
export const maposV1Adapter = {
  id: "mapos_v1" as const,
  geocoding,
  routing,
  isochrones: { contours: isochrone.contours },
  tiles: { styleUrl },
  webSearch: { search: webSearch.search }
};
