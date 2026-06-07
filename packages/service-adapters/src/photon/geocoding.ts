import type {
  Endpoint,
  GeocodeForwardRequest,
  GeocodeResult,
  GeocodeReverseRequest
} from "@mapos/contracts";
import { z } from "zod";
import { fetchJson } from "../http";
import type { AdapterContext } from "../types";

const DEFAULT_LIMIT = 8;

const PhotonPropertiesSchema = z.object({
  name: z.string().optional(),
  street: z.string().optional(),
  housenumber: z.string().optional(),
  city: z.string().optional(),
  locality: z.string().optional(),
  district: z.string().optional(),
  county: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  postcode: z.string().optional(),
  osm_key: z.string().optional(),
  osm_value: z.string().optional(),
  // [west, north, east, south] per Photon
  extent: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional()
});

const PhotonFeatureSchema = z.object({
  geometry: z
    .object({
      type: z.string().optional(),
      coordinates: z.tuple([z.number(), z.number()]).optional()
    })
    .optional(),
  properties: PhotonPropertiesSchema.optional()
});

const PhotonResponseSchema = z.object({
  features: z.array(PhotonFeatureSchema).optional()
});

type PhotonProperties = z.infer<typeof PhotonPropertiesSchema>;
type PhotonFeature = z.infer<typeof PhotonFeatureSchema>;

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
  if (!geom || geom.type !== "Point" || !geom.coordinates) return null;
  const [lng, lat] = geom.coordinates;
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

export async function forward(
  req: GeocodeForwardRequest,
  ep: Endpoint,
  ctx: AdapterContext = {}
): Promise<GeocodeResult[]> {
  // Photon needs text — a pure category filter (query omitted) is offline-only.
  const q = req.query?.trim() ?? "";
  if (!q) return [];
  const limit = req.limit ?? DEFAULT_LIMIT;
  const params = new URLSearchParams({ q, limit: String(limit) });
  if (req.lang) params.set("lang", req.lang);
  if (req.bbox) {
    const { west, south, east, north } = req.bbox;
    params.set("bbox", `${west},${south},${east},${north}`);
  }
  const url = `${ep.url}/api/?${params.toString()}`;
  const data = await fetchJson(url, PhotonResponseSchema, undefined, { signal: ctx.signal });
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

export async function reverse(
  req: GeocodeReverseRequest,
  ep: Endpoint,
  ctx: AdapterContext = {}
): Promise<GeocodeResult[]> {
  const limit = req.limit ?? 1;
  const params = new URLSearchParams({
    lat: String(req.point.lat),
    lon: String(req.point.lng),
    limit: String(limit)
  });
  if (req.lang) params.set("lang", req.lang);
  const url = `${ep.url}/reverse?${params.toString()}`;
  const data = await fetchJson(url, PhotonResponseSchema, undefined, { signal: ctx.signal });
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
