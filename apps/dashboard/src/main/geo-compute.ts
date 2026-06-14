import { area } from "@turf/area";
import { bbox } from "@turf/bbox";
import { buffer } from "@turf/buffer";
import { centroid } from "@turf/centroid";
import { clustersDbscan } from "@turf/clusters-dbscan";
import { convex } from "@turf/convex";
import { feature, featureCollection } from "@turf/helpers";
import { intersect } from "@turf/intersect";
import { length } from "@turf/length";
import { simplify } from "@turf/simplify";
import { union } from "@turf/union";
import type { Feature, FeatureCollection, Geometry, Polygon } from "geojson";
import { getFeatureGeometries } from "./db";

export type GeoOperation =
  | "buffer"
  | "area"
  | "length"
  | "centroid"
  | "bbox"
  | "convex_hull"
  | "simplify"
  | "union"
  | "intersect"
  | "clusters_dbscan";

export interface GeoComputeArgs {
  operation: GeoOperation;
  /** Inline GeoJSON geometry, Feature, or FeatureCollection. */
  geometry?: unknown;
  /** Second operand (e.g. the other polygon for `intersect`). */
  geometryB?: unknown;
  /** Resolve geometry from the spatial index by vault file path instead of inlining it. */
  featurePaths?: string[];
  params?: { radius_m?: number; tolerance?: number; max_distance_m?: number };
}

/** Loose GeoJSON — Turf accepts geometry, Feature, or FeatureCollection at these call sites. */
// biome-ignore lint/suspicious/noExplicitAny: Turf's overloads accept mixed GeoJSON shapes.
type AnyGeo = any;

function requireParam(value: number | undefined, name: string): number {
  if (value == null) throw new Error(`\`${name}\` is required for this operation.`);
  return value;
}

/**
 * Normalize a GeoJSON argument to an object. Models (especially local ones) often pass GeoJSON
 * as a JSON string, or even a double-encoded string, rather than a nested object — accept both
 * so a stringified payload isn't rejected as "invalid".
 */
function coerceGeoJson(value: unknown): AnyGeo {
  let g: unknown = value;
  for (let i = 0; i < 2 && typeof g === "string"; i++) {
    try {
      g = JSON.parse(g);
    } catch {
      throw new Error("Invalid GeoJSON: expected an object or a JSON string.");
    }
  }
  return g;
}

function toFeature(g: AnyGeo): Feature {
  if (!g || typeof g !== "object") throw new Error("Invalid GeoJSON input.");
  if (g.type === "Feature") return g;
  if (g.type === "FeatureCollection") {
    throw new Error("Expected a single geometry/Feature here, got a FeatureCollection.");
  }
  return feature(g as Geometry);
}

function toFeatureCollection(g: AnyGeo): FeatureCollection {
  if (!g || typeof g !== "object") throw new Error("Invalid GeoJSON input.");
  if (g.type === "FeatureCollection") return g;
  if (g.type === "Feature") return featureCollection([g]);
  return featureCollection([feature(g as Geometry)]);
}

/** Resolve the primary input: indexed features (by path) take precedence over inline geometry. */
function resolveInput(args: GeoComputeArgs): AnyGeo {
  if (args.featurePaths && args.featurePaths.length > 0) {
    const rows = getFeatureGeometries(args.featurePaths);
    if (rows.length === 0) {
      throw new Error("No indexed geometry found for the given feature_paths.");
    }
    return featureCollection(rows.map((r) => feature(JSON.parse(r.geometry) as Geometry)));
  }
  if (args.geometry != null) return coerceGeoJson(args.geometry);
  throw new Error("Provide `geometry` or `feature_paths`.");
}

/** Polygon set for union/intersect: the input's polygons plus an optional second operand. */
function polygonCollection(args: GeoComputeArgs): FeatureCollection<Polygon> {
  const fc = toFeatureCollection(resolveInput(args)) as FeatureCollection<Polygon>;
  if (args.geometryB != null) {
    fc.features.push(toFeature(coerceGeoJson(args.geometryB)) as Feature<Polygon>);
  }
  if (fc.features.length < 2) {
    throw new Error("union/intersect need at least two polygons (via feature_paths or geometry + geometry_b).");
  }
  return fc;
}

/**
 * Run a single offline Turf geometry operation. Inputs/outputs are GeoJSON in the same format
 * as the index `geometry` column and get_isochrone contours, so results render directly via
 * render_overlay_on_map. Measurement ops return a number; geometry ops return GeoJSON.
 */
export function runGeoCompute(args: GeoComputeArgs): unknown {
  const { operation, params } = args;

  switch (operation) {
    case "area":
      return { area_m2: area(resolveInput(args)) };
    case "length":
      return { length_m: length(resolveInput(args), { units: "meters" }) };
    case "centroid":
      return centroid(resolveInput(args));
    case "bbox": {
      const b = bbox(resolveInput(args));
      return { bbox: b, bounds: { west: b[0], south: b[1], east: b[2], north: b[3] } };
    }
    case "buffer":
      return buffer(resolveInput(args), requireParam(params?.radius_m, "radius_m"), {
        units: "meters"
      });
    case "simplify":
      return simplify(resolveInput(args), {
        tolerance: params?.tolerance ?? 0.001,
        highQuality: false,
        mutate: false
      });
    case "convex_hull":
      return convex(toFeatureCollection(resolveInput(args)));
    case "union":
      return union(polygonCollection(args));
    case "intersect":
      return intersect(polygonCollection(args));
    case "clusters_dbscan":
      return clustersDbscan(
        toFeatureCollection(resolveInput(args)) as FeatureCollection<import("geojson").Point>,
        requireParam(params?.max_distance_m, "max_distance_m"),
        { units: "meters" }
      );
    default: {
      const exhaustive: never = operation;
      throw new Error(`Unknown operation: ${String(exhaustive)}`);
    }
  }
}
