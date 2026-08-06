import { useEffect, useState } from "react";
import type { PlaceRecord } from "../../../shared/types";

/**
 * Renderer-side mirror of the indexed places, keyed by file path.
 * Subscribes to the initial dump + incremental updates so chat features and other
 * lookups can resolve a path → PlaceRecord synchronously without an IPC round-trip.
 */
export function usePlacesIndex(): {
  byPath: Map<string, PlaceRecord>;
  /** False until the initial dump lands. Distinguishes "not indexed yet" from "not in the
   *  vault" — a lookup miss means nothing until this is true. */
  loaded: boolean;
} {
  const [byPath, setByPath] = useState<Map<string, PlaceRecord>>(() => new Map());
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const offInitial = window.api.places.onInitial((places) => {
      const next = new Map<string, PlaceRecord>();
      for (const p of places) next.set(p.filePath, p);
      setByPath(next);
      setLoaded(true);
    });
    const offUpdated = window.api.places.onUpdated((update) => {
      setByPath((prev) => {
        const next = new Map(prev);
        if (update.event === "unlink") next.delete(update.filePath);
        else next.set(update.place.filePath, update.place);
        return next;
      });
    });
    window.api.places.requestInitial();
    return () => {
      offInitial();
      offUpdated();
    };
  }, []);

  return { byPath, loaded };
}
