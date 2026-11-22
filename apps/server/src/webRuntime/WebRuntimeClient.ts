import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../config.ts";
import * as WebRuntimeBinary from "./WebRuntimeBinary.ts";

const READY_PREFIX = "EREBUS_WEB_READY ";
const START_TIMEOUT = Duration.seconds(8);
const REQUEST_TIMEOUT_MS = 8_000;
const SHUTDOWN_REQUEST_TIMEOUT_MS = 2_000;
const GRACEFUL_SHUTDOWN_TIMEOUT = Duration.seconds(20);
const MAX_FAILURES_PER_WINDOW = 5;
const FAILURE_WINDOW_MS = 60_000;

const RUNTIME_ENVIRONMENT_KEYS = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "LANG",
  "LC_ALL",
  "TZ",
  "LD_LIBRARY_PATH",
  "DYLD_LIBRARY_PATH",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "RUST_LOG",
  "RUST_BACKTRACE",
] as const;

const RuntimeHealth = Schema.Struct({
  status: Schema.Literal("ok"),
  protocolVersion: Schema.Literal(1),
  schemaVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});

export const decodeRuntimeHealth = Schema.decodeUnknownEffect(RuntimeHealth);

export interface WebRuntimeConnection {
  readonly baseUrl: string;
  readonly protocolVersion: 1;
  readonly schemaVersion: number;
}

interface PrivateConnection extends WebRuntimeConnection {
  readonly token: string;
}

export type WebRuntimeStatus = "disabled" | "starting" | "healthy" | "degraded" | "unavailable";

export interface WebRuntimeClientHealth {
  readonly status: WebRuntimeStatus;
  readonly connection: Option.Option<WebRuntimeConnection>;
  readonly lastError: Option.Option<string>;
  readonly restartCount: number;
}

interface ClientState {
  readonly status: WebRuntimeStatus;
  readonly connection: Option.Option<PrivateConnection>;
  readonly lastError: Option.Option<string>;
  readonly restartCount: number;
}

export class WebRuntimeSpawnFailed extends Schema.TaggedErrorClass<WebRuntimeSpawnFailed>()(
  "WebRuntimeSpawnFailed",
  { path: Schema.String, cause: Schema.Defect() },
) {}

export class WebRuntimeStartTimedOut extends Schema.TaggedErrorClass<WebRuntimeStartTimedOut>()(
  "WebRuntimeStartTimedOut",
  { timeoutMs: Schema.Number },
) {}

