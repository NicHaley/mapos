#!/usr/bin/env bash
# Cut a MapOS release: bump the version, generate the changelog section, build +
# publish to R2, record it as a commit and tag, then redeploy the website so its
# download CTA advertises the new version.
#
# Usage:
#   pnpm release                  # 1.0.0-beta.12 -> 1.0.0-beta.13
#   pnpm release patch            # -> 1.0.0 (npm semver keywords)
#   pnpm release 1.1.0            # explicit version
#   pnpm release --dry-run        # everything except publish/commit/tag/push/deploy
#   pnpm release --yes            # skip the confirmation prompt
#   pnpm release --no-push        # commit + tag locally, don't push
#   pnpm release --no-deploy      # skip the website deploy
#
# Ordering is deliberate: nothing is committed, tagged, or pushed until the build
# is signed, notarized, and live on R2. A failure before that point rolls the
# working tree back, so a failed release leaves no trace. See apps/dashboard/
# RELEASING.md for the underlying publish step and its credential requirements.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PKG="apps/dashboard/package.json"
RELEASE_BRANCH="main"
# Pinned so the changelog format can't shift under a release.
CLIFF_VERSION="2.13.1"

BUMP="prerelease"
DRY_RUN=0
ASSUME_YES=0
PUSH=1
DEPLOY_WEB=1

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    --no-push) PUSH=0 ;;
    --no-deploy) DEPLOY_WEB=0 ;;
    -h|--help) awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "$0"; exit 0 ;;
    -*) echo "error: unknown flag $arg" >&2; exit 1 ;;
    *) BUMP="$arg" ;;
  esac
done

# ── rollback ──────────────────────────────────────────────────────────────────
# Everything up to the R2 upload is reversible; past it, the release is public
# and the commit/tag must go through so the repo matches what shipped.
PUBLISHED=0
NEW_VERSION=""
rollback() {
  local code=$?
  if (( code != 0 && PUBLISHED == 0 )); then
    echo
    echo "release failed — reverting version bump + changelog" >&2
    git checkout -- "$PKG" CHANGELOG.md 2>/dev/null || true
  elif (( code != 0 && PUBLISHED == 1 )); then
    echo
    echo "WARNING: the build is already live on R2 but the release was not recorded." >&2
    echo "Commit $PKG + CHANGELOG.md and tag v${NEW_VERSION} by hand." >&2
  fi
}
trap rollback EXIT

# ── git-cliff resolution ──────────────────────────────────────────────────────
# Prefer a local binary; fall back to pnpm dlx (cached in the pnpm store after
# the first run). Not a devDependency because git-cliff's install pulls a git
# subdependency that pnpm's blockExoticSubdeps policy rejects.
if command -v git-cliff >/dev/null 2>&1; then
  cliff() { git-cliff "$@"; }
else
  cliff() { pnpm dlx "git-cliff@${CLIFF_VERSION}" "$@"; }
fi

# ── guards ────────────────────────────────────────────────────────────────────
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$BRANCH" != "$RELEASE_BRANCH" ]]; then
  echo "error: on '$BRANCH', releases are cut from '$RELEASE_BRANCH'" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: working tree is dirty — commit or stash first" >&2
  git status --short >&2
  exit 1
fi

echo "fetching origin…"
git fetch --quiet origin "$RELEASE_BRANCH" --tags
if git rev-parse --verify --quiet "origin/${RELEASE_BRANCH}" >/dev/null; then
  BEHIND="$(git rev-list --count "HEAD..origin/${RELEASE_BRANCH}")"
  if [[ "$BEHIND" != "0" ]]; then
    echo "error: local $RELEASE_BRANCH is $BEHIND commit(s) behind origin — pull first" >&2
    exit 1
  fi
fi

LAST_TAG="$(git describe --tags --abbrev=0 2>/dev/null || true)"
if [[ -z "$LAST_TAG" ]]; then
  echo "error: no tags found — tag the current release before using this script" >&2
  exit 1
fi

# Fail before the multi-minute signed build rather than after it, matching
# publish-release.sh's rclone precheck.
if (( DEPLOY_WEB && ! DRY_RUN )); then
  echo "checking cloudflare auth…"
  if ! pnpm --filter=@mapos/web exec wrangler whoami >/dev/null 2>&1; then
    echo "error: wrangler is not authenticated — the website deploy would fail" >&2
    echo "       run: pnpm --filter=@mapos/web exec wrangler login" >&2
    echo "       or:  pnpm release --no-deploy" >&2
    exit 1
  fi
