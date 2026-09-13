# Install Erebus

The current Erebus release targets Windows 10 and newer. It runs locally and uses your Codex subscription. This is the current release scope, not a limit on future platforms or providers.

## Desktop release

Download the Windows installer from [Erebus releases](https://github.com/Vyntra-Research/Erebus/releases). Erebus does not yet have an official WinGet, Homebrew, Linux, or mobile package.

You need:

- Git, for repository projects.
- The Codex CLI on `PATH`.
- A ChatGPT account that can use Codex.

Erebus keeps its Codex profile under its own application data. It does not reuse the Codex desktop app's `CODEX_HOME`, session database, or configuration.

## First login

Open **Settings -> Providers -> Codex** after Erebus starts, then select **Sign in to Codex**. Erebus opens the standard Codex browser sign-in flow and refreshes the provider when authorization finishes. It writes the session to the isolated Erebus profile; no `auth.json` copy is required.

The provider status also shows a PowerShell fallback with the exact profile path. The default packaged path uses this form:

```powershell
$env:CODEX_HOME="$env:USERPROFILE\.erebus\userdata\providers\codex"; codex login
```

Run it only if the in-app flow cannot start, then refresh the Codex provider status.

## Argos

Do not install Argos separately. Erebus includes the tested Argos 0.1.0 release and installs its MCP and skills in the shared Codex profile. Argos keeps the current project's graph in `.argos/knowledge.sqlite`; all Erebus Codex accounts and tasks in that project use the same map.

The managed MCP runs through Erebus's Node runtime, so a global `argos` command is not required. Direct CLI use remains available through the standalone [Argos project](https://github.com/rafabd1/Argos), but it is optional for Erebus research.

Erebus checks for a newer stable Argos release at most once every 24 hours. It verifies the release asset size and SHA-256 digest before installation, retains the active and previous managed versions, and falls back to the last verified or bundled version if an update fails.

## Proteus

Do not install Proteus separately. Erebus ships a tested fallback and installs a read-only Proteus MCP plugin in the Erebus Codex profile. The plugin exposes legacy lookup and status tools. It does not expose write operations, CVSS calculation, or Proteus skills. Erebus provides CVSS calculation directly.

When a Codex environment starts, Erebus checks for a newer stable Proteus release at most once every 24 hours. It verifies the release package SHA-256 digest before installing it in versioned Erebus storage. Erebus retains the active and one previous managed version and removes older owned copies. A failed or unavailable update leaves the last verified runtime in place and does not stop Codex from starting.

## Build from source

Source builds need Node.js 24 or newer and pnpm.

```powershell
git clone https://github.com/Vyntra-Research/Erebus.git
Set-Location Erebus
pnpm install
pnpm dist:desktop:win:x64
```

The unsigned development artifact is written under `release/`. Public installers may still show a Windows trust warning until release signing is configured.

## Next steps

- [Codex profiles](./providers-codex.md)
- [Permission modes](./permission-modes.md)
- [Research and independent review](./research-supervision.md)
