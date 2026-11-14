# Workspace layout

> For maintainers. Using Erebus? See [docs/user](../user/).

A pnpm workspace driven by [vite-plus](https://vite.plus) (`vp`). See [scripts.md](./scripts.md) for
the task commands.

## apps

- `apps/server` (`erebus`): the execution runtime and bundled server CLI. Owns orchestration, provider
  drivers, checkpointing, VCS, terminals, filesystem access, auth, and the HTTP + WebSocket surface.
  Also serves the built web app.
- `apps/web` (`@t3tools/web`): React + Vite UI. Consumes the shared client runtime and adds routing,
  components, and web-specific platform layers.
- `apps/desktop` (`@t3tools/desktop`): Electron shell. Supervises a desktop-scoped server, loads the
  web bundle over the compatibility `t3code://` protocol, hosts the browser preview, and manages
  desktop updates.
- `apps/mobile` (`@t3tools/mobile`): inherited Expo/React Native client kept as compatibility source.

## packages

- `packages/contracts` (`@t3tools/contracts`): shared Effect Schema definitions. RPC group,
  orchestration commands/events/read model, auth scopes, environment descriptors, settings.
- `packages/shared` (`@t3tools/shared`): framework-agnostic utilities used by server and clients
  (`DrainableWorker`, git and source-control helpers, relay auth and signing, DPoP, semver, logging,
  observability, and more).
- `packages/client-runtime` (`@t3tools/client-runtime`): connection lifecycle, authorization, RPC
  session, environment registry, and Atom-based domain state used by web. The inherited mobile
  client also consumes it. See its
  [README](../../packages/client-runtime/README.md).
- `packages/ssh` (`@t3tools/ssh`): inherited SSH and tunnel compatibility source.
- `packages/tailscale` (`@t3tools/tailscale`): Tailscale wrappers used by development sharing.
- `packages/effect-acp` (`effect-acp`): inherited Effect implementation of the Agent Client Protocol
  for ACP-speaking provider adapters.
- `packages/effect-codex-app-server` (`effect-codex-app-server`): Effect client for the
  `codex app-server` JSON-RPC protocol.

## infra

- `infra/relay` (`t3code-relay`): inherited relay compatibility source.

## Other top-level directories

- `scripts/`: workspace tooling run through `vp run`. Dev runner, desktop artifact builds, release
  helpers, update-manifest merging, and inherited compatibility checks.
- `assets/`: brand and app icon sources per channel (`dev`, `nightly`, `prod`).
- `patches/`: pnpm patches for pinned upstream dependencies.
- `oxlint-plugin-t3code/`: repo-specific lint rules.
- `experiments/`: throwaway prototypes. Not part of the shipped build.
- `docs/`: this documentation tree.

## Import conventions

`@t3tools/shared` and `@t3tools/client-runtime` use explicit subpath exports with no barrel index and
no root export. Import the narrow path (`@t3tools/shared/DrainableWorker`,
`@t3tools/client-runtime/state/threads`) rather than the package root. Files that are not exported
are implementation details. `@t3tools/contracts` does export a root alongside `./settings` and
`./relay`.
