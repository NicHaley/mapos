/**
 * Map-drawing session types shared by the place card (which starts a session),
 * App (which owns it and commits the result), and MapView (which renders it).
 *
 * Values match Terra Draw's own mode names so they can be passed to `setMode`
 * without a lookup table.
 */

/** The shapes a place's geometry can be drawn with. */
export type DrawShape = "point" | "linestring" | "polygon" | "rectangle" | "circle" | "freehand";

/** `"select"` edits existing geometry in place; every other value draws a new shape. */
export type DrawMode = DrawShape | "select";

/** An in-progress draw or edit, bound to the one vault file it will write to. */
export type DrawSession = {
  filePath: string;
  mode: DrawMode;
  /** GeoJSON geometry (JSON string) loaded into the editor. Set only for `"select"`. */
  initialGeometry?: string;
};

export const DRAW_SHAPE_LABELS: Record<DrawShape, string> = {
  point: "Drop a point",
  linestring: "Draw a line",
  polygon: "Draw an area",
  rectangle: "Draw a rectangle",
  circle: "Draw a circle",
  freehand: "Draw freehand"
};

/** What the map toolbar tells the user to do while a session is active. */
export const DRAW_MODE_HINTS: Record<DrawMode, string> = {
  point: "Click the map to place the point",
  linestring: "Click to add points, double-click or press Enter to finish",
  polygon: "Click to add corners, double-click or press Enter to close the area",
  rectangle: "Click and drag to size the rectangle",
  circle: "Click the centre, then drag out the radius",
  freehand: "Hold and drag to trace the outline",
  select: "Drag the shape or its handles, then save"
};

/** Shapes that Terra Draw completes as a Polygon rather than their own geometry type. */
export function drawShapeGeometryType(shape: DrawShape): "Point" | "LineString" | "Polygon" {
  if (shape === "point") return "Point";
  if (shape === "linestring") return "LineString";
  return "Polygon";
}

/**
 * The Terra Draw mode that owns an existing geometry, used to re-add it to the
 * editor for a `"select"` session. Terra Draw rejects features whose `mode`
 * property names a mode the instance was not constructed with.
 */
export function drawModeForGeometryType(type: string): "point" | "linestring" | "polygon" | null {
  if (type === "Point") return "point";
  if (type === "LineString") return "linestring";
  if (type === "Polygon") return "polygon";
  return null;
}
