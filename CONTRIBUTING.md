# Contributing to MapOS

Thanks for considering a contribution. We appreciate your efforts to make MapOS better.

## Reporting issues

If you hit a bug, open a GitHub issue. Check the existing issues first to avoid
duplicates. Include a clear description of the problem, the steps to reproduce it, what
you expected instead, and any relevant screenshots or error messages. Your macOS version
and MapOS version (Settings → About) help too.

## Feature requests

Ideas belong in
[Discussions → Ideas](https://github.com/NicHaley/mapos/discussions/categories/ideas)
rather than in issues, so that others can upvote and comment. Describe what you're trying
to do, not only the feature you have in mind.

If an idea is accepted, a maintainer opens a tracking issue from the discussion, so
everyone following it sees the work.

## Submitting changes

Node 22 and pnpm; see [README.md](README.md) for local setup. `pnpm install` is the only
step — a fresh clone typechecks, builds, and runs.

To contribute code changes:

1. Fork the repository and create a branch off `main`.
2. Make sure your code follows the project's coding conventions.
3. Run `pnpm check`, `pnpm typecheck`, and `pnpm test`. CI runs the same three.
4. Make commits with clear, descriptive messages. Each commit should have a single
   logical purpose.
5. Push your branch to your fork and open a pull request against `main`.
6. Describe what changed and why, and link any related issue. Screenshots or a short clip
   help a lot for anything visual.

A maintainer will review your PR, give feedback if needed, and merge it once it meets the
project's standards. Small, focused pull requests get reviewed faster. If you're planning
something substantial, open an issue first so we can agree on the approach.

## Coding conventions

Please match the existing conventions and style of the file you're editing. Formatting is
Biome-enforced — run `pnpm check` rather than hand-formatting. Commits follow
[Conventional Commits](https://www.conventionalcommits.org/), enforced by commitlint.

`CLAUDE.md` at the repo root has the full architecture notes. It's written for coding
agents, but it's the most detailed map of the codebase that exists. If you're unsure
about any aspect of the conventions, feel free to ask in your PR.

## Documentation

Improvements to documentation are always welcome and don't need an issue first. If
something in a README or in `CLAUDE.md` was wrong or confusing while you were getting set
up, fixing it is a genuinely useful contribution.

## Licensing of contributions

MapOS is [Apache-2.0](LICENSE). By submitting a pull request you agree that your
contribution is licensed under those same terms.

## Questions

[Discussions → Q&A](https://github.com/NicHaley/mapos/discussions/categories/q-a), or
[hello@mapos.md](mailto:hello@mapos.md) if you'd rather not ask in public.