fi

# ── version bump ──────────────────────────────────────────────────────────────
OLD_VERSION="$(node -p "require('./$PKG').version")"
# npm version writes package.json and echoes "vX.Y.Z". Reverted by the trap if
# anything downstream fails.
NEW_VERSION="$( (cd apps/dashboard && npm version --no-git-tag-version --preid beta "$BUMP") )"
NEW_VERSION="${NEW_VERSION#v}"

COMMIT_COUNT="$(git rev-list --count "${LAST_TAG}..HEAD")"

echo
echo "  version   ${OLD_VERSION} → ${NEW_VERSION}"
echo "  commits   ${COMMIT_COUNT} since ${LAST_TAG}"
echo "  publish   $( ((DRY_RUN)) && echo "no (dry run)" || echo "yes → r2://mapos-updates" )"
echo "  website   $( ((DRY_RUN)) && echo "no (dry run)" || { ((DEPLOY_WEB)) && echo "yes → mapos-web" || echo "no (--no-deploy)"; } )"
echo

if (( ! ASSUME_YES )); then
  read -r -p "continue? [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]] || { echo "aborted"; exit 1; }
fi

# ── gates ─────────────────────────────────────────────────────────────────────
# Test coverage is narrow (pure main-process logic), so this is a floor rather
# than a guarantee — the manual smoke test at the end still matters.
echo
echo "▸ lint"
pnpm lint
echo "▸ typecheck"
pnpm typecheck
echo "▸ test"
pnpm test

# ── changelog ─────────────────────────────────────────────────────────────────
echo
echo "▸ changelog"
cliff --unreleased --tag "v${NEW_VERSION}" --prepend CHANGELOG.md
if ! git diff --quiet -- CHANGELOG.md; then
  { git diff --unified=0 -- CHANGELOG.md | grep '^+' | grep -v '^+++' | sed 's/^+/  /'; } || true
else
  echo "  warning: no changelog entries generated for this release" >&2
  echo "  (commits since ${LAST_TAG} were all skipped — wip/chore/merge)" >&2
fi

if (( DRY_RUN )); then
  echo
  echo "dry run — reverting $PKG + CHANGELOG.md, nothing published"
  git checkout -- "$PKG" CHANGELOG.md
  trap - EXIT
  exit 0
fi

# ── publish (point of no return) ──────────────────────────────────────────────
echo
echo "▸ build + publish (signing + notarization, several minutes)"
pnpm --filter @mapos/dashboard release
PUBLISHED=1

# ── record ────────────────────────────────────────────────────────────────────
echo
echo "▸ recording release"
git add "$PKG" CHANGELOG.md
git commit -m "release: v${NEW_VERSION}"
git tag -a "v${NEW_VERSION}" -m "v${NEW_VERSION}"

if (( PUSH )); then
  git push origin "$RELEASE_BRANCH" --follow-tags
else
  echo "  --no-push: run 'git push origin ${RELEASE_BRANCH} --follow-tags' when ready"
fi

trap - EXIT

# ── website ───────────────────────────────────────────────────────────────────
# apps/web prerenders the landing page at build time, reading the version from
# updates.mapos.md/latest-mac.yml — so this has to run *after* the R2 upload, or
# it would bake the version we just replaced. Non-fatal: the app release is
# already public and recorded, and the deploy is independently rerunnable.
WEB_DEPLOYED=0
if (( DEPLOY_WEB )); then
  echo
  echo "▸ deploying website"
  # Next caches that manifest fetch for an hour under .next/cache/fetch-cache.
  # Without dropping it, a release cut within an hour of the last web build
  # prerenders the stale version.
  rm -rf apps/web/.next/cache/fetch-cache
  if pnpm --filter=@mapos/web cf:deploy; then
    WEB_DEPLOYED=1
  else
    echo
    echo "WARNING: website deploy failed. The app release is live and recorded," >&2
    echo "but mapos.md still advertises the previous version." >&2
    echo "rerun: pnpm --filter=@mapos/web cf:deploy" >&2
  fi
fi

echo
echo "released v${NEW_VERSION}"
echo
echo "next:"
echo "  · verify:  curl -s https://updates.mapos.md/latest-mac.yml | head -3"
if (( WEB_DEPLOYED )); then
  echo "  · verify:  the download CTA on https://mapos.md reads ${NEW_VERSION}"
fi
echo "  · smoke test auto-update from an older install"
echo "  · write the user-facing post from this CHANGELOG.md section (userjot.com)"
