import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getLatestRelease } from "../_lib/latest-release";

// Stable, shareable download URL. Resolves the current .dmg at request time and
// 302s to it, so the landing CTA never needs to embed a version-specific link
// (and never 404s if the manifest is briefly unreachable — falls back home).
export async function GET(request: Request) {
  const release = await getLatestRelease();
  if (!release) return Response.redirect(new URL("/", request.url), 302);
  recordDownload(request.headers.get("user-agent"));
  return Response.redirect(release.url, 302);
}

// Bump the daily download counter in D1, fire-and-forget: counting must never
// delay or fail the redirect, and must no-op where bindings are unavailable.
function recordDownload(userAgent: string | null) {
  try {
    const { env, ctx } = getCloudflareContext();
    const day = new Date().toISOString().slice(0, 10);
    ctx.waitUntil(
      env.STATS_DB.prepare(
        "INSERT INTO downloads (day, platform, count) VALUES (?, ?, 1) ON CONFLICT (day, platform) DO UPDATE SET count = count + 1"
      )
        .bind(day, classify(userAgent))
        .run()
        .catch(() => {})
    );
  } catch {}
}

// Coarse, non-identifying buckets: enough to separate real Mac demand from
// bots and window-shoppers on other platforms.
function classify(ua: string | null): "mac" | "other" | "bot" {
  if (!ua || /bot|crawler|spider|preview|externalhit|curl|wget|python|httpclient/i.test(ua)) {
    return "bot";
  }
  return /macintosh|mac os x/i.test(ua) ? "mac" : "other";
}
