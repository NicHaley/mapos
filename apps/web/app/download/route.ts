import { getLatestRelease } from "../_lib/latest-release";

// Stable, shareable download URL. Resolves the current .dmg at request time and
// 302s to it, so the landing CTA never needs to embed a version-specific link
// (and never 404s if the manifest is briefly unreachable — falls back home).
export async function GET(request: Request) {
  const release = await getLatestRelease();
  if (release) return Response.redirect(release.url, 302);
  return Response.redirect(new URL("/", request.url), 302);
}
