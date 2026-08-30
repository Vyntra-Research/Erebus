# Changelog

## 0.1.7 - 2026-08-30

### Added

- Added the installed Proteus version and a manual update check to Settings.

### Changed

- Renamed the backend exposure setting to "LAN access" and clarified that it does not control Codex internet access.
- Kept only the active and previous Erebus-managed Proteus versions.

### Fixed

- Fixed Proteus plugin installation from packaged Windows builds so Codex remains available after an Erebus update.
- Published the desktop update manifest with each release and now show update-check failures in the UI.

## 0.1.6 - 2026-08-29

### Added

- Added independent Proteus updates from verified stable GitHub release packages, with a daily check and the bundled runtime as an offline fallback.

### Changed

- Updated the bundled Proteus fallback from 2.1.7 to 2.1.8.
- Documented the built-in Erebus download and install flow instead of requiring a manual installer download for every update.

## 0.1.5 - 2026-08-29

### Fixed

- Restored the `research.*` control plane when a Codex task created outside Erebus is resumed inside it.
- Kept Observer steering historical after compaction and tightened the default realism rules for research chains.

## 0.1.4 - 2026-08-29

### Changed

- Rebuilt the desktop and web icons from a responsive vector with flat face shading, native small-size renditions, and a matching README mark.

### Fixed

- Bound each research run to the one ancestor Proteus root that contains its linked campaign so work from a nested folder cannot create or use split state.
- Completed linked active Proteus rounds and the Proteus campaign before marking an Erebus campaign complete.
- Recovered preview automation when an attached webview missed its initial desktop registration event.
- Reconciled copied Codex rollout paths with the standalone Erebus data directory.
- Limited automatic releases to revisions from merged pull requests and sourced release notes from this changelog.
