# Install Erebus

The current Erebus release targets Windows 10 and newer and current x64 glibc-based Linux distributions. It runs locally and uses your Codex subscription. This is the current release scope, not a limit on future platforms or providers.

## Desktop release

Download the Windows installer or Linux AppImage from [Erebus releases](https://github.com/Vyntra-Research/Erebus/releases). Erebus does not yet have an official WinGet, Homebrew, AUR, or mobile package.

You need:

- Git, for repository projects.
- The Codex CLI on `PATH`.
- A ChatGPT account that can use Codex.

On Linux, make the AppImage executable and start it directly:

```sh
chmod +x Erebus-*.AppImage
./Erebus-*.AppImage
```

Erebus uses GNOME Keyring through libsecret on GNOME, Hyprland, and other non-KDE desktops. KDE can use KWallet. `xdg-utils` and an active, unlocked Secret Service must be available in the graphical session so Erebus can protect credentials and register its application launcher and `erebus://` login callbacks.

Erebus keeps its Codex profile under its own application data. It does not reuse the Codex desktop app's `CODEX_HOME`, session database, or configuration.

## First login

Open **Settings -> Providers -> Codex** after Erebus starts, then select **Sign in to Codex**. Erebus opens the standard Codex browser sign-in flow and refreshes the provider when authorization finishes. It writes the session to the isolated Erebus profile; no `auth.json` copy is required.

The provider status also shows a platform-specific fallback with the exact profile path. On Windows, the default packaged path uses this form:

```powershell
$env:CODEX_HOME="$env:USERPROFILE\.erebus\userdata\providers\codex"; codex login
```

Run it only if the in-app flow cannot start, then refresh the Codex provider status.

On Linux, the fallback has this form:

```sh
CODEX_HOME="$HOME/.erebus/userdata/providers/codex" codex login
```

## Argos

Do not install Argos separately. Erebus includes the tested Argos 0.1.0 release and installs its MCP and skills in the shared Codex profile. Argos keeps the current project's graph in `.argos/knowledge.sqlite`; all Erebus Codex accounts and tasks in that project use the same map.

The managed MCP runs through Erebus's Node runtime, so a global `argos` command is not required. Direct CLI use remains available through the standalone [Argos project](https://github.com/rafabd1/Argos), but it is optional for Erebus research.

Erebus checks for a newer stable Argos release at most once every 24 hours. It verifies the release asset size and SHA-256 digest before installation, retains the active and previous managed versions, and falls back to the last verified or bundled version if an update fails.

## Proteus

Do not install Proteus separately. Erebus ships a tested fallback and installs a read-only Proteus MCP plugin in the Erebus Codex profile. The plugin exposes legacy lookup and status tools. It does not expose write operations, CVSS calculation, or Proteus skills. Erebus provides CVSS calculation directly.

When a Codex environment starts, Erebus checks for a newer stable Proteus release at most once every 24 hours. It verifies the release package SHA-256 digest before installing it in versioned Erebus storage. Erebus retains the active and one previous managed version and removes older owned copies. A failed or unavailable update leaves the last verified runtime in place and does not stop Codex from starting.

## Build from source

Source builds need Node.js 24.13.1 or newer within the Node 24 line, plus pnpm 11. Clone the repository first:

```sh
git clone https://github.com/Vyntra-Research/Erebus.git
cd Erebus
```

Build the Windows installer on Windows:

```powershell
pnpm install
pnpm dist:desktop:win:x64
```

Build the Linux AppImage on Linux. Install the native dependencies before `pnpm install`, because packages such as `node-pty` may compile during installation. Arch-based systems need Python, Rust, the base development tools, pkgconf, and ImageMagick for the build. The running app also needs GTK 3, libsecret, xdg-utils, and a Secret Service such as GNOME Keyring:

```sh
sudo pacman -S --needed python rust base-devel pkgconf imagemagick gtk3 libsecret xdg-utils gnome-keyring
pnpm install
pnpm dist:desktop:linux
```

On Ubuntu or Debian, install a current stable Rust toolchain and the native packages first:

```sh
sudo apt-get update
sudo apt-get install -y build-essential python3 pkg-config imagemagick libgtk-3-bin libsecret-1-0 xdg-utils gnome-keyring
pnpm install
pnpm dist:desktop:linux
```

The unsigned development artifacts are written under `release/`. The Windows installer may still show a trust warning until release signing is configured.

## Next steps

- [Codex profiles](./providers-codex.md)
- [Permission modes](./permission-modes.md)
- [Research and independent review](./research-supervision.md)
