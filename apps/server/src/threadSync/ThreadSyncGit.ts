import * as NodeCrypto from "node:crypto";

import {
  ThreadSyncError,
  type ThreadSyncConfiguration,
  type ThreadSyncRevision,
} from "@t3tools/contracts";
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

function mirrorKey(configuration: ThreadSyncConfiguration): string {
  return NodeCrypto.createHash("sha256")
    .update(`${configuration.remoteUrl}\0${configuration.branch}`, "utf8")
    .digest("hex")
    .slice(0, 24);
}

export function hasUnsafeThreadSyncRemoteComponents(remoteUrl: string): boolean {
  try {
    const parsed = new URL(remoteUrl);
    const allowsSshUsername = parsed.protocol === "ssh:" && parsed.password.length === 0;
    return (
      (!allowsSshUsername && parsed.username.length > 0) ||
      parsed.password.length > 0 ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0
    );
  } catch {
    const scpLike = /^(?![A-Za-z]:[\\/])(?:[^/@\s]+@)?[^/\\:\s]+:[^\\]+$/.test(remoteUrl);
    return scpLike && /[?#]/.test(remoteUrl);
  }
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
  const mirrorsRoot = path.join(config.stateDir, "thread-sync", "mirrors");

  const runGit = Effect.fn("ThreadSyncGit.runGit")(function* (input: {
    readonly operation: "configure" | "fetch" | "disconnect" | "push";
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
    readonly allowExitCodes?: ReadonlyArray<number>;
  }) {
    const result = yield* vcsProcess
      .run({
        operation: `thread-sync:${input.operation}`,
        command: "git",
        args: input.args,
        cwd: input.cwd,
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
          "The sync remote must use Git credential management or SSH instead of embedded credentials, query parameters, or fragments.",
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
    return mirrorPath;
  });

  const fetch = Effect.fn("ThreadSyncGit.fetch")(function* (
    configuration: ThreadSyncConfiguration,
  ): Effect.fn.Return<ThreadSyncGitFetchResult, ThreadSyncError> {
    const mirrorPath = yield* resolveMirror(configuration).pipe(
      Effect.mapError((cause) => mapThreadSyncIoError("configure", cause)),
    );
    const remoteRef = `refs/heads/${configuration.branch}`;
    const trackingRef = `refs/remotes/${REMOTE_NAME}/${configuration.branch}`;
    const exists = yield* runGit({
      operation: "fetch",
      cwd: mirrorPath,
      args: ["ls-remote", "--exit-code", "--heads", REMOTE_NAME, remoteRef],
      allowExitCodes: [2],
    });
    if (exists.exitCode !== 0) {
      return { mirrorPath, remoteRevision: null };
    }
    yield* runGit({
      operation: "fetch",
      cwd: mirrorPath,
      args: ["fetch", "--prune", REMOTE_NAME, `+${remoteRef}:${trackingRef}`],
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
      // The managed branch is absent remotely. Clear both tracked and
      // untracked namespace files, then leave HEAD on an unborn branch. This
      // also recovers a mirror that contains a prepared snapshot or a local
      // commit from a failed push attempt.
      yield* runGit({
        operation,
        cwd: fetched.mirrorPath,
        args: ["rm", "-rf", "--ignore-unmatch", "--", "."],
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
