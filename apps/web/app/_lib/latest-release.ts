// Reads the latest macOS release straight from the electron-updater manifest on
// R2 (updates.mapos.md/latest-mac.yml) — the same file every `release` publishes,
// so the site never needs its own release-flow step. Server-only; results are
// cached and revalidated hourly via the fetch data cache.

const UPDATES_BASE = "https://updates.mapos.md";
const REVALIDATE_SECONDS = 3600;

export type LatestRelease = {
  version: string;
  /** Direct link to the macOS .dmg for this version. */
  url: string;
  /** Size of the .dmg in bytes, or null if the manifest didn't record it. */
  sizeBytes: number | null;
};

export async function getLatestRelease(): Promise<LatestRelease | null> {
  try {
    const res = await fetch(`${UPDATES_BASE}/latest-mac.yml`, {
      next: { revalidate: REVALIDATE_SECONDS },
    });
    if (!res.ok) return null;
    const dmg = parseDmg(await res.text());
    // Derive the version from the .dmg filename, not the manifest's top-level
    // `version:` — they can diverge (a botched release), and the label must
    // describe the file the user actually downloads.
    if (!dmg) return null;
    const version = dmg.file.replace(/^MapOS-/, "").replace(/\.dmg$/, "");
    return { version, url: `${UPDATES_BASE}/${dmg.file}`, sizeBytes: dmg.size };
  } catch {
    return null;
  }
}

// electron-updater's mac manifest lists each artifact under `files:` as
// `- url: <name>` followed by `sha512:` and `size:`. Pull the .dmg entry and its
// size without a YAML dependency — the shape is fixed and simple.
function parseDmg(text: string): { file: string; size: number | null } | null {
  let pending: string | null = null;
  for (const line of text.split("\n")) {
    const url = line.match(/^\s*-?\s*url:\s*(.+?)\s*$/)?.[1]?.replace(/^["']|["']$/g, "");
    if (url !== undefined) {
      pending = url.endsWith(".dmg") ? url : null;
      continue;
    }
    if (pending) {
      const size = line.match(/^\s*size:\s*(\d+)\s*$/)?.[1];
      if (size) return { file: pending, size: Number(size) };
    }
  }
  return pending ? { file: pending, size: null } : null;
}

/** "44040192" -> "44.0 MB". One decimal; GB above 1000 MB. */
export function formatBytes(bytes: number): string {
  const mb = bytes / 1_000_000;
  return mb < 1000 ? `${mb.toFixed(1)} MB` : `${(mb / 1000).toFixed(1)} GB`;
}
