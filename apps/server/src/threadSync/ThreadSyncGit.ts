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

const MANAGED_MIRROR_MARKER = "erebus-managed-thread-sync-v1\n";
const REMOTE_NAME = "origin";
const SPARSE_CHECKOUT_PATTERN = `/${THREAD_SYNC_NAMESPACE}/`;
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
  ) => Effect.Effect<ThreadSyncGitFetchResult, ThreadSyncError>;
  readonly commitAndPush: (input: {
    readonly configuration: ThreadSyncConfiguration;
    readonly expectedRemoteRevision: ThreadSyncRevision | null;
    readonly message: string;
  }) => Effect.Effect<ThreadSyncRevision, ThreadSyncError>;
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
    readonly env?: NodeJS.ProcessEnv;
    readonly allowExitCodes?: ReadonlyArray<number>;
  }) {
    const result = yield* vcsProcess
      .run({
        operation: `thread-sync:${input.operation}`,
        command: "git",
        args: input.args,
        cwd: input.cwd,
        env: { ...input.env, LANG: "C", LC_ALL: "C" },
        allowNonZeroExit: true,
        timeoutMs: 60_000,
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
    // owned by other tools, while materializing only Erebus thread data in the
    // managed worktree. Running these commands again also migrates mirrors
    // created before sparse checkout was enabled.
    yield* runGit({
      operation: "configure",
      cwd: mirrorPath,
      args: ["sparse-checkout", "init", "--no-cone"],
    });
    yield* runGit({
      operation: "configure",
      cwd: mirrorPath,
      args: ["sparse-checkout", "set", "--no-cone", SPARSE_CHECKOUT_PATTERN],
    });
    return mirrorPath;
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
        args: ["clean", "-fdx", "--", THREAD_SYNC_NAMESPACE],
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
      args: ["clean", "-fdx", "--", THREAD_SYNC_NAMESPACE],
    });
  });

  const checkoutRemote = Effect.fn("ThreadSyncGit.checkoutRemote")(function* (
    configuration: ThreadSyncConfiguration,
    expectedRemoteRevision: ThreadSyncRevision | null,
  ): Effect.fn.Return<ThreadSyncGitFetchResult, ThreadSyncError> {
    const fetched = yield* fetch(configuration);
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
    const status = yield* runGit({
      operation: "push",
      cwd: checkedOut.mirrorPath,
      args: ["status", "--porcelain", "--", THREAD_SYNC_NAMESPACE],
    });
    if (status.stdout.trim().length > 0) {
      yield* runGit({
        operation: "push",
        cwd: checkedOut.mirrorPath,
        args: ["add", "--", THREAD_SYNC_NAMESPACE],
      });
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

  return ThreadSyncGit.of({ fetch, checkoutRemote, commitAndPush, removeMirror });
});

export const layer = Layer.effect(ThreadSyncGit, make).pipe(Layer.provide(VcsProcess.layer));
