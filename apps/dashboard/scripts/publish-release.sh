#!/usr/bin/env bash
# Build the dashboard and upload it to Cloudflare R2 for auto-update distribution.
#
# Usage:
#   pnpm --filter @mapos/dashboard release
#   (or invoke this script directly)
#
# Loads notarization credentials from apps/dashboard/.env (if present), builds
# the macOS app, then uploads artifacts to R2 in the order electron-updater
# expects: binaries + blockmaps first, then latest-mac.yml (with short cache
# TTL) last, so clients never see a manifest pointing at a missing artifact.
# Finally prunes all but the newest MAPOS_R2_RETAIN versions (default 2).
#
# Upload + prune go through rclone's `r2:` remote (same R2 S3 keys as the region
# pipeline), so the whole flow uses one credential system.
#
# Expected env vars:
#   APPLE_ID                     Apple ID email                  (apps/dashboard/.env)
#   APPLE_APP_SPECIFIC_PASSWORD  app-specific password           (apps/dashboard/.env)
#   APPLE_TEAM_ID                Apple Developer Team ID          (apps/dashboard/.env)
#   RCLONE_CONFIG_R2_*           R2 S3 keys for the `r2:` remote  (repo-root .env)
#   MAPOS_R2_BUCKET              optional bucket (default: mapos-updates)

set -euo pipefail

# ── paths ─────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DASHBOARD_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$DASHBOARD_DIR/dist"
REPO_ROOT="$(cd "$DASHBOARD_DIR/../.." && pwd)"

# ── load credentials from .env (if present) ───────────────────────────────────
# `set -a` makes everything sourced get auto-exported, so child processes
# (electron-builder during build) see APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD /
# APPLE_TEAM_ID. Vars already set in the calling shell are not overwritten by
# `source` for un-quoted assignments, so shell env still wins where it exists.
if [[ -f "$DASHBOARD_DIR/.env" ]]; then
  echo "loading env from apps/dashboard/.env"
  set -a
  # shellcheck disable=SC1091
  source "$DASHBOARD_DIR/.env"
  set +a
fi

# Upload + prune use rclone's R2 S3 keys, which live in the repo-root .env
# alongside the region pipeline's. Pull ONLY those keys — a full source would
# clobber this script's DIST_DIR (the root .env defines its own for regions).
ROOT_ENV="$REPO_ROOT/.env"
if [[ -f "$ROOT_ENV" ]]; then
  while IFS= read -r line; do
    [[ "$line" =~ ^RCLONE_CONFIG_R2_ ]] && export "${line?}"
  done < "$ROOT_ENV"
fi

# Fail fast — before the multi-minute build — if we can't upload afterward.
if ! command -v rclone >/dev/null 2>&1; then
  echo "error: rclone not found (brew install rclone)" >&2
  exit 1
fi
if [[ -z "${RCLONE_CONFIG_R2_TYPE:-}" ]]; then
  echo "error: RCLONE_CONFIG_R2_* not set — add the R2 S3 keys to $ROOT_ENV" >&2
  exit 1
fi

# ── config ────────────────────────────────────────────────────────────────────
# R2 bucket name (not the custom domain). Find it in the Cloudflare dashboard →
# R2 → bucket details. The custom domain updates.mapos.md should be bound to it.
BUCKET="${MAPOS_R2_BUCKET:-mapos-updates}"
# Versions kept on R2 after each publish (newest first); older ones are pruned.
# 2 = current + previous, so a client mid-download during a rollover survives.
RETAIN="${MAPOS_R2_RETAIN:-2}"

VERSION=$(node -p "require('$DASHBOARD_DIR/package.json').version")
echo "publishing MapOS ${VERSION} → r2://${BUCKET}"

# ── build ─────────────────────────────────────────────────────────────────────
echo "building macOS app (this includes signing + notarization — may take several minutes)…"
(cd "$REPO_ROOT" && pnpm --filter @mapos/dashboard build:mac)

if [[ ! -d "$DIST_DIR" ]]; then
  echo "error: $DIST_DIR not found after build" >&2
  exit 1
fi

# ── uploader ──────────────────────────────────────────────────────────────────
# --s3-no-check-bucket: skip the bucket-existence probe so a bucket-scoped token
# (no ListBuckets) still works, matching the region pipeline.
put() {
  local local_path="$1"
  local remote_key="$2"
  shift 2
  if [[ ! -f "$local_path" ]]; then
    echo "error: missing $local_path" >&2
    exit 1
  fi
  echo "  ↑ ${remote_key}"
  rclone copyto "$local_path" "r2:${BUCKET}/${remote_key}" --s3-no-check-bucket "$@"
}

# ── upload artifacts (binaries + blockmaps), then manifest ────────────────────
ZIP="MapOS-${VERSION}-arm64-mac.zip"
DMG="MapOS-${VERSION}.dmg"

put "$DIST_DIR/$ZIP"          "$ZIP"
put "$DIST_DIR/$ZIP.blockmap" "$ZIP.blockmap"
put "$DIST_DIR/$DMG"          "$DMG"
put "$DIST_DIR/$DMG.blockmap" "$DMG.blockmap"

# Manifest LAST. Short max-age so a new release propagates within ~60s instead
# of being masked by CDN caching of the previous yml.
put "$DIST_DIR/latest-mac.yml" "latest-mac.yml" \
  --header-upload "Content-Type: application/x-yaml" \
  --header-upload "Cache-Control: public, max-age=60"

# ── prune old versions ────────────────────────────────────────────────────────
# Best-effort: the new release is fully published by now, so a prune hiccup must
# not fail the release. Worst case, old artifacts linger and the next publish
# cleans them up.
echo "pruning old versions (keeping newest ${RETAIN})…"
node "$SCRIPT_DIR/prune-r2-updates.mjs" --bucket "$BUCKET" --keep "$RETAIN" --current "$VERSION" \
  || echo "warning: prune failed (non-fatal) — old versions remain on R2"

echo
echo "done. verify:"
echo "  curl -I https://updates.mapos.md/latest-mac.yml"