export class WebRuntimeProtocolError extends Schema.TaggedErrorClass<WebRuntimeProtocolError>()(
  "WebRuntimeProtocolError",
  { message: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {}

export class WebRuntimeExited extends Schema.TaggedErrorClass<WebRuntimeExited>()(
  "WebRuntimeExited",
  { exitCode: Schema.Number },
) {}

export class WebRuntimeUnavailable extends Schema.TaggedErrorClass<WebRuntimeUnavailable>()(
  "WebRuntimeUnavailable",
  { message: Schema.String },
) {}

export class WebRuntimeRequestFailed extends Schema.TaggedErrorClass<WebRuntimeRequestFailed>()(
  "WebRuntimeRequestFailed",
  {
    path: Schema.String,
    status: Schema.optionalKey(Schema.Number),
    detail: Schema.optionalKey(Schema.String),
    retryAfterSeconds: Schema.optionalKey(Schema.Number),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export type WebRuntimeClientError =
  | WebRuntimeBinary.WebRuntimeBinaryError
  | WebRuntimeSpawnFailed
  | WebRuntimeStartTimedOut
  | WebRuntimeProtocolError
  | WebRuntimeExited
  | WebRuntimeUnavailable
  | WebRuntimeRequestFailed;

export interface WebRuntimeRequest {
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly body?: unknown;
  readonly timeoutMs?: number;
}

export class WebRuntimeClient extends Context.Service<
  WebRuntimeClient,
  {
    readonly health: Effect.Effect<WebRuntimeClientHealth>;
    readonly connection: Effect.Effect<WebRuntimeConnection, WebRuntimeUnavailable>;
    readonly requestJson: (
      path: string,
      request?: WebRuntimeRequest,
    ) => Effect.Effect<unknown, WebRuntimeUnavailable | WebRuntimeRequestFailed>;
    readonly requestText: (
      path: string,
      request?: WebRuntimeRequest,
    ) => Effect.Effect<string, WebRuntimeUnavailable | WebRuntimeRequestFailed>;
  }
>()("erebus/webRuntime/WebRuntimeClient") {}

export function parseReadyLine(line: string): string | undefined {
  const value = line.trim();
  if (!value.startsWith(READY_PREFIX)) return undefined;
  const candidate = value.slice(READY_PREFIX.length);
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" || !["127.0.0.1", "::1", "[::1]"].includes(url.hostname)) {
      return undefined;
    }
    return url.href.replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

export function runtimeEnvironment(
  source: NodeJS.ProcessEnv,
  token: string,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of RUNTIME_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  environment.EREBUS_WEB_TOKEN = token;
  return environment;
}

export function makeRuntimeCommand(input: {
  readonly executablePath: string;
  readonly dataDir: string;
  readonly cwd: string;
  readonly token: string;
}): ChildProcess.StandardCommand {
  return ChildProcess.make(
    input.executablePath,
    ["--data-dir", input.dataDir, "--bind", "127.0.0.1:0"],
    {
      cwd: input.cwd,
      env: runtimeEnvironment(process.env, input.token),
      extendEnv: false,
      stdin: { stream: "pipe", endOnDone: false },
      stdout: "pipe",
      stderr: "pipe",
      killSignal: "SIGTERM",
      forceKillAfter: GRACEFUL_SHUTDOWN_TIMEOUT,
    },
  );
}

export function nextRestart(
  priorFailures: ReadonlyArray<number>,
  now: number,
): {
  readonly failures: ReadonlyArray<number>;
  readonly exhausted: boolean;
  readonly delayMs: number;
} {
  const failures = [...priorFailures.filter((value) => now - value < FAILURE_WINDOW_MS), now];
  return {
    failures,
    exhausted: failures.length >= MAX_FAILURES_PER_WINDOW,
    delayMs: Math.min(500 * 2 ** (failures.length - 1), 10_000),
  };
}

const publicConnection = (connection: PrivateConnection): WebRuntimeConnection => ({
  baseUrl: connection.baseUrl,
  protocolVersion: connection.protocolVersion,
  schemaVersion: connection.schemaVersion,
});

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isWebRuntimeRequestFailed = Schema.is(WebRuntimeRequestFailed);

const asRequestFailure = (path: string, cause: unknown): WebRuntimeRequestFailed =>
  isWebRuntimeRequestFailed(cause) ? cause : new WebRuntimeRequestFailed({ path, cause });

const responseErrorDetail = (text: string): string | undefined => {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  try {
    const decoded: unknown = JSON.parse(trimmed);
    if (
      typeof decoded === "object" &&
      decoded !== null &&
      "error" in decoded &&
      typeof decoded.error === "string"
    ) {
      return decoded.error.slice(0, 500);
    }
  } catch {
    // Fall through to the bounded plain-text response.
  }
  return trimmed.slice(0, 500);
};

const retryAfterSeconds = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};

const requestResponse = Effect.fn("webRuntime.requestResponse")(function* (
  httpClient: HttpClient.HttpClient,
  connection: PrivateConnection,
  path: string,
  input: WebRuntimeRequest = {},
) {
  const url = yield* Effect.try({
    try: () => {
      const url = new URL(path, `${connection.baseUrl}/`);
      if (url.origin !== new URL(connection.baseUrl).origin || !url.pathname.startsWith("/v1/")) {
        throw new Error("Web runtime requests must target a local /v1 endpoint.");
      }
      return url;
    },
    catch: (cause) => new WebRuntimeRequestFailed({ path, cause }),
  });
  let httpRequest = HttpClientRequest.make(input.method ?? "GET")(url).pipe(
    HttpClientRequest.bearerToken(connection.token),
  );
  if (input.body !== undefined) {
    httpRequest = yield* HttpClientRequest.bodyJson(httpRequest, input.body).pipe(
      Effect.mapError((cause) => new WebRuntimeRequestFailed({ path, cause })),
    );
  }
  return yield* httpClient.execute(httpRequest).pipe(
    Effect.flatMap((response) => {
      if (response.status >= 200 && response.status < 300) return Effect.succeed(response);
      return response.text.pipe(
        Effect.orElseSucceed(() => ""),
        Effect.flatMap((text) => {
          const detail = responseErrorDetail(text);
          const retryAfter = retryAfterSeconds(response.headers["retry-after"]);
          return Effect.fail(
            new WebRuntimeRequestFailed({
              path,
              status: response.status,
              ...(detail === undefined ? {} : { detail }),
              ...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter }),
            }),
          );
        }),
      );
    }),
    Effect.timeout(Duration.millis(input.timeoutMs ?? REQUEST_TIMEOUT_MS)),
    Effect.mapError((cause) => asRequestFailure(path, cause)),
  );
});

export const make = Effect.fn("webRuntime.webRuntimeClient.make")(function* () {
  const binary = yield* WebRuntimeBinary.WebRuntimeBinary;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const httpClient = yield* HttpClient.HttpClient;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const initialResolution = yield* Effect.result(binary.resolve);
  const resolved = Result.isSuccess(initialResolution)
    ? initialResolution.success
    : Option.none<string>();
  const shouldRun = Result.isFailure(initialResolution) || Option.isSome(resolved);
  const state = yield* Ref.make<ClientState>({
    status: Result.isFailure(initialResolution)
      ? "unavailable"
      : Option.isNone(resolved)
        ? "disabled"
        : "starting",
    connection: Option.none(),
    lastError: Result.isFailure(initialResolution)
      ? Option.some(errorMessage(initialResolution.failure))
      : Option.none(),
    restartCount: 0,
  });

  const health = Ref.get(state).pipe(
    Effect.map(
      (current): WebRuntimeClientHealth => ({
        status: current.status,
        connection: Option.map(current.connection, publicConnection),
        lastError: current.lastError,
        restartCount: current.restartCount,
      }),
    ),
  );

  const connection = Ref.get(state).pipe(
    Effect.flatMap((current) =>
      Option.match(current.connection, {
        onSome: (value) => Effect.succeed(publicConnection(value)),
        onNone: () =>
          Effect.fail(
            new WebRuntimeUnavailable({
              message:
                current.status === "disabled"
                  ? "Web runtime is not installed."
                  : "Web runtime is not ready.",
            }),
          ),
      }),
    ),
  );

  const requestJson: WebRuntimeClient["Service"]["requestJson"] = Effect.fn(
    "webRuntime.requestJson",
  )(function* (path, input) {
    const current = yield* Ref.get(state);
    if (Option.isNone(current.connection)) {
      return yield* new WebRuntimeUnavailable({ message: "Web runtime is not ready." });
    }
    return yield* requestResponse(httpClient, current.connection.value, path, input).pipe(
      Effect.flatMap((response) => response.json),
      Effect.mapError((cause) => asRequestFailure(path, cause)),
    );
  });

  const requestText: WebRuntimeClient["Service"]["requestText"] = Effect.fn(
    "webRuntime.requestText",
  )(function* (path, input) {
    const current = yield* Ref.get(state);
    if (Option.isNone(current.connection)) {
      return yield* new WebRuntimeUnavailable({ message: "Web runtime is not ready." });
    }
    return yield* requestResponse(httpClient, current.connection.value, path, input).pipe(
      Effect.flatMap((response) => response.text),
      Effect.mapError((cause) => asRequestFailure(path, cause)),
    );
  });

  if (shouldRun) {
    const runAttempt: Effect.Effect<void, WebRuntimeClientError> = Effect.scoped(
      Effect.gen(function* () {
        const attemptResolution = yield* binary.resolve;
        if (Option.isNone(attemptResolution)) {
          return yield* new WebRuntimeUnavailable({
            message: "Web runtime is not configured.",
          });
        }
        const executablePath = attemptResolution.value;
        const token = Encoding.encodeHex(yield* crypto.randomBytes(32));
        const command = makeRuntimeCommand({
          executablePath,
          dataDir: path.join(config.stateDir, "web-runtime"),
          cwd: config.cwd,
          token,
        });
        const attemptConnection = yield* Ref.make<Option.Option<PrivateConnection>>(Option.none());
        const handle = yield* Effect.acquireRelease(
          spawner
            .spawn(command)
            .pipe(
              Effect.mapError(
                (cause) => new WebRuntimeSpawnFailed({ path: executablePath, cause }),
              ),
            ),
          (child) =>
            Effect.gen(function* () {
              const running = yield* child.isRunning.pipe(Effect.orElseSucceed(() => false));
              if (!running) return;
              const current = yield* Ref.get(attemptConnection);
              if (Option.isSome(current)) {
                const shutdownRequested = yield* requestResponse(
                  httpClient,
                  current.value,
                  "/v1/shutdown",
                  {
                    method: "POST",
                    timeoutMs: SHUTDOWN_REQUEST_TIMEOUT_MS,
                  },
                ).pipe(
                  Effect.as(true),
                  Effect.orElseSucceed(() => false),
                );
                if (shutdownRequested) {
                  const exited = yield* child.exitCode.pipe(
                    Effect.result,
                    Effect.timeoutOption(GRACEFUL_SHUTDOWN_TIMEOUT),
                  );
                  if (Option.isSome(exited)) return;
                }
              }
              yield* child
                .kill({
                  killSignal: "SIGTERM",
                  forceKillAfter: GRACEFUL_SHUTDOWN_TIMEOUT,
                })
                .pipe(Effect.ignore);
            }),
        );
        const ready = yield* Deferred.make<string>();
        yield* handle.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runForEach((line) => {
            const baseUrl = parseReadyLine(line);
            return baseUrl
              ? Deferred.succeed(ready, baseUrl).pipe(Effect.asVoid)
              : Effect.logDebug("Web runtime output", { output: line.trim() });
          }),
          Effect.forkScoped,
        );
        yield* handle.stderr.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.filter((line) => line.trim().length > 0),
          Stream.runForEach((line) =>
            Effect.logDebug("Web runtime diagnostic", { output: line.trim() }),
          ),
          Effect.forkScoped,
        );

        const readyUrl = yield* Effect.raceFirst(
          Deferred.await(ready).pipe(
            Effect.timeoutOption(START_TIMEOUT),
            Effect.flatMap(
              Option.match({
                onSome: Effect.succeed,
                onNone: () =>
                  Effect.fail(
                    new WebRuntimeStartTimedOut({
                      timeoutMs: Duration.toMillis(START_TIMEOUT),
                    }),
                  ),
              }),
            ),
          ),
          handle.exitCode.pipe(
            Effect.mapError(
              (cause) =>
                new WebRuntimeProtocolError({ message: "Could not read exit status.", cause }),
            ),
            Effect.flatMap((exitCode) =>
              Effect.fail(new WebRuntimeExited({ exitCode: Number(exitCode) })),
            ),
          ),
        );
        const provisional: PrivateConnection = {
          baseUrl: readyUrl,
          token,
          protocolVersion: 1,
          schemaVersion: 1,
        };
        const healthPayload = yield* requestResponse(httpClient, provisional, "/v1/health").pipe(
          Effect.flatMap((response) => response.json),
          Effect.mapError((cause) => asRequestFailure("/v1/health", cause)),
        );
        const runtimeHealth = yield* decodeRuntimeHealth(healthPayload).pipe(
          Effect.mapError(
            (cause) =>
              new WebRuntimeProtocolError({
                message: "Web runtime health check was invalid.",
                cause,
              }),
          ),
        );
        const active: PrivateConnection = {
          ...provisional,
          schemaVersion: runtimeHealth.schemaVersion,
        };
        yield* Ref.set(attemptConnection, Option.some(active));
        yield* Ref.set(state, {
          status: "healthy",
          connection: Option.some(active),
          lastError: Option.none(),
          restartCount: (yield* Ref.get(state)).restartCount,
        });
        yield* Effect.logInfo("Web runtime ready", {
          baseUrl: active.baseUrl,
          protocolVersion: active.protocolVersion,
          schemaVersion: active.schemaVersion,
        });
        const exitCode = yield* handle.exitCode.pipe(
          Effect.mapError(
            (cause) =>
              new WebRuntimeProtocolError({ message: "Could not read exit status.", cause }),
          ),
        );
        return yield* new WebRuntimeExited({ exitCode: Number(exitCode) });
      }).pipe(
        Effect.mapError((error) =>
          error._tag === "PlatformError"
            ? new WebRuntimeProtocolError({
                message: "Web runtime process I/O failed.",
                cause: error,
              })
            : error,
        ),
      ),
    ).pipe(
      Effect.ensuring(Ref.update(state, (current) => ({ ...current, connection: Option.none() }))),
    );

    yield* Effect.gen(function* () {
      let failures: ReadonlyArray<number> = [];
      while (true) {
        const result = yield* Effect.result(runAttempt);
        if (Result.isSuccess(result)) return;
        const now = yield* Clock.currentTimeMillis;
        const restart = nextRestart(failures, now);
        failures = restart.failures;
        const restartCount = (yield* Ref.get(state)).restartCount + 1;
        const exhausted = restart.exhausted;
        yield* Ref.set(state, {
          status: exhausted ? "unavailable" : "degraded",
          connection: Option.none(),
          lastError: Option.some(errorMessage(result.failure)),
          restartCount,
        });
        yield* Effect.logWarning("Web runtime stopped", {
          cause: errorMessage(result.failure),
          restartCount,
        });
        if (exhausted) failures = [];
        yield* Effect.sleep(Duration.millis(exhausted ? FAILURE_WINDOW_MS : restart.delayMs));
        yield* Ref.update(state, (current): ClientState => ({ ...current, status: "starting" }));
      }
    }).pipe(Effect.forkScoped);
  }

  return WebRuntimeClient.of({ health, connection, requestJson, requestText });
});

export const layer = Layer.effect(WebRuntimeClient, make());
