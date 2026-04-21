import { uniqueNameCandidates } from "./unique-name";

export function filenameBaseFromPlaceTitle(title: string): string {
  const s = title
    .trim()
    .replace(/[/\\:*?"<>|]/g, "")
    .trim();
  return s || "place";
}

export async function renameCreatedPlaceToSlug(
  initialPath: string,
  baseSlug: string
): Promise<{ ok: true; filePath: string } | { ok: false; error: string }> {
  let n = 0;
  const maxCandidates = 31;
  for (const slug of uniqueNameCandidates(baseSlug, "hyphenNumbered")) {
    if (++n > maxCandidates) return { ok: false, error: "Could not find an available filename" };
    const r = await window.api.fs.renameFile(initialPath, slug);
    if (r.success) return { ok: true, filePath: r.newPath };
    if (r.error !== "A file or folder with that name already exists") {
      return { ok: false, error: r.error };
    }
  }
  return { ok: false, error: "Could not find an available filename" };
}
