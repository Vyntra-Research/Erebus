# Erebus

[![Release](https://img.shields.io/github/v/release/Vyntra-Research/Erebus?display_name=tag&sort=semver)](https://github.com/Vyntra-Research/Erebus/releases/latest)
[![CI](https://github.com/Vyntra-Research/Erebus/actions/workflows/ci.yml/badge.svg)](https://github.com/Vyntra-Research/Erebus/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-GPL--3.0--or--later-blue.svg)](./LICENSE)

Erebus is a desktop harness for long-running security research with Codex. It keeps a small set of research rules in the agent context, coordinates parallel tasks, and sends finished findings to an independent Judge. Research itself stays direct: there is no Erebus campaign to register or maintain.

Erebus is based on [T3 Code](https://github.com/pingdotgg/t3code). The current release supports Windows and Codex. Other platforms and provider bindings remain disabled while they are tested.

## What it does

- Keeps evidence scope, realistic attacker control, anti-tunnel checks, dedupe, safe execution, and Post-AI blind-spot analysis active during long runs.
- Uses the native Codex/T3 goal for visible task progress. Erebus does not create a second goal or campaign state.
- Sends the finding document and working PoC to an independent Judge, then delivers the verdict in a separate turn.
- Supports up to four direct co-agent tasks for separate horizontal research surfaces. Each co-agent can use native subagents for work within its assigned surface.
- Supports multiple Codex accounts with separate sign-in state, shared task data, and quota-aware routing at turn boundaries.
- Keeps the Erebus Codex profile separate from the Codex desktop app profile.
- Provides read-only access to legacy Proteus records and its CVSS calculator. Erebus does not load Proteus skills or allow Proteus writes.
- Installs [Argos](https://github.com/rafabd1/Argos) as the connected research map, including its MCP tools and specialist skills.

## Research and review

1. Start research directly. Create a native goal only when the task benefits from one.
2. Record connected research knowledge in Argos. Erebus does not mirror that state.
3. Use Proteus only to read older evidence, check prior records, or calculate CVSS.
4. Place the finding under `findings/` and the working PoC under `pocs/`.
5. Submit those paths to the Judge. A successful submission ends the current turn.
6. Erebus stores the verdict and starts a separate follow-up turn when the task is idle.

The Judge checks fixed evidence gates. It does not run a new research project, fill gaps on behalf of the submitter, or require ZIP files, hashes, release bundles, or a final report.

## Install

Download the current Windows x64 installer from [GitHub Releases](https://github.com/Vyntra-Research/Erebus/releases/latest).

You need:

- Windows 10 or newer
- Git for repository projects
- a ChatGPT account with access to Codex
- the Codex CLI available on `PATH`

Open **Settings > Providers > Codex** after installation to sign in. Erebus uses Codex's browser login and stores the session in its own profile. It does not copy or modify the Codex desktop app profile.

Proteus needs no separate installation. Erebus maintains a verified runtime and exposes only its read-only legacy lookup surface. It keeps the active and previous managed versions. If an update fails, the last verified runtime remains available.

Argos also needs no separate installation. Erebus includes the tested Argos 0.1.0 release, checks for newer stable releases, verifies the package digest, and installs its MCP and skills in the shared Codex profile. Each project keeps its own connected map under `.argos/`, so every task and Codex account working in that project sees the same research knowledge.

See the [installation guide](./docs/user/install.md), [research and Judge guide](./docs/user/research-supervision.md), and [update guide](./docs/user/updating.md) for details.

## Development

Source builds need Node.js 24 or newer and pnpm.

```powershell
pnpm install
pnpm dev
```

Build the Windows x64 installer with:

```powershell
pnpm dist:desktop:win:x64
```

Development state stays in the worktree-local `.t3` directory inherited from T3 Code. Packaged builds use an Erebus desktop profile and `~/.erebus`.

Read the [developer documentation](./docs/README.md) before changing provider, desktop lifecycle, or release code. Contributions should follow [CONTRIBUTING.md](./CONTRIBUTING.md). Report security problems through [SECURITY.md](./SECURITY.md), not a public issue.

## Project status

Erebus is an early release. Keep normal backups and review Judge decisions before disclosure. The Judge gives an independent triage result; it does not replace researcher judgment.

## License and upstream

Erebus is licensed under [GPL-3.0-or-later](./LICENSE). It retains the original T3 Code MIT notice in [LICENSES/T3-CODE-MIT.txt](./LICENSES/T3-CODE-MIT.txt). Erebus is not an official T3 Tools release.

Proteus is maintained separately at [Vyntra-Research/Proteus](https://github.com/Vyntra-Research/Proteus). See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for third-party notices.
Argos is maintained at [rafabd1/Argos](https://github.com/rafabd1/Argos).
