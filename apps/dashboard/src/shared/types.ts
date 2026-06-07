import type { Message } from "@earendil-works/pi-ai";

export type PlaceRecord = {
  geometry?: string; // GeoJSON geometry JSON string; omitted when the file has no location
  title: string;
  color?: string;
  type: string;
  // Canonical place identity in MapOS (replaces separate id field).
  filePath: string;
  /** When set, PlaceCard shows preview content without reading the file; no save/rename. */
  previewMarkdown?: string;
};

export type PlaceUpdate =
  | { event: "add" | "change"; place: PlaceRecord }
  | { event: "unlink"; filePath: string };

export type OverlayPoint = {
  id: string;
  lat: number;
  lng: number;
  title: string;
  /** Shown in mini PlaceCard body before save (optional). */
  preview_markdown?: string;
};

export type OverlayLine = {
  id: string;
  coordinates: [number, number][];
  title?: string;
  preview_markdown?: string;
};

export type OverlayPolygon = {
  id: string;
  coordinates: [number, number][][];
  title?: string;
  preview_markdown?: string;
};

/** Normalized overlay payload for map + chat batch save. */
export type MapOverlayPayload = {
  layerName: string;
  points: OverlayPoint[];
  lines: OverlayLine[];
  polygons: OverlayPolygon[];
};

export type FileNode = {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileNode[];
};

export type ChatToolCallPayload = {
  convId: string;
  id: string;
  name: string;
  input: unknown;
};

export type ChatToolResultPayload = {
  convId: string;
  tool_use_id: string;
  content: string;
  isError: boolean;
};

export type ChatChunkPayload = { convId: string; text: string };
export type ChatDonePayload = {
  convId: string;
  canUndo: boolean;
  /** Pi-native messages that the agent appended this turn (assistant + toolResult rows). */
  newMessages: Message[];
  /** Set when an assistant message in this turn mentioned an overlay ref worth pinning. */
  overlaySnapshot?: OverlaySnapshotEntry;
};
export type ChatErrorPayload = {
  convId: string;
  message: string;
  /** Structured code so the renderer can render targeted affordances (e.g. Reconfigure link). */
  code?: "AI_NOT_CONFIGURED" | "AI_DECRYPT_FAILED";
  /** When set, the renderer should surface a "Reconfigure" link that deep-links to a settings section. */
  reconfigureProvider?: "ai";
};

/**
 * Overlay snapshot pinned to an assistant message whose text mentions an
 * `overlay:` ref. Stored in a sidecar JSONL so historic refs stay resolvable
 * after the live overlay has been replaced or cleared. The key is the
 * assistant message's epoch-ms timestamp (Pi `AssistantMessage.timestamp`).
 */
export type OverlaySnapshotEntry = {
  messageTimestamp: number;
  overlay: MapOverlayPayload;
};

export type ConversationMeta = {
  id: string;
  created_at: string;
  updated_at: string;
  messageCount: number;
  preview: string;
  /** User-renamed title. When unset, the UI falls back to `preview`. */
  title?: string;
};

export type VaultOperation = {
  path: string;
  previousContent: string | null; // null = file was created this turn (undo = delete it)
};

export type UndoEntry = {
  operations: VaultOperation[];
};

// ── Region packs (offline map data) ───────────────────────────────────────────
// Mirrors the R2 manifest schema (pipeline/scripts/make-manifest.ts, schema 3).

export type RegionArtifact = { file: string; bytes: number; sha256: string };

export type RegionVersion = {
  path: string;
  total_bytes: number;
  artifacts: Record<string, RegionArtifact>;
};

export type RegionManifestEntry = {
  name?: string;
  group?: string;
  /** [minLng, minLat, maxLng, maxLat] — from the latest pmtiles header. */
  bbox?: [number, number, number, number];
  /** [lng, lat] — used to place the region's marker on the globe. */
  center?: [number, number];
  latest: string;
  versions: Record<string, RegionVersion>;
};

/**
 * Stable content fingerprint of a version, derived from its artifacts' sha256s. Lets the
 * client detect republished content at an UNCHANGED version string (the manifest is keyed
 * by data date, so a re-upload that fixes a pack keeps the same date) — version-string
 * comparison alone would miss it. Crypto-free so it runs in the renderer too.
 */
export function regionVersionDigest(version: RegionVersion): string {
  return Object.entries(version.artifacts)
    .map(([key, a]) => `${key}:${a.sha256}`)
    .sort()
    .join("|");
}

export type RegionGroup = { name: string; regions: string[] };

export type RegionManifest = {
  schema: number;
  groups: Record<string, RegionGroup>;
  regions: Record<string, RegionManifestEntry>;
};

/** A region pack present on disk (flat layout: `<regionsDir>/<region>/`). */
export type InstalledRegionPack = {
  region: string;
  /** Display name copied from the manifest at install time so offline UI shows
   *  "Quebec", not the slug. Absent on packs installed before this was recorded. */
  name?: string;
  version: string;
  totalBytes: number;
  installedAt: string;
  /** {@link regionVersionDigest} of the version that was downloaded. Compared against the
   *  manifest's current digest to surface same-version content updates. Absent on packs
   *  installed before this was recorded — callers fall back to version-string comparison. */
  contentHash?: string;
  /** [minLng, minLat, maxLng, maxLat] — copied from the manifest so offline
   *  region selection (which pack covers a point) works without the network. */
  bbox?: [number, number, number, number];
};

export type RegionDownloadProgress = {
  region: string;
  receivedBytes: number;
  totalBytes: number;
  /** Coarse lifecycle stage for UI copy. `error` carries `error` (incl. "cancelled"). */
  phase: "downloading" | "verifying" | "done" | "error";
  error?: string;
};

export type PropertyType = "text" | "number" | "date" | "checkbox" | "multi_select";
/** Frontmatter keys managed by the map; not shown as generic properties. */
export const RESERVED_PROPERTY_KEYS = ["geometry", "color"] as const;

/** Returned by chat:load-history and chat:switch-conversation. */
export type ConversationLoadResult = {
  messages: Message[];
  overlay: MapOverlayPayload | null;
  overlaySnapshots: OverlaySnapshotEntry[];
};
