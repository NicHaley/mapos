import { Button } from "@mapos/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@mapos/ui/components/tooltip";
import { cn } from "@mapos/ui/lib/utils";
import { buffer } from "@turf/buffer";
import { point } from "@turf/helpers";
import { InfoIcon, LoaderCircleIcon, MinusIcon, NavigationIcon, PlusIcon } from "lucide-react";
import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { Layer, Marker, Source, useMap } from "react-map-gl/maplibre";

function stop(e: React.SyntheticEvent): void {
  e.stopPropagation();
}

// Glassy floating chrome, used only for the transient error pill now that the
// buttons themselves are ghost (Felt-style: transparent until hover).
const surface = "border border-border bg-background/70 shadow-sm backdrop-blur-md";

// A soft shadow keeps the ghost icons legible over any map background.
const ICON = "size-4 drop-shadow-[0_1px_2px_rgba(0,0,0,0.45)]";

// Tick marks around the dial: 12 spokes (every 30°), cardinals longer/bolder.
const COMPASS_TICKS = Array.from({ length: 12 }, (_, i) => {
  const rad = (i * 30 * Math.PI) / 180;
  const cardinal = i % 3 === 0;
  const outer = 11;
  const inner = cardinal ? 8 : 9.5;
  return {
    deg: i * 30,
    x1: 12 + outer * Math.sin(rad),
    y1: 12 - outer * Math.cos(rad),
    x2: 12 + inner * Math.sin(rad),
    y2: 12 - inner * Math.cos(rad),
    cardinal
  };
});

/**
 * Custom compass rose. The whole dial — tick ring and needle — rotates by
 * -bearing so the red north arm always points to true north; clicking the
 * button resets the map to north-up.
 */
function CompassRose({ bearing }: { bearing: number }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-5 text-foreground drop-shadow-[0_1px_2px_rgba(0,0,0,0.45)]"
      aria-hidden="true"
    >
      <title>Compass</title>
      <g transform={`rotate(${-bearing} 12 12)`}>
        {COMPASS_TICKS.map((t) => (
          <line
            key={t.deg}
            x1={t.x1}
            y1={t.y1}
            x2={t.x2}
            y2={t.y2}
            stroke="currentColor"
            strokeWidth={t.cardinal ? 1 : 0.75}
            strokeLinecap="round"
            opacity={t.cardinal ? 0.7 : 0.3}
          />
        ))}
        <path d="M12 5 L14.5 12 L12 11 L9.5 12 Z" className="fill-red-500" />
        <path d="M12 19 L14.5 12 L12 13 L9.5 12 Z" className="fill-muted-foreground" />
      </g>
    </svg>
  );
}

