import { app } from "electron";

/**
 * Wikidata → Wikimedia Commons image resolution for geocode results.
 *
 * All fetching happens in the main process: the renderer's CSP has no
 * connect-src for remote hosts, only an img-src allowance for the two
 * Wikimedia origins so the resolved thumbnail can render directly.
 */

export type WikiImage = {
  /** Commons thumbnail URL (Special:FilePath, redirects to upload.wikimedia.org). */
  thumbUrl: string;
  /** Original Commons file name, e.g. "Montreal skyline 2020.jpg". */
  fileName: string;
  /** Commons file page — the attribution/license landing page. */
  pageUrl: string;
  artist?: string;
  license?: string;
  licenseUrl?: string;
};

const QID_RE = /^Q\d+$/;
const THUMB_WIDTH = 640;
const FETCH_TIMEOUT_MS = 10_000;

// Session-scoped; misses are cached too so an offline machine doesn't re-hit
// the network every time a card opens.
const cache = new Map<string, WikiImage | null>();

function userAgent(): string {
  return `MapOS/${app.getVersion()} (hello@nichaley.com)`;
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { "user-agent": userAgent() },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** First preferred-rank P18 claim's file name, else the first claim's. */
function imageFileNameFromClaims(data: unknown): string | null {
  const claims = (data as { claims?: { P18?: unknown[] } })?.claims?.P18;
  if (!Array.isArray(claims) || claims.length === 0) return null;
  const pick = claims.find((c) => (c as { rank?: string }).rank === "preferred") ?? claims[0];
  const value = (pick as { mainsnak?: { datavalue?: { value?: unknown } } })?.mainsnak?.datavalue
    ?.value;
  return typeof value === "string" && value ? value : null;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Best-effort artist + license from the Commons extmetadata for a file. */
async function fetchAttribution(
  fileName: string
): Promise<{ artist?: string; license?: string; licenseUrl?: string }> {
  try {
    const url = `https://commons.wikimedia.org/w/api.php?action=query&prop=imageinfo&iiprop=extmetadata&format=json&titles=${encodeURIComponent(`File:${fileName}`)}`;
    const data = (await fetchJson(url)) as {
      query?: { pages?: Record<string, { imageinfo?: Array<{ extmetadata?: unknown }> }> };
    };
    const pages = data.query?.pages ?? {};
    const meta = Object.values(pages)[0]?.imageinfo?.[0]?.extmetadata as
      | Record<string, { value?: unknown }>
      | undefined;
    const rawArtist = meta?.Artist?.value;
    const rawLicense = meta?.LicenseShortName?.value;
    const rawLicenseUrl = meta?.LicenseUrl?.value;
    const artist = typeof rawArtist === "string" ? stripHtml(rawArtist).slice(0, 60) : undefined;
    const license = typeof rawLicense === "string" ? stripHtml(rawLicense) : undefined;
    const licenseUrl =
      typeof rawLicenseUrl === "string" && /^https?:/.test(rawLicenseUrl)
        ? rawLicenseUrl
        : undefined;
    return { artist: artist || undefined, license: license || undefined, licenseUrl };
  } catch {
    return {};
  }
}

/** Resolve a Wikidata QID to its P18 Commons image, or null if none/unreachable. */
export async function lookupWikidataImage(qid: string): Promise<WikiImage | null> {
  if (!QID_RE.test(qid)) return null;
  const cached = cache.get(qid);
  if (cached !== undefined) return cached;
  let result: WikiImage | null = null;
  try {
    const data = await fetchJson(
      `https://www.wikidata.org/w/api.php?action=wbgetclaims&entity=${qid}&property=P18&format=json`
    );
    const fileName = imageFileNameFromClaims(data);
    if (fileName) {
      const encoded = encodeURIComponent(fileName);
      const attribution = await fetchAttribution(fileName);
      result = {
        thumbUrl: `https://commons.wikimedia.org/wiki/Special:FilePath/${encoded}?width=${THUMB_WIDTH}`,
        fileName,
        pageUrl: `https://commons.wikimedia.org/wiki/File:${encoded}`,
        ...attribution
      };
    }
  } catch {
    // Offline / API hiccup — cache the miss for this session.
  }
  cache.set(qid, result);
  return result;
}

/** Download the resolved thumbnail's bytes for importing into the vault. */
export async function downloadWikidataImage(
  qid: string
): Promise<{ bytes: Uint8Array; fileName: string; pageUrl: string } | null> {
  const image = await lookupWikidataImage(qid);
  if (!image) return null;
  try {
    const res = await fetch(image.thumbUrl, {
      headers: { "user-agent": userAgent() },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { bytes, fileName: image.fileName, pageUrl: image.pageUrl };
  } catch {
    return null;
  }
}
