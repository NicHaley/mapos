# Changelog

Notable changes to MapOS. Generated from commit history by [git-cliff](https://git-cliff.org).
History before `v1.0.0-beta.12` is not covered here — see `git log`.


## 1.0.0-beta.16 — 2026-08-13

### Bug fixes

- **mcp:** Preserve open lists and vault-linked stops when presenting again ([`eaacf4a`](https://github.com/NicHaley/mapos/commit/eaacf4ae1df0d3b28eafa8638c2ec5646e5996ec))
- **mcp:** Let the agent update open feature lists in place ([`5fbcbfb`](https://github.com/NicHaley/mapos/commit/5fbcbfb33a0469aff9b4ed66b56b343c140f98f4))
- **mcp:** Save routes with route frontmatter so they reopen in directions ([`65007b5`](https://github.com/NicHaley/mapos/commit/65007b5db7c7385858f5589ea08092ce7cf2ae38))
- Fix region pill and slow tiles on cold start ([`516dc51`](https://github.com/NicHaley/mapos/commit/516dc51d35629f4f39d5f1ac826df092e9b9df00))
- Fix sidebar rename from the ellipsis menu ([`58bb578`](https://github.com/NicHaley/mapos/commit/58bb5780939f07a8148c44953e4653a83e044895))
- Stretch the sidebar file tree to fill its available height ([`61ca7f7`](https://github.com/NicHaley/mapos/commit/61ca7f7c7bb5360405dc960f8c0148e47333f57f))

### Features

- Add a Report a bug link to the About tab ([`6efe1e5`](https://github.com/NicHaley/mapos/commit/6efe1e57bc70ad6b4296472fab700d0551b10de2))

### Other

- Revise README with new project details and image

Updated the project description and image in README.md. ([`6528257`](https://github.com/NicHaley/mapos/commit/652825784bf3c5628f2b0415480ca1bea2ade51a))


## 1.0.0-beta.15 — 2026-08-07

### Features

- **web:** Add GitHub link to site footers ([`8d0791e`](https://github.com/NicHaley/mapos/commit/8d0791e71a9818466aed548719d06e891d95aa59))


## 1.0.0-beta.14 — 2026-08-06

### Bug fixes

- File changes correctly update in real-time ([`13bcf3c`](https://github.com/NicHaley/mapos/commit/13bcf3ce959009b9c55edb9f50ef464f93a7d6ef))
- Correct route stop handling in directions and saved routes ([`fddf794`](https://github.com/NicHaley/mapos/commit/fddf7947a56428a53d74dd5e0e7c2b7d326b88ea))
- Correct route stop handling in directions and saved routes ([`1077038`](https://github.com/NicHaley/mapos/commit/10770383df8938d86f3c8692ee34a0b864ec3796))
- Multiple directions improvements ([`92a1432`](https://github.com/NicHaley/mapos/commit/92a1432e0053725e4dec80fd558ac7e665f0822f))
- Resolve issue where search would lag on first key stroke ([`64db6be`](https://github.com/NicHaley/mapos/commit/64db6becfe71f3f40bfc3ed3ec210db8a6102ff8))
- Bug fixes to routing ([`79881b7`](https://github.com/NicHaley/mapos/commit/79881b73511fdff3f8ba7385b1d0653dbd9142b3))
- Hide directions button to routes ([`c148c4e`](https://github.com/NicHaley/mapos/commit/c148c4e4d3d502d451b93d365daa019e2f221cd4))
- Resolve drawing issues ([`6402132`](https://github.com/NicHaley/mapos/commit/6402132b1124d3bfe896983fad01fa15899376f6))
- Styling fix to MCP config ([`edf0880`](https://github.com/NicHaley/mapos/commit/edf0880e5a6f3b793ab34ece9df87f628543a9e1))
- **mcp:** Error handling ([`846743d`](https://github.com/NicHaley/mapos/commit/846743de956eb5363d4482680a053c21fa19ec9f))

### Features

- Add color and icon support ([`e1a4b02`](https://github.com/NicHaley/mapos/commit/e1a4b0284b662fe3cdc0840f5eef298d43431882))
- Rewrite the welcome copy around offline maps and AI ([`26a20e8`](https://github.com/NicHaley/mapos/commit/26a20e82b25e4f13c4ae484c89f7efdb00e2a6ca))
- Clarify the file/place model in UI copy and file-tree icons ([`38d80c9`](https://github.com/NicHaley/mapos/commit/38d80c94e14f8faa4ac6ca90b700eac214af412f))
- Add route dragging ([`3ffdc99`](https://github.com/NicHaley/mapos/commit/3ffdc998a81c0c06afeaded9820dae62cdfe5185))
- Add directions to and from a location in right click context menu ([`70d3758`](https://github.com/NicHaley/mapos/commit/70d3758a1594d6eb556af3b495f074ed78552692))
- **pipeline:** Add elevation to routes ([`ad56d6d`](https://github.com/NicHaley/mapos/commit/ad56d6d327f6e8df26e5f6dbc96d2b139db2d202))
- Save wikilinks in routes ([`3b1ecb9`](https://github.com/NicHaley/mapos/commit/3b1ecb9fe84bfbb0fa34b34ac4ef72a93084afef))
- Add support for saving directions ([`881c019`](https://github.com/NicHaley/mapos/commit/881c01921f6a5b57a072dc1b179375dc6f0d6aad))
- **mcp:** Add one click setup for Claude, Codex, and Cursor ([`129c6ee`](https://github.com/NicHaley/mapos/commit/129c6eee4e83b90d4d40540889707bbfb00040cb))

### Refactor

- Code cleanup ([`217b443`](https://github.com/NicHaley/mapos/commit/217b4438864ecfa04d73b76f3f664fe3d75fd563))
- Reorganize place card dropdown ([`d9da8e9`](https://github.com/NicHaley/mapos/commit/d9da8e92b730f8a23925fc1604040b2f4e026676))


## 1.0.0-beta.13 — 2026-07-30

## 1.0.0-beta.12 — 2026-07-29

Baseline. Releases from here on get a generated section, written by `pnpm release`.
