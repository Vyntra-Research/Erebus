import {
  IsoDateTime,
  ProjectId,
  ThreadId,
  ThreadSyncConfiguration,
  type ThreadSyncBindingUpdate,
  ThreadSyncError,
  ThreadSyncProjectId,
  ThreadSyncRevision,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "../atomicWrite.ts";

export const THREAD_SYNC_LOCAL_STATE_VERSION = 2 as const;

export const ThreadSyncLocalProjectBinding = Schema.Struct({
  syncProjectId: ThreadSyncProjectId,
  projectId: ProjectId,
  linkedAt: IsoDateTime,
});
export type ThreadSyncLocalProjectBinding = typeof ThreadSyncLocalProjectBinding.Type;

export const ThreadSyncLocalThreadBinding = Schema.Struct({
  syncThreadId: ThreadId,
  localThreadId: ThreadId,
  syncProjectId: ThreadSyncProjectId,
  baseRevision: Schema.NullOr(ThreadSyncRevision),
});
export type ThreadSyncLocalThreadBinding = typeof ThreadSyncLocalThreadBinding.Type;

export const ThreadSyncLocalState = Schema.Struct({
  formatVersion: Schema.Literal(THREAD_SYNC_LOCAL_STATE_VERSION),
  configuration: Schema.NullOr(ThreadSyncConfiguration),
  remoteRevision: Schema.NullOr(ThreadSyncRevision),
  lastFetchedAt: Schema.NullOr(IsoDateTime),
  projectBindings: Schema.Array(ThreadSyncLocalProjectBinding),
  threadBindings: Schema.Array(ThreadSyncLocalThreadBinding),
  lastBindingEventSequence: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type ThreadSyncLocalState = typeof ThreadSyncLocalState.Type;

const ThreadSyncLocalStateV1 = Schema.Struct({
  formatVersion: Schema.Literal(1),
  configuration: Schema.NullOr(ThreadSyncConfiguration),
  remoteRevision: Schema.NullOr(ThreadSyncRevision),
  lastFetchedAt: Schema.NullOr(IsoDateTime),
  projectBindings: Schema.Array(ThreadSyncLocalProjectBinding),
  threadBindings: Schema.Array(ThreadSyncLocalThreadBinding),
  // A short-lived development build wrote the cursor while still identifying
  // the file as v1. Accept and preserve it during the v2 migration.
  lastBindingEventSequence: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});

const DecodableThreadSyncLocalState = Schema.Union([ThreadSyncLocalStateV1, ThreadSyncLocalState]);
const decodeLocalStateJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(DecodableThreadSyncLocalState),
);
const encodeLocalStateJson = Schema.encodeUnknownEffect(
  Schema.fromJsonString(ThreadSyncLocalState),
);

export function emptyThreadSyncLocalState(): ThreadSyncLocalState {
  return {
    formatVersion: THREAD_SYNC_LOCAL_STATE_VERSION,
    configuration: null,
    remoteRevision: null,
    lastFetchedAt: null,
    projectBindings: [],
    threadBindings: [],
    lastBindingEventSequence: null,
  };
}

export function resetThreadSyncLocalStateAt(
  lastBindingEventSequence: number,
): ThreadSyncLocalState {
  return { ...emptyThreadSyncLocalState(), lastBindingEventSequence };
}

export function applyThreadSyncBindingUpdates(
  bindings: ReadonlyArray<ThreadSyncLocalThreadBinding>,
  updates: ReadonlyArray<ThreadSyncBindingUpdate>,
): ReadonlyArray<ThreadSyncLocalThreadBinding> {
  const next = [...bindings];
  for (const update of updates) {
    const retained = next.filter(
      (binding) =>
        binding.syncThreadId !== update.syncThreadId &&
        binding.localThreadId !== update.localThreadId,
    );
    next.splice(0, next.length, ...retained, {
      syncThreadId: update.syncThreadId,
      localThreadId: update.localThreadId,
      syncProjectId: update.syncProjectId as ThreadSyncProjectId,
      baseRevision: update.baseRevision as ThreadSyncRevision | null,
    });
  }
  return next;
}

function validateUniqueBindings(state: ThreadSyncLocalState): ThreadSyncLocalState {
  const syncProjects = new Set<string>();
  const localProjects = new Set<string>();
  for (const binding of state.projectBindings) {
    if (syncProjects.has(binding.syncProjectId) || localProjects.has(binding.projectId)) {
      throw new Error("Thread sync state contains duplicate project bindings.");
    }
    syncProjects.add(binding.syncProjectId);
    localProjects.add(binding.projectId);
  }

  const syncThreads = new Set<string>();
  const localThreads = new Set<string>();
  for (const binding of state.threadBindings) {
    if (syncThreads.has(binding.syncThreadId) || localThreads.has(binding.localThreadId)) {
      throw new Error("Thread sync state contains duplicate thread bindings.");
    }
    syncThreads.add(binding.syncThreadId);
    localThreads.add(binding.localThreadId);
  }
  return state;
}

export const loadThreadSyncLocalState = Effect.fn("ThreadSyncState.load")(function* (
  filePath: string,
): Effect.fn.Return<ThreadSyncLocalState, ThreadSyncError, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  const exists = yield* fileSystem.exists(filePath).pipe(
    Effect.mapError(
      (cause) =>
        new ThreadSyncError({
          operation: "status",
          code: "io-failed",
          detail: `Could not inspect the local thread sync state: ${String(cause)}`,
        }),
    ),
  );
  if (!exists) {
    return emptyThreadSyncLocalState();
  }

  const contents = yield* fileSystem.readFileString(filePath).pipe(
    Effect.mapError(
      (cause) =>
        new ThreadSyncError({
          operation: "status",
          code: "io-failed",
          detail: `Could not read the local thread sync state: ${String(cause)}`,
        }),
    ),
  );

  const persisted = yield* decodeLocalStateJson(contents).pipe(
    Effect.mapError(
      (cause) =>
        new ThreadSyncError({
          operation: "status",
          code: "integrity-failed",
          detail: `The local thread sync state is invalid: ${String(cause)}`,
        }),
    ),
  );
  const decoded: ThreadSyncLocalState =
    persisted.formatVersion === 1
      ? { ...persisted, formatVersion: THREAD_SYNC_LOCAL_STATE_VERSION }
      : persisted;
  return yield* Effect.try({
    try: () => validateUniqueBindings(decoded),
    catch: (cause) =>
      new ThreadSyncError({
        operation: "status",
        code: "integrity-failed",
        detail: `The local thread sync bindings are invalid: ${String(cause)}`,
      }),
  });
});

export const saveThreadSyncLocalState = Effect.fn("ThreadSyncState.save")(function* (
  filePath: string,
  state: ThreadSyncLocalState,
): Effect.fn.Return<void, ThreadSyncError, FileSystem.FileSystem | Path.Path> {
  const validated = yield* Effect.try({
    try: () => validateUniqueBindings(state),
    catch: (cause) =>
      new ThreadSyncError({
        operation: "status",
        code: "integrity-failed",
        detail: `The local thread sync bindings are invalid: ${String(cause)}`,
      }),
  });
  const encoded = yield* encodeLocalStateJson(validated).pipe(
    Effect.mapError(
      (cause) =>
        new ThreadSyncError({
          operation: "status",
          code: "integrity-failed",
          detail: `The local thread sync state could not be encoded: ${String(cause)}`,
        }),
    ),
  );
  yield* writeFileStringAtomically({
    filePath,
    contents: `${encoded.trimEnd()}\n`,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ThreadSyncError({
          operation: "status",
          code: "io-failed",
          detail: `Could not save the local thread sync state: ${String(cause)}`,
        }),
    ),
  );
});