/** Ghost icon button — transparent until hover, with the map-click guard. */
function ControlButton({
  label,
  onClick,
  disabled,
  children
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label={label}
            disabled={disabled}
            className="pointer-events-auto"
            onPointerDown={stop}
            onClick={(e) => {
              stop(e);
              onClick();
            }}
          >
            {children}
          </Button>
        }
      />
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Bottom-right map controls (Felt-style): ghost icon buttons, evenly spaced. A
 * compass that appears only when the map is rotated and snaps it back to north,
 * zoom in/out, and a locate button that centers on the user's current position.
 * Lives as a child of <MapGL> so it can read the live map via useMap() and drop
 * a location marker directly into the map.
 */
export function MapControls(): React.JSX.Element {
  const maps = useMap();
  const mapRef = maps.current;
  const [camera, setCamera] = useState({ bearing: 0, zoom: 0 });
  const [locating, setLocating] = useState(false);
  const [userLoc, setUserLoc] = useState<{ lng: number; lat: number; accuracy: number } | null>(
    null
  );
  const [locateError, setLocateError] = useState<string | null>(null);

  // Accuracy ring as a real GeoJSON circle (radius in meters), so it scales with
  // zoom and tells the truth about how coarse desktop (wifi) positioning is.
  const accuracyCircle = useMemo(() => {
    if (!userLoc || userLoc.accuracy <= 0) return null;
    return buffer(point([userLoc.lng, userLoc.lat]), userLoc.accuracy / 1000, { steps: 64 });
  }, [userLoc]);

  // Auto-dismiss the location error so it doesn't linger in the corner.
  useEffect(() => {
    if (!locateError) return;
    const id = setTimeout(() => setLocateError(null), 4000);
    return () => clearTimeout(id);
  }, [locateError]);

  useEffect(() => {
    const map = mapRef?.getMap();
    if (!map) return;
    const update = (): void => {
      const bearing = map.getBearing();
      const zoom = map.getZoom();
      setCamera((prev) =>
        prev.bearing === bearing && prev.zoom === zoom ? prev : { bearing, zoom }
      );
    };
    update();
    map.on("move", update);
    return () => {
      map.off("move", update);
    };
  }, [mapRef]);

  const map = mapRef?.getMap();
  const atMax = map ? camera.zoom >= map.getMaxZoom() : false;
  const atMin = map ? camera.zoom <= map.getMinZoom() : false;
  const rotated = Math.abs(camera.bearing) > 0.5;

  const locate = (): void => {
    if (!map) return;
    setLocating(true);
    setLocateError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        const { longitude, latitude, accuracy } = pos.coords;
        setUserLoc({ lng: longitude, lat: latitude, accuracy });
        map.flyTo({
          center: [longitude, latitude],
          zoom: Math.max(map.getZoom(), 14),
          duration: 1200
        });
      },
      (err) => {
        setLocating(false);
        const message =
          err.code === err.PERMISSION_DENIED
            ? "Location access denied"
            : err.code === err.TIMEOUT
              ? "Location timed out"
              : "Location unavailable";
        console.warn(`Geolocation failed (${err.code}): ${err.message}`);
        setLocateError(message);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  return (
    <>
      {accuracyCircle && (
        <Source id="user-location-accuracy" type="geojson" data={accuracyCircle}>
          <Layer
            id="user-location-accuracy-fill"
            type="fill"
            paint={{ "fill-color": "#0ea5e9", "fill-opacity": 0.12 }}
          />
          <Layer
            id="user-location-accuracy-line"
            type="line"
            paint={{ "line-color": "#0ea5e9", "line-width": 1, "line-opacity": 0.35 }}
          />
        </Source>
      )}
      {userLoc && (
        <Marker longitude={userLoc.lng} latitude={userLoc.lat}>
          <div className="size-3.5 rounded-full border-2 border-white bg-sky-500 shadow-md" />
        </Marker>
      )}
      <div className="pointer-events-none absolute right-2 bottom-2 z-10 flex flex-col items-end gap-1">
        {locateError && (
          <div
            className={cn(
              "pointer-events-auto flex h-8 items-center rounded-full px-3 text-xs text-muted-foreground",
              surface
            )}
          >
            {locateError}
          </div>
        )}
        <div className="flex flex-row items-center gap-1">
          {rotated && (
            <ControlButton label="Reset north" onClick={() => map?.resetNorth()}>
              <CompassRose bearing={camera.bearing} />
            </ControlButton>
          )}
          <ControlButton label="My location" disabled={locating} onClick={locate}>
            {locating ? (
              <LoaderCircleIcon className={cn(ICON, "animate-spin")} />
            ) : (
              <NavigationIcon className={cn(ICON, userLoc && "fill-sky-500 text-sky-500")} />
            )}
          </ControlButton>
          <ControlButton label="Zoom out" disabled={atMin} onClick={() => map?.zoomOut()}>
            <MinusIcon className={ICON} />
          </ControlButton>
          <ControlButton label="Zoom in" disabled={atMax} onClick={() => map?.zoomIn()}>
            <PlusIcon className={ICON} />
          </ControlButton>
          {/* Attribution shown on hover; mirrors ATTRIBUTION in main/region-protocol.ts. */}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Map data attribution"
                  className="pointer-events-auto"
                  onPointerDown={stop}
                  onClick={stop}
                >
                  <InfoIcon className={ICON} />
                </Button>
              }
            />
            <TooltipContent side="top">© OpenStreetMap contributors · © Protomaps</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </>
  );
}
