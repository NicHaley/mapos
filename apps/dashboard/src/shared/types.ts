import type { RouteFrontmatter } from "./route";

export type PlaceRecord = {
  geometry?: string; // GeoJSON geometry JSON string; omitted when the file has no location
  title: string;
  color?: string;
  type: string;
  /**
   * A saved route's stops and travel mode (reserved `route` frontmatter key), so the
   * directions panel can reopen it. `geometry` holds the same route's shape.
   *
   * Only present on records built from frontmatter — `places:query-bounds` and
   * `places:query-folder-all` construct theirs from SQLite rows and can never carry it,
   * so resolve this through the places index rather than off a record from a map click.
   */
  route?: RouteFrontmatter;
  // Canonical place identity in MapOS (replaces separate id field).
  filePath: string;
  /** When set, PlaceCard shows preview content without reading the file; no save/rename. */
  previewMarkdown?: string;
  /** Transient: a just-created file, so PlaceCard opens with the title selected for renaming. */
  justCreated?: boolean;
  /**
   * Structured details for a preview place (search result / chat feature), rendered
   * read-only in the place card by the same properties system and persisted verbatim
   * as frontmatter on "Add". Only present in preview mode; saved vault files carry
   * their properties in the file's frontmatter instead.
   */
  properties?: Record<string, string>;
};

/**
 * Canonical detail keys, in the order they render in the place-card grid and in
 * which they're written to frontmatter on "Add". Known keys come first (this order);
 * any extra keys follow in insertion order. The renderer special-cases these for
 * labels and link affordances. Keep in sync with the place-card detail renderer.
 */
export const CANONICAL_DETAIL_KEYS = [
  "category",
  "address",
  "source_url",
  "osm_id",
  "wikidata_id"
] as const;

/**
 * Return a copy of `props` with the canonical keys first (in {@link CANONICAL_DETAIL_KEYS}
 * order), then any remaining keys in their original insertion order. Empty/blank values
 * are dropped so the preview grid only shows filled keys.
 */
export function orderDetailProperties(
  props: Record<string, string> | undefined
): Record<string, string> {
  if (!props) return {};
  const ordered: Record<string, string> = {};
  const seen = new Set<string>();
  for (const key of CANONICAL_DETAIL_KEYS) {
    const v = props[key];
    if (typeof v === "string" && v.trim()) {
      ordered[key] = v;
      seen.add(key);
    }
  }
  for (const [key, v] of Object.entries(props)) {
    if (seen.has(key)) continue;
    if (typeof v === "string" && v.trim()) ordered[key] = v;
  }
  return ordered;
}

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
  /**
   * Structured details (category, address, source_url, osm_id, wikidata_id, …).
   * Rendered read-only in the place card and persisted as frontmatter on "Add".
   */
  properties?: Record<string, string>;
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

/**
 * One accumulated overlay layer on the map. Each `present_features` /
 * `render_overlay_on_map` call produces a layer with a stable `id` (the tool
 * call id). Layers accumulate rather than replace, so multiple result sets
 * coexist; a chat card owns its layer and can add it to the vault or remove it.
 * Marker ids within a layer are namespaced (`<id>:feature-0`) to stay unique
 * across layers.
 */
/** Overlay-layer id prefix for directions routes — the renderer styles these solid
 * (nav convention) while other overlays draw dashed. */
export const DIRECTIONS_OVERLAY_PREFIX = "directions:";

export type MapOverlayLayer = MapOverlayPayload & {
  id: string;
  /**
   * Vault file paths of saved places presented in this layer (present_features
   * `path` entries). The renderer resolves them against the live places index and
   * draws their markers while the layer is shown — they may lie outside the
   * selected folder, so no other source would render them.
   */
  vaultPaths?: string[];
};

export type FileNode = {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileNode[];
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
  /** Continent slug — lets the client nest country groups under continents. */
  continent?: string;
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

export type RegionGroup = { name: string; continent?: string; regions: string[] };

/** A continent's display name and the country groups nested under it. */
export type RegionContinent = { name: string; groups: string[] };

export type RegionManifest = {
  schema: number;
  /** Continent slug → display name + ordered country groups. */
  continents: Record<string, RegionContinent>;
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
export const RESERVED_PROPERTY_KEYS = [
  "geometry",
  "color",
  "cover",
  "cover_source",
  "route"
] as const;

/**
 * Image formats the mapos-vault:// protocol serves. SVG is deliberately
 * excluded (script-capable format on a privileged, fetch-capable scheme).
 * Single source for the protocol allowlist, the vault tree listing/watcher,
 * and renderer image affordances.
 */
export const SERVABLE_IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp"] as const;

export function isServableImageFile(name: string): boolean {
  const lower = name.toLowerCase();
  return SERVABLE_IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Local MCP server connection info surfaced to the renderer's Settings → Connections panel.
 * Lives in shared/ so main, preload, and renderer share one definition without the renderer
 * pulling in any main-only (node/electron) modules.
 */
export type McpConnectionInfo = {
  enabled: boolean;
  running: boolean;
  port: number;
  token: string;
  url: string;
  /**
   * How to reach the server over stdio instead of HTTP: the bundled bridge, spawned with the app
   * binary running as plain Node. Preferred in client configs because the bridge exists even when
   * MapOS doesn't — it starts the app on demand, where a bare HTTP URL just gets refused.
   */
  stdio: McpStdioLauncher;
  /** `stdio` as one shell command, for a client that takes a command line rather than a config. */
  stdioCommand: string;
  /** The clients MapOS can add itself to, in the order they should be offered. */
  clients: McpClientTarget[];
  /**
   * Why the listener isn't up despite being enabled (a taken port, most likely), or null. Distinct
   * from `running: false`, which on its own can't say whether that's intentional.
   */
  startError: string | null;
  /** Most recent authorized request seen (survives restarts), or null if none since setup. */
  lastActivity: McpActivity | null;
};

export type McpStdioLauncher = { command: string; args: string[]; env: Record<string, string> };

/** MCP clients with a config file MapOS knows how to write. */
export type McpClientId = "claude-code" | "claude-desktop" | "cursor" | "codex";

/** One installable client, as offered by the Connections panel. */
export type McpClientTarget = {
  id: McpClientId;
  label: string;
  /** Absolute path of the config file a one-click install writes. */
  configPath: string;
  /** Same path with the home directory shortened to `~`, for display. */
  configLabel: string;
  /** That config already points a `mapos` server at this build's bridge. */
  configured: boolean;
  /** Paste-it-yourself equivalent, generated from the same launcher the install writes. */
  manual: { hint: string; code: string };
};

/**
 * Evidence that a client is (or was) talking to the local MCP server: the timestamp of the most
 * recent authorized request, plus the client's identity from its most recent `initialize`
 * handshake. Identity can be absent — e.g. activity resumed after an app restart, before the
 * client's next handshake.
 */
export type McpActivity = {
  name?: string;
  version?: string;
  /** Epoch ms of the most recent authorized request. */
  at: number;
};

/**
 * A tool call crossing the MCP bridge: `"start"` when the server begins handling it, `"end"` when
 * it settles (success or error). Transient and live-only (never persisted) — it drives the
 * "MapOS is working" shimmer in the map controls, not the historical "last active" indicator.
 */
export type McpToolPhase = {
  phase: "start" | "end";
  tool: string;
};
