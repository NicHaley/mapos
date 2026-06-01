import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type InstalledRegionPack,
  type RegionDownloadProgress,
  type RegionManifest,
  regionVersionDigest
} from "../../../shared/types";

export type RegionStatus =
  | "available"
  | "downloading"
  | "verifying"
  | "installed"
  | "update-available"
  | "error";

export type RegionRow = {
  slug: string;
  name: string;
  group?: string;
  /** [lng, lat] — globe marker position, when the pack carries geometry. */
  center?: [number, number];
  /** [minLng, minLat, maxLng, maxLat] — coverage box, used to find the region under a point. */
  bbox?: [number, number, number, number];
  latest: string;
  /** Bytes of the latest version (what a fresh download costs). */
  latestBytes: number;
  installed?: InstalledRegionPack;
  status: RegionStatus;
  progress?: { received: number; total: number };
  error?: string;
};

export type RegionGroupRow = { key: string; name: string; rows: RegionRow[] };

const OTHER_GROUP_KEY = "__other__";

export type UseRegionPacks = {
  loading: boolean;
  /** Set when the manifest can't be fetched (offline, or URL unconfigured). */
  error: string | null;
  groups: RegionGroupRow[];
  /** Flat list — convenient for the globe's markers. */
  regions: RegionRow[];
  /** Raw installed packs (with bbox). Loaded even when the manifest can't be fetched. */
  installedPacks: InstalledRegionPack[];
  totalInstalledBytes: number;
  refresh: () => void;
  download: (slug: string) => void;
  cancel: (slug: string) => void;
  remove: (slug: string) => Promise<void>;
};

export function useRegionPacks(enabled: boolean): UseRegionPacks {
  const [manifest, setManifest] = useState<RegionManifest | null>(null);
  const [local, setLocal] = useState<InstalledRegionPack[]>([]);
  const [progress, setProgress] = useState<Record<string, RegionDownloadProgress>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refreshLocal = useCallback(async () => {
    setLocal(await window.api.regions.listLocal());
  }, []);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    // Load installed packs independently of the manifest: a manifest failure (offline,
    // or unconfigured URL) must not hide packs already on disk — that's exactly when the
    // "this area is available offline" signal matters most.
    window.api.regions.listLocal().then(setLocal).catch(() => {});
    window.api.regions
      .getManifest()
      .then(setManifest)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  // Load once the tab is shown (avoids hitting the network until the user opens it).
  useEffect(() => {
    if (enabled) refresh();
  }, [enabled, refresh]);

  // Packs added/removed elsewhere (e.g. deleted from the Offline tab) broadcast
  // `regions:changed`. Re-read local so every hook instance — including the map's
  // coverage indicator — stays in sync without waiting for a manual refresh.
  useEffect(() => window.api.regions.onChanged(() => void refreshLocal()), [refreshLocal]);

  // Stream download progress. "done" clears the row and re-reads local packs;
  // a cancellation just clears it; real errors stay so the row can show + offer retry.
  useEffect(() => {
    const offProgress = window.api.regions.onProgress((p) => {
      setProgress((prev) => {
        const next = { ...prev };
        if (p.phase === "done" || (p.phase === "error" && p.error === "cancelled")) {
          delete next[p.region];
        } else {
          next[p.region] = p;
        }
        return next;
      });
      if (p.phase === "done") void refreshLocal();
    });
    return offProgress;
  }, [refreshLocal]);

  const download = useCallback(
    (slug: string) => {
      const total = manifest?.regions[slug]?.versions[manifest.regions[slug].latest]?.total_bytes ?? 0;
      setProgress((prev) => ({
        ...prev,
        [slug]: { region: slug, receivedBytes: 0, totalBytes: total, phase: "downloading" }
      }));
      window.api.regions.download(slug).catch((e: unknown) => {
        setProgress((prev) => ({
          ...prev,
          [slug]: {
            region: slug,
            receivedBytes: 0,
            totalBytes: total,
            phase: "error",
            error: e instanceof Error ? e.message : String(e)
          }
        }));
      });
    },
    [manifest]
  );

  const cancel = useCallback((slug: string) => {
    void window.api.regions.cancelDownload(slug);
  }, []);

  const remove = useCallback(
    async (slug: string) => {
      await window.api.regions.delete(slug);
      await refreshLocal();
    },
    [refreshLocal]
  );

  const localByRegion = useMemo(() => {
    const m = new Map<string, InstalledRegionPack>();
    for (const p of local) m.set(p.region, p);
    return m;
  }, [local]);

  const regions = useMemo<RegionRow[]>(() => {
    if (!manifest) return [];
    return Object.entries(manifest.regions).map(([slug, entry]) => {
      const installed = localByRegion.get(slug);
      const prog = progress[slug];
      const latestBytes = entry.versions[entry.latest]?.total_bytes ?? 0;

      let status: RegionStatus;
      if (prog) {
        status = prog.phase === "verifying" ? "verifying" : prog.phase === "error" ? "error" : "downloading";
      } else if (installed) {
        // Up to date only if the version matches AND — when the pack recorded a content
        // hash — its content still matches the manifest. The hash check catches packs
        // republished at the same version date (manifest is keyed by data date); packs
        // installed before hashes were recorded fall back to version-string comparison.
        const latestEntry = entry.versions[entry.latest];
        const sameVersion = installed.version === entry.latest;
        const sameContent =
          installed.contentHash === undefined ||
          (latestEntry !== undefined && installed.contentHash === regionVersionDigest(latestEntry));
        status = sameVersion && sameContent ? "installed" : "update-available";
      } else {
        status = "available";
      }

      return {
        slug,
        name: entry.name ?? slug,
        group: entry.group,
        center: entry.center,
        bbox: entry.bbox,
        latest: entry.latest,
        latestBytes,
        installed,
        status,
        progress: prog ? { received: prog.receivedBytes, total: prog.totalBytes } : undefined,
        error: prog?.phase === "error" ? prog.error : undefined
      };
    });
  }, [manifest, localByRegion, progress]);

  const groups = useMemo<RegionGroupRow[]>(() => {
    if (!manifest) return [];
    const bySlug = new Map(regions.map((r) => [r.slug, r]));
    const out: RegionGroupRow[] = [];
    const grouped = new Set<string>();

    for (const [key, g] of Object.entries(manifest.groups)) {
      const rows = g.regions.map((s) => bySlug.get(s)).filter((r): r is RegionRow => !!r);
      for (const r of rows) grouped.add(r.slug);
      if (rows.length) out.push({ key, name: g.name, rows });
    }
    const orphans = regions.filter((r) => !grouped.has(r.slug));
    if (orphans.length) out.push({ key: OTHER_GROUP_KEY, name: "Other", rows: orphans });
    return out;
  }, [manifest, regions]);

  const totalInstalledBytes = useMemo(
    () => local.reduce((sum, p) => sum + p.totalBytes, 0),
    [local]
  );

  return {
    loading,
    error,
    groups,
    regions,
    installedPacks: local,
    totalInstalledBytes,
    refresh,
    download,
    cancel,
    remove
  };
}
