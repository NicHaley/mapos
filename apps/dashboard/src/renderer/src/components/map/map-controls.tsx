import { Button } from "@mapos/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@mapos/ui/components/tooltip";
import { cn } from "@mapos/ui/lib/utils";
import { LoaderCircleIcon, LocateFixedIcon, MinusIcon, PlusIcon } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { Marker, useMap } from "react-map-gl/maplibre";

function stop(e: React.SyntheticEvent): void {
  e.stopPropagation();
}

// Glassy floating chrome, a touch more transparent than the region-coverage pill.
const surface = "border border-border bg-background/70 shadow-sm backdrop-blur-md";

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
    <svg viewBox="0 0 24 24" className="size-5 text-muted-foreground" aria-hidden="true">
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

/**
 * Bottom-right map controls: zoom in/out, a compass that resets bearing/pitch,
 * and a locate button that centers on the user's current position. Lives as a
 * child of <MapGL> so it can read the live map via useMap() and drop a location
 * marker directly into the map.
 */
export function MapControls(): React.JSX.Element {
  const maps = useMap();
  const mapRef = maps.current;
  const [camera, setCamera] = useState({ bearing: 0, zoom: 0 });
  const [locating, setLocating] = useState(false);
  const [userLoc, setUserLoc] = useState<{ lng: number; lat: number } | null>(null);

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

  const locate = (): void => {
    if (!map) return;
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        const { longitude, latitude } = pos.coords;
        setUserLoc({ lng: longitude, lat: latitude });
        map.flyTo({
          center: [longitude, latitude],
          zoom: Math.max(map.getZoom(), 14),
          duration: 1200
        });
      },
      (err) => {
        setLocating(false);
        console.warn("Geolocation failed:", err.message);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  return (
    <>
      {userLoc && (
        <Marker longitude={userLoc.lng} latitude={userLoc.lat}>
          <div className="size-3.5 rounded-full border-2 border-white bg-sky-500 shadow-md" />
        </Marker>
      )}
      <div className="pointer-events-none absolute right-2 bottom-16 z-10 flex flex-col items-end gap-2">
        <div className={cn("pointer-events-auto overflow-hidden rounded-full", surface)}>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Reset bearing to north"
                  className="rounded-full"
                  onPointerDown={stop}
                  onClick={(e) => {
                    stop(e);
                    map?.resetNorthPitch();
                  }}
                >
                  <CompassRose bearing={camera.bearing} />
                </Button>
              }
            />
            <TooltipContent side="left">Reset north</TooltipContent>
          </Tooltip>
        </div>

        <div
          className={cn("pointer-events-auto flex flex-col overflow-hidden rounded-lg", surface)}
        >
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Zoom in"
                  disabled={atMax}
                  className="rounded-none"
                  onPointerDown={stop}
                  onClick={(e) => {
                    stop(e);
                    map?.zoomIn();
                  }}
                >
                  <PlusIcon className="size-4" />
                </Button>
              }
            />
            <TooltipContent side="left">Zoom in</TooltipContent>
          </Tooltip>
          <div className="h-px bg-border" />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Zoom out"
                  disabled={atMin}
                  className="rounded-none"
                  onPointerDown={stop}
                  onClick={(e) => {
                    stop(e);
                    map?.zoomOut();
                  }}
                >
                  <MinusIcon className="size-4" />
                </Button>
              }
            />
            <TooltipContent side="left">Zoom out</TooltipContent>
          </Tooltip>
        </div>

        <div className={cn("pointer-events-auto overflow-hidden rounded-lg", surface)}>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Show my location"
                  disabled={locating}
                  className="rounded-none"
                  onPointerDown={stop}
                  onClick={(e) => {
                    stop(e);
                    locate();
                  }}
                >
                  {locating ? (
                    <LoaderCircleIcon className="size-4 animate-spin" />
                  ) : (
                    <LocateFixedIcon className="size-4" />
                  )}
                </Button>
              }
            />
            <TooltipContent side="left">My location</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </>
  );
}
