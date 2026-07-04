#!/usr/bin/env tsx
/**
 * Extract coarse place features (countries, regions, major cities) from the
 * bundled low-zoom world basemap (`world.pmtiles`, Protomaps schema) and emit
 * them as GeoJSONSeq on stdout — the same format `osmium export` produces for
 * region packs, so the output pipes straight into `build-geocode.ts`.
 *
 * Why this source: the world basemap we already ship contains a `places` layer
 * (country / region / locality labels, with population, wikidata, and 40+
 * localized name:* fields) already rank-filtered for low-zoom cartography, which
 * is almost exactly the "countries + major cities" tier we want for a global
 * offline search fallback. Reusing it means no new dataset, and the names match
 * the labels drawn on the map.
 *
 * We synthesize OSM-ish tags (place=country|state|city, population, wikidata,
 * name:*) so `build-geocode.ts`'s existing classify()/importance()/admin path
 * handles the features unchanged.
 *
 *   tsx extract-world-places.ts WORLD.pmtiles [--maxzoom 6] | tsx build-geocode.ts ...
 */

import { closeSync, openSync, readSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { VectorTile } from "@mapbox/vector-tile";
import type { Feature, Point } from "geojson";
import Pbf from "pbf";
import { PMTiles, type Source } from "pmtiles";

// Node fs-backed pmtiles Source (the library's FileSource is browser-only). Same
// shape as the desktop app's NodeFileSource (region-protocol.ts).
class NodeFileSource implements Source {
  private readonly fd: number;
  constructor(private readonly path: string) {
    this.fd = openSync(path, "r");
  }
  getKey(): string {
    return this.path;
  }
  async getBytes(offset: number, length: number): Promise<{ data: ArrayBuffer }> {
    const buf = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const n = readSync(this.fd, buf, read, length - read, offset + read);
      if (n === 0) break;
      read += n;
    }
    return { data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + read) };
  }
  close(): void {
    closeSync(this.fd);
  }
}

// Protomaps `places.kind` -> synthetic OSM `place` value. `region` is a state /
// province; `locality` carries the OSM place value in `kind_detail` (city, town,
// village, ...). We keep only the coarse tiers — anything finer than a town is a
// region-pack concern, not a world fallback.
const KEEP_LOCALITY_DETAIL = new Set(["city", "town"]);

type PlaceProps = Record<string, unknown>;

/** Map a places-layer feature to synthetic OSM tags, or null to drop it. */
function toTags(props: PlaceProps): Record<string, string> | null {
  const kind = typeof props.kind === "string" ? props.kind : "";
  // Emit the raw local name as `name` (+ name:* incl. name:en), exactly the shape
  // `osmium export` produces for packs. build-geocode owns the name:en-primary rule,
  // so both pipelines converge on one convention.
  const name = typeof props.name === "string" ? props.name.trim() : "";
  if (!name) return null;

  let place: string | null = null;
  if (kind === "country") place = "country";
  else if (kind === "region") place = "state";
  else if (kind === "locality") {
    const detail = typeof props.kind_detail === "string" ? props.kind_detail : "city";
    if (!KEEP_LOCALITY_DETAIL.has(detail)) return null;
    place = detail;
  }
  if (!place) return null;

  const tags: Record<string, string> = { place, name, "@type": "node", "@id": "0" };
  // Localized names -> name:* tags; build-geocode's altNames() makes them searchable.
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith("name:") && typeof v === "string" && v.trim()) tags[k] = v;
  }
  if (props.population != null) tags.population = String(props.population);
  // wikidata is build-geocode's fame proxy in importance() — lets a landmark city
  // outrank a same-population neighbour.
  if (typeof props.wikidata === "string" && props.wikidata) tags.wikidata = props.wikidata;
  return tags;
}

/** Dedup key: a place repeats across tile buffers near edges. Prefer wikidata. */
function dedupeKey(tags: Record<string, string>, lng: number, lat: number): string {
  if (tags.wikidata) return `wd:${tags.wikidata}`;
  // ~1 km grid so the same label emitted into two adjacent tiles collapses.
  return `${tags.place}:${tags.name.toLowerCase()}:${Math.round(lat * 100)}:${Math.round(lng * 100)}`;
}

async function main(): Promise<void> {
  const [input, ...rest] = process.argv.slice(2);
  if (!input) {
    console.error("usage: extract-world-places.ts WORLD.pmtiles [--maxzoom N]");
    process.exit(1);
  }
  const zIdx = rest.indexOf("--maxzoom");
  const maxzoomArg = zIdx >= 0 ? Number.parseInt(rest[zIdx + 1] ?? "", 10) : Number.NaN;

  const source = new NodeFileSource(input);
  const pmtiles = new PMTiles(source);
  const header = await pmtiles.getHeader();
  // Sweep every zoom 0..maxZoom and union. A label isn't present at all zooms: it
  // has a min_zoom AND (for coarse tiers) a max_zoom — country labels are drawn at
  // low zoom and dropped higher up so a continent-sized name doesn't blanket the
  // map. So a single-level sweep would miss big countries (visible only at low z)
  // or, at low z, the cities (visible only higher). Dedup collapses cross-zoom and
  // tile-edge repeats; wikidata is the stable key, with a ~1 km grid fallback.
  const maxZoom = Number.isFinite(maxzoomArg) ? maxzoomArg : header.maxZoom;

  const seen = new Set<string>();
  const counts: Record<string, number> = {};
  let emitted = 0;

  for (let z = 0; z <= maxZoom; z++) {
    const side = 2 ** z;
    for (let x = 0; x < side; x++) {
      for (let y = 0; y < side; y++) {
        const tile = await pmtiles.getZxy(z, x, y);
        if (!tile?.data) continue;
        let bytes = new Uint8Array(tile.data);
        if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
        const layer = new VectorTile(new Pbf(bytes)).layers.places;
        if (!layer) continue;
        for (let i = 0; i < layer.length; i++) {
          const f = layer.feature(i);
          const tags = toTags(f.properties as PlaceProps);
          if (!tags) continue;
          const gj = f.toGeoJSON(x, y, z) as Feature<Point>;
          if (gj.geometry?.type !== "Point") continue;
          const [rawLng, lat] = gj.geometry.coordinates;
          // Low-zoom tiles + tile buffers can project a longitude outside [-180,180]
          // (Sydney came out at -208.78 = 151.22 - 360), which breaks point-in-polygon
          // admin lookup and the map marker. Wrap to the canonical range.
          const lng = ((((rawLng + 180) % 360) + 360) % 360) - 180;
          const key = dedupeKey(tags, lng, lat);
          if (seen.has(key)) continue;
          seen.add(key);
          counts[tags.place] = (counts[tags.place] ?? 0) + 1;
          process.stdout.write(
            `${JSON.stringify({
              type: "Feature",
              geometry: { type: "Point", coordinates: [lng, lat] },
              properties: tags
            })}\n`
          );
          emitted += 1;
        }
      }
    }
  }
  source.close();
  console.error(
    `extracted ${emitted.toLocaleString()} places from z0-${maxZoom} (${Object.entries(counts)
      .map(([k, v]) => `${k}:${v}`)
      .join(", ")})`
  );
}

void main();
