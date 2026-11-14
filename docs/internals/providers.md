# Codex provider runtime

> For maintainers. Using Erebus? See [docs/user](../user/).

Codex is the provider supported by current Erebus releases. The repository still contains inherited Claude, Cursor, Grok, and OpenCode adapters, but they have no supported settings, update, or release surface.

## Registry and sessions

[`ProviderInstanceRegistry`][instances] owns configured Codex account instances. [`ProviderAdapterRegistry`][registry] resolves an instance to its live adapter. [`ProviderService`][service] routes task and turn operations by thread, so orchestration code does not need to know which account serves a request.

The adapter starts the Codex app-server with the isolated Erebus profile. A resumed native Codex thread omits its stored turns because the orchestration projection already owns UI history. An imported thread without matching native history receives a bounded continuation seed instead of the full transcript.

## Account routing

Codex accounts share the task and its durable thread state. A loopback request gateway selects an account for each new model request. Changing the primary account does not restart or detach the task.

Routing considers account priority, current quota, configured switch points, and credits. If an account rejects a request for lack of quota before output begins, Erebus may retry that request through another usable account. It never replays a response after streaming starts.

## Models

`apps/server/src/provider/model-manifest.json` identifies current Codex model slugs. The model manifest service first tries the file on `main`, then the last successful cached copy, then the bundled copy. A failed refresh never fails the provider check.

Capability data from the signed-in account decides which reasoning levels, speed options, and Daybreak controls the UI can offer. The picker keeps a selected legacy model visible without presenting every old alias as current.

## Request flow

Clients dispatch typed orchestration commands. The engine persists the intent, and queue-backed reactors perform the provider work:

1. [`ProviderCommandReactor`][cmd] calls the provider adapter.
2. [`ProviderRuntimeIngestion`][ingest] turns provider events into orchestration commands.
3. [`CheckpointReactor`][checkpoint] captures and restores workspace checkpoints.

All three workers expose `drain` for deterministic tests. Tests wait for receipts and worker drains, not timers.

Assistant text may stream normally or use buffered delivery. Buffered output flushes at interaction boundaries and before its size limit would be exceeded, so approvals and user-input requests never sit behind a completed text buffer.

[instances]: ../../apps/server/src/provider/Services/ProviderInstanceRegistry.ts
[registry]: ../../apps/server/src/provider/Services/ProviderAdapterRegistry.ts
[service]: ../../apps/server/src/provider/Layers/ProviderService.ts
[cmd]: ../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts
[ingest]: ../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
[checkpoint]: ../../apps/server/src/orchestration/Layers/CheckpointReactor.ts
