import * as NodeCrypto from "node:crypto";

import {
  ThreadSyncError,
  type ThreadSyncConfiguration,
  type ThreadSyncRevision,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { THREAD_SYNC_NAMESPACE } from "./ThreadSyncDocuments.ts";
import {
  THREAD_SYNC_V2_BLOBS_DIRECTORY,
  THREAD_SYNC_V2_CHUNKS_DIRECTORY,
  THREAD_SYNC_V2_MANIFEST_PATH,
  THREAD_SYNC_V2_NAMESPACE,
  THREAD_SYNC_V2_PROJECTS_DIRECTORY,
  THREAD_SYNC_V2_THREADS_DIRECTORY,
} from "./ThreadSyncRepositoryV2.ts";

const MANAGED_MIRROR_MARKER = "erebus-managed-thread-sync-v1\n";
const REMOTE_NAME = "origin";
const SPARSE_METADATA_PATTERNS = [
  // V1 metadata stays available for imports; migrated remotes keep only a
  // fail-closed retirement marker. V2 separates its bounded index from the
  // potentially large content-addressed payload.
  `/${THREAD_SYNC_NAMESPACE}/`,
  `/${THREAD_SYNC_V2_MANIFEST_PATH}`,
  `/${THREAD_SYNC_V2_PROJECTS_DIRECTORY}/`,
  `/${THREAD_SYNC_V2_THREADS_DIRECTORY}/`,
  `!/${THREAD_SYNC_V2_CHUNKS_DIRECTORY}/`,
  `!/${THREAD_SYNC_V2_BLOBS_DIRECTORY}/`,
] as const;
const MANAGED_SYNC_NAMESPACES = [THREAD_SYNC_NAMESPACE, THREAD_SYNC_V2_NAMESPACE] as const;
const V2_PAYLOAD_PATH_PATTERN = new RegExp(
  `^${THREAD_SYNC_V2_NAMESPACE.replaceAll(".", "\\.").replaceAll("/", "\\/")}/(?:chunks/[a-f0-9]{64}\\.ndjson|blobs/[a-f0-9]{64}\\.blob)$`,
);
const GIT_PATH_BATCH_SIZE = 128;
const MANAGED_ATTRIBUTES_BEGIN = "# BEGIN EREBUS THREAD SYNC ATTRIBUTES";
const MANAGED_ATTRIBUTES_END = "# END EREBUS THREAD SYNC ATTRIBUTES";
const MANAGED_ATTRIBUTES_RULE = `${THREAD_SYNC_V2_NAMESPACE}/** -text`;
const isThreadSyncError = Schema.is(ThreadSyncError);

export interface ThreadSyncGitFetchResult {
  readonly mirrorPath: string;
  readonly remoteRevision: ThreadSyncRevision | null;
}

export interface ThreadSyncGitShape {
  readonly fetch: (
    configuration: ThreadSyncConfiguration,
  ) => Effect.Effect<ThreadSyncGitFetchResult, ThreadSyncError>;
  readonly checkoutRemote: (
    configuration: ThreadSyncConfiguration,
    expectedRemoteRevision: ThreadSyncRevision | null,
    /** Reuses the immediately preceding discovery instead of contacting the remote twice. */
    fetched?: ThreadSyncGitFetchResult,
  ) => Effect.Effect<ThreadSyncGitFetchResult, ThreadSyncError>;
  readonly commitAndPush: (input: {
    readonly configuration: ThreadSyncConfiguration;
    readonly expectedRemoteRevision: ThreadSyncRevision | null;
    readonly message: string;
    /** Exact content-addressed V2 payloads made unreachable by this commit. */
    readonly removePayloadPaths?: ReadonlyArray<string>;
  }) => Effect.Effect<ThreadSyncRevision, ThreadSyncError>;
  /**
   * Hydrates only the selected V2 payload objects. Optional so older test
   * doubles remain source-compatible while the service adopts lazy payloads.
   */
  readonly materializePayloadPaths?: (input: {
    readonly configuration: ThreadSyncConfiguration;
    readonly mirrorPath: string;
    readonly paths: ReadonlyArray<string>;
  }) => Effect.Effect<void, ThreadSyncError>;
  /** Removes hydrated V2 payload files while keeping metadata checked out. */
  readonly prunePayloads?: (input: {
    readonly configuration: ThreadSyncConfiguration;
    readonly mirrorPath: string;
  }) => Effect.Effect<void, ThreadSyncError>;
  readonly removeMirror: (
    configuration: ThreadSyncConfiguration,
  ) => Effect.Effect<void, ThreadSyncError>;
}

export class ThreadSyncGit extends Context.Service<ThreadSyncGit, ThreadSyncGitShape>()(
  "erebus/threadSync/ThreadSyncGit",
) {}

const URL_REMOTE_PATTERN = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//;
const REMOTE_HELPER_PATTERN = /^[^/\\:]+::/;
const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const WINDOWS_DRIVE_RELATIVE_PATH_PATTERN = /^[A-Za-z]:(?!:)[^/\\]/;
const UNC_PATH_PATTERN = /^(?:\\\\|\/\/)[^/\\]+[\\/][^/\\]+/;
const EXPLICIT_LOCAL_PATH_PATTERN = /^(?:\.{1,2}[\\/]|~[\\/]|\/)/;
const SCP_LIKE_REMOTE_PATTERN =
  /^(?:[A-Za-z0-9._-]+@)?(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?):[^:\s][^\r\n]*$/;
const AMBIGUOUS_SCHEME_HOSTS = new Set([
  "ext",
  "file",
  "ftp",
  "git",
  "http",
  "https",
  "rsync",
  "ssh",
]);

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      return true;
    }
  }
  return false;
}

