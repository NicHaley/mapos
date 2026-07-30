// Conventional Commits, enforced by the commit-msg hook (.husky/commit-msg).
// The types here are the input to the changelog: cliff.toml groups feat/fix/perf/
// refactor/docs into sections and drops the rest, so a type is really a decision
// about whether the commit shows up in CHANGELOG.md.

export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [
      2,
      "always",
      [
        "feat",
        "fix",
        "perf",
        "refactor",
        "docs",
        "style",
        "test",
        "build",
        "ci",
        "chore",
        "revert",
        // Not conventional-commits standard, added deliberately:
        // `wip` keeps the existing habit of committing partial work legal, and
        // cliff.toml filters it out of the changelog.
        "wip",
        // `release` is what scripts/release.sh commits as; without it the release
        // script's own commit would be rejected by this hook.
        "release"
      ]
    ],
    // Scopes mark the *exceptions*. An unscoped commit means the desktop app,
    // which is the large majority of them, so a `dashboard` scope would sit on
    // most changelog lines while saying nothing. Only reach for a scope when the
    // commit isn't about the app itself.
    //
    // Level 1 (warn, don't reject): an unlisted scope still commits, so this
    // nudges toward the canonical set without blocking work. Grow the list when
    // you notice yourself reaching for something that isn't here.
    //
    // Scope is about INTENT, not file coverage. 85% of MCP commits also touch
    // renderer/preload code (adding a tool tends to touch the bridge and some
    // status UI); if the commit is *about* MCP, scope it `mcp` regardless.
    "scope-enum": [1, "always", ["mcp", "web", "pipeline"]],
    // Hard error: casing drift (mcp/MCP/Mcp) would fragment the changelog, and
    // there's never a reason to want it.
    "scope-case": [2, "always", "lower-case"],
    // config-conventional wants a lower-case subject; this repo's history is
    // sentence-case ("Add consistent tooltips") and that reads better in the
    // generated changelog.
    "subject-case": [0],
    // Commit bodies carry URLs and pasted output that shouldn't be hard-wrapped.
    "body-max-line-length": [0]
  }
};
