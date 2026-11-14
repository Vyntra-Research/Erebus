# Observability

> For maintainers. Using Erebus? See [docs/user](../user/).

Erebus writes human-readable server logs to stdout and completed spans to a local NDJSON trace file. It can also export traces and metrics through OTLP.

## Local files

Packaged desktop state normally lives under:

- Windows: `%USERPROFILE%\.erebus\userdata`
- Linux: `$HOME/.erebus/userdata`

The trace is `logs/server.trace.ndjson`. Provider event logs and terminal logs live in their own subdirectories under `logs`.

Development paths differ:

- linked worktree: `<worktree>/.t3/userdata/logs`
- main checkout with implicit dev state: `~/.t3/dev/logs`
- explicit `--home-dir <path>`: `<path>/userdata/logs`

The trace writer rotates files. It records span name, trace and span IDs, duration, attributes, events, and success or failure. Metrics stay in memory unless OTLP export is configured.

## Local debugging

Run the app normally, reproduce the problem, then inspect `server.trace.ndjson`. For live development:

```sh
vp run dev
```

For the desktop shell:

```sh
vp run dev:desktop
```

Useful `jq` filters on Linux:

```sh
jq -c 'select(.type == "effect-span" and .exit._tag != "Success")' server.trace.ndjson
jq -c 'select(.durationMs >= 1000) | {name, durationMs, attributes}' server.trace.ndjson
```

On Windows, `Get-Content server.trace.ndjson -Wait` follows the file.

## OTLP export

Set the endpoint variables before launching Erebus:

```sh
export T3CODE_OTLP_TRACES_URL=http://localhost:4318/v1/traces
export T3CODE_OTLP_METRICS_URL=http://localhost:4318/v1/metrics
export T3CODE_OTLP_SERVICE_NAME=erebus-local
```

PowerShell uses `$env:T3CODE_OTLP_TRACES_URL`, `$env:T3CODE_OTLP_METRICS_URL`, and `$env:T3CODE_OTLP_SERVICE_NAME` in the same shell that starts the app.

These `T3CODE_*` names remain for compatibility. The backend reads them only at process start.

Optional controls:

- `T3CODE_TRACE_FILE`: override the trace path
- `T3CODE_TRACE_MAX_BYTES`: rotation size per file
- `T3CODE_TRACE_MAX_FILES`: number of rotated files
- `T3CODE_TRACE_BATCH_WINDOW_MS`: trace flush window
- `T3CODE_TRACE_MIN_LEVEL`: minimum recorded level
- `T3CODE_TRACE_TIMING_ENABLED`: include timing metadata
- `T3CODE_OTLP_EXPORT_INTERVAL_MS`: OTLP export interval

Do not put credentials, thread text, unpublished findings, or raw PoC material in span attributes. Use stable IDs, counts, sizes, states, and durations.