function isLocalThreadSyncRemote(remoteUrl: string): boolean {
  const urlMatch = URL_REMOTE_PATTERN.exec(remoteUrl);
  if (urlMatch !== null) {
    return urlMatch[1]?.toLowerCase() === "file";
  }
  if (
    WINDOWS_DRIVE_PATH_PATTERN.test(remoteUrl) ||
    WINDOWS_DRIVE_RELATIVE_PATH_PATTERN.test(remoteUrl) ||
    UNC_PATH_PATTERN.test(remoteUrl) ||
    EXPLICIT_LOCAL_PATH_PATTERN.test(remoteUrl)
  ) {
    return true;
  }
  return !SCP_LIKE_REMOTE_PATTERN.test(remoteUrl);
}

function isWindowsOnlyThreadSyncRemote(remoteUrl: string): boolean {
  if (
    WINDOWS_DRIVE_PATH_PATTERN.test(remoteUrl) ||
    WINDOWS_DRIVE_RELATIVE_PATH_PATTERN.test(remoteUrl) ||
    UNC_PATH_PATTERN.test(remoteUrl)
  ) {
    return true;
  }
  if (!remoteUrl.toLowerCase().startsWith("file://")) {
    return false;
  }
  try {
    const parsed = new URL(remoteUrl);
    const hasUncHost = parsed.hostname.length > 0 && parsed.hostname !== "localhost";
    return hasUncHost || /^\/[A-Za-z]:\//.test(parsed.pathname);
  } catch {
    return false;
  }
}

function serverIgnoredObjectFilter(stderr: string): boolean {
  const normalized = stderr.toLowerCase();
  return (
    normalized.includes("filtering not recognized by server") ||
    normalized.includes("server does not support filter") ||
    normalized.includes("filter capability is not supported")
  );
}

function traceAdvertisesObjectFilter(stderr: string): boolean {
  for (const line of stderr.split(/\r?\n/)) {
    const capability = /packet:.*<\s*fetch=([^\r\n]*)/i.exec(line)?.[1];
    if (capability?.split(/\s+/).includes("filter")) {
      return true;
    }
  }
  return false;
}

function mirrorKey(configuration: ThreadSyncConfiguration): string {
  return NodeCrypto.createHash("sha256")
    .update(`${configuration.remoteUrl}\0${configuration.branch}`, "utf8")
    .digest("hex")
    .slice(0, 24);
}

export function hasUnsafeThreadSyncRemoteComponents(remoteUrl: string): boolean {
  if (
    remoteUrl.length === 0 ||
    remoteUrl !== remoteUrl.trim() ||
    containsControlCharacter(remoteUrl)
  ) {
    return true;
  }

  // Git treats <transport>::<address> as a remote-helper invocation. Helpers
  // such as ext can execute a command, so they are never valid sync remotes.
  // A separator after a path segment is still a normal local filename on
  // platforms that permit it.
  if (REMOTE_HELPER_PATTERN.test(remoteUrl)) {
    return true;
  }

  const urlMatch = URL_REMOTE_PATTERN.exec(remoteUrl);
  if (urlMatch !== null) {
    // WHATWG URL parsing can normalize backslashes as path separators before
    // credentials are inspected. Reject them in URL-style remotes so a value
    // such as `https://user\\:secret@host/repo` cannot bypass the credential
    // check through parser normalization.
    if (remoteUrl.includes("\\")) {
      return true;
    }
    const scheme = urlMatch[1]?.toLowerCase();
    if (scheme !== "https" && scheme !== "ssh" && scheme !== "file") {
      return true;
    }
    try {
      const parsed = new URL(remoteUrl);
      const hasDisallowedState =
        parsed.password.length > 0 || parsed.search.length > 0 || parsed.hash.length > 0;
      if (hasDisallowedState) {
        return true;
      }
      if (scheme === "https") {
        return parsed.hostname.length === 0 || parsed.username.length > 0;
      }
      if (scheme === "ssh") {
        return parsed.hostname.length === 0;
      }
      return parsed.username.length > 0;
    } catch {
      return true;
    }
  }

  if (
    WINDOWS_DRIVE_PATH_PATTERN.test(remoteUrl) ||
    WINDOWS_DRIVE_RELATIVE_PATH_PATTERN.test(remoteUrl) ||
    UNC_PATH_PATTERN.test(remoteUrl) ||
    EXPLICIT_LOCAL_PATH_PATTERN.test(remoteUrl)
  ) {
    return false;
  }

  if (SCP_LIKE_REMOTE_PATTERN.test(remoteUrl)) {
    const hostWithOptionalUser = remoteUrl.slice(0, remoteUrl.indexOf(":"));
    const host = (hostWithOptionalUser.split("@").at(-1) ?? "").toLowerCase();
    return AMBIGUOUS_SCHEME_HOSTS.has(host) || remoteUrl.includes("?") || remoteUrl.includes("#");
  }

  // A colon that was not classified above is neither a local path nor a
  // well-formed SCP remote. Plain relative paths remain valid local remotes.
  return remoteUrl.includes(":");
}

