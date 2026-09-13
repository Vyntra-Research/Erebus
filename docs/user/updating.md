# Update Erebus

Erebus checks GitHub Releases when it starts and at regular intervals. It does not silently download or install an Erebus update while a research task is running.

Before updating:

1. Let active agent work and terminal commands finish.
2. Pause active native goals or leave each task at a clear stopping point.
3. Select the update notice in the sidebar to download the release.
4. Confirm installation. Erebus closes, installs the downloaded release, and opens again.

An update keeps projects, tasks, settings, native goals, and stored Judge reviews. Older campaign records remain readable for compatibility, but Erebus 0.6 does not resume or change them. If the built-in updater cannot complete, download and run the newer Windows installer from [Erebus releases](https://github.com/Vyntra-Research/Erebus/releases).

Erebus 0.6 includes the tested Argos 0.1.0 release as an offline fallback. Erebus checks the latest stable Argos release at most once every 24 hours, verifies the exact release asset and SHA-256 digest, and installs it before the next Codex environment starts. Settings shows the installed and available versions and can run the same verified update on demand. Erebus retains the active and one previous managed version. Argos updates do not remove any project's `.argos` knowledge database.

Proteus updates independently. Erebus checks the latest stable Proteus release at most once every 24 hours when a Codex environment starts, verifies its package digest, and installs it before starting that environment. It retains the active and one previous managed version. A running task keeps its current runtime until the environment starts again. Erebus exposes the managed runtime through a read-only MCP plugin and does not install its skills.

When a Codex home was copied or moved, Erebus repairs a stored rollout path only if the old path is missing and the matching rollout exists under the active home.

The inherited Linux service, hosted web app, mobile client, and relay updater are not enabled in the current release.
