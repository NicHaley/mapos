# MapOS

A local-first desktop app where the map is the primary interface for your personal files and places.

[License: AGPL-3.0](LICENSE)

> Status: early development.

## About

MapOS turns your file system into a spatial canvas. Save places, plan trips, and explore your world, all backed by plain markdown files on disk and a local spatial index. Nothing is uploaded; your files are yours.

A conversational AI agent in the sidebar can read, write, and reason about your vault: finding places near you, summarizing trips, or curating collections from across your files.

The vault format is fully compatible with [Obsidian](https://obsidian.md/), so the same directory works in both apps.

## Tech Stack

- **[Electron](https://www.electronjs.org/)**: desktop runtime
- **[React](https://react.dev/)** + **[TypeScript](https://www.typescriptlang.org/)**: UI
- **[MapLibre GL](https://maplibre.org/)**: map rendering
- **[SQLite](https://www.sqlite.org/)** + **SpatiaLite**: local spatial index
- **[Tiptap](https://tiptap.dev/)**: editor
- **[Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript)**: AI agent
- **[Tailwind CSS](https://tailwindcss.com/)**: styling
- **[shadcn/ui](https://ui.shadcn.com/)**: UI components
- **[Turborepo](https://turborepo.dev/)** + **[pnpm](https://pnpm.io/)**: monorepo

## Development

Requires Node 18+ and pnpm.

```sh
pnpm install
pnpm dev          # desktop app (Electron)
```

## Contributing

MapOS is in early development. Issues and PRs are welcome. Please open an issue to discuss larger changes before opening a PR.

## Contact

Nicholas Haley, [hello@nichaley.com](mailto:hello@nichaley.com)

## License

Distributed under the [AGPL-3.0-only](LICENSE) license.