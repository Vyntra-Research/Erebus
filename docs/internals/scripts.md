# Scripts

> For maintainers. Using Erebus? See [docs/user](../user/).

## First checkout

Erebus uses [Vite+](https://viteplus.dev/guide/). Install its `vp` command, then install the workspace:

```sh
curl -fsSL https://vite.plus | bash
vp i
```

On PowerShell, install Vite+ with `irm https://vite.plus/ps1 | iex`.

Node 24 is required. Bun is optional.

## Development

- `vp run dev` starts the server and web client in watch mode.
- `vp run dev:desktop` starts the Electron app against the dev server.
- `vp run dev:server` starts only the local server.
- `vp run dev:web` starts only Vite.
- `vp run dev --browser` opens the pairing URL automatically.
- `vp run dev --share` exposes the dev client on the machine's tailnet and prints an authenticated pairing URL.
- `vp run dev --home-dir <path>` uses an explicit isolated state directory.

A linked worktree defaults to `<worktree>/.t3/userdata`. The main checkout defaults to `~/.t3/dev`. Never point a development server at a live packaged profile.

Worktrees derive stable port offsets from their paths. Read the real server and web ports from the `[dev-runner]` line because an occupied port may shift them.

The inherited `T3CODE_*`, `.t3`, `@t3tools/*`, and `t3code://` names remain compatibility identifiers. Do not rename them piecemeal.

## Build and verification

- `vp run build:desktop` builds the desktop and server pipeline.
- `vp check` runs formatting and lint rules.
- `vp run typecheck` runs workspace TypeScript checks.
- `vp test run <files>` runs focused tests.
- `cargo test --locked --manifest-path native/resource-monitor/Cargo.toml` tests the Rust monitor.

Follow [AGENTS.md](../../AGENTS.md) for test scope. Do not run the full workspace suite for a narrow change unless the maintainer asks.

## Desktop artifacts

- `vp run dist:desktop:win:x64` builds the Windows x64 NSIS installer.
- `vp run dist:desktop:linux` builds the Linux x64 AppImage.

Artifacts are written under `release/`. The release workflow publishes Windows x64 and Linux x64 desktop builds.

Windows signing uses Azure Trusted Signing when the required release secrets are present. Local artifacts are unsigned by default.

## Browser development

Leave `VITE_HTTP_URL` and `VITE_WS_URL` unset. Vite proxies `/api`, `/ws`, `/oauth`, and `/.well-known` to the local server so the same bundle works from localhost or the optional tailnet dev share.
