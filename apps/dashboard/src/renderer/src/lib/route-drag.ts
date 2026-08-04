/**
 * Geometry for dragging a directions route: snapping the pointer onto the route line, and
 * working out which leg it landed on so a dropped point becomes a stop in the right place.
 *
 * Distances here are latitude-corrected squared degrees — comparable to each other, never
 * metres. Nothing needs a real geodesic: every question is "which of these is nearest",
 * asked over a few metres of screen space.
 */

export type LngLat = [number, number];

/** Longitude degrees shrink towards the poles; scale x so comparisons are locally isotropic. */
function lngScale(lat: number): number {
  return Math.cos((lat * Math.PI) / 180);
}

function distanceSq(a: LngLat, b: LngLat, scale: number): number {
  const dx = (a[0] - b[0]) * scale;
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

export type SnappedPoint = {
  /** The point on the line, projected onto its nearest segment. */
  point: LngLat;
  /** Start vertex of that segment — where along the route the point sits. */
  segmentIndex: number;
  distanceSq: number;
};

/**
 * The point on `line` nearest to `point`. Projected onto the nearest *segment* rather than
 * snapped to the nearest vertex, so the drag handle glides along a sparse line instead of
 * hopping between shape points.
 */
export function snapToPolyline(line: LngLat[], point: LngLat): SnappedPoint | null {
  if (line.length === 0) return null;
  const scale = lngScale(point[1]);
  if (line.length === 1) {
    return { point: line[0], segmentIndex: 0, distanceSq: distanceSq(line[0], point, scale) };
  }
  let best: SnappedPoint | null = null;
  for (let i = 0; i < line.length - 1; i++) {
    const [ax, ay] = line[i];
    const [bx, by] = line[i + 1];
    const dx = (bx - ax) * scale;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;
    const t =
      lengthSq === 0
        ? 0
        : Math.max(
            0,
            Math.min(1, ((point[0] - ax) * scale * dx + (point[1] - ay) * dy) / lengthSq)
          );
    const projected: LngLat = [ax + (bx - ax) * t, ay + (by - ay) * t];
    const d = distanceSq(projected, point, scale);
    if (!best || d < best.distanceSq) {
      best = { point: projected, segmentIndex: i, distanceSq: d };
    }
  }
  return best;
}

/**
 * Each stop's vertex index along the route, assigned in order: stop k is matched only from
 * where stop k-1 matched onwards. The walk is monotone so a route that covers the same road
 * twice (an out-and-back) can't pull a later stop back onto the first pass.
 */
export function stopVertexIndices(line: LngLat[], stops: LngLat[]): number[] {
  const indices: number[] = [];
  let from = 0;
  for (const stop of stops) {
    const scale = lngScale(stop[1]);
    let bestIndex = from;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let i = from; i < line.length; i++) {
      const d = distanceSq(line[i], stop, scale);
      if (d < bestDistance) {
        bestDistance = d;
        bestIndex = i;
      }
    }
    indices.push(bestIndex);
    from = bestIndex;
  }
  return indices;
}

/**
 * Where a point dropped on `segmentIndex` belongs in the stop list: before the first stop that
 * lies further along the route. Counted over the stops the route was computed from, so a caller
 * whose list holds blank rows has to map the result back onto its own indices.
 */
export function insertionIndexForSegment(stopIndices: number[], segmentIndex: number): number {
  for (let k = 1; k < stopIndices.length; k++) {
    if (segmentIndex < stopIndices[k]) return k;
  }
  // Past the last stop's own vertex (a route that overshoots its destination): the drop still
  // belongs before the destination, never after it.
  return Math.max(1, stopIndices.length - 1);
}

/**
 * A drag on the route, as an edit to its stops: dropping a point on a leg adds a stop there,
 * dragging an existing stop moves it. `index` counts the *routed* stops in both cases.
 */
export type RouteDragEdit =
  | { kind: "insert"; index: number; point: { lat: number; lng: number } }
  | { kind: "move"; index: number; point: { lat: number; lng: number } };

/**
 * Apply a drag edit to a stop list that may hold blank rows. `index` counts only the filled
 * (routed) stops, so it's mapped back through their positions first — a blank row earlier in
 * the list would otherwise shift every later leg by one. Returns the list unchanged if the
 * index doesn't resolve.
 */
export function applyRouteDragEdit<T>(
  stops: (T | null)[],
  edit: RouteDragEdit,
  stopAtPoint: (point: { lat: number; lng: number }) => T
): (T | null)[] {
  const filled = stops.flatMap((stop, i) => (stop != null ? [i] : []));
  if (edit.kind === "move") {
    const at = filled[edit.index];
    if (at === undefined) return stops;
    return stops.map((stop, i) => (i === at ? stopAtPoint(edit.point) : stop));
  }
  const next = [...stops];
  next.splice(filled[edit.index] ?? stops.length, 0, stopAtPoint(edit.point));
  return next;
}
