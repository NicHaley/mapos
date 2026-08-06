# Contributing to MapOS

Thanks for your interest in MapOS. This document covers how to report problems, propose
changes, and get the project running locally.

## Reporting issues

Report bugs through GitHub issues. Search the existing issues first so we don't end up
with duplicates.

A good report includes a clear description of the problem, the steps to reproduce it,
what you expected instead, and screenshots or error text where they help. Because MapOS
is local-first, please also include your macOS version, the MapOS version (Settings →
About), and whether you were in local or cloud services mode. If the bug involves a place
file, the frontmatter of that file is usually the fastest way to reproduce it.

Don't paste vault contents you'd rather not make public. A minimal file that reproduces
the issue is better than a real one.

## Feature requests

Ideas are welcome. The [feedback board](https://mapos.userjot.com) is the best place for
them, since it lets other people upvote and comment. GitHub issues work too.

Describe what you're trying to do, not only the feature you have in mind. The underlying
need often has a better solution than the one that first comes to mind, and it helps
prioritize.

## Development setup

You'll need Node 22 and pnpm (the version is pinned in the root `packageManager` field).

```sh
git clone https://github.com/NicHaley/mapos.git
cd mapos
pnpm install
```

**One extra step on a fresh clone.** `apps/web` typechecks against
`cloudflare-env.d.ts`, which is generated and gitignored. Wrangler discovers secret
*names* by reading `.dev.vars`, so the template has to be in place first:

```sh
cp apps/web/.dev.vars.example apps/web/.dev.vars
pnpm --filter=@mapos/web cf-typegen
```

Skip it and `pnpm typecheck` fails on `apps/web` with a missing `STATS_KEY`. You only
need to do this once.

Then:

```sh
pnpm dev            # the desktop app
pnpm dev:web        # the marketing site
```

`pnpm dev` opens a vault picker on first run. Point it at an empty folder; MapOS creates
what it needs. A MapOS vault is also a valid Obsidian vault, so an existing Obsidian
vault works too.

Adding a new secret to `apps/web`? Add it to `.dev.vars.example` as well. Forgetting
means typecheck passes on your machine (your real `.dev.vars` has it) and fails in CI.

## Submitting changes

1. Fork the repository and create a branch off `main`.
2. Make your change.
3. Run `pnpm check`, `pnpm typecheck`, and `pnpm test`. CI runs the same three.
4. Commit. Each commit should have a single logical purpose.
5. Push to your fork and open a pull request against `main`.
6. Describe what changed and why. Link the issue if there is one. Screenshots or a short
   clip help a lot for anything visual.

A maintainer will review before merging. Small, focused pull requests get reviewed faster
than large ones. If you're planning something substantial, open an issue first so we can
agree on the approach before you write it.

Git hooks run automatically (installed by the root `prepare` script):

| Hook | What it runs |
|---|---|
| `pre-commit` | Biome over staged files, via lint-staged |
| `commit-msg` | commitlint |
| `pre-push` | `pnpm typecheck` |

Bypass a single commit with `--no-verify` if you need to, but CI will still check.

## Coding conventions

**Match the surrounding file.** That's the main rule. Comments are sparse here and
reserved for logic that isn't self-evident.

**Formatting is Biome-enforced.** Don't hand-format; run `pnpm check`. CI runs
`biome ci`, which checks lint *and* formatting without writing.

**Commits follow [Conventional Commits](https://www.conventionalcommits.org/)**, enforced
by commitlint. Types: `feat`, `fix`, `perf`, `refactor`, `docs`, plus `wip` for partial
work. The type decides whether the commit shows up in `CHANGELOG.md` (see `cliff.toml`).
Subjects are sentence-case.

Scopes mark the exceptions, not the norm. `mcp` and `web` are the recognized ones. **An
unscoped commit means the desktop app**, which is most of them. Scope by intent rather
than by which files changed: an MCP change usually touches the renderer too, and it's
still `mcp`.

**A few architectural rules worth knowing before you start:**

- **Files are the source of truth.** The SQLite index is a rebuildable cache. Never
  persist canonical state only in the index.
- **All vault mutations go through the file-write path**, so the index stays in sync.
  Never write to vault files directly.
- **Geometry is WKT** in place-file frontmatter, converted to GeoJSON for queries and
  rendering. Use Turf for computation; there are no spatial SQL `ST_*` functions.

`CLAUDE.md` at the repo root has the full architecture notes. It's written for coding
agents, but it's the most detailed map of the codebase that exists.

## Testing

```sh
pnpm test                                   # all of it
pnpm --filter @mapos/dashboard test:watch   # while working
```

Coverage is deliberately narrow: pure main-process logic only, mainly `vault-path.ts`
(the write-safety boundary for every agent tool), `wkt.ts`, and `bbox.ts`. There is no
renderer, IPC, or end-to-end coverage.

**So passing tests are a floor, not proof your change works.** Verify UI and
main-process changes in the running app, and say in your pull request that you did.

One hard constraint: **a test may not import Electron or `better-sqlite3`.** The native
binding is compiled for Electron's ABI and won't load in plain Node, so any module that
reaches the database needs that seam mocked first.

## What you can't build locally

Two things need credentials or assets that aren't in this repo. Neither blocks normal
development.

**Signed macOS builds.** `build:mac` signs and notarizes with an Apple Developer
certificate. Without one, electron-builder skips signing and produces an unsigned build,
which is fine for testing. Nothing is pinned to a specific identity, so this won't error
out on you.

**Region packs.** The pipeline that turns OpenStreetMap extracts into offline packs is a
separate project, not in this repo. `build:mac` also expects a prebuilt `world.pmtiles`
in `resources/basemap-assets/` and fails loudly without it. You can run and develop the
app in cloud services mode without any of this.

## Documentation

Documentation improvements are welcome and don't need an issue first. If something in a
README or in `CLAUDE.md` was wrong or confusing while you were getting set up, fixing it
is a genuinely useful contribution.

## Licensing of contributions

MapOS is [Apache-2.0](LICENSE). By submitting a pull request you agree that your
contribution is licensed under those same terms.

## Questions

[hello@mapos.md](mailto:hello@mapos.md)
