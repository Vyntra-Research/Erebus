# Erebus

[![Release](https://img.shields.io/github/v/release/Vyntra-Research/Erebus?display_name=tag&sort=semver)](https://github.com/Vyntra-Research/Erebus/releases/latest)
[![CI](https://github.com/Vyntra-Research/Erebus/actions/workflows/ci.yml/badge.svg)](https://github.com/Vyntra-Research/Erebus/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-GPL--3.0--or--later-blue.svg)](./LICENSE)

Erebus is a desktop harness for long-running security research with Codex. It keeps the campaign objective, scope, gates, state, and evidence available throughout the run. Passive reviewers can then catch research drift and assess findings without taking over the principal agent's work.

Erebus is based on [T3 Code](https://github.com/pingdotgg/t3code). The current release supports Windows and Codex. Other platforms and provider bindings remain disabled while they are tested.

## What it does

- Stores one active research campaign per task, with a durable contract and linked Proteus campaign.
- Runs an Observer after a configurable number of completed assistant messages. It sends a correction only when the run has materially departed from the contract.
- Sends submitted findings to an independent Judge. The Judge checks the evidence and campaign gates in a separate turn before accepting the finding or requesting research changes.
- Keeps the principal Codex session isolated from the Codex desktop app, including its home, session database, and configuration.
- Supports multiple Codex accounts with separate sign-in state, shared task data, and quota-aware routing at turn boundaries.
- Installs and updates the Proteus CLI, MCP server, plugin, and skills inside Erebus-managed storage.

## Supervision flow

1. The principal agent registers the campaign contract and links its Proteus campaign.
2. Research starts and the Observer begins counting completed assistant messages.
3. The Observer checks sampled progress against the objective, heuristics, and gates. Most checks produce no message.
4. A finding submission ends the principal turn and starts an independent Judge review.
5. Erebus records the verdict and delivers it in a separate follow-up turn. The principal either closes the campaign or resumes from the correction.

Campaign and review state survives normal pauses, restarts, and context compaction.

## Install

Download the current Windows x64 installer from [GitHub Releases](https://github.com/Vyntra-Research/Erebus/releases/latest).

You need:

- Windows 10 or newer
- Git for repository projects
- a ChatGPT account with access to Codex
- the Codex CLI available on `PATH`

Open **Settings > Providers > Codex** after installation to sign in. Erebus uses Codex's browser login and stores the session in its own profile. It does not copy or modify the Codex desktop app profile.

Proteus needs no separate installation. Erebus ships a verified fallback, checks for stable Proteus releases, and retains the active and previous managed versions. If an update fails, the last verified runtime remains available.

See the [installation guide](./docs/user/install.md), [research supervision guide](./docs/user/research-supervision.md), and [update guide](./docs/user/updating.md) for details.

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

Erebus is an early release. Keep normal backups and review Judge decisions before disclosure. The harness helps enforce a research contract, but it does not replace researcher judgment.

## License and upstream

Erebus is licensed under [GPL-3.0-or-later](./LICENSE). It retains the original T3 Code MIT notice in [LICENSES/T3-CODE-MIT.txt](./LICENSES/T3-CODE-MIT.txt). Erebus is not an official T3 Tools release.

Proteus is maintained separately at [Vyntra-Research/Proteus](https://github.com/Vyntra-Research/Proteus). See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for third-party notices.
