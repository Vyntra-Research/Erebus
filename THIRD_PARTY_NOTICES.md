# Third-party notices

Erebus modifications are Copyright 2026 Vyntra Research and licensed under GPL-3.0.

## T3 Code

Erebus is based on [T3 Code](https://github.com/pingdotgg/t3code), Copyright 2026 T3 Tools Inc. The upstream code is available under the MIT License. Its notice is preserved in [LICENSES/T3-CODE-MIT.txt](./LICENSES/T3-CODE-MIT.txt).

Erebus changes the product identity, local state paths, security-research workflow, and bundled integrations. It is not an official T3 Tools release.

## Proteus

Erebus installs [Proteus](https://github.com/Vyntra-Research/Proteus) as a command-line and MCP dependency. Proteus is Copyright Vyntra Research and licensed under GPL-3.0-or-later. Erebus exposes only its read-only legacy lookup surface and does not install its skills.

The pinned Proteus source revision appears in `apps/server/package.json` and `pnpm-lock.yaml`. Erebus invokes Proteus as a subprocess and copies its plugin files into Erebus-managed Codex storage at runtime.

## Argos

Erebus installs [Argos](https://github.com/rafabd1/Argos) as its graph-native research knowledge system. Argos is Copyright Vyntra Research and licensed under GPL-3.0-or-later.

The pinned Argos release appears in `apps/server/package.json` and `pnpm-lock.yaml`. Erebus invokes Argos as a subprocess and installs its MCP plugin and skills into Erebus-managed Codex storage at runtime.

## CVSS calculator

Erebus uses [ae-cvss-calculator](https://github.com/org-metaeffekt/metaeffekt-universal-cvss-calculator) 1.0.13 for deterministic CVSS 3.0, 3.1, and 4.0 scoring. The package is licensed under Apache-2.0, with its notice preserved in [LICENSES/AE-CVSS-CALCULATOR-APACHE-2.0.txt](./LICENSES/AE-CVSS-CALCULATOR-APACHE-2.0.txt). CVSS is owned by FIRST.Org, Inc. and used by permission.
