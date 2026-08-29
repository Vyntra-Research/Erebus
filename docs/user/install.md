# Install Erebus

Erebus `0.1.3` targets Windows 10 and newer. It runs locally and uses your Codex subscription. This is the current release scope, not a limit on future platforms or providers.

## Desktop release

Download the Windows installer from [Erebus releases](https://github.com/Vyntra-Research/Erebus/releases). Erebus does not yet have an official WinGet, Homebrew, Linux, or mobile package.

You need:

- Git, for repository projects.
- The Codex CLI on `PATH`.
- A ChatGPT account that can use Codex.

Erebus keeps its Codex profile under its own application data. It does not reuse the Codex desktop app's `CODEX_HOME`, session database, or configuration.

## First login

Open **Settings -> Providers -> Codex** after Erebus starts, then select **Sign in to Codex**. Erebus opens the ChatGPT device page, shows the one-time code, and refreshes the provider when authorization finishes. It writes the session to the isolated Erebus profile; no `auth.json` copy is required.

If Codex says device authorization is disabled, enable device code authorization in the ChatGPT **Security** settings and try again.

The provider status also shows a PowerShell fallback with the exact profile path. The default packaged path uses this form:

```powershell
$env:CODEX_HOME="$env:USERPROFILE\.erebus\userdata\providers\codex"; codex login --device-auth
```

Run it only if the in-app flow cannot start, then refresh the Codex provider status.

## Proteus

Do not install Proteus separately. Each Erebus release pins a tested Proteus version and installs its CLI, MCP server, plugin, and skills into the Erebus Codex profile. Erebus refreshes that managed copy when its pinned version changes and leaves other Codex configuration alone.

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
- [Research supervision](./research-supervision.md)