function errorFromGit(input: {
  readonly operation: "configure" | "fetch" | "disconnect" | "push";
  readonly stderr: string;
  readonly exitCode: number | null;
}): ThreadSyncError {
  const normalized = input.stderr.toLowerCase();
  const code =
    normalized.includes("authentication failed") ||
    normalized.includes("permission denied") ||
    normalized.includes("could not read username") ||
    normalized.includes("unauthorized")
      ? "authentication-failed"
      : normalized.includes("non-fast-forward") ||
          normalized.includes("fetch first") ||
          normalized.includes("failed to push some refs") ||
          normalized.includes("couldn't find remote ref")
        ? "remote-changed"
        : "git-failed";
  const detail =
    code === "authentication-failed"
      ? "Git could not authenticate to the thread sync remote."
      : code === "remote-changed"
        ? "The thread sync remote changed while the operation was running."
        : `Git failed with exit code ${String(input.exitCode)}.`;
  return new ThreadSyncError({ operation: input.operation, code, detail });
}

function mapThreadSyncIoError(
  operation: "configure" | "disconnect",
  cause: unknown,
): ThreadSyncError {
  if (isThreadSyncError(cause)) {
    return cause;
  }
  return new ThreadSyncError({
    operation,
    code: "io-failed",
    detail: `The managed sync mirror could not be accessed: ${String(cause)}`,
  });
}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const hostPlatform = yield* HostProcessPlatform;
  const mirrorsRoot = path.join(config.stateDir, "thread-sync", "mirrors");

  const runGit = Effect.fn("ThreadSyncGit.runGit")(function* (input: {
    readonly operation: "configure" | "fetch" | "disconnect" | "push";
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
    readonly stdin?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly allowExitCodes?: ReadonlyArray<number>;
  }) {
    const result = yield* vcsProcess
      .run({
        operation: `thread-sync:${input.operation}`,
        command: "git",
        args: input.args,
        cwd: input.cwd,
        ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
        env: { ...input.env, LANG: "C", LC_ALL: "C" },
        allowNonZeroExit: true,
        timeoutMs: input.args.some(
          (argument) => argument === "fetch" || argument === "push" || argument === "ls-remote",
        )
          ? 10 * 60_000
          : 60_000,
        maxOutputBytes: 16 * 1024 * 1024,
      })
      .pipe(
        Effect.mapError(
          (_cause) =>
            new ThreadSyncError({
              operation: input.operation,
              code: "git-failed",
              detail: "Git could not start or complete the thread sync operation.",
            }),
        ),
      );
    const exitCode = typeof result.exitCode === "number" ? result.exitCode : null;
    if (exitCode !== 0 && !input.allowExitCodes?.includes(exitCode ?? -1)) {
      return yield* errorFromGit({
        operation: input.operation,
        stderr: result.stderr,
        exitCode,
      });
    }
    return result;
  });

  const applyMetadataSparseCheckout = Effect.fn("ThreadSyncGit.applyMetadataSparseCheckout")(
    function* (mirrorPath: string, operation: "configure" | "fetch" | "push") {
      yield* runGit({
        operation,
        cwd: mirrorPath,
        args: ["sparse-checkout", "init", "--no-cone"],
      });
      yield* runGit({
        operation,
        cwd: mirrorPath,
        args: ["sparse-checkout", "set", "--no-cone", ...SPARSE_METADATA_PATTERNS],
      });
    },
  );

  const configureManagedContentBytes = Effect.fn("ThreadSyncGit.configureManagedContentBytes")(
    function* (mirrorPath: string) {
      // V2 addresses JSON and NDJSON objects by their exact bytes. Pin the
      // managed mirror so a host-level autocrlf setting cannot rewrite those
      // bytes during checkout or staging. These settings remain local to the
      // Erebus-owned repository.
      yield* runGit({
        operation: "configure",
        cwd: mirrorPath,
        args: ["config", "--local", "core.autocrlf", "false"],
      });
      yield* runGit({
        operation: "configure",
        cwd: mirrorPath,
        args: ["config", "--local", "core.eol", "lf"],
      });

      // A tracked .gitattributes file can override core.autocrlf and rewrite
      // content-addressed NDJSON or blobs. Pin only Erebus v2 paths in the
      // repository-local attributes file, which remote commits cannot change.
      const infoPath = path.join(mirrorPath, ".git", "info");
      const attributesPath = path.join(infoPath, "attributes");
      yield* fileSystem
        .makeDirectory(infoPath, { recursive: true })
        .pipe(Effect.mapError((cause) => mapThreadSyncIoError("configure", cause)));
      const existing = (yield* fileSystem.exists(attributesPath))
        ? yield* fileSystem
            .readFileString(attributesPath)
            .pipe(Effect.mapError((cause) => mapThreadSyncIoError("configure", cause)))
        : "";
      const lines = existing.split(/\r?\n/);
      const beginIndex = lines.indexOf(MANAGED_ATTRIBUTES_BEGIN);
      const endIndex = beginIndex < 0 ? -1 : lines.indexOf(MANAGED_ATTRIBUTES_END, beginIndex + 1);
      const preserved =
        beginIndex >= 0 && endIndex > beginIndex
          ? [...lines.slice(0, beginIndex), ...lines.slice(endIndex + 1)]
          : lines.filter(
              (line) => line !== MANAGED_ATTRIBUTES_BEGIN && line !== MANAGED_ATTRIBUTES_END,
            );
      while (preserved.at(-1) === "") preserved.pop();
      const managedAttributes = [
        ...preserved,
        ...(preserved.length === 0 ? [] : [""]),
        MANAGED_ATTRIBUTES_BEGIN,
        MANAGED_ATTRIBUTES_RULE,
        MANAGED_ATTRIBUTES_END,
        "",
      ].join("\n");
      if (existing !== managedAttributes) {
        yield* fileSystem
          .writeFileString(attributesPath, managedAttributes)
          .pipe(Effect.mapError((cause) => mapThreadSyncIoError("configure", cause)));
      }
    },
  );

  const resolveMirror = Effect.fn("ThreadSyncGit.resolveMirror")(function* (
    configuration: ThreadSyncConfiguration,
  ) {
    if (configuration.remoteUrl.startsWith("-")) {
      return yield* new ThreadSyncError({
        operation: "configure",
        code: "invalid-remote",
        detail: "The sync remote cannot begin with a dash.",
      });
    }
    if (hasUnsafeThreadSyncRemoteComponents(configuration.remoteUrl)) {
      return yield* new ThreadSyncError({
        operation: "configure",
        code: "invalid-remote",
        detail:
          "The sync remote must be an HTTPS, SSH, file, local-path, or SCP-style Git remote without embedded credentials, query parameters, or fragments.",
      });
    }
    if (hostPlatform !== "win32" && isWindowsOnlyThreadSyncRemote(configuration.remoteUrl)) {
      return yield* new ThreadSyncError({
        operation: "configure",
        code: "invalid-remote",
        detail: "A Windows drive or UNC sync remote can only be used on Windows.",
      });
    }
    if (configuration.branch.startsWith("-")) {
      return yield* new ThreadSyncError({
        operation: "configure",
        code: "invalid-remote",
        detail: "The sync branch cannot begin with a dash.",
      });
    }

    yield* fileSystem.makeDirectory(mirrorsRoot, { recursive: true });
    const mirrorPath = path.join(mirrorsRoot, mirrorKey(configuration));
    const markerPath = path.join(mirrorPath, ".erebus-thread-sync-managed");
    yield* fileSystem.makeDirectory(mirrorPath, { recursive: true });

    if (yield* fileSystem.exists(markerPath)) {
      const marker = yield* fileSystem.readFileString(markerPath).pipe(
        Effect.mapError(
          (cause) =>
            new ThreadSyncError({
              operation: "configure",
              code: "io-failed",
              detail: `Could not verify the managed sync mirror: ${String(cause)}`,
            }),
        ),
      );
      if (marker !== MANAGED_MIRROR_MARKER) {
        return yield* new ThreadSyncError({
          operation: "configure",
          code: "integrity-failed",
          detail: "The managed sync mirror marker is invalid.",
        });
      }
    } else {
      const entries = yield* fileSystem.readDirectory(mirrorPath);
      if (entries.length > 0) {
        return yield* new ThreadSyncError({
          operation: "configure",
          code: "integrity-failed",
          detail: "The sync mirror directory is not empty and has no Erebus marker.",
        });
      }
      yield* fileSystem.writeFileString(markerPath, MANAGED_MIRROR_MARKER);
    }

    const gitDirectory = path.join(mirrorPath, ".git");
    if (!(yield* fileSystem.exists(gitDirectory))) {
      yield* runGit({ operation: "configure", cwd: mirrorPath, args: ["init"] });
      yield* runGit({
        operation: "configure",
        cwd: mirrorPath,
        args: ["config", "user.name", "Erebus Thread Sync"],
      });
      yield* runGit({
        operation: "configure",
        cwd: mirrorPath,
        args: ["config", "user.email", "thread-sync@localhost"],
      });
    }

    // Apply this on every reuse as well as first initialization. Older
    // mirrors may have inherited a global autocrlf=true setting or retained a
    // stale local override from a previous build.
    yield* configureManagedContentBytes(mirrorPath);

    yield* runGit({
      operation: "configure",
      cwd: mirrorPath,
      args: ["check-ref-format", `refs/heads/${configuration.branch}`],
    }).pipe(
      Effect.mapError((cause) =>
        cause.code === "git-failed"
          ? new ThreadSyncError({
              operation: "configure",
              code: "invalid-remote",
              detail: "The configured sync branch is not a valid Git branch name.",
            })
          : cause,
      ),
    );

    const currentRemote = yield* runGit({
      operation: "configure",
      cwd: mirrorPath,
      args: ["remote", "get-url", REMOTE_NAME],
      allowExitCodes: [2],
    });
    if (currentRemote.exitCode === 0) {
      if (currentRemote.stdout.trim() !== configuration.remoteUrl) {
        yield* runGit({
          operation: "configure",
          cwd: mirrorPath,
          args: ["remote", "set-url", REMOTE_NAME, configuration.remoteUrl],
        });
      }
    } else {
      yield* runGit({
        operation: "configure",
        cwd: mirrorPath,
        args: ["remote", "add", REMOTE_NAME, configuration.remoteUrl],
      });
    }

    // Keep the complete remote tree in the index so commits preserve files
    // owned by other tools. V2 checks out only its bounded index; selected
    // chunks and blobs are hydrated explicitly. Running this again also
    // migrates mirrors created before sparse checkout was enabled.
    yield* applyMetadataSparseCheckout(mirrorPath, "configure");
    return mirrorPath;
  });

  const verifyManagedMirrorPath = Effect.fn("ThreadSyncGit.verifyManagedMirrorPath")(function* (
    configuration: ThreadSyncConfiguration,
    mirrorPath: string,
  ) {
    const expectedPath = path.resolve(mirrorsRoot, mirrorKey(configuration));
    if (
      path.resolve(mirrorPath) !== expectedPath ||
      path.dirname(expectedPath) !== path.resolve(mirrorsRoot)
    ) {
      return yield* new ThreadSyncError({
        operation: "fetch",
        code: "integrity-failed",
        detail: "The requested payload path does not belong to this managed sync mirror.",
      });
    }
    const markerPath = path.join(expectedPath, ".erebus-thread-sync-managed");
    const marker = yield* fileSystem
      .readFileString(markerPath)
      .pipe(Effect.mapError((cause) => mapThreadSyncIoError("configure", cause)));
    if (marker !== MANAGED_MIRROR_MARKER) {
      return yield* new ThreadSyncError({
        operation: "fetch",
        code: "integrity-failed",
        detail: "The managed sync mirror marker is invalid.",
      });
    }
    return expectedPath;
  });

  const configurePartialClone = Effect.fn("ThreadSyncGit.configurePartialClone")(function* (input: {
    readonly mirrorPath: string;
    readonly enabled: boolean;
  }) {
    yield* runGit({
      operation: "configure",
      cwd: input.mirrorPath,
      args: ["config", `remote.${REMOTE_NAME}.promisor`, input.enabled ? "true" : "false"],
    });
    if (input.enabled) {
      yield* runGit({
        operation: "configure",
        cwd: input.mirrorPath,
        args: ["config", `remote.${REMOTE_NAME}.partialclonefilter`, "blob:none"],
      });
    }
  });

  const fetchTrackingRef = Effect.fn("ThreadSyncGit.fetchTrackingRef")(function* (input: {
    readonly mirrorPath: string;
    readonly remoteRef: string;
    readonly trackingRef: string;
    readonly allowUnfilteredFallback: boolean;
  }) {
    const refspec = `+${input.remoteRef}:${input.trackingRef}`;
    const filteredArgs = [
      "fetch",
      "--no-tags",
      "--filter=blob:none",
      "--depth=1",
      REMOTE_NAME,
      refspec,
    ];
    const filtered = yield* runGit({
      operation: "fetch",
      cwd: input.mirrorPath,
      args: filteredArgs,
      allowExitCodes: [1, 2, 128, 129],
    });
    if (filtered.exitCode === 0 && !serverIgnoredObjectFilter(filtered.stderr)) {
      yield* configurePartialClone({ mirrorPath: input.mirrorPath, enabled: true });
      return;
    }

    if (!input.allowUnfilteredFallback) {
      if (filtered.exitCode !== 0) {
        const failure = errorFromGit({
          operation: "fetch",
          stderr: filtered.stderr,
          exitCode: typeof filtered.exitCode === "number" ? filtered.exitCode : null,
        });
        if (failure.code !== "git-failed") {
          return yield* failure;
        }
      }
      return yield* new ThreadSyncError({
        operation: "fetch",
        code: "git-failed",
        detail: "The network Git remote must support filtered blobless fetches.",
      });
    }

    yield* configurePartialClone({ mirrorPath: input.mirrorPath, enabled: false });
    const fallbackAttempts: ReadonlyArray<ReadonlyArray<string>> = [
      ["fetch", "--no-tags", "--depth=1", REMOTE_NAME, refspec],
      ["fetch", "--no-tags", REMOTE_NAME, refspec],
    ];
    for (const [attemptIndex, args] of fallbackAttempts.entries()) {
      const result = yield* runGit({
        operation: "fetch",
        cwd: input.mirrorPath,
        args,
        allowExitCodes: [1, 2, 128, 129],
      });
      if (result.exitCode === 0) {
        yield* configurePartialClone({ mirrorPath: input.mirrorPath, enabled: false });
        return;
      }

      const failure = errorFromGit({
        operation: "fetch",
        stderr: result.stderr,
        exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
      });
      const canRetryWithBroaderFetch =
        failure.code === "git-failed" && attemptIndex < fallbackAttempts.length - 1;
      if (!canRetryWithBroaderFetch) {
        return yield* failure;
      }
    }
  });

  const fetch = Effect.fn("ThreadSyncGit.fetch")(function* (
    configuration: ThreadSyncConfiguration,
  ): Effect.fn.Return<ThreadSyncGitFetchResult, ThreadSyncError> {
    const mirrorPath = yield* resolveMirror(configuration).pipe(
      Effect.mapError((cause) => mapThreadSyncIoError("configure", cause)),
    );
    const localRemote = isLocalThreadSyncRemote(configuration.remoteUrl);
    const remoteRef = `refs/heads/${configuration.branch}`;
    const trackingRef = `refs/remotes/${REMOTE_NAME}/${configuration.branch}`;
    const exists = yield* runGit({
      operation: "fetch",
      cwd: mirrorPath,
      args: [
        ...(localRemote ? [] : ["-c", "protocol.version=2"]),
        "ls-remote",
        "--exit-code",
        "--heads",
        REMOTE_NAME,
        remoteRef,
      ],
      ...(localRemote ? {} : { env: { GIT_TRACE_PACKET: "1" } }),
      allowExitCodes: [2],
    });
    if (!localRemote && !traceAdvertisesObjectFilter(exists.stderr)) {
      return yield* new ThreadSyncError({
        operation: "fetch",
        code: "git-failed",
        detail: "The network Git remote does not advertise filtered blobless fetch support.",
      });
    }
    // Exit 2 means the branch is absent, not that capability negotiation
    // failed. Validate network capabilities above before accepting an empty
    // remote so the first push cannot create a branch that later cannot sync.
    if (exists.exitCode !== 0) {
      return { mirrorPath, remoteRevision: null };
    }
    yield* fetchTrackingRef({
      mirrorPath,
      remoteRef,
      trackingRef,
      allowUnfilteredFallback: localRemote,
    });
    const markerEntry = yield* runGit({
      operation: "fetch",
      cwd: mirrorPath,
      args: ["ls-tree", "--name-only", trackingRef, "--", ".erebus-thread-sync-managed"],
    });
    if (markerEntry.stdout.trim().length > 0) {
      return yield* new ThreadSyncError({
        operation: "fetch",
        code: "integrity-failed",
        detail: "The remote branch attempts to control the local sync mirror marker.",
      });
    }
    const revision = yield* runGit({
      operation: "fetch",
      cwd: mirrorPath,
      args: ["rev-parse", "--verify", trackingRef],
    });
    return {
      mirrorPath,
      remoteRevision: revision.stdout.trim() as ThreadSyncRevision,
    };
  });

  const restoreFetchedCheckout = Effect.fn("ThreadSyncGit.restoreFetchedCheckout")(function* (
    configuration: ThreadSyncConfiguration,
    fetched: ThreadSyncGitFetchResult,
    operation: "fetch" | "push",
  ): Effect.fn.Return<void, ThreadSyncError> {
    const localRef = `refs/heads/${configuration.branch}`;
    if (fetched.remoteRevision === null) {
      // The managed branch is absent remotely. Clear the index directly rather
      // than asking a sparse worktree to remove paths it did not materialize,
      // then remove only Erebus-owned files and leave HEAD unborn. This also
      // recovers a prepared snapshot or a local commit from a failed push.
      yield* runGit({
        operation,
        cwd: fetched.mirrorPath,
        args: ["read-tree", "--empty"],
      });
      yield* runGit({
        operation,
        cwd: fetched.mirrorPath,
        args: ["clean", "-fdx", "--", ...MANAGED_SYNC_NAMESPACES],
      });
      yield* runGit({
        operation,
        cwd: fetched.mirrorPath,
        args: ["update-ref", "-d", localRef],
      });
      yield* runGit({
        operation,
        cwd: fetched.mirrorPath,
        args: ["symbolic-ref", "HEAD", localRef],
      });
      return;
    }

    const trackingRef = `refs/remotes/${REMOTE_NAME}/${configuration.branch}`;
    yield* runGit({
      operation,
      cwd: fetched.mirrorPath,
      args: ["checkout", "-f", "-B", configuration.branch, trackingRef],
    });
    yield* runGit({
      operation,
      cwd: fetched.mirrorPath,
      args: ["reset", "--hard", trackingRef],
    });
    yield* runGit({
      operation,
      cwd: fetched.mirrorPath,
      args: ["clean", "-fdx", "--", ...MANAGED_SYNC_NAMESPACES],
    });
  });

  const checkoutRemote = Effect.fn("ThreadSyncGit.checkoutRemote")(function* (
    configuration: ThreadSyncConfiguration,
    expectedRemoteRevision: ThreadSyncRevision | null,
    prefetched?: ThreadSyncGitFetchResult,
  ): Effect.fn.Return<ThreadSyncGitFetchResult, ThreadSyncError> {
    const fetched = prefetched ?? (yield* fetch(configuration));
    if (fetched.remoteRevision !== expectedRemoteRevision) {
      return yield* new ThreadSyncError({
        operation: "fetch",
        code: "remote-changed",
        detail:
          "The sync remote changed after the last fetch. Fetch again before applying changes.",
      });
    }
    yield* restoreFetchedCheckout(configuration, fetched, "fetch");
    return fetched;
  });

  const materializePayloadPaths: NonNullable<ThreadSyncGitShape["materializePayloadPaths"]> =
    Effect.fn("ThreadSyncGit.materializePayloadPaths")(function* (input) {
      const mirrorPath = yield* verifyManagedMirrorPath(input.configuration, input.mirrorPath);
      const payloadPaths = [...new Set(input.paths)].toSorted();
      if (payloadPaths.some((payloadPath) => !V2_PAYLOAD_PATH_PATTERN.test(payloadPath))) {
        return yield* new ThreadSyncError({
          operation: "fetch",
          code: "integrity-failed",
          detail: "Only content-addressed V2 chunk and blob paths can be materialized.",
        });
      }
      if (payloadPaths.length > 0) {
        yield* runGit({
          operation: "fetch",
          cwd: mirrorPath,
          args: ["sparse-checkout", "add", "--stdin"],
          stdin: `${payloadPaths.map((payloadPath) => `/${payloadPath}`).join("\n")}\n`,
        });
      }
    });

  const prunePayloads: NonNullable<ThreadSyncGitShape["prunePayloads"]> = Effect.fn(
    "ThreadSyncGit.prunePayloads",
  )(function* (input) {
    const mirrorPath = yield* verifyManagedMirrorPath(input.configuration, input.mirrorPath);
    yield* applyMetadataSparseCheckout(mirrorPath, "fetch");
  });

  function nullSeparatedPaths(value: string): ReadonlyArray<string> {
    return value.split("\0").filter((entry) => entry.length > 0);
  }

  const managedDirtyPaths = Effect.fn("ThreadSyncGit.managedDirtyPaths")(function* (
    mirrorPath: string,
  ) {
    const changed = yield* runGit({
      operation: "push",
      cwd: mirrorPath,
      args: ["diff", "--name-only", "--no-renames", "-z", "--", ...MANAGED_SYNC_NAMESPACES],
    });
    const untracked = yield* runGit({
      operation: "push",
      cwd: mirrorPath,
      args: ["ls-files", "--others", "--exclude-standard", "-z", "--", ...MANAGED_SYNC_NAMESPACES],
    });
    const staged = yield* runGit({
      operation: "push",
      cwd: mirrorPath,
      args: [
        "diff",
        "--cached",
        "--name-only",
        "--no-renames",
        "-z",
        "--",
        ...MANAGED_SYNC_NAMESPACES,
      ],
    });
    return [
      ...new Set([
        ...nullSeparatedPaths(changed.stdout),
        ...nullSeparatedPaths(untracked.stdout),
        ...nullSeparatedPaths(staged.stdout),
      ]),
    ].toSorted();
  });

  const commitAndPush: ThreadSyncGitShape["commitAndPush"] = Effect.fn(
    "ThreadSyncGit.commitAndPush",
  )(function* (input) {
    // The caller has already checked out the expected remote revision and
    // written the portable documents. Re-fetch only to close the race; a
    // second checkout here would erase those prepared files.
    const checkedOut = yield* fetch(input.configuration);
    if (checkedOut.remoteRevision !== input.expectedRemoteRevision) {
      // The fetched tracking ref now represents the remote winner. Restore the
      // managed mirror before surfacing the conflict so a later checkout or
      // retry never inherits the rejected prepared tree.
      yield* restoreFetchedCheckout(input.configuration, checkedOut, "push");
      return yield* new ThreadSyncError({
        operation: "push",
        code: "remote-changed",
        detail: "The sync remote advanced while the local snapshot was being prepared.",
      });
    }
    const removePayloadPaths = [...new Set(input.removePayloadPaths ?? [])].toSorted();
    if (removePayloadPaths.some((payloadPath) => !V2_PAYLOAD_PATH_PATTERN.test(payloadPath))) {
      return yield* new ThreadSyncError({
        operation: "push",
        code: "integrity-failed",
        detail: "Only exact content-addressed V2 payload paths can be removed.",
      });
    }
    for (let offset = 0; offset < removePayloadPaths.length; offset += GIT_PATH_BATCH_SIZE) {
      yield* runGit({
        operation: "push",
        cwd: checkedOut.mirrorPath,
        args: [
          "update-index",
          "--force-remove",
          "--",
          ...removePayloadPaths.slice(offset, offset + GIT_PATH_BATCH_SIZE),
        ],
      });
    }
    const dirtyPaths = yield* managedDirtyPaths(checkedOut.mirrorPath);
    if (dirtyPaths.length > 0) {
      const removedPayloadPathSet = new Set(removePayloadPaths);
      const pathsToStage = dirtyPaths.filter((dirtyPath) => !removedPayloadPathSet.has(dirtyPath));
      for (let offset = 0; offset < pathsToStage.length; offset += GIT_PATH_BATCH_SIZE) {
        yield* runGit({
          operation: "push",
          cwd: checkedOut.mirrorPath,
          args: [
            "add",
            "--sparse",
            "--",
            ...pathsToStage.slice(offset, offset + GIT_PATH_BATCH_SIZE),
          ],
        });
      }
      yield* runGit({
        operation: "push",
        cwd: checkedOut.mirrorPath,
        args: ["commit", "-m", input.message],
      });
    }
    yield* runGit({
      operation: "push",
      cwd: checkedOut.mirrorPath,
      args: ["push", REMOTE_NAME, `HEAD:refs/heads/${input.configuration.branch}`],
    });
    const revision = yield* runGit({
      operation: "push",
      cwd: checkedOut.mirrorPath,
      args: ["rev-parse", "HEAD"],
    });
    yield* applyMetadataSparseCheckout(checkedOut.mirrorPath, "push");
    return revision.stdout.trim() as ThreadSyncRevision;
  });

  const removeMirror: ThreadSyncGitShape["removeMirror"] = (configuration) =>
    Effect.gen(function* () {
      const mirrorPath = path.join(mirrorsRoot, mirrorKey(configuration));
      const markerPath = path.join(mirrorPath, ".erebus-thread-sync-managed");
      if (!(yield* fileSystem.exists(mirrorPath))) {
        return;
      }
      if (!(yield* fileSystem.exists(markerPath))) {
        return yield* new ThreadSyncError({
          operation: "disconnect",
          code: "integrity-failed",
          detail: "Refusing to remove an unmarked sync mirror.",
        });
      }
      const marker = yield* fileSystem.readFileString(markerPath);
      if (marker !== MANAGED_MIRROR_MARKER || path.dirname(mirrorPath) !== mirrorsRoot) {
        return yield* new ThreadSyncError({
          operation: "disconnect",
          code: "integrity-failed",
          detail: "Refusing to remove a sync mirror outside the managed directory.",
        });
      }
      yield* fileSystem.remove(mirrorPath, { recursive: true });
    }).pipe(Effect.mapError((cause) => mapThreadSyncIoError("disconnect", cause)));

  return ThreadSyncGit.of({
    fetch,
    checkoutRemote,
    commitAndPush,
    materializePayloadPaths,
    prunePayloads,
    removeMirror,
  });
});

export const layer = Layer.effect(ThreadSyncGit, make).pipe(Layer.provide(VcsProcess.layer));
