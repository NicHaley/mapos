import { Button } from "@mapos/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@mapos/ui/components/tooltip";
import { cn } from "@mapos/ui/lib/utils";
import { InfoIcon, LoaderCircleIcon, MinusIcon, NavigationIcon, PlusIcon } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { useMap } from "react-map-gl/maplibre";
import type { UserLocation } from "./user-location-layer";

// Glassy chrome for the transient error pill; the buttons themselves are ghost.
const surface = "border border-border bg-background/70 shadow-sm backdrop-blur-md";

// A soft shadow keeps the ghost icons legible when the top bar is transparent.
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

/** Ghost icon button — transparent until hover. */
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
            onClick={onClick}
          >
            {children}
          </Button>
        }
      />
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Map controls that live in the top bar (right side): a compass that appears
 * only when the map is rotated and snaps it back to north, zoom in/out, a locate
 * button, and attribution. Reads the map via useMap() — so it must render inside
 * the <MapProvider> — and lifts the resolved location up to App, which feeds it
 * back to <UserLocationLayer> inside the map.
 */
export function MapControls({
  userLocation,
  onUserLocationChange
}: {
  userLocation: UserLocation | null;
  onUserLocationChange: (location: UserLocation) => void;
}): React.JSX.Element {
  const maps = useMap();
  const mapRef = maps.main ?? maps.current;
  const [camera, setCamera] = useState({ bearing: 0, zoom: 0 });
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState<string | null>(null);

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

  // Auto-dismiss the location error so it doesn't linger in the bar.
  useEffect(() => {
    if (!locateError) return;
    const id = setTimeout(() => setLocateError(null), 4000);
    return () => clearTimeout(id);
  }, [locateError]);

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
        onUserLocationChange({ lng: longitude, lat: latitude, accuracy });
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
    <div className="flex items-center gap-1">
      {locateError && (
        <div
          className={cn(
            "mr-1 flex h-7 items-center rounded-full px-3 text-xs text-muted-foreground",
            surface
          )}
        >
          {locateError}
        </div>
      )}
      {rotated && (
        <ControlButton label="Reset north" onClick={() => map?.resetNorth()}>
          <CompassRose bearing={camera.bearing} />
        </ControlButton>
      )}
      <ControlButton label="My location" disabled={locating} onClick={locate}>
        {locating ? (
          <LoaderCircleIcon className={cn(ICON, "animate-spin")} />
        ) : (
          <NavigationIcon className={cn(ICON, userLocation && "fill-sky-500 text-sky-500")} />
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
            <Button variant="ghost" size="icon" aria-label="Map data attribution">
              <InfoIcon className={ICON} />
            </Button>
          }
        />
        <TooltipContent side="bottom">© OpenStreetMap contributors · © Protomaps</TooltipContent>
      </Tooltip>
    </div>
  );
}
