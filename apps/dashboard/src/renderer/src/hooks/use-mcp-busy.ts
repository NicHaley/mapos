import { useEffect, useRef, useState } from "react";

// How long to keep the indicator lit after the last tool call settles. MapOS can't see the agent
// think between calls (that happens in the MCP client, off-app) — it only sees discrete tool
// calls. So we treat "a tool fired recently" as "still working": each call re-arms this window,
// so a working agent (which calls tools periodically) keeps it continuously lit, and it only
// fades once the agent has gone quiet for this long. Longer = feels more continuous but lingers
// after the agent is done; shorter = flickers off during long think-gaps. Tune to taste.
const IDLE_MS = 10_000;

/**
 * True while the local MCP server has a tool call in flight, or has had one within the last
 * IDLE_MS. Backs the "MapOS is working" shimmer in the map controls.
 */
export function useMcpBusy(): boolean {
  const [busy, setBusy] = useState(false);
  // Imperative by nature: the in-flight count must not itself trigger re-renders, and the tail
  // timer is a mutable handle — neither belongs in state.
  const inFlight = useRef(0);
  const tailTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const clearTail = (): void => {
      if (tailTimer.current !== null) {
        clearTimeout(tailTimer.current);
        tailTimer.current = null;
      }
    };
    const off = window.api.mcp.onToolPhase(({ phase }) => {
      if (phase === "start") {
        inFlight.current += 1;
        clearTail();
        setBusy(true);
      } else {
        inFlight.current = Math.max(0, inFlight.current - 1);
        if (inFlight.current === 0) {
          clearTail();
          tailTimer.current = setTimeout(() => {
            tailTimer.current = null;
            setBusy(false);
          }, IDLE_MS);
        }
      }
    });
    return () => {
      off();
      clearTail();
    };
  }, []);

  return busy;
}
