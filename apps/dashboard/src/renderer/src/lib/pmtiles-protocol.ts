import maplibregl from "maplibre-gl";
import { Protocol } from "pmtiles";

/**
 * Register the `pmtiles://` protocol with MapLibre once, at module load. The
 * offline tile style references
 * `pmtiles://mapos-region://<region>/<region>.pmtiles`; this protocol unwraps the
 * `pmtiles://` prefix and range-fetches the archive (the Electron region scheme
 * serves the bytes). Importing this module for its side effect is enough.
 */
const protocol = new Protocol();
maplibregl.addProtocol("pmtiles", protocol.tile);
