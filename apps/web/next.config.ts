import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
import type { NextConfig } from "next";
import { withNextVideo } from "next-video/process";

const nextConfig: NextConfig = {
  /* config options here */
};

initOpenNextCloudflareForDev();

// Demo videos: local sources in /videos, uploaded to R2 with `npx next-video sync`.
// Sync needs R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY plus the vars below in the
// environment; none of them are required at runtime (asset JSON in /videos holds
// the resolved public URLs).
export default withNextVideo(nextConfig, {
  provider: "cloudflare-r2",
  providerConfig: {
    "cloudflare-r2": {
      // S3 API endpoint, e.g. https://<account-id>.r2.cloudflarestorage.com
      endpoint: process.env.R2_ENDPOINT ?? "",
      bucket: process.env.R2_BUCKET,
      // Public bucket URL (custom domain or *.r2.dev), baked into asset JSON at sync time.
      bucketUrlPublic: process.env.R2_BUCKET_URL_PUBLIC
    }
  }
});
