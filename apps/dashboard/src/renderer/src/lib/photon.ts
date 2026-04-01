/** Public Photon API (OpenStreetMap search). See https://photon.komoot.io/ */
export const PHOTON_API_BASE = "https://photon.komoot.io";

const DEFAULT_LIMIT = 8;

export type PhotonSearchResult = {
  id: string;
  lat: number;
  lng: number;
  primaryLabel: string;
  secondaryLabel: string;
};

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
};

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

type GeoJSONPoint = { type: "Point"; coordinates: [number, number] };

function isPointGeometry(g: unknown): g is GeoJSONPoint {
  return (
    typeof g === "object" &&
    g !== null &&
    (g as GeoJSONPoint).type === "Point" &&
    Array.isArray((g as GeoJSONPoint).coordinates) &&
    (g as GeoJSONPoint).coordinates.length >= 2
  );
}

export type SearchPhotonOptions = {
  signal?: AbortSignal;
  limit?: number;
  lang?: string;
};

/**
 * Forward geocode via Photon. Returns point results with [lng, lat] mapped to lat/lng fields.
 */
export async function searchPhoton(
  query: string,
  options: SearchPhotonOptions = {}
): Promise<PhotonSearchResult[]> {
  const q = query.trim();
  if (!q) return [];

  const limit = options.limit ?? DEFAULT_LIMIT;
  const params = new URLSearchParams({ q, limit: String(limit) });
  if (options.lang) params.set("lang", options.lang);

  const url = `${PHOTON_API_BASE}/api/?${params.toString()}`;
  const res = await fetch(url, { signal: options.signal });
  if (!res.ok) throw new Error(`Photon search failed (${res.status})`);

  const data = (await res.json()) as {
    features?: Array<{
      geometry?: unknown;
      properties?: PhotonProperties;
    }>;
  };

  const features = data.features ?? [];
  const out: PhotonSearchResult[] = [];

  for (let i = 0; i < features.length; i++) {
    const f = features[i];
    if (!f?.geometry || !isPointGeometry(f.geometry)) continue;
    const [lng, lat] = f.geometry.coordinates;
    const props = f.properties ?? {};
    const primaryLabel = buildPrimaryLabel(props);
    const secondaryLabel = buildSecondaryLabel(props, primaryLabel);
    out.push({
      id: `${lat},${lng},${i}`,
      lat,
      lng,
      primaryLabel,
      secondaryLabel
    });
  }

  return out;
}
