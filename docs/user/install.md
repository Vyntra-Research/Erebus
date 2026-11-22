# Install Erebus

The current Erebus release targets Windows 10 and newer and current x64 glibc-based Linux distributions. It runs locally with Codex or OpenCode.

## Desktop release

Download the Windows installer or Linux AppImage from [Erebus releases](https://github.com/Vyntra-Research/Erebus/releases).

You need:

- Git, for repository projects.
- The Codex CLI and a ChatGPT account with Codex access, or an installed and configured OpenCode CLI.
- Hardware virtualization with Windows Hypervisor Platform or KVM when using microVMs.

On Linux, make the AppImage executable and start it directly:

```sh
chmod +x Erebus-*.AppImage
./Erebus-*.AppImage
```

Erebus uses GNOME Keyring through libsecret on GNOME, Hyprland, and other non-KDE desktops. KDE can use KWallet. `xdg-utils` and an active, unlocked Secret Service must be available in the graphical session so Erebus can protect credentials and register its application launcher and `erebus://` login callbacks.

Erebus keeps each Codex account under its own application data, isolated from the Codex desktop app. OpenCode uses its local CLI configuration and connected providers.

## Add a provider

Open **Settings -> Providers**, select **Add provider**, then choose Codex or OpenCode.

For Codex, select **Sign in to Codex**. Erebus opens the standard browser sign-in flow and writes the session to the selected isolated profile.

The provider status also shows a platform-specific fallback with the exact profile path. On Windows, the default packaged path uses this form:

```powershell
$env:CODEX_HOME="$env:USERPROFILE\.erebus\userdata\providers\codex"; codex login
```

Run it only if the in-app flow cannot start, then refresh the Codex provider status.

On Linux, the fallback has this form:

```sh
CODEX_HOME="$HOME/.erebus/userdata/providers/codex" codex login
```

For OpenCode, sign in and configure model providers through the OpenCode CLI first. Erebus reads the connected model inventory from that installation. You can set a custom executable, server URL, password, or environment variables in the provider settings.

## Argos

Erebus includes the tested Argos 0.1.0 release and installs its MCP and operational skill in each enabled provider. Argos keeps the current project's graph in `.argos/knowledge.sqlite`; tasks in that project use the same map. Erebus supplies its research-method skills separately.

The managed MCP runs through Erebus's Node runtime. Direct CLI use remains available through the standalone [Argos project](https://github.com/rafabd1/Argos).

Erebus checks for a newer stable Argos release at most once every 24 hours. It verifies the release asset size and SHA-256 digest before installation, retains the active and previous managed versions, and falls back to the last verified or bundled version if an update fails.

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

- [Providers and accounts](./providers-codex.md)
- [Permission modes](./permission-modes.md)
- [Research and independent review](./research-supervision.md)
- [Persistent microVMs](./microvms.md)
