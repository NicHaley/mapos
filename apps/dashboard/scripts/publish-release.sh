#!/usr/bin/env bash
# Upload the current dashboard build to Cloudflare R2 for auto-update distribution.
#
# Usage:
#   pnpm --filter @mapos/dashboard build:mac
#   apps/dashboard/scripts/publish-release.sh
#
# Reads version from apps/dashboard/package.json, finds the matching files in
# apps/dashboard/dist/, and uploads them in the order electron-updater expects:
# binaries + blockmaps first, then latest-mac.yml (with short cache TTL) last,
# so clients never see a manifest pointing at a missing artifact.

set -euo pipefail

# ── config ────────────────────────────────────────────────────────────────────
# R2 bucket name (not the custom domain). Find it in the Cloudflare dashboard →
# R2 → bucket details. The custom domain updates.mapos.md should be bound to it.
BUCKET="${MAPOS_R2_BUCKET:-mapos-updates}"

# ── paths ─────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DASHBOARD_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$DASHBOARD_DIR/dist"
REPO_ROOT="$(cd "$DASHBOARD_DIR/../.." && pwd)"

if [[ ! -d "$DIST_DIR" ]]; then
  echo "error: $DIST_DIR not found — run 'pnpm --filter @mapos/dashboard build:mac' first" >&2
  exit 1
fi

VERSION=$(node -p "require('$DASHBOARD_DIR/package.json').version")
echo "publishing MapOS ${VERSION} → r2://${BUCKET}"

# ── wrangler runner ───────────────────────────────────────────────────────────
# Wrangler is installed in apps/web; reuse it rather than requiring a global.
WRANGLER=(pnpm --silent --filter @mapos/web exec wrangler)

put() {
  local local_path="$1"
  local remote_key="$2"
  shift 2
  if [[ ! -f "$local_path" ]]; then
    echo "error: missing $local_path" >&2
    exit 1
  fi
  echo "  ↑ ${remote_key}"
  (cd "$REPO_ROOT" && "${WRANGLER[@]}" r2 object put \
    "${BUCKET}/${remote_key}" \
    --file="$local_path" \
    --remote \
    "$@" >/dev/null)
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
  --content-type="application/x-yaml" \
  --cache-control="public, max-age=60"

echo
echo "done. verify:"
echo "  curl -I https://updates.mapos.md/latest-mac.yml"
