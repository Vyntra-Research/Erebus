# Changelog

## 0.3.0 - 2026-09-04

### Added

- Added one confirmed action to permanently delete the current archived-task set, with full server validation before each environment commits the batch.

### Changed

- Defined native subagents as vertical helpers within one task and co-agent tasks as separate horizontal dives into distinct sinks or surfaces.
- Completed co-agent tasks are now discarded after their result is collected instead of moving into the archive.
- Co-agent coordination now appears as a quiet task card instead of a user message.
- Context compaction now appears as ordinary live work and folds with the completed turn.
- Research rules now require sustained work on real, high-ROI sinks while plausible paths remain, regardless of time or complexity.

### Fixed

- Mark the exact last live user steer or co-agent message as historical after context compaction, including when Codex replays it below the compacted summary.
- Route isolated Observer and Judge evaluations through Codex account routing, retry on another account after quota exhaustion, retain a safe failure reason when review remains blocked, and keep full evaluator prompts out of failure logs.
- Replace the stop action with send steering whenever a running task has content ready to send.
- Release the prior Codex app-server before a routed account resumes the same thread, serialize session handoffs, and reuse compatible persisted resume state after restart.
- Preserve the last healthy Codex provider state when a bounded status probe times out instead of marking the account unavailable.

## 0.2.6 - 2026-09-03

### Fixed

- Keep each Codex account's SQLite state private while sharing sessions and configuration, preventing database corruption during concurrent research.
- Rebuild missing cross-account thread index entries from their preserved rollouts and refuse unsafe blank-thread fallback.

## 0.2.5 - 2026-09-03

### Fixed

- Finish context-compaction markers when Codex reports completion, including repeated compactions in the same turn.
- Repair old compaction markers that remained active even though the conversation had continued.

## 0.2.4 - 2026-09-02

### Fixed

- Show context compaction while it runs and keep a marker at its place in conversation history after it finishes.
- Removed message editing because the provider could produce incomplete conversation branches.

## 0.2.3 - 2026-09-02

### Added

- Added co-agent tasks for parallel coverage. A principal task can create blank or forked tasks, inspect progress, send follow-up instructions, wait for results, interrupt work, and release completed slots.
- Added independent Observer windows for co-agent tasks while keeping campaign control with the principal task.
- Added an option to keep Erebus running in the system tray when its window closes.

### Changed

- Grouped active tasks by project and nested co-agents under their principal task with a visible role marker.
- Moved the Settings shortcut into the sidebar footer and reduced the height of active task cards.
- Extended the authenticated fallback control plane to cover task coordination when an older Codex session cannot receive native tools on resume.

### Fixed

- Prevented co-agents from changing campaign state while still allowing them to read the active research status.
- Kept Observer message windows and steering bound to the task they evaluated.

## 0.2.2 - 2026-09-01

### Fixed

- Restrict Observer steering to clear contract violations. The Observer no longer coordinates strategy, stops legitimate tests, kills valid sinks, or orders pivots based on cost or its own tactical preference.
- Keep checkpoint plans and tentative stop conditions as research context rather than binding authority unless the active contract or user explicitly makes them binding.

## 0.2.1 - 2026-09-01

### Fixed

- Allow campaign start and resume when the Proteus plugin probe times out but its skills and MCP tools are ready. Confirmed missing, disabled, or incompatible plugins still block the campaign.

## 0.2.0 - 2026-09-01

### Added

- Added multiple Codex accounts with separate authentication and shared sessions, configuration, skills, plugins, MCP servers, and memories.
- Added quota-aware account routing with a configurable primary account, switch threshold, fallback reserve, and turn-boundary handoff.
- Added a sidebar account menu with quota bars for every Codex account and quick links to provider settings and usage.

### Changed

- Replaced device-code-only authentication with the standard Codex browser sign-in flow.
- Present the Codex account pool as one logical provider in the model selector; manual account choice now lives in provider settings.
- Give the Observer the latest user prompt and relevant user steers in chronological order so it can check whether the principal follows current instructions.

### Fixed

- Made Codex account overlays recover safely when Codex atomically replaces shared runtime files during login or startup.
- Kept account switching global and atomic so active turns wait for routing to finish instead of mixing account state.

## 0.1.12 - 2026-09-01

### Fixed

- Prevented fragmented Codex responses from blocking the Erebus server and briefly disconnecting the desktop interface when large threads resume.

## 0.1.11 - 2026-09-01

### Fixed

- Prevented large Codex threads from stalling or exhausting the Erebus backend when the first message resumes an idle session.
- Kept Codex sessions warm during long workdays while retaining bounded idle cleanup.

## 0.1.10 - 2026-08-31

### Changed

- Replaced the desktop and web icon with a responsive vector ouroboros and native small-size renditions.
- Documented every required research-control field in the tool schemas, including the exact `register_contract` shape and `contract.target` format.

## 0.1.9 - 2026-08-31

### Fixed

- Prevented Codex from reapplying the last live user steer when it repeats that message after context compaction.

## 0.1.8 - 2026-08-30

### Fixed

- Fixed the managed Proteus MCP launch in packaged builds, repaired stale plugin manifests, and accepted displayed checkpoint ids such as `K74`.
- Prevented `research.start` and `research.resume` from activating Erebus monitoring while the linked Proteus campaign is not active.

## 0.1.7 - 2026-08-30

### Added

- Added the installed Proteus version and a manual update check to Settings.

### Changed

- Renamed the backend exposure setting to "LAN access" and clarified that it does not control Codex internet access.
- Kept only the active and previous Erebus-managed Proteus versions.

### Fixed

- Fixed Proteus plugin installation from packaged Windows builds so Codex remains available after an Erebus update.
- Preserved the selected theme across forced restarts and desktop updates.
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
