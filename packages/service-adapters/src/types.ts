import type {
  Endpoint,
  GeocodeForwardRequest,
  GeocodeResult,
  GeocodeReverseRequest,
  Isochrone,
  IsochroneRequest,
  Matrix,
  Route,
  RouteDirectionsRequest,
  RouteMatrixRequest,
  TileStyleRequest
} from "@mapos/contracts";

/**
 * Per-call transport context. Distinct from `Endpoint` (which the dispatcher
 * resolves from registry config) so the caller can pass an AbortSignal without
 * threading it through the endpoint config.
 */
export type AdapterContext = {
  signal?: AbortSignal;
};

export interface GeocodingCapability {
  forward(
    req: GeocodeForwardRequest,
    ep: Endpoint,
    ctx?: AdapterContext
  ): Promise<GeocodeResult[]>;
  reverse(
    req: GeocodeReverseRequest,
    ep: Endpoint,
    ctx?: AdapterContext
  ): Promise<GeocodeResult[]>;
}

export interface RoutingCapability {
  directions(
    req: RouteDirectionsRequest,
    ep: Endpoint,
    ctx?: AdapterContext
  ): Promise<Route>;
  matrix(req: RouteMatrixRequest, ep: Endpoint, ctx?: AdapterContext): Promise<Matrix>;
}

export interface IsochroneCapability {
  contours(
    req: IsochroneRequest,
    ep: Endpoint,
    ctx?: AdapterContext
  ): Promise<Isochrone>;
}

export interface TileCapability {
  /** Returns a MapLibre style URL. Synchronous — tile rendering can't await. */
  styleUrl(req: TileStyleRequest, ep: Endpoint): string;
}

/**
 * An adapter bundles one or more capabilities under a single provider id. A
 * provider may implement any subset — Photon only does geocoding, Valhalla does
 * routing and isochrones, Protomaps only does tiles.
 */
export type Adapter = {
  readonly id: string;
  geocoding?: GeocodingCapability;
  routing?: RoutingCapability;
  isochrones?: IsochroneCapability;
  tiles?: TileCapability;
};
