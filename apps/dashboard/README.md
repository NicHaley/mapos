# dashboard

An Electron application with React and TypeScript

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

## Project Setup

### Install

```bash
$ pnpm install
```

### Development

```bash
$ pnpm dev
```

### Build

```bash
# For windows
$ pnpm build:win

# For macOS
$ pnpm build:mac

# For Linux
$ pnpm build:linux
```


## Features

### Search

- **Online place search** uses [Photon](https://photon.komoot.io/) (OpenStreetMap-backed). Results are previewed on the map; saving creates a note in the vault using the active folder or parent directory of the open file, same as other “new place” flows.
- **Local search (planned):** SQLite **FTS5** over the vault and indexed metadata, extending to **downloaded / offline map** assets once those are stored and indexed locally.
