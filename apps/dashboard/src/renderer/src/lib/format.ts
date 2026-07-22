/** Human-readable byte size: "—" for empty, MB up to 1000, then GB. */
export function formatBytes(n: number): string {
  if (n <= 0) return "—";
  const mb = n / 1_000_000;
  if (mb < 1000) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return `${(mb / 1000).toFixed(1)} GB`;
}

/** Human-readable distance: metres under 1 km, then km (one decimal below 10). */
export function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`;
  const km = meters / 1000;
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
}

/** Human-readable duration: minutes under an hour, then "H h M min". */
export function formatDuration(seconds: number): string {
  const mins = Math.max(1, Math.round(seconds / 60));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}
