# Connection runtime

> For maintainers. Using Erebus? See [docs/user](../user/).

The connection runtime owns the authenticated link between the React interface and the local Erebus server. The web client mounts it once. The desktop app embeds that client and supplies the local server endpoint.

The current release path connects the Windows and Linux desktop app to its local server. Inherited remote, relay, and mobile sources remain available for future work.

## Composition

[`connection/layer.ts`][layer] assembles the runtime:

- `ConnectionResolver` prepares the local authenticated endpoint.
- `ConnectionDriver` opens one RPC session and reports connection progress.
- `RpcSessionFactory` performs one transport attempt. It does not own retries.
- `EnvironmentRegistry` owns the local environment scope and cached projections.
- `EnvironmentSupervisor` owns desired state, retry timing, and the live session.

React components do not construct transports, retry loops, or RPC clients.

## Connection state

The supervisor is the only retry owner:

1. The desktop or browser registration marks the environment as wanted.
2. Offline state releases the active session without consuming retries.
3. Online state starts one prepared connection and one RPC session.
4. Transient failures retry with capped exponential backoff.
5. Authentication and configuration failures wait for the relevant input to change.
6. An involuntary close keeps cached data and reconnects.
7. Explicit removal closes the session and clears its owned local state.

The UI reports connection health from supervisor and synchronization state. It does not infer health from cached data or the existence of a transport object. The environment becomes connected only after the socket opens and the initial configuration request succeeds.

## Data boundary

Finite requests, durable subscriptions, and commands use separate paths:

- query atoms revalidate when the RPC generation changes;
- subscription atoms move to replacement sessions;
- domain failures may retry on the same healthy session;
- transport failures wait for the supervisor to replace the session;
- mutations resolve the current environment runtime when they run;
- shell and thread caches never overwrite newer live data;
- large threads load a recent turn window and fetch older pages with an opaque cursor.

The Promise bridge exists only at the React and Atom boundary. Runtime and business logic stay in Effect.

## Source boundaries

Applications import explicit `@t3tools/client-runtime` subpaths. The inherited package name is a compatibility identifier. The package has no root export, and files outside its `exports` map are private implementation details.

Core tests cover offline startup, retry, authentication wakeups, involuntary close, explicit removal, cache hydration, subscription replacement, and command metadata. Use deterministic service layers rather than sleeps.

[layer]: ../../packages/client-runtime/src/connection/layer.ts
