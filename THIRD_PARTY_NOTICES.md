# Third-party notices

Erebus modifications are Copyright 2026 Vyntra Research and licensed under GPL-3.0.

## T3 Code

Erebus is based on [T3 Code](https://github.com/pingdotgg/t3code), Copyright 2026 T3 Tools Inc. The upstream code is available under the MIT License. Its notice is preserved in [LICENSES/T3-CODE-MIT.txt](./LICENSES/T3-CODE-MIT.txt).

Erebus changes the product identity, local state paths, security-research workflow, and bundled integrations. It is not an official T3 Tools release.

## Proteus

Erebus installs [Proteus](https://github.com/Vyntra-Research/Proteus) as a command-line, MCP, plugin, and skills dependency. Proteus is Copyright Vyntra Research and licensed under GPL-3.0-or-later.

The pinned Proteus source revision appears in `apps/server/package.json` and `pnpm-lock.yaml`. Erebus invokes Proteus as a subprocess and copies its plugin files into Erebus-managed Codex storage at runtime.
