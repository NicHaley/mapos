import { PHOTON_BASE } from "./config";
import { fetchJson } from "./http";
import type { GeocodeResult, LatLng } from "./types";

const DEFAULT_LIMIT = 8;

type PhotonProperties = {
  name?: string;
  street?: string;
  housenumber?: string;
  city?: string;
  locality?: string;
  district?: string;
  county?: string;
  state?: string;
  country?: string;
  postcode?: string;
  osm_key?: string;
  osm_value?: string;
  extent?: [number, number, number, number]; // [west, north, east, south] per Photon
};

type PhotonFeature = {
  geometry?: { type?: string; coordinates?: [number, number] };
  properties?: PhotonProperties;
};

type PhotonResponse = { features?: PhotonFeature[] };

function buildPrimaryLabel(props: PhotonProperties): string {
  const name = props.name?.trim();
  if (name) return name;
  const parts = [props.housenumber, props.street].filter(Boolean);
  if (parts.length) return parts.join(" ");
  return props.city?.trim() || props.locality?.trim() || "Unknown place";
}

function buildSecondaryLabel(props: PhotonProperties, primary: string): string {
  const parts: string[] = [];
  const streetLine = [props.housenumber, props.street].filter(Boolean).join(" ").trim();
  if (streetLine && streetLine !== primary) parts.push(streetLine);
  const locality = props.city || props.locality || props.district;
  if (locality && locality !== primary) parts.push(locality);
  for (const x of [props.state, props.country, props.county]) {
    if (x && x !== primary && !parts.includes(x)) parts.push(x);
  }
  return parts.join(", ");
}

function featureToResult(feature: PhotonFeature, index: number): GeocodeResult | null {
  const geom = feature.geometry;
  if (!geom || geom.type !== "Point" || !Array.isArray(geom.coordinates)) return null;
  const [lng, lat] = geom.coordinates;
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  const props = feature.properties ?? {};
  const primaryLabel = buildPrimaryLabel(props);
  const secondaryLabel = buildSecondaryLabel(props, primaryLabel);
  const result: GeocodeResult = {
    id: `${lat},${lng},${index}`,
    lat,
    lng,
    primaryLabel,
    secondaryLabel
  };
  if (props.extent) {
    const [west, north, east, south] = props.extent;
    result.bbox = { west, north, east, south };
  }
  if (props.osm_key && props.osm_value) {
    result.categories = [`${props.osm_key}:${props.osm_value}`];
  }
  return result;
}

export type ForwardGeocodeOptions = {
  signal?: AbortSignal;
  limit?: number;
  /** ISO 639-1 language code, e.g. "en", "fr". Passed through to Photon. */
  lang?: string;
  /** Optional bias rectangle for results. */
  bbox?: { north: number; south: number; east: number; west: number };
};

export async function forwardGeocode(
  query: string,
  options: ForwardGeocodeOptions = {}
): Promise<GeocodeResult[]> {
  const q = query.trim();
  if (!q) return [];
  const limit = options.limit ?? DEFAULT_LIMIT;
  const params = new URLSearchParams({ q, limit: String(limit) });
  if (options.lang) params.set("lang", options.lang);
  if (options.bbox) {
    const { west, south, east, north } = options.bbox;
    params.set("bbox", `${west},${south},${east},${north}`);
  }
  const url = `${PHOTON_BASE}/api/?${params.toString()}`;
  const data = await fetchJson<PhotonResponse>(url, undefined, { signal: options.signal });
  const out: GeocodeResult[] = [];
  const features = data.features ?? [];
  for (let i = 0; i < features.length; i++) {
    const feature = features[i];
    if (!feature) continue;
    const r = featureToResult(feature, i);
    if (r) out.push(r);
  }
  return out;
}

export type ReverseGeocodeOptions = {
  signal?: AbortSignal;
  limit?: number;
  lang?: string;
};

export async function reverseGeocode(
  point: LatLng,
  options: ReverseGeocodeOptions = {}
): Promise<GeocodeResult[]> {
  const limit = options.limit ?? 1;
  const params = new URLSearchParams({
    lat: String(point.lat),
    lon: String(point.lng),
    limit: String(limit)
  });
  if (options.lang) params.set("lang", options.lang);
  const url = `${PHOTON_BASE}/reverse?${params.toString()}`;
  const data = await fetchJson<PhotonResponse>(url, undefined, { signal: options.signal });
  const out: GeocodeResult[] = [];
  const features = data.features ?? [];
  for (let i = 0; i < features.length; i++) {
    const feature = features[i];
    if (!feature) continue;
    const r = featureToResult(feature, i);
    if (r) out.push(r);
  }
  return out;
}
