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

// A soft halo keeps the ghost icons legible over the map: a light glow behind the
// dark icons in light mode, a dark shadow behind the light icons in dark mode.
const ICON =
  "size-4 drop-shadow-[0_0_2px_rgba(255,255,255,0.8)] dark:drop-shadow-[0_1px_2px_rgba(0,0,0,0.45)]";

/**
 * Compass needle in Lucide's stroke style (Felt-inspired). A diamond needle
 * that rotates by -bearing so the filled north half always points to true
 * north; clicking the button resets the map to north-up.
 */
function CompassRose({ bearing }: { bearing: number }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-5 drop-shadow-[0_0_2px_rgba(255,255,255,0.8)] dark:drop-shadow-[0_1px_2px_rgba(0,0,0,0.45)]"
      aria-hidden="true"
    >
      <title>Compass</title>
      <g transform={`rotate(${-bearing} 12 12)`}>
        {/* North (pointing) half filled for contrast; full diamond outlined. */}
        <path d="M12 2.5 L16 13 L8 13 Z" fill="currentColor" stroke="none" />
        <path d="M12 2.5 L16 13 L12 21.5 L8 13 Z" />
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
  // Current map bearing normalized to 0–359° for the compass tooltip.
  const heading = Math.round((camera.bearing % 360) + 360) % 360;

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
      <ControlButton label={`Reset north (${heading}°)`} onClick={() => map?.resetNorth()}>
        <CompassRose bearing={camera.bearing} />
      </ControlButton>
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
