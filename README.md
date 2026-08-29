<h1 align="left"><img src="./assets/erebus-readme-header.svg" alt="Erebus" width="248"></h1>

Erebus is a research harness for long-running security work. It adds durable campaign contracts, Proteus memory, passive drift checks, and independent finding review to an agent workspace based on [T3 Code](https://github.com/pingdotgg/t3code).

The principal agent performs the research. Erebus keeps one active campaign per task, checks completed assistant messages against its contract, and sends a live correction only when the Observer finds a material drift. A finding submission ends the principal turn. The Judge then reviews the saved evidence and returns its decision in a separate turn.

## Current release

Erebus 0.1.4 currently ships as a Windows desktop app with Codex support. Other host and provider bindings are not enabled in this release.

It includes:

- an isolated Codex home, separate from the Codex desktop app
- Codex device login in the provider settings
- a managed Proteus CLI, MCP server, plugin, and skills
- persistent contracts, checkpoints, Observer evaluations, finding submissions, and Judge verdicts
- settings for Observer cadence, confidence, cooldown, optional correction caps, evaluator model, and reasoning effort

## Requirements

- Windows 10 or newer
- a Codex account
- Git for repository projects

Proteus needs no separate global install. Erebus pins a tested version and installs its runtime and Codex integration in Erebus-managed storage.

## Development

Use Node.js 24 or newer and pnpm.

```powershell
pnpm install
pnpm dev
```

Build the Windows x64 installer with:

```powershell
pnpm dist:desktop:win:x64
```

Development state stays in the worktree-local `.t3` directory inherited from the T3 Code tooling. Packaged builds use an Erebus desktop profile and `~/.erebus`.

## Status

Erebus is an early release. Keep normal backups and review Judge decisions before disclosure.

## License and upstream

Erebus is licensed under [GPL-3.0](./LICENSE). It is based on T3 Code, whose original MIT notice remains in [LICENSES/T3-CODE-MIT.txt](./LICENSES/T3-CODE-MIT.txt). Erebus is not an official T3 Tools release.

Proteus is maintained separately at [Vyntra-Research/Proteus](https://github.com/Vyntra-Research/Proteus). See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for details.
