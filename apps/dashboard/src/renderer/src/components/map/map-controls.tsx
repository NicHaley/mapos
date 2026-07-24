import { Button } from "@mapos/ui/components/button";
import { Surface, surfaceVariants } from "@mapos/ui/components/surface";
import { Tooltip, TooltipContent, TooltipTrigger } from "@mapos/ui/components/tooltip";
import { cn } from "@mapos/ui/lib/utils";
import { LoaderCircleIcon, MinusIcon, NavigationIcon, PlusIcon, XIcon } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { useMap } from "react-map-gl/maplibre";
import { type McpStatus, useMcpStatus } from "../../hooks/use-mcp-status";
import type { UserLocation } from "./user-location-layer";

// Icons sit on the control pill's surface, so they match the plain ghost icons
// in the left-side cluster — no over-map legibility halo needed.
const ICON = "size-4";

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
      className="size-5"
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
  tooltip,
  onClick,
  disabled,
  children
}: {
  label: string;
  // Hover-tooltip text when it should differ from the aria label (e.g. a state hint).
  tooltip?: string;
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
      <TooltipContent side="bottom">{tooltip ?? label}</TooltipContent>
    </Tooltip>
  );
}

const AGENT_TOOLTIP: Record<McpStatus, string> = {
  active: "MapOS is working…",
  connected: "AI client connected",
  disconnected: "No AI client connected"
};

/**
 * MCP status control in the cluster — a real button like its neighbours. The dot reads the link
 * at a glance: grey when nothing's connected, green when a client is connected (recent activity),
 * and the accent shimmer while an agent is actively driving MapOS. Clicking opens
 * Settings › Connections. Occupies a full control-button footprint (size-8) so the cluster never
 * reflows as the state changes.
 */
function AgentActivity({ status }: { status: McpStatus }): React.JSX.Element {
  return (
    <ControlButton
      label="MCP connection status"
      tooltip={AGENT_TOOLTIP[status]}
      onClick={() =>
        window.dispatchEvent(
          new CustomEvent("mapos:open-settings", { detail: { section: "connections" } })
        )
      }
    >
      <span
        className={cn(
          "rounded-full transition-all duration-500 ease-out",
          status === "active"
            ? "size-3 animate-mcp-shimmer"
            : status === "connected"
              ? "size-2 bg-emerald-500"
              : "size-2 bg-muted-foreground/40"
        )}
      />
    </ControlButton>
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
  // App owns the camera move so it can respect sidebar/main-pane padding; we hand
  // up the resolved location and the zoom we'd like (never zooming further out).
  onUserLocationChange: (location: UserLocation, targetZoom: number) => void;
}): React.JSX.Element {
  const maps = useMap();
  const mapRef = maps.main ?? maps.current;
  const [camera, setCamera] = useState({ bearing: 0, zoom: 0 });
  const [locating, setLocating] = useState(false);
  // Last geolocation failure. Sticky (no auto-dismiss): the pill and amber needle
  // stay until the next attempt, so the recovery action stays reachable.
  const [locateError, setLocateError] = useState<string | null>(null);
  const isMac = window.electron.process.platform === "darwin";
  // Grey (disconnected) / green (connected) / accent (actively working) — drives the status
  // control's dot and, while active, the cluster's accent tint + pulsing contour.
  const mcpStatus = useMcpStatus();
  const mcpBusy = mcpStatus === "active";

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
        onUserLocationChange(
          { lng: longitude, lat: latitude, accuracy },
          Math.max(map.getZoom(), 14)
        );
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
            "mr-1 flex h-8 items-center gap-2 rounded-lg px-3 text-xs text-muted-foreground",
            surfaceVariants({ variant: "pill" })
          )}
        >
          <span>{locateError}</span>
          {isMac && (
            <button
              type="button"
              className="font-medium text-foreground underline-offset-2 hover:underline"
              onClick={() => void window.api.system.openLocationSettings()}
            >
              Open Settings
            </button>
          )}
          <button
            type="button"
            aria-label="Dismiss"
            className="-mr-1 rounded p-0.5 text-muted-foreground hover:text-foreground"
            onClick={() => setLocateError(null)}
          >
            <XIcon className="size-3.5" />
          </button>
        </div>
      )}
      {/* Floating cluster mirroring the left-side controls and the mini place-card actions. */}
      <Surface variant="cluster" className="relative isolate">
        {/* Accent wash over the frosted glass while an agent is working. `-z-1` inside the
            isolated stacking context keeps it above the glass fill but below the buttons. */}
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-0 -z-1 rounded-[inherit] bg-primary/15 opacity-0 transition-opacity duration-500",
            mcpBusy && "opacity-100"
          )}
        />
        {/* Luminous accent contour that travels around the cluster while an agent works. */}
        {mcpBusy && (
          <span
            aria-hidden
            className="mcp-pulsing-border pointer-events-none absolute inset-0 rounded-[inherit]"
          />
        )}
        <AgentActivity status={mcpStatus} />
        <ControlButton label={`Reset north (${heading}°)`} onClick={() => map?.resetNorth()}>
          <CompassRose bearing={camera.bearing} />
        </ControlButton>
        <ControlButton
          label="My location"
          tooltip={
            locating
              ? "Locating…"
              : locateError
                ? "Can't access your location. Check your system's location settings."
                : "My location"
          }
          disabled={locating}
          onClick={locate}
        >
          {locating ? (
            <LoaderCircleIcon className={cn(ICON, "animate-spin")} />
          ) : (
            <NavigationIcon
              className={cn(
                ICON,
                locateError ? "text-amber-500" : userLocation && "fill-sky-500 text-sky-500"
              )}
            />
          )}
        </ControlButton>
        <ControlButton label="Zoom out" disabled={atMin} onClick={() => map?.zoomOut()}>
          <MinusIcon className={ICON} />
        </ControlButton>
        <ControlButton label="Zoom in" disabled={atMax} onClick={() => map?.zoomIn()}>
          <PlusIcon className={ICON} />
        </ControlButton>
      </Surface>
    </div>
  );
}
