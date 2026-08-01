import { type DrawSession, drawModeForGeometryType } from "@renderer/lib/draw";
import type { Geometry } from "geojson";
import { useEffect, useRef } from "react";
import { useMap } from "react-map-gl/maplibre";
import {
  type HexColor,
  TerraDraw,
  TerraDrawCircleMode,
  TerraDrawFreehandMode,
  TerraDrawLineStringMode,
  TerraDrawPointMode,
  TerraDrawPolygonMode,
  TerraDrawRectangleMode,
  TerraDrawSelectMode
} from "terra-draw";
import { TerraDrawMapLibreGLAdapter } from "terra-draw-maplibre-gl-adapter";

/** ~10cm. The default (9) writes 9 decimal places of noise into every frontmatter WKT. */
const COORDINATE_PRECISION = 6;

/** Vertex handles are only draggable/deletable for the three geometry types a place can hold. */
const SELECT_FLAGS = {
  point: { feature: { draggable: true } },
  linestring: {
    feature: {
      draggable: true,
      coordinates: { midpoints: true, draggable: true, deletable: true }
    }
  },
  polygon: {
    feature: {
      draggable: true,
      coordinates: { midpoints: true, draggable: true, deletable: true }
    }
  }
};

/**
 * Terra Draw bound to the MapLibre map, active only while a draw session is.
 *
 * Rendered as a child of <MapGL> so it can reach the map through `useMap`. It draws
 * onto its own MapLibre layers, above the vault/overlay sources, and tears them all
 * down when the session ends.
 *
 * Draw modes commit on Terra Draw's `finish` event (double-click, ring close, pointer
 * up — whatever completes that shape). Select mode has no such moment, so it reports
 * every geometry change and waits for the user to save from the toolbar.
 */
