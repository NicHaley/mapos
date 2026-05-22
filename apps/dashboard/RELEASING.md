# Releasing the Dashboard

How to ship a new version of the MapOS dashboard to existing installs via auto-update.

Updates are distributed through a Cloudflare R2 bucket exposed at `https://updates.mapos.md`. On launch, installed apps fetch `latest-mac.yml`, compare versions, and (if newer) auto-download the artifact and prompt the user to restart via the in-app banner.

---

## Prerequisites (one-time)

- Wrangler authenticated against the Cloudflare account that owns the R2 bucket. The release script invokes wrangler via the web workspace:
  ```
  pnpm --filter @mapos/web exec wrangler whoami
  ```
  If not logged in: `pnpm --filter @mapos/web exec wrangler login`.
- R2 bucket name. Defaults to `mapos-updates`. Override with `MAPOS_R2_BUCKET=<name>` in `.env` or your shell.
- Custom domain `updates.mapos.md` bound to the bucket (configured in Cloudflare → R2 → bucket → Settings → Custom Domains).
- `apps/dashboard/.env` populated with notarization credentials. Copy `.env.example` to `.env` and fill in:
  ```
  APPLE_ID=your.apple.id@example.com
  APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx
  APPLE_TEAM_ID=ABCDE12345
  ```
  Generate the app-specific password at [appleid.apple.com](https://appleid.apple.com) → Sign-In and Security → App-Specific Passwords. The `.env` file is gitignored.

---

## Release steps

1. **Bump the version** in `apps/dashboard/package.json` (e.g. `1.0.0-alpha.1` → `1.0.0-alpha.2`). The release script reads from here and `electron-updater` uses it to decide if clients should update. If you forget this, the upload will succeed but no client will pick it up.

2. **Commit and tag**:
   ```
   git commit -am "release: vX.Y.Z"
   git tag vX.Y.Z
   ```

3. **Build and publish**:
   ```
   pnpm --filter @mapos/dashboard release
   ```
   This runs `scripts/publish-release.sh`, which:
   - Loads `apps/dashboard/.env` (Apple notarization credentials).
   - Runs `build:mac` — signs with the Developer ID Application identity and notarizes via Apple's service. Notarization can add 2–15 minutes depending on Apple's queue.
   - Produces in `apps/dashboard/dist/`: `MapOS-<version>.dmg` + `.blockmap`, `MapOS-<version>-arm64-mac.zip` + `.blockmap`, and `latest-mac.yml`.
   - Uploads binaries + blockmaps first.
   - Uploads `latest-mac.yml` last, with `Cache-Control: public, max-age=60`. The short TTL ensures a new release propagates within ~60s instead of being masked by CDN caching of the previous manifest. The "manifest last" order means clients never see a manifest pointing at a missing artifact.

4. **Verify the manifest is live**:
   ```
   curl -I https://updates.mapos.md/latest-mac.yml
   curl -s https://updates.mapos.md/latest-mac.yml | head
   ```
   Expect a 200, and the `version:` line should match what you bumped in step 1. If you still see the old version, give it up to a minute for the cache to expire.

5. **Smoke test** with an older installed build:
   - Launch the older version.
   - On startup the app calls `autoUpdater.checkForUpdates()` (skipped in dev — release builds only).
   - The update banner (top-right) should show download progress, then "Update X ready" with a **Restart** button.
   - Click Restart → app quits and relaunches on the new version.

6. **Push the tag** so the release is recorded:
   ```
   git push origin vX.Y.Z
   ```

> To build without publishing (e.g. to inspect the artifact locally), run `pnpm --filter @mapos/dashboard build:mac` directly. You'll need the same env vars set in your shell, since `build:mac` doesn't auto-load `.env`.

---

## Rollback

There is no automated rollback. If a bad release ships:

1. Bump the version *forward* with the fix (don't republish the same version — clients that already pulled it won't re-download).
2. Re-run the release flow.

Republishing the same version number under different content is unsafe: clients cache by version, and electron-updater compares versions only.

---

## File map

- `electron-builder.yml` — build + publish config. `publish.url` points at the R2 custom domain.
- `dev-app-update.yml` — same URL, used only when testing `autoUpdater` against a dev build.
- `scripts/publish-release.sh` — the build + upload script. Loads `.env`, builds, uploads to R2.
- `.env.example` — template for `.env`. Copy to `.env` and fill in Apple credentials.
- `src/main/updater.ts` — wires `electron-updater` events to IPC channels.
- `src/renderer/src/components/update-banner.tsx` — the in-app UI.
