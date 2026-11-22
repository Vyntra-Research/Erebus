# Provider runtime

> For maintainers. Using Erebus? See [docs/user](../user/).

Current Erebus releases support Codex and OpenCode. Both implement the same provider adapter contract, while each driver owns its native process, model inventory, session protocol, and maintenance checks.

## Registry and sessions

[`ProviderInstanceRegistry`][instances] owns configured provider instances. [`ProviderAdapterRegistry`][registry] resolves an instance to its live adapter. [`ProviderService`][service] routes task and turn operations by thread, so orchestration code does not need to know which driver serves a request.

Codex starts an app-server with an isolated Erebus profile. OpenCode starts the installed CLI or connects to a configured server. A resumed native session omits turns already held by that runtime. A new provider session receives a bounded continuation seed instead of the full transcript.

Erebus keeps the durable thread, workspace, checkpoints, and normalized event stream outside either provider. This lets the user change provider for a later request without replacing the thread.

## Codex account routing

Codex accounts share the task and its durable thread state. A loopback request gateway selects an account for each new model request. Changing the primary account does not restart or detach the task.

Routing considers account priority, current quota, configured switch points, and credits. If an account rejects a request for lack of quota before output begins, Erebus may retry that request through another usable account. It never replays a response after streaming starts.

## Models

`apps/server/src/provider/model-manifest.json` identifies current Codex model slugs. The model manifest service first tries the file on `main`, then the last successful cached copy, then the bundled copy. A failed refresh never fails the provider check.

Capability data from the signed-in account decides which reasoning levels, speed options, and Daybreak controls the UI can offer. The picker keeps a selected legacy model visible without presenting every old alias as current.

OpenCode reports its connected providers, models, variants, and agents through the v2 client. Erebus builds the picker from that live inventory and keeps one OpenCode instance because authentication and provider configuration belong to the local OpenCode installation.

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