export function DrawLayer({
  session,
  color,
  onFinish,
  onEditChange
}: {
  session: DrawSession;
  /** Hex colour drawn shapes render in — the same accent a saved place would use. */
  color: string;
  /** A draw-mode shape was completed. */
  onFinish: (geometry: Geometry) => void;
  /** Select-mode geometry changed. The parent holds it until the user saves. */
  onEditChange: (geometry: Geometry) => void;
}): null {
  const { current: mapRef } = useMap();

  // Held in refs so a new callback identity doesn't tear down the Terra Draw
  // instance mid-drawing — the effect below must only re-run when the session does.
  const onFinishRef = useRef(onFinish);
  onFinishRef.current = onFinish;
  const onEditChangeRef = useRef(onEditChange);
  onEditChangeRef.current = onEditChange;

  const { mode, initialGeometry } = session;

  useEffect(() => {
    const map = mapRef?.getMap();
    if (!map) return;

    // Terra Draw types every colour as `#${string}`; the accent palette is hex-only.
    const hex = color as HexColor;
    const pointStyles = {
      pointColor: hex,
      pointWidth: 6,
      pointOutlineColor: "#ffffff",
      pointOutlineWidth: 2
    } as const;
    const lineStyles = { lineStringColor: hex, lineStringWidth: 3 } as const;
    const areaStyles = {
      fillColor: hex,
      fillOpacity: 0.2,
      outlineColor: hex,
      outlineWidth: 2
    } as const;

    const draw = new TerraDraw({
      adapter: new TerraDrawMapLibreGLAdapter({
        map,
        coordinatePrecision: COORDINATE_PRECISION
      }),
      // Every mode is registered regardless of the session's own mode: a select
      // session needs the mode that owns the geometry it loads, and registering
      // the rest costs nothing until `setMode` activates one.
      modes: [
        new TerraDrawPointMode({ styles: pointStyles }),
        new TerraDrawLineStringMode({ styles: lineStyles, showCoordinatePoints: true }),
        new TerraDrawPolygonMode({ styles: areaStyles, showCoordinatePoints: true }),
        // These three default to "click-move" (click, move the cursor, click to
        // finish). Press-and-drag is the more expected gesture — freehand in
        // particular reads as tracing — so accept both.
        new TerraDrawRectangleMode({
          styles: areaStyles,
          drawInteraction: "click-move-or-drag"
        }),
        new TerraDrawCircleMode({ styles: areaStyles, drawInteraction: "click-move-or-drag" }),
        new TerraDrawFreehandMode({ styles: areaStyles, drawInteraction: "click-move-or-drag" }),
        new TerraDrawSelectMode({
          flags: SELECT_FLAGS,
          styles: {
            selectedPointColor: hex,
            selectedLineStringColor: hex,
            selectedPolygonColor: hex,
            selectedPolygonFillOpacity: 0.2,
            selectedPolygonOutlineColor: hex,
            selectedPolygonOutlineWidth: 2,
            selectionPointColor: "#ffffff",
            selectionPointOutlineColor: hex,
            midPointColor: hex,
            midPointOutlineColor: "#ffffff"
          },
          // Deleting the whole feature from the editor would leave the session with
          // nothing to save; vertices stay deletable through the flags above.
          keyEvents: { deselect: null, delete: null, rotate: null, scale: null }
        })
      ]
    });

    draw.start();

    let editedId: string | number | null = null;
    if (mode === "select") {
      editedId = loadForEditing(draw, initialGeometry);
      // A geometry type with no editor (or one that failed validation) leaves the
      // session with nothing to select — fall back to an inert select mode rather
      // than throwing, and let the user cancel out.
      draw.setMode("select");
      if (editedId !== null) draw.selectFeature(editedId);
    } else {
      draw.setMode(mode);
    }

    const onDrawFinish = (id: string | number): void => {
      if (mode === "select") return;
      const feature = draw.getSnapshotFeature(id);
      if (feature) onFinishRef.current(feature.geometry as Geometry);
    };

    // Select mode keeps its selection handles and midpoints in the same store as
    // the feature being edited, and they change far more often than it does —
    // match on the edited id or we would save a midpoint marker as the geometry.
    const onDrawChange = (ids: Array<string | number>, type: string): void => {
      if (editedId === null || type === "delete" || !ids.includes(editedId)) return;
      const feature = draw.getSnapshotFeature(editedId);
      if (feature) onEditChangeRef.current(feature.geometry as Geometry);
    };

    draw.on("finish", onDrawFinish);
    draw.on("change", onDrawChange);

    return () => {
      draw.off("finish", onDrawFinish);
      draw.off("change", onDrawChange);
      // stop() clears the store and removes the adapter's layers. It throws if the
      // map's style was swapped out from under it (theme change mid-session).
      try {
        draw.stop();
      } catch {
        /* layers already gone with the old style */
      }
      // Terra Draw only resets the cursor in a *mode's* stop(), which runs on setMode
      // transitions — TerraDraw.stop() just unregisters the adapter, so the crosshair
      // the active mode set would outlive the session. Clearing the property is what
      // the adapter itself does for the "unset" cursor; MapLibre reapplies its own on
      // the next interaction.
      map.getCanvas().style.removeProperty("cursor");
    };
  }, [mapRef, mode, initialGeometry, color]);

  return null;
}

/** Adds the session's existing geometry to the editor. Returns its feature id, or null. */
function loadForEditing(draw: TerraDraw, geometryJson: string | undefined): string | number | null {
  if (!geometryJson) return null;
  let geometry: Geometry;
  try {
    geometry = JSON.parse(geometryJson) as Geometry;
  } catch {
    return null;
  }
  const featureMode = drawModeForGeometryType(geometry.type);
  if (!featureMode) return null;
  const id = draw.getFeatureId();
  const [validation] = draw.addFeatures([
    { id, type: "Feature", geometry, properties: { mode: featureMode } } as Parameters<
      TerraDraw["addFeatures"]
    >[0][number]
  ]);
  if (!validation?.valid) {
    console.error("[draw-layer] could not load geometry for editing", validation?.reason);
    return null;
  }
  return id;
}
