# Update Erebus

Erebus `0.1.6` checks GitHub Releases when it starts and at regular intervals. It does not silently download or install an Erebus update while a research task is running.

Before updating:

1. Let active agent work and terminal commands finish.
2. Pause or close any live research campaign at a safe checkpoint.
3. Select the update notice in the sidebar to download the release.
4. Confirm installation. Erebus closes, installs the downloaded release, and opens again.

An update keeps projects, tasks, settings, and campaign state. If the built-in updater cannot complete, download and run the newer Windows installer from [Erebus releases](https://github.com/Vyntra-Research/Erebus/releases).

Proteus updates independently. Erebus checks the latest stable Proteus release at most once every 24 hours when a Codex environment starts, verifies its package digest, and installs it before starting that environment. A running task keeps its current runtime until the environment starts again.

When a Codex home was copied or moved, Erebus repairs a stored rollout path only if the old path is missing and the matching rollout exists under the active home.

The inherited Linux service, hosted web app, mobile client, and relay updater are not enabled in `0.1.6`.
