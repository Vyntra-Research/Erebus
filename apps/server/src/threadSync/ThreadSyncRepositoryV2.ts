// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  ThreadSyncError,
  ThreadSyncActivity,
  ThreadSyncCoagent,
  ThreadSyncMessage,
  ThreadSyncProjectId,
  ThreadSyncProjectSnapshot,
  ThreadSyncThreadSnapshot,
  ThreadSyncProposedPlan,
  ThreadSyncRevision,
  ThreadSyncTerminalTurn,
  ThreadSyncThreadLifecycle,
  TrimmedNonEmptyString,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";
import * as StreamRuntime from "effect/Stream";

import { canonicalThreadSyncJson, threadSyncRevision } from "./ThreadSyncDocuments.ts";

export const THREAD_SYNC_V2_FORMAT_VERSION = 2 as const;
export const THREAD_SYNC_V2_NAMESPACE = ".erebus-thread-sync/v2";
export const THREAD_SYNC_V2_MANIFEST_PATH = `${THREAD_SYNC_V2_NAMESPACE}/manifest.json`;
export const THREAD_SYNC_V2_PROJECTS_DIRECTORY = `${THREAD_SYNC_V2_NAMESPACE}/projects`;
export const THREAD_SYNC_V2_THREADS_DIRECTORY = `${THREAD_SYNC_V2_NAMESPACE}/threads`;
export const THREAD_SYNC_V2_CHUNKS_DIRECTORY = `${THREAD_SYNC_V2_NAMESPACE}/chunks`;
export const THREAD_SYNC_V2_BLOBS_DIRECTORY = `${THREAD_SYNC_V2_NAMESPACE}/blobs`;
export const THREAD_SYNC_V2_WORK_DIRECTORY = ".erebus-thread-sync-work/v2";
export const THREAD_SYNC_V2_DEFAULT_CHUNK_BYTES = 1024 * 1024;
export const THREAD_SYNC_V2_TEXT_FRAGMENT_BYTES = 256 * 1024;
export const THREAD_SYNC_V2_GENERIC_FRAGMENT_BYTES = 64 * 1024;
export const THREAD_SYNC_V2_MAX_STORED_ROW_BYTES = 512 * 1024;
export const THREAD_SYNC_V2_MAX_LOGICAL_RECORD_BYTES = 1024 * 1024;
export const THREAD_SYNC_V2_MAX_CHUNK_BYTES = 8 * 1024 * 1024;

const MAX_MANAGED_ENTRY_COUNT = 20_000;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_PROJECT_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_PROJECT_BYTES = 256 * 1024 * 1024;
const MAX_CHUNKS_PER_THREAD = 100_000;
const MAX_BLOB_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BLOB_BYTES = 512 * 1024 * 1024;
const MAX_WORK_DIRECTORY_ENTRIES = 20_000;
const MAX_WORK_GENERATIONS_REMOVED_PER_EXPORT = 64;
const MAX_WORK_FILES_PER_GENERATION = 8;
const MAX_ORPHAN_BLOB_PARTIALS_REMOVED_PER_EXPORT = 64;

const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const ManagedJsonFileName = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}\.json$/));
const ChunkFileName = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}\.ndjson$/));

/** Metadata kept outside the chunk stream so a remote can be indexed cheaply. */
export const ThreadSyncV2ThreadHeader = Schema.Struct({
  formatVersion: Schema.Literal(THREAD_SYNC_V2_FORMAT_VERSION),
  threadId: ThreadId,
  syncProjectId: ThreadSyncProjectId,
  title: TrimmedNonEmptyString,
  coagent: Schema.NullOr(ThreadSyncCoagent),
  latestTurnId: Schema.NullOr(TurnId),
  lifecycle: ThreadSyncThreadLifecycle,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ThreadSyncV2ThreadHeader = typeof ThreadSyncV2ThreadHeader.Type;

const recordBase = {
  ordinal: NonNegativeInt,
};

const ThreadSyncV2TextDescriptor = Schema.Struct({
  sha256: Sha256,
  sizeBytes: NonNegativeInt,
  fragmentCount: NonNegativeInt,
});

export const ThreadSyncV2MessageMetadata = Schema.Struct({
  id: ThreadSyncMessage.fields.id,
  role: ThreadSyncMessage.fields.role,
  text: ThreadSyncV2TextDescriptor,
  attachments: ThreadSyncMessage.fields.attachments,
  turnId: ThreadSyncMessage.fields.turnId,
  streaming: ThreadSyncMessage.fields.streaming,
  createdAt: ThreadSyncMessage.fields.createdAt,
  updatedAt: ThreadSyncMessage.fields.updatedAt,
});
export type ThreadSyncV2MessageMetadata = typeof ThreadSyncV2MessageMetadata.Type;

export const ThreadSyncV2PlanMetadata = Schema.Struct({
  id: ThreadSyncProposedPlan.fields.id,
  turnId: ThreadSyncProposedPlan.fields.turnId,
  planMarkdown: ThreadSyncV2TextDescriptor,
  implementedAt: ThreadSyncProposedPlan.fields.implementedAt,
  implementationThreadId: ThreadSyncProposedPlan.fields.implementationThreadId,
  createdAt: ThreadSyncProposedPlan.fields.createdAt,
  updatedAt: ThreadSyncProposedPlan.fields.updatedAt,
});
export type ThreadSyncV2PlanMetadata = typeof ThreadSyncV2PlanMetadata.Type;

export const ThreadSyncV2ActivityMetadata = Schema.Struct({
  id: ThreadSyncActivity.fields.id,
  tone: ThreadSyncActivity.fields.tone,
  kind: ThreadSyncActivity.fields.kind,
  summary: ThreadSyncV2TextDescriptor,
  turnId: ThreadSyncActivity.fields.turnId,
  sequence: ThreadSyncActivity.fields.sequence,
  createdAt: ThreadSyncActivity.fields.createdAt,
});
export type ThreadSyncV2ActivityMetadata = typeof ThreadSyncV2ActivityMetadata.Type;

const TextFragment = Schema.String.check(Schema.isMaxLength(THREAD_SYNC_V2_TEXT_FRAGMENT_BYTES));

/** One logical history record. The storage layer fragments its encoded form when needed. */
export const ThreadSyncV2Record = Schema.Union([
  Schema.Struct({ ...recordBase, kind: Schema.Literal("turn"), value: ThreadSyncTerminalTurn }),
  Schema.Struct({
    ...recordBase,
    kind: Schema.Literal("message"),
    value: ThreadSyncV2MessageMetadata,
  }),
  Schema.Struct({
    ...recordBase,
    kind: Schema.Literal("message-text"),
    messageId: ThreadSyncMessage.fields.id,
    fragmentIndex: NonNegativeInt,
    text: TextFragment,
  }),
  Schema.Struct({ ...recordBase, kind: Schema.Literal("plan"), value: ThreadSyncV2PlanMetadata }),
  Schema.Struct({
    ...recordBase,
    kind: Schema.Literal("plan-markdown"),
    planId: ThreadSyncProposedPlan.fields.id,
    fragmentIndex: NonNegativeInt,
    text: TextFragment,
  }),
  Schema.Struct({
    ...recordBase,
    kind: Schema.Literal("activity"),
    value: ThreadSyncV2ActivityMetadata,
  }),
  Schema.Struct({
    ...recordBase,
    kind: Schema.Literal("activity-summary"),
    activityId: ThreadSyncActivity.fields.id,
    fragmentIndex: NonNegativeInt,
    text: TextFragment,
  }),
]);
export type ThreadSyncV2Record = typeof ThreadSyncV2Record.Type;
type ThreadSyncV2RecordWithoutOrdinal<T = ThreadSyncV2Record> = T extends {
  readonly ordinal: number;
}
  ? Omit<T, "ordinal">
  : never;

export const ThreadSyncV2ChunkDescriptor = Schema.Struct({
  fileName: ChunkFileName,
  sha256: Sha256,
  sizeBytes: NonNegativeInt,
  rowCount: NonNegativeInt,
  firstRowOrdinal: NonNegativeInt,
  lastRowOrdinal: NonNegativeInt,
  firstRecordOrdinal: NonNegativeInt,
  lastRecordOrdinal: NonNegativeInt,
});
export type ThreadSyncV2ChunkDescriptor = typeof ThreadSyncV2ChunkDescriptor.Type;

export const ThreadSyncV2ThreadManifest = Schema.Struct({
  formatVersion: Schema.Literal(THREAD_SYNC_V2_FORMAT_VERSION),
  kind: Schema.Literal("erebus-thread-sync-thread"),
  sourceKeyHash: Sha256,
  revision: ThreadSyncRevision,
  header: ThreadSyncV2ThreadHeader,
  recordCount: NonNegativeInt,
  rowCount: NonNegativeInt,
  chunks: Schema.Array(ThreadSyncV2ChunkDescriptor),
  /** Complete attachment reachability for safe content-addressed blob GC. */
  blobHashes: Schema.optionalKey(Schema.Array(Sha256)),
});
export type ThreadSyncV2ThreadManifest = typeof ThreadSyncV2ThreadManifest.Type;

export const ThreadSyncV2ProjectEntry = Schema.Struct({
  syncProjectId: ThreadSyncProjectId,
  fileName: ManagedJsonFileName,
  sha256: Sha256,
});
export type ThreadSyncV2ProjectEntry = typeof ThreadSyncV2ProjectEntry.Type;

export const ThreadSyncV2ThreadEntry = Schema.Struct({
  threadId: ThreadId,
  syncProjectId: ThreadSyncProjectId,
  title: TrimmedNonEmptyString,
  manifestPath: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}\/[a-f0-9]{64}\.json$/)),
  manifestSha256: Sha256,
  revision: ThreadSyncRevision,
  sourceKeyHash: Schema.optionalKey(Sha256),
});
export type ThreadSyncV2ThreadEntry = typeof ThreadSyncV2ThreadEntry.Type;

export const ThreadSyncV2BlobEntry = Schema.Struct({
  sha256: Sha256,
  sizeBytes: NonNegativeInt,
});
export type ThreadSyncV2BlobEntry = typeof ThreadSyncV2BlobEntry.Type;

export const ThreadSyncV2RepositoryManifest = Schema.Struct({
  formatVersion: Schema.Literal(THREAD_SYNC_V2_FORMAT_VERSION),
  kind: Schema.Literal("erebus-thread-sync"),
  updatedAt: IsoDateTime,
  projects: Schema.Array(ThreadSyncV2ProjectEntry),
  threads: Schema.Array(ThreadSyncV2ThreadEntry),
  blobs: Schema.Array(ThreadSyncV2BlobEntry),
});
export type ThreadSyncV2RepositoryManifest = typeof ThreadSyncV2RepositoryManifest.Type;

export interface ThreadSyncV2SourceRecord {
  readonly record: ThreadSyncV2Record;
  /** Opaque position immediately after this record, safe to persist. */
  readonly nextResumeToken: string;
}

export interface ThreadSyncV2ThreadSource<E = never, R = never> {
  readonly sourceKey: string;
  readonly header: ThreadSyncV2ThreadHeader;
  readonly records: (resumeToken: string | null) => Stream.Stream<ThreadSyncV2SourceRecord, E, R>;
}

export interface ThreadSyncV2RepositorySource<E = never, R = never> {
  readonly projects: ReadonlyMap<ThreadSyncProjectId, ThreadSyncProjectSnapshot>;
  readonly threads: Iterable<ThreadSyncV2ThreadSource<E, R>>;
  readonly blobs: Iterable<ThreadSyncV2BlobSource<E, R>>;
  /** Already-indexed remote entries kept without materializing their payloads. */
  readonly retainedThreads?: Iterable<ThreadSyncV2ThreadEntry>;
  readonly retainedBlobs?: Iterable<ThreadSyncV2BlobEntry>;
  /**
   * The complete prior remote thread index. Its metadata manifests are used to
   * collect sparse chunks that became unreachable without hydrating any chunk.
   */
  readonly previousThreads?: Iterable<ThreadSyncV2ThreadEntry>;
  readonly updatedAt: string;
}

export interface ThreadSyncV2BlobSource<E = never, R = never> {
  readonly sha256: string;
  readonly sizeBytes: number;
  /** Opens the byte stream at an exact offset so a partial blob can resume. */
  readonly bytes: (offset: number) => Stream.Stream<Uint8Array, E, R>;
}

export function threadSyncV2Sha256(value: string | Uint8Array): string {
  return NodeCrypto.createHash("sha256").update(value).digest("hex");
}

function threadSyncV2ManifestRevision(input: {
  readonly header: ThreadSyncV2ThreadHeader;
  readonly recordCount: number;
  readonly rowCount: number;
  readonly chunks: ReadonlyArray<ThreadSyncV2ChunkDescriptor>;
  readonly blobHashes?: ReadonlyArray<string>;
}): ThreadSyncRevision {
  return threadSyncV2Sha256(
    canonicalThreadSyncJson({
      formatVersion: THREAD_SYNC_V2_FORMAT_VERSION,
      header: input.header,
      recordCount: input.recordCount,
      rowCount: input.rowCount,
      chunks: input.chunks,
      ...(input.blobHashes === undefined ? {} : { blobHashes: input.blobHashes }),
    }),
  ) as ThreadSyncRevision;
}

/** Splits UTF-8 text on code-point boundaries without imposing a content limit. */
export function* threadSyncV2TextFragments(
  value: string,
  maximumBytes = THREAD_SYNC_V2_TEXT_FRAGMENT_BYTES,
): Generator<string> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 4) {
    throw new Error("The v2 text fragment budget must be at least four bytes.");
  }
  let offset = 0;
  while (offset < value.length) {
    let end = Math.min(value.length, offset + maximumBytes);
    if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]!)) end -= 1;
    let fragment = value.slice(offset, end);
    let size = Buffer.byteLength(fragment, "utf8");
    while (size > maximumBytes) {
      end -= Math.max(1, Math.ceil((size - maximumBytes) / 4));
      if (end > offset && /[\uD800-\uDBFF]/.test(value[end - 1]!)) end -= 1;
      fragment = value.slice(offset, end);
      size = Buffer.byteLength(fragment, "utf8");
    }
    if (fragment.length === 0 || size > maximumBytes) {
      throw new Error("Could not split v2 text within the fragment budget.");
    }
    yield fragment;
    offset = end;
  }
}

function describeThreadSyncV2TextWithBudget(
  value: string,
  maximumBytes: number,
): {
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly fragmentCount: number;
} {
  const hash = NodeCrypto.createHash("sha256");
  let sizeBytes = 0;
  let fragmentCount = 0;
  for (const fragment of threadSyncV2TextFragments(value, maximumBytes)) {
    const bytes = Buffer.from(fragment, "utf8");
    hash.update(bytes);
    sizeBytes += bytes.byteLength;
    fragmentCount += 1;
  }
  return { sha256: hash.digest("hex"), sizeBytes, fragmentCount };
}

export function describeThreadSyncV2Text(value: string): {
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly fragmentCount: number;
} {
  return describeThreadSyncV2TextWithBudget(value, THREAD_SYNC_V2_TEXT_FRAGMENT_BYTES);
}

/**
 * Adapts a verified v1 document to the resumable v2 writer without first
 * expanding the whole repository into another in-memory representation.
 * The v1 reader already bounds each document; this adapter emits one logical
 * record at a time and gives every record a deterministic resume position.
 */
export function threadSyncV2SourceFromV1Snapshot(
  snapshot: ThreadSyncThreadSnapshot,
): ThreadSyncV2ThreadSource<ThreadSyncError> {
  const textRecordCount = (value: string) => describeThreadSyncV2Text(value).fragmentCount;
  const recordCount =
    snapshot.turns.length +
    snapshot.messages.reduce((total, message) => total + 1 + textRecordCount(message.text), 0) +
    snapshot.proposedPlans.reduce(
      (total, plan) => total + 1 + textRecordCount(plan.planMarkdown),
      0,
    ) +
    snapshot.activities.reduce(
      (total, activity) => total + 1 + textRecordCount(activity.summary),
      0,
    );
  const header: ThreadSyncV2ThreadHeader = {
    formatVersion: THREAD_SYNC_V2_FORMAT_VERSION,
    threadId: snapshot.threadId,
    syncProjectId: snapshot.syncProjectId,
    title: snapshot.title,
    coagent: snapshot.coagent,
    latestTurnId: snapshot.latestTurn?.turnId ?? null,
    lifecycle: snapshot.lifecycle,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
  };

  return {
    sourceKey: `v1:${threadSyncRevision(snapshot)}`,
    header,
    records: (resumeToken) => {
      const startOrdinal =
        resumeToken === null || resumeToken === ""
          ? 0
          : /^(?:0|[1-9][0-9]*)$/.test(resumeToken)
            ? Number(resumeToken)
            : Number.NaN;
      if (!Number.isSafeInteger(startOrdinal) || startOrdinal < 0 || startOrdinal > recordCount) {
        return StreamRuntime.fail(
          repositoryV2Error("push", "integrity-failed", "A v1 migration resume token is invalid."),
        );
      }

      function* iterate(): Generator<ThreadSyncV2SourceRecord> {
        let ordinal = 0;
        const emit = (record: ThreadSyncV2RecordWithoutOrdinal) => {
          const current = ordinal;
          ordinal += 1;
          return current < startOrdinal
            ? null
            : {
                record: { ...record, ordinal: current } as ThreadSyncV2Record,
                nextResumeToken: String(ordinal),
              };
        };

        for (const turn of snapshot.turns) {
          const emitted = emit({ kind: "turn", value: turn });
          if (emitted !== null) yield emitted;
        }
        for (const message of snapshot.messages) {
          const descriptor = describeThreadSyncV2Text(message.text);
          const metadata = emit({
            kind: "message",
            value: { ...message, text: descriptor, streaming: false },
          });
          if (metadata !== null) yield metadata;
          let fragmentIndex = 0;
          for (const text of threadSyncV2TextFragments(message.text)) {
            const emitted = emit({
              kind: "message-text",
              messageId: message.id,
              fragmentIndex,
              text,
            });
            fragmentIndex += 1;
            if (emitted !== null) yield emitted;
          }
        }
        for (const plan of snapshot.proposedPlans) {
          const descriptor = describeThreadSyncV2Text(plan.planMarkdown);
          const metadata = emit({
            kind: "plan",
            value: { ...plan, planMarkdown: descriptor },
          });
          if (metadata !== null) yield metadata;
          let fragmentIndex = 0;
          for (const text of threadSyncV2TextFragments(plan.planMarkdown)) {
            const emitted = emit({
              kind: "plan-markdown",
              planId: plan.id,
              fragmentIndex,
              text,
            });
            fragmentIndex += 1;
            if (emitted !== null) yield emitted;
          }
        }
        for (const activity of snapshot.activities) {
          const descriptor = describeThreadSyncV2Text(activity.summary);
          const metadata = emit({
            kind: "activity",
            value: { ...activity, summary: descriptor, sequence: activity.sequence ?? null },
          });
          if (metadata !== null) yield metadata;
          let fragmentIndex = 0;
          for (const text of threadSyncV2TextFragments(activity.summary)) {
            const emitted = emit({
              kind: "activity-summary",
              activityId: activity.id,
              fragmentIndex,
              text,
            });
            fragmentIndex += 1;
            if (emitted !== null) yield emitted;
          }
        }
      }

      return StreamRuntime.fromIterable(iterate());
    },
  };
}

export function threadSyncV2ProjectFileName(syncProjectId: ThreadSyncProjectId): string {
  return `${threadSyncV2Sha256(syncProjectId)}.json`;
}

export function threadSyncV2ThreadDirectory(threadId: ThreadId): string {
  return threadSyncV2Sha256(threadId);
}

const ThreadSyncV2Checkpoint = Schema.Struct({
  formatVersion: Schema.Literal(THREAD_SYNC_V2_FORMAT_VERSION),
  sourceKeyHash: Sha256,
  headerHash: Sha256,
  nextResumeToken: Schema.NullOr(Schema.String),
  nextRecordOrdinal: NonNegativeInt,
  nextRowOrdinal: NonNegativeInt,
  chunks: Schema.Array(ThreadSyncV2ChunkDescriptor),
  blobHashes: Schema.optionalKey(Schema.Array(Sha256)),
});
type ThreadSyncV2Checkpoint = typeof ThreadSyncV2Checkpoint.Type;

const decodeCheckpoint = Schema.decodeUnknownSync(ThreadSyncV2Checkpoint);
const decodeThreadManifest = Schema.decodeUnknownSync(ThreadSyncV2ThreadManifest);
const decodeRepositoryManifest = Schema.decodeUnknownSync(ThreadSyncV2RepositoryManifest);
const decodeRecord = Schema.decodeUnknownSync(ThreadSyncV2Record);
const decodeProjectSnapshotJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ThreadSyncProjectSnapshot),
);
const encodeHeader = Schema.encodeSync(ThreadSyncV2ThreadHeader);
const encodeRecord = Schema.encodeSync(ThreadSyncV2Record);
const isThreadSyncError = Schema.is(ThreadSyncError);

const ThreadSyncV2StoredRow = Schema.Union([
  Schema.Struct({
    rowOrdinal: NonNegativeInt,
    kind: Schema.Literal("record"),
    record: ThreadSyncV2Record,
  }),
  Schema.Struct({
    rowOrdinal: NonNegativeInt,
    kind: Schema.Literal("record-fragment"),
    recordOrdinal: NonNegativeInt,
    fragmentIndex: NonNegativeInt,
    fragmentCount: NonNegativeInt,
    sha256: Sha256,
    sizeBytes: NonNegativeInt,
    jsonFragment: Schema.String,
  }),
]);
type ThreadSyncV2StoredRow = typeof ThreadSyncV2StoredRow.Type;

const decodeStoredRow = Schema.decodeUnknownSync(ThreadSyncV2StoredRow);
const encodeStoredRow = Schema.encodeSync(ThreadSyncV2StoredRow);

function repositoryV2Error(
  operation: "pull" | "push",
  code: "integrity-failed" | "invalid-snapshot" | "io-failed",
  detail: string,
): ThreadSyncError {
  return new ThreadSyncError({ operation, code, detail });
}

function isInside(root: string, candidate: string): boolean {
  const relative = NodePath.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
}

function ensureManagedDirectory(mirrorPath: string, segments: ReadonlyArray<string>): string {
  const mirrorInfo = NodeFS.lstatSync(mirrorPath);
  if (!mirrorInfo.isDirectory() || mirrorInfo.isSymbolicLink()) {
    throw new Error("The managed mirror is not a regular directory.");
  }
  const realMirror = NodeFS.realpathSync(mirrorPath);
  let current = mirrorPath;
  for (const segment of segments) {
    if (!/^[a-zA-Z0-9._-]+$/.test(segment) || segment === "." || segment === "..") {
      throw new Error("A managed v2 path segment is invalid.");
    }
    current = NodePath.join(current, segment);
    try {
      const info = NodeFS.lstatSync(current);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error("A managed v2 directory is a link or non-directory.");
      }
    } catch (cause) {
      if (
        typeof cause === "object" &&
        cause !== null &&
        "code" in cause &&
        cause.code === "ENOENT"
      ) {
        NodeFS.mkdirSync(current);
      } else {
        throw cause;
      }
    }
    const realCurrent = NodeFS.realpathSync(current);
    if (!isInside(realMirror, realCurrent)) {
      throw new Error("A managed v2 directory escapes its mirror.");
    }
  }
  return current;
}

function assertRegularFile(mirrorPath: string, filePath: string): NodeFS.Stats {
  const realMirror = NodeFS.realpathSync(mirrorPath);
  const resolvedFile = NodePath.resolve(filePath);
  if (!isInside(NodePath.resolve(mirrorPath), resolvedFile)) {
    throw new Error("A managed v2 file path escapes its mirror.");
  }
  const info = NodeFS.lstatSync(filePath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("A managed v2 file is a link or non-file.");
  }
  const realFile = NodeFS.realpathSync(filePath);
  if (!isInside(realMirror, realFile)) {
    throw new Error("A managed v2 file escapes its mirror.");
  }
  return info;
}

function writeUtf8Atomically(mirrorPath: string, filePath: string, contents: string): void {
  const directory = NodePath.dirname(filePath);
  const realMirror = NodeFS.realpathSync(mirrorPath);
  if (!isInside(realMirror, NodeFS.realpathSync(directory))) {
    throw new Error("A managed v2 write escapes its mirror.");
  }
  try {
    const existing = NodeFS.lstatSync(filePath);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error("A managed v2 destination is a link or non-file.");
    }
  } catch (cause) {
    if (
      !(typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT")
    ) {
      throw cause;
    }
  }

  const temporaryPath = NodePath.join(
    directory,
    `.${NodePath.basename(filePath)}.${NodeCrypto.randomUUID()}.tmp`,
  );
  let descriptor: number | null = null;
  let failure: { readonly cause: unknown } | undefined;
  try {
    descriptor = NodeFS.openSync(temporaryPath, "wx");
    NodeFS.writeFileSync(descriptor, contents, "utf8");
    NodeFS.fsyncSync(descriptor);
    NodeFS.closeSync(descriptor);
    descriptor = null;
    NodeFS.renameSync(temporaryPath, filePath);
  } catch (cause) {
    failure = { cause };
  }
  if (descriptor !== null) {
    try {
      NodeFS.closeSync(descriptor);
    } catch (cause) {
      failure ??= { cause };
    }
  }
  try {
    NodeFS.unlinkSync(temporaryPath);
  } catch (cause) {
    if (
      !(typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT")
    ) {
      failure ??= { cause };
    }
  }
  if (failure !== undefined) throw failure.cause;
}

async function hashFile(
  filePath: string,
): Promise<{ readonly sha256: string; readonly size: number }> {
  const hash = NodeCrypto.createHash("sha256");
  let size = 0;
  for await (const chunk of NodeFS.createReadStream(filePath)) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += bytes.byteLength;
    hash.update(bytes);
  }
  return { sha256: hash.digest("hex"), size };
}

function compactJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function compactJson(value: unknown): string {
  return JSON.stringify(value);
}

function readBoundedJson(filePath: string, maximumBytes = 16 * 1024 * 1024): unknown {
  const info = NodeFS.lstatSync(filePath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximumBytes) {
    throw new Error("A managed v2 JSON document is not a bounded regular file.");
  }
  return JSON.parse(NodeFS.readFileSync(filePath, "utf8"));
}

function readBoundedUtf8(filePath: string, maximumBytes: number): string {
  const info = NodeFS.lstatSync(filePath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximumBytes) {
    throw new Error("A managed v2 text document is not a bounded regular file.");
  }
  return NodeFS.readFileSync(filePath, "utf8");
}

function storedRowsForRecord(
  record: ThreadSyncV2Record,
  firstRowOrdinal: number,
): ReadonlyArray<ThreadSyncV2StoredRow> {
  const direct: ThreadSyncV2StoredRow = {
    rowOrdinal: firstRowOrdinal,
    kind: "record",
    record,
  };
  const directLine = compactJsonLine(encodeStoredRow(direct));
  if (Buffer.byteLength(directLine, "utf8") <= THREAD_SYNC_V2_MAX_STORED_ROW_BYTES) {
    return [direct];
  }

  const encodedRecord = compactJson(encodeRecord(record));
  if (Buffer.byteLength(encodedRecord, "utf8") > THREAD_SYNC_V2_MAX_LOGICAL_RECORD_BYTES) {
    throw new Error("A v2 logical history record exceeds the hard record limit.");
  }
  const descriptor = describeThreadSyncV2TextWithBudget(
    encodedRecord,
    THREAD_SYNC_V2_GENERIC_FRAGMENT_BYTES,
  );
  const fragments = [
    ...threadSyncV2TextFragments(encodedRecord, THREAD_SYNC_V2_GENERIC_FRAGMENT_BYTES),
  ];
  return fragments.map((jsonFragment, fragmentIndex) => ({
    rowOrdinal: firstRowOrdinal + fragmentIndex,
    kind: "record-fragment" as const,
    recordOrdinal: record.ordinal,
    fragmentIndex,
    fragmentCount: descriptor.fragmentCount,
    sha256: descriptor.sha256,
    sizeBytes: descriptor.sizeBytes,
    jsonFragment,
  }));
}

function effectIo<A>(operation: "pull" | "push", detail: string, run: () => A) {
  return Effect.try({
    try: run,
    catch: (cause) => repositoryV2Error(operation, "io-failed", `${detail}: ${String(cause)}`),
  });
}

function effectIoPromise<A>(operation: "pull" | "push", detail: string, run: () => Promise<A>) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => repositoryV2Error(operation, "io-failed", `${detail}: ${String(cause)}`),
  });
}

function validateChunkDescriptors(input: {
  readonly mirrorPath: string;
  readonly chunksPath: string;
  readonly chunks: ReadonlyArray<ThreadSyncV2ChunkDescriptor>;
}) {
  return Effect.gen(function* () {
    if (input.chunks.length > MAX_CHUNKS_PER_THREAD) {
      return yield* Effect.fail(
        repositoryV2Error("pull", "integrity-failed", "A v2 thread contains too many chunks."),
      );
    }
    let nextRowOrdinal = 0;
    let lastRecordOrdinal: number | null = null;
    const files = new Set<string>();
    for (const chunk of input.chunks) {
      if (
        chunk.firstRowOrdinal !== nextRowOrdinal ||
        chunk.lastRowOrdinal < chunk.firstRowOrdinal ||
        chunk.rowCount !== chunk.lastRowOrdinal - chunk.firstRowOrdinal + 1 ||
        chunk.sizeBytes > THREAD_SYNC_V2_MAX_CHUNK_BYTES ||
        chunk.firstRecordOrdinal > chunk.lastRecordOrdinal ||
        (lastRecordOrdinal === null
          ? chunk.firstRecordOrdinal !== 0
          : chunk.firstRecordOrdinal !== lastRecordOrdinal &&
            chunk.firstRecordOrdinal !== lastRecordOrdinal + 1) ||
        chunk.fileName !== `${chunk.sha256}.ndjson` ||
        files.has(chunk.fileName)
      ) {
        return yield* Effect.fail(
          repositoryV2Error("pull", "integrity-failed", "A v2 chunk sequence is inconsistent."),
        );
      }
      files.add(chunk.fileName);
      const filePath = NodePath.join(input.chunksPath, chunk.fileName);
      yield* effectIo("pull", "Could not inspect a v2 chunk", () =>
        assertRegularFile(input.mirrorPath, filePath),
      );
      const digest = yield* effectIoPromise("pull", "Could not hash a v2 chunk", () =>
        hashFile(filePath),
      );
      if (digest.sha256 !== chunk.sha256 || digest.size !== chunk.sizeBytes) {
        return yield* Effect.fail(
          repositoryV2Error(
            "pull",
            "integrity-failed",
            `V2 chunk '${chunk.fileName}' failed size or SHA-256 verification.`,
          ),
        );
      }
      nextRowOrdinal = chunk.lastRowOrdinal + 1;
      lastRecordOrdinal = chunk.lastRecordOrdinal;
    }
    return nextRowOrdinal;
  });
}

function checkpointChunkFilesPresent(input: {
  readonly mirrorPath: string;
  readonly chunksPath: string;
  readonly chunks: ReadonlyArray<ThreadSyncV2ChunkDescriptor>;
}): boolean {
  for (const chunk of input.chunks) {
    try {
      assertRegularFile(input.mirrorPath, NodePath.join(input.chunksPath, chunk.fileName));
    } catch (cause) {
      if (
        typeof cause === "object" &&
        cause !== null &&
        "code" in cause &&
        cause.code === "ENOENT"
      ) {
        return false;
      }
      throw cause;
    }
  }
  return true;
}

export interface ThreadSyncV2ThreadWriteResult {
  readonly manifest: ThreadSyncV2ThreadManifest;
  /** Path relative to the v2 threads directory, always slash-normalized. */
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly resumedAtOrdinal: number;
}

/**
 * Computes the exact logical revision that the writer will publish without
 * building a thread snapshot or touching the repository checkout.
 */
export function computeThreadSyncV2SourceRevision<E, R>(
  source: ThreadSyncV2ThreadSource<E, R>,
): Effect.Effect<ThreadSyncRevision, E | ThreadSyncError, R> {
  return Effect.gen(function* () {
    const encodedHeader = yield* Effect.try({
      try: () => encodeHeader(source.header),
      catch: (cause) =>
        repositoryV2Error("push", "invalid-snapshot", `The v2 header is invalid: ${String(cause)}`),
    });
    const hash = NodeCrypto.createHash("sha256");
    hash.update("erebus-thread-sync-v2\n");
    hash.update(compactJsonLine(encodedHeader));
    let nextRecordOrdinal = 0;
    let nextRowOrdinal = 0;
    yield* StreamRuntime.runForEach(source.records(null), ({ record, nextResumeToken }) =>
      Effect.gen(function* () {
        if (record.ordinal !== nextRecordOrdinal || nextResumeToken.length === 0) {
          return yield* Effect.fail(
            repositoryV2Error(
              "push",
              "invalid-snapshot",
              "The v2 source emitted a duplicate, skipped, or uncheckpointable record.",
            ),
          );
        }
        const rows = yield* Effect.try({
          try: () => storedRowsForRecord(record, nextRowOrdinal),
          catch: (cause) =>
            repositoryV2Error(
              "push",
              "invalid-snapshot",
              `A v2 history record is invalid: ${String(cause)}`,
            ),
        });
        for (const row of rows) {
          const line = compactJsonLine(encodeStoredRow(row));
          if (Buffer.byteLength(line, "utf8") > THREAD_SYNC_V2_MAX_STORED_ROW_BYTES) {
            return yield* Effect.fail(
              repositoryV2Error(
                "push",
                "invalid-snapshot",
                "A fragmented v2 storage row still exceeds the hard row limit.",
              ),
            );
          }
          hash.update(line);
          nextRowOrdinal += 1;
        }
        nextRecordOrdinal += 1;
      }),
    );
    return hash.digest("hex") as ThreadSyncRevision;
  });
}

export function writeThreadSyncV2Thread<E, R>(input: {
  readonly mirrorPath: string;
  readonly source: ThreadSyncV2ThreadSource<E, R>;
  readonly targetChunkBytes?: number;
}): Effect.Effect<ThreadSyncV2ThreadWriteResult, E | ThreadSyncError, R> {
  return Effect.gen(function* () {
    const targetChunkBytes = input.targetChunkBytes ?? THREAD_SYNC_V2_DEFAULT_CHUNK_BYTES;
    if (
      !Number.isSafeInteger(targetChunkBytes) ||
      targetChunkBytes < 1 ||
      targetChunkBytes > THREAD_SYNC_V2_MAX_CHUNK_BYTES
    ) {
      return yield* Effect.fail(
        repositoryV2Error(
          "push",
          "invalid-snapshot",
          "The v2 chunk target is outside the supported bounded range.",
        ),
      );
    }

    const sourceKeyHash = threadSyncV2Sha256(input.source.sourceKey);
    const encodedHeader = yield* Effect.try({
      try: () => encodeHeader(input.source.header),
      catch: (cause) =>
        repositoryV2Error("push", "invalid-snapshot", `The v2 header is invalid: ${String(cause)}`),
    });
    const headerLine = compactJsonLine(encodedHeader);
    const headerHash = threadSyncV2Sha256(headerLine);
    const threadDirectory = threadSyncV2ThreadDirectory(input.source.header.threadId);
    const threadPath = yield* effectIo("push", "Could not prepare a v2 thread directory", () =>
      ensureManagedDirectory(input.mirrorPath, [
        ".erebus-thread-sync",
        "v2",
        "threads",
        threadDirectory,
      ]),
    );
    const chunksPath = yield* effectIo("push", "Could not prepare the v2 chunk directory", () =>
      ensureManagedDirectory(input.mirrorPath, [".erebus-thread-sync", "v2", "chunks"]),
    );
    const workPath = yield* effectIo("push", "Could not prepare the v2 checkpoint directory", () =>
      ensureManagedDirectory(input.mirrorPath, [
        ".erebus-thread-sync-work",
        "v2",
        threadDirectory,
        sourceKeyHash,
      ]),
    );

    const checkpointPath = NodePath.join(workPath, "checkpoint.json");
    let checkpoint = yield* effectIo("push", "Could not read the v2 export checkpoint", () => {
      try {
        assertRegularFile(input.mirrorPath, checkpointPath);
        return decodeCheckpoint(readBoundedJson(checkpointPath));
      } catch (cause) {
        if (
          typeof cause === "object" &&
          cause !== null &&
          "code" in cause &&
          cause.code === "ENOENT"
        ) {
          return null;
        }
        throw cause;
      }
    });
    if (
      checkpoint !== null &&
      (checkpoint.sourceKeyHash !== sourceKeyHash || checkpoint.headerHash !== headerHash)
    ) {
      return yield* Effect.fail(
        repositoryV2Error(
          "push",
          "integrity-failed",
          "A v2 checkpoint does not match the requested source generation.",
        ),
      );
    }

    // Checkpoints written before attachment reachability was persisted cannot
    // safely resume halfway through a thread: doing so would omit blob hashes
    // from the final manifest and could collect live attachments. Restart the
    // replayable source while retaining content-addressed chunks for reuse.
    if (
      checkpoint !== null &&
      checkpoint.nextRecordOrdinal > 0 &&
      checkpoint.blobHashes === undefined
    ) {
      checkpoint = null;
    }

    if (checkpoint !== null) {
      const checkpointPayloadPresent = yield* effectIo(
        "push",
        "Could not inspect the v2 export checkpoint payload",
        () =>
          checkpointChunkFilesPresent({
            mirrorPath: input.mirrorPath,
            chunksPath,
            chunks: checkpoint!.chunks,
          }),
      );
      if (!checkpointPayloadPresent) {
        // A failed optimistic Git push restores the fetched checkout and can
        // remove unpublished content-addressed chunks while intentionally
        // retaining the local work checkpoint. The source is replayable, so
        // restart this generation instead of trapping every later retry on a
        // checkpoint that can no longer be resumed. Existing chunks that are
        // still present remain protected by their SHA-256 address below.
        checkpoint = null;
      }
    }

    const chunks = checkpoint === null ? [] : [...checkpoint.chunks];
    const verifiedRowOrdinal = yield* validateChunkDescriptors({
      mirrorPath: input.mirrorPath,
      chunksPath,
      chunks,
    }).pipe(Effect.mapError((error) => new ThreadSyncError({ ...error, operation: "push" })));
    let nextRecordOrdinal = checkpoint?.nextRecordOrdinal ?? 0;
    let nextRowOrdinal = checkpoint?.nextRowOrdinal ?? 0;
    if (
      verifiedRowOrdinal !== nextRowOrdinal ||
      nextRecordOrdinal > nextRowOrdinal ||
      (chunks.length === 0
        ? nextRecordOrdinal !== 0
        : chunks.at(-1)?.lastRecordOrdinal !== nextRecordOrdinal - 1)
    ) {
      return yield* Effect.fail(
        repositoryV2Error(
          "push",
          "integrity-failed",
          "A v2 checkpoint has inconsistent record or row ordinals.",
        ),
      );
    }
    const resumedAtOrdinal = nextRecordOrdinal;
    const referencedBlobHashes = new Set(checkpoint?.blobHashes ?? []);
    let nextResumeToken = checkpoint?.nextResumeToken ?? null;
    let currentHandle: NodeFSP.FileHandle | null = null;
    let currentTemporaryPath: string | null = null;
    let currentSize = 0;
    let currentCount = 0;
    let currentFirstRowOrdinal = nextRowOrdinal;
    let currentFirstRecordOrdinal = nextRecordOrdinal;
    let currentLastRecordOrdinal = nextRecordOrdinal;
    let checkpointNeeded = false;

    const saveCheckpoint = () =>
      effectIo("push", "Could not save the v2 export checkpoint", () => {
        if (currentHandle !== null || currentCount !== 0) {
          throw new Error("A v2 checkpoint cannot include an unpublished partial chunk.");
        }
        const value: ThreadSyncV2Checkpoint = {
          formatVersion: THREAD_SYNC_V2_FORMAT_VERSION,
          sourceKeyHash,
          headerHash,
          nextResumeToken,
          nextRecordOrdinal,
          nextRowOrdinal,
          chunks,
          blobHashes: [...referencedBlobHashes].toSorted(),
        };
        writeUtf8Atomically(input.mirrorPath, checkpointPath, canonicalThreadSyncJson(value));
        checkpointNeeded = false;
      });

    const openChunk = () =>
      Effect.gen(function* () {
        const temporaryPath = NodePath.join(
          workPath,
          `chunk-${String(chunks.length).padStart(8, "0")}.partial`,
        );
        yield* effectIoPromise("push", "Could not reset a v2 partial chunk", async () => {
          try {
            assertRegularFile(input.mirrorPath, temporaryPath);
            await NodeFSP.unlink(temporaryPath);
          } catch (cause) {
            if (
              !(
                typeof cause === "object" &&
                cause !== null &&
                "code" in cause &&
                cause.code === "ENOENT"
              )
            ) {
              throw cause;
            }
          }
        });
        currentHandle = yield* effectIoPromise("push", "Could not open a v2 chunk", () =>
          NodeFSP.open(temporaryPath, "wx"),
        );
        currentTemporaryPath = temporaryPath;
        currentSize = 0;
        currentCount = 0;
        currentFirstRowOrdinal = nextRowOrdinal;
        currentFirstRecordOrdinal = nextRecordOrdinal;
        currentLastRecordOrdinal = nextRecordOrdinal;
      });

    const finalizeChunk = () =>
      Effect.gen(function* () {
        if (currentHandle === null || currentTemporaryPath === null || currentCount === 0) return;
        const handle = currentHandle;
        const temporaryPath = currentTemporaryPath;
        yield* effectIoPromise("push", "Could not flush a v2 chunk", async () => {
          await handle.sync();
          await handle.close();
        });
        currentHandle = null;
        currentTemporaryPath = null;
        const digest = yield* effectIoPromise("push", "Could not hash a v2 chunk", () =>
          hashFile(temporaryPath),
        );
        const fileName = `${digest.sha256}.ndjson`;
        const finalPath = NodePath.join(chunksPath, fileName);
        yield* effectIoPromise("push", "Could not publish a v2 chunk", async () => {
          try {
            assertRegularFile(input.mirrorPath, finalPath);
            const existing = await hashFile(finalPath);
            if (existing.sha256 !== digest.sha256 || existing.size !== digest.size) {
              throw new Error("An existing v2 chunk does not match its content address.");
            }
            await NodeFSP.unlink(temporaryPath);
          } catch (cause) {
            if (
              typeof cause === "object" &&
              cause !== null &&
              "code" in cause &&
              cause.code === "ENOENT"
            ) {
              await NodeFSP.rename(temporaryPath, finalPath);
            } else {
              throw cause;
            }
          }
        });
        chunks.push({
          fileName,
          sha256: digest.sha256,
          sizeBytes: digest.size,
          rowCount: currentCount,
          firstRowOrdinal: currentFirstRowOrdinal,
          lastRowOrdinal: nextRowOrdinal - 1,
          firstRecordOrdinal: currentFirstRecordOrdinal,
          lastRecordOrdinal: currentLastRecordOrdinal,
        });
        checkpointNeeded = true;
        currentSize = 0;
        currentCount = 0;
      });

    const consume = StreamRuntime.runForEach(
      input.source.records(nextResumeToken),
      ({ record, nextResumeToken: itemResumeToken }) =>
        Effect.gen(function* () {
          if (record.ordinal !== nextRecordOrdinal || itemResumeToken.length === 0) {
            return yield* Effect.fail(
              repositoryV2Error(
                "push",
                "invalid-snapshot",
                "The v2 source emitted a duplicate, skipped, or uncheckpointable record.",
              ),
            );
          }
          if (record.kind === "message") {
            for (const attachment of record.value.attachments) {
              referencedBlobHashes.add(attachment.blobHash);
            }
          }
          const rows = yield* Effect.try({
            try: () => storedRowsForRecord(record, nextRowOrdinal),
            catch: (cause) =>
              repositoryV2Error(
                "push",
                "invalid-snapshot",
                `A v2 history record is invalid: ${String(cause)}`,
              ),
          });
          for (const row of rows) {
            const line = compactJsonLine(encodeStoredRow(row));
            const bytes = Buffer.from(line, "utf8");
            if (bytes.byteLength > THREAD_SYNC_V2_MAX_STORED_ROW_BYTES) {
              return yield* Effect.fail(
                repositoryV2Error(
                  "push",
                  "invalid-snapshot",
                  "A fragmented v2 storage row still exceeds the hard row limit.",
                ),
              );
            }
            if (currentCount > 0 && currentSize + bytes.byteLength > targetChunkBytes) {
              yield* finalizeChunk();
            }
            if (currentHandle === null) yield* openChunk();
            currentLastRecordOrdinal = record.ordinal;
            yield* effectIoPromise("push", "Could not append a v2 history row", async () => {
              await currentHandle!.writeFile(bytes);
            });
            currentSize += bytes.byteLength;
            currentCount += 1;
            nextRowOrdinal += 1;
            if (currentSize >= targetChunkBytes) yield* finalizeChunk();
          }
          nextRecordOrdinal += 1;
          nextResumeToken = itemResumeToken;

          // A generic record may span several chunks. Publish its final tail
          // before advancing the durable source token so a retry never starts
          // halfway through one logical record.
          if (rows.length > 1 && currentHandle !== null) yield* finalizeChunk();
          if (checkpointNeeded && currentHandle === null) yield* saveCheckpoint();
        }),
    );
    yield* consume.pipe(
      Effect.onError(() =>
        Effect.suspend(() => {
          if (currentHandle === null) return Effect.void;
          const handle = currentHandle;
          currentHandle = null;
          return Effect.promise(() => handle.close()).pipe(Effect.ignore);
        }),
      ),
    );
    yield* finalizeChunk();
    if (checkpointNeeded || checkpoint === null) yield* saveCheckpoint();

    // Every descriptor is content-addressed and was verified while it was
    // finalized (or while a checkpoint was resumed). Deriving the revision
    // from those descriptors avoids rereading the whole history after export.
    const revision = threadSyncV2ManifestRevision({
      header: input.source.header,
      recordCount: nextRecordOrdinal,
      rowCount: nextRowOrdinal,
      chunks,
      blobHashes: [...referencedBlobHashes].toSorted(),
    });
    const manifest: ThreadSyncV2ThreadManifest = {
      formatVersion: THREAD_SYNC_V2_FORMAT_VERSION,
      kind: "erebus-thread-sync-thread",
      sourceKeyHash,
      revision,
      header: input.source.header,
      recordCount: nextRecordOrdinal,
      rowCount: nextRowOrdinal,
      chunks,
      blobHashes: [...referencedBlobHashes].toSorted(),
    };
    const manifestContents = canonicalThreadSyncJson(manifest);
    const manifestSha256 = threadSyncV2Sha256(manifestContents);
    const manifestPath = `${threadDirectory}/${manifestSha256}.json`;
    const manifestFilePath = NodePath.join(threadPath, `${manifestSha256}.json`);
    yield* effectIo("push", "Could not publish the v2 thread manifest", () =>
      writeUtf8Atomically(input.mirrorPath, manifestFilePath, manifestContents),
    );
    yield* effectIoPromise("push", "Could not prune stale v2 export checkpoints", () =>
      pruneThreadSyncV2WorkGenerations({
        mirrorPath: input.mirrorPath,
        threadWorkPath: NodePath.dirname(workPath),
        keepSourceKeyHash: sourceKeyHash,
      }),
    );
    return {
      manifest,
      manifestPath,
      manifestSha256,
      resumedAtOrdinal,
    };
  });
}

export interface ThreadSyncV2BlobWriteResult {
  readonly entry: ThreadSyncV2BlobEntry;
  readonly resumedAtOffset: number;
}

/** Streams one content-addressed blob, resuming only from a verified regular partial file. */
export function writeThreadSyncV2Blob<E, R>(input: {
  readonly mirrorPath: string;
  readonly source: ThreadSyncV2BlobSource<E, R>;
}): Effect.Effect<ThreadSyncV2BlobWriteResult, E | ThreadSyncError, R> {
  return Effect.gen(function* () {
    const { sha256, sizeBytes } = input.source;
    if (
      !/^[a-f0-9]{64}$/.test(sha256) ||
      !Number.isSafeInteger(sizeBytes) ||
      sizeBytes < 0 ||
      sizeBytes > MAX_BLOB_BYTES
    ) {
      return yield* Effect.fail(
        repositoryV2Error("push", "invalid-snapshot", "A v2 blob descriptor is invalid."),
      );
    }
    const blobsPath = yield* effectIo("push", "Could not prepare the v2 blob directory", () =>
      ensureManagedDirectory(input.mirrorPath, [".erebus-thread-sync", "v2", "blobs"]),
    );
    const workPath = yield* effectIo("push", "Could not prepare the v2 blob work directory", () =>
      ensureManagedDirectory(input.mirrorPath, [".erebus-thread-sync-work", "v2", "blobs"]),
    );
    const finalPath = NodePath.join(blobsPath, `${sha256}.blob`);
    const existing = yield* effectIoPromise(
      "push",
      "Could not inspect an existing v2 blob",
      async () => {
        try {
          const info = assertRegularFile(input.mirrorPath, finalPath);
          const digest = await hashFile(finalPath);
          if (info.size !== sizeBytes || digest.size !== sizeBytes || digest.sha256 !== sha256) {
            throw new Error("An existing v2 blob does not match its content address.");
          }
          return true;
        } catch (cause) {
          if (
            typeof cause === "object" &&
            cause !== null &&
            "code" in cause &&
            cause.code === "ENOENT"
          ) {
            return false;
          }
          throw cause;
        }
      },
    );
    if (existing) {
      return { entry: { sha256, sizeBytes }, resumedAtOffset: sizeBytes };
    }

    const partialPath = NodePath.join(workPath, `${sha256}.partial`);
    const partial = yield* effectIo("push", "Could not inspect a partial v2 blob", () => {
      try {
        const info = assertRegularFile(input.mirrorPath, partialPath);
        if (!Number.isSafeInteger(info.size) || info.size > sizeBytes) {
          throw new Error("A partial v2 blob exceeds its declared size.");
        }
        return { exists: true, offset: info.size } as const;
      } catch (cause) {
        if (
          typeof cause === "object" &&
          cause !== null &&
          "code" in cause &&
          cause.code === "ENOENT"
        ) {
          return { exists: false, offset: 0 } as const;
        }
        throw cause;
      }
    });
    const offset = partial.offset;
    const handle = yield* effectIoPromise("push", "Could not open a partial v2 blob", () =>
      NodeFSP.open(partialPath, partial.exists ? "a" : "wx"),
    );
    let written = offset;
    const append = StreamRuntime.runForEach(input.source.bytes(offset), (bytes) =>
      Effect.gen(function* () {
        if (!(bytes instanceof Uint8Array)) {
          return yield* Effect.fail(
            repositoryV2Error("push", "invalid-snapshot", "A v2 blob source emitted non-bytes."),
          );
        }
        if (bytes.byteLength === 0) return;
        if (written > sizeBytes - bytes.byteLength) {
          return yield* Effect.fail(
            repositoryV2Error(
              "push",
              "invalid-snapshot",
              "A v2 blob source emitted more bytes than declared.",
            ),
          );
        }
        yield* effectIoPromise("push", "Could not append a partial v2 blob", () =>
          handle.writeFile(bytes),
        );
        written += bytes.byteLength;
      }),
    );
    yield* append.pipe(
      Effect.onError(() => Effect.promise(() => handle.close()).pipe(Effect.ignore)),
    );
    yield* effectIoPromise("push", "Could not flush a partial v2 blob", async () => {
      await handle.sync();
      await handle.close();
    });
    if (written !== sizeBytes) {
      return yield* Effect.fail(
        repositoryV2Error(
          "push",
          "invalid-snapshot",
          "A v2 blob source ended before its declared size.",
        ),
      );
    }
    const digest = yield* effectIoPromise("push", "Could not hash a completed v2 blob", () =>
      hashFile(partialPath),
    );
    if (digest.size !== sizeBytes || digest.sha256 !== sha256) {
      return yield* Effect.fail(
        repositoryV2Error(
          "push",
          "integrity-failed",
          "A completed v2 blob failed size or SHA-256 verification.",
        ),
      );
    }
    yield* effectIoPromise("push", "Could not publish a v2 blob", async () => {
      try {
        assertRegularFile(input.mirrorPath, finalPath);
        const finalDigest = await hashFile(finalPath);
        if (finalDigest.size !== sizeBytes || finalDigest.sha256 !== sha256) {
          throw new Error("A concurrent v2 blob does not match its content address.");
        }
        await NodeFSP.unlink(partialPath);
      } catch (cause) {
        if (
          typeof cause === "object" &&
          cause !== null &&
          "code" in cause &&
          cause.code === "ENOENT"
        ) {
          await NodeFSP.rename(partialPath, finalPath);
        } else {
          throw cause;
        }
      }
    });
    return { entry: { sha256, sizeBytes }, resumedAtOffset: offset };
  });
}

export interface ThreadSyncV2RepositoryWriteResult {
  readonly manifest: ThreadSyncV2RepositoryManifest;
  readonly threadResults: ReadonlyMap<ThreadId, ThreadSyncV2ThreadWriteResult>;
  /** Tracked sparse payloads that are no longer reachable from the final manifests. */
  readonly removedPayloadPaths: ReadonlyArray<string>;
}

function reconcileFlatManagedDirectory(input: {
  readonly mirrorPath: string;
  readonly directoryPath: string;
  readonly desiredNames: ReadonlySet<string>;
  readonly pattern: RegExp;
  readonly validateDesired?: (fileName: string, filePath: string) => Promise<void>;
}): Promise<void> {
  return (async () => {
    const names = await NodeFSP.readdir(input.directoryPath);
    if (names.length > MAX_CHUNKS_PER_THREAD + MAX_MANAGED_ENTRY_COUNT) {
      throw new Error("A managed v2 directory contains too many entries.");
    }
    for (const name of names) {
      if (!input.pattern.test(name)) {
        throw new Error(`Unexpected entry in a managed v2 directory: ${name}`);
      }
      const filePath = NodePath.join(input.directoryPath, name);
      assertRegularFile(input.mirrorPath, filePath);
      if (!input.desiredNames.has(name)) {
        await NodeFSP.unlink(filePath);
      } else if (input.validateDesired !== undefined) {
        await input.validateDesired(name, filePath);
      }
    }
  })();
}

async function pruneThreadSyncV2WorkGenerations(input: {
  readonly mirrorPath: string;
  readonly threadWorkPath: string;
  readonly keepSourceKeyHash: string;
}): Promise<void> {
  const realMirror = NodeFS.realpathSync(input.mirrorPath);
  const workInfo = NodeFS.lstatSync(input.threadWorkPath);
  if (!workInfo.isDirectory() || workInfo.isSymbolicLink()) {
    throw new Error("A managed v2 thread work path is a link or non-directory.");
  }
  const realWorkPath = NodeFS.realpathSync(input.threadWorkPath);
  if (!isInside(realMirror, realWorkPath)) {
    throw new Error("A managed v2 thread work path escapes its mirror.");
  }

  const names = (await NodeFSP.readdir(input.threadWorkPath)).toSorted();
  if (names.length > MAX_WORK_DIRECTORY_ENTRIES) {
    throw new Error("A managed v2 thread work path contains too many entries.");
  }

  const isDisposableWorkFile = (fileName: string) =>
    /^chunk-[0-9]{8}\.partial$/.test(fileName) ||
    /^\.checkpoint\.json\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/.test(
      fileName,
    );
  const currentGenerationPath = NodePath.join(input.threadWorkPath, input.keepSourceKeyHash);
  const currentInfo = NodeFS.lstatSync(currentGenerationPath);
  if (!currentInfo.isDirectory() || currentInfo.isSymbolicLink()) {
    throw new Error("The current v2 thread work generation is a link or non-directory.");
  }
  const realCurrentGenerationPath = NodeFS.realpathSync(currentGenerationPath);
  if (!isInside(realWorkPath, realCurrentGenerationPath)) {
    throw new Error("The current v2 thread work generation escapes its thread directory.");
  }
  const currentFiles = (await NodeFSP.readdir(currentGenerationPath)).toSorted();
  if (currentFiles.length > MAX_WORK_FILES_PER_GENERATION) {
    throw new Error("The current v2 thread work generation contains too many files.");
  }
  if (!currentFiles.includes("checkpoint.json")) {
    throw new Error("The current v2 thread work generation has no resumable checkpoint.");
  }
  for (const fileName of currentFiles) {
    if (fileName !== "checkpoint.json" && !isDisposableWorkFile(fileName)) {
      throw new Error("The current v2 thread work generation contains an unexpected file.");
    }
    const filePath = NodePath.join(currentGenerationPath, fileName);
    assertRegularFile(input.mirrorPath, filePath);
    if (fileName !== "checkpoint.json") await NodeFSP.unlink(filePath);
  }
  const staleNames = names
    .filter((name) => name !== input.keepSourceKeyHash)
    .slice(0, MAX_WORK_GENERATIONS_REMOVED_PER_EXPORT);
  for (const name of staleNames) {
    if (!/^[a-f0-9]{64}$/.test(name)) {
      throw new Error("A managed v2 thread work generation has an invalid name.");
    }
    const generationPath = NodePath.join(input.threadWorkPath, name);
    const generationInfo = NodeFS.lstatSync(generationPath);
    if (!generationInfo.isDirectory() || generationInfo.isSymbolicLink()) {
      throw new Error("A managed v2 thread work generation is a link or non-directory.");
    }
    const realGenerationPath = NodeFS.realpathSync(generationPath);
    if (!isInside(realWorkPath, realGenerationPath)) {
      throw new Error("A managed v2 thread work generation escapes its thread directory.");
    }
    const files = (await NodeFSP.readdir(generationPath)).toSorted();
    if (files.length > MAX_WORK_FILES_PER_GENERATION) {
      throw new Error("A managed v2 thread work generation contains too many files.");
    }
    for (const fileName of files) {
      if (fileName !== "checkpoint.json" && !isDisposableWorkFile(fileName)) {
        throw new Error("A managed v2 thread work generation contains an unexpected file.");
      }
      const filePath = NodePath.join(generationPath, fileName);
      assertRegularFile(input.mirrorPath, filePath);
      await NodeFSP.unlink(filePath);
    }
    await NodeFSP.rmdir(generationPath);
  }
}

async function pruneThreadSyncV2OrphanBlobPartials(mirrorPath: string): Promise<void> {
  const blobsWorkPath = NodePath.join(mirrorPath, THREAD_SYNC_V2_WORK_DIRECTORY, "blobs");
  let names: string[];
  try {
    const info = NodeFS.lstatSync(blobsWorkPath);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("The managed v2 blob work path is a link or non-directory.");
    }
    const realMirror = NodeFS.realpathSync(mirrorPath);
    if (!isInside(realMirror, NodeFS.realpathSync(blobsWorkPath))) {
      throw new Error("The managed v2 blob work path escapes its mirror.");
    }
    names = (await NodeFSP.readdir(blobsWorkPath)).toSorted();
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") {
      return;
    }
    throw cause;
  }
  if (names.length > MAX_WORK_DIRECTORY_ENTRIES) {
    throw new Error("The managed v2 blob work path contains too many entries.");
  }
  for (const fileName of names.slice(0, MAX_ORPHAN_BLOB_PARTIALS_REMOVED_PER_EXPORT)) {
    if (!/^[a-f0-9]{64}\.partial$/.test(fileName)) {
      throw new Error("The managed v2 blob work path contains an unexpected file.");
    }
    const filePath = NodePath.join(blobsWorkPath, fileName);
    assertRegularFile(mirrorPath, filePath);
    await NodeFSP.unlink(filePath);
  }
}

/** Writes a complete v2 repository while keeping bodies and blobs bounded and resumable. */
export function writeThreadSyncV2Repository<E, R>(input: {
  readonly mirrorPath: string;
  readonly source: ThreadSyncV2RepositorySource<E, R>;
  readonly targetChunkBytes?: number;
}): Effect.Effect<ThreadSyncV2RepositoryWriteResult, E | ThreadSyncError, R> {
  return Effect.gen(function* () {
    const projects = [...input.source.projects.entries()].toSorted(([left], [right]) =>
      left.localeCompare(right),
    );
    const threads = [...input.source.threads].toSorted((left, right) =>
      left.header.threadId.localeCompare(right.header.threadId),
    );
    const blobs = [...input.source.blobs].toSorted((left, right) =>
      left.sha256.localeCompare(right.sha256),
    );
    const retainedThreads = [...(input.source.retainedThreads ?? [])].toSorted((left, right) =>
      left.threadId.localeCompare(right.threadId),
    );
    const retainedBlobs = [...(input.source.retainedBlobs ?? [])].toSorted((left, right) =>
      left.sha256.localeCompare(right.sha256),
    );
    const previousThreads = [...(input.source.previousThreads ?? [])].toSorted((left, right) =>
      left.threadId.localeCompare(right.threadId),
    );
    if (
      projects.length + threads.length + retainedThreads.length > MAX_MANAGED_ENTRY_COUNT ||
      blobs.length + retainedBlobs.length > MAX_MANAGED_ENTRY_COUNT ||
      previousThreads.length > MAX_MANAGED_ENTRY_COUNT
    ) {
      return yield* Effect.fail(
        repositoryV2Error("push", "invalid-snapshot", "A v2 repository has too many entries."),
      );
    }

    const projectIds = new Set<ThreadSyncProjectId>();
    const threadIds = new Set<ThreadId>();
    const blobHashes = new Set<string>();
    let totalBlobBytes = 0;
    for (const [id, project] of projects) {
      if (id !== project.syncProjectId || projectIds.has(id)) {
        return yield* Effect.fail(
          repositoryV2Error(
            "push",
            "invalid-snapshot",
            "A v2 project key is invalid or duplicated.",
          ),
        );
      }
      projectIds.add(id);
    }
    for (const entry of retainedThreads) {
      if (threadIds.has(entry.threadId) || !projectIds.has(entry.syncProjectId)) {
        return yield* Effect.fail(
          repositoryV2Error(
            "push",
            "invalid-snapshot",
            "A retained v2 thread is duplicated or references a missing project.",
          ),
        );
      }
      threadIds.add(entry.threadId);
    }
    for (const source of threads) {
      if (threadIds.has(source.header.threadId) || !projectIds.has(source.header.syncProjectId)) {
        return yield* Effect.fail(
          repositoryV2Error(
            "push",
            "invalid-snapshot",
            "A v2 thread is duplicated or references a missing project.",
          ),
        );
      }
      threadIds.add(source.header.threadId);
    }
    for (const entry of retainedBlobs) {
      if (
        blobHashes.has(entry.sha256) ||
        entry.sizeBytes > MAX_BLOB_BYTES ||
        totalBlobBytes > MAX_TOTAL_BLOB_BYTES - entry.sizeBytes
      ) {
        return yield* Effect.fail(
          repositoryV2Error("push", "invalid-snapshot", "A retained v2 blob index is invalid."),
        );
      }
      blobHashes.add(entry.sha256);
      totalBlobBytes += entry.sizeBytes;
    }
    for (const source of blobs) {
      if (
        blobHashes.has(source.sha256) ||
        !/^[a-f0-9]{64}$/.test(source.sha256) ||
        !Number.isSafeInteger(source.sizeBytes) ||
        source.sizeBytes < 0 ||
        source.sizeBytes > MAX_BLOB_BYTES ||
        totalBlobBytes > MAX_TOTAL_BLOB_BYTES - source.sizeBytes
      ) {
        return yield* Effect.fail(
          repositoryV2Error("push", "invalid-snapshot", "A v2 blob index is invalid."),
        );
      }
      blobHashes.add(source.sha256);
      totalBlobBytes += source.sizeBytes;
    }

    const namespacePath = yield* effectIo("push", "Could not prepare the v2 namespace", () =>
      ensureManagedDirectory(input.mirrorPath, [".erebus-thread-sync", "v2"]),
    );
    const projectsPath = yield* effectIo("push", "Could not prepare the v2 projects", () =>
      ensureManagedDirectory(input.mirrorPath, [".erebus-thread-sync", "v2", "projects"]),
    );
    const threadsPath = yield* effectIo("push", "Could not prepare the v2 threads", () =>
      ensureManagedDirectory(input.mirrorPath, [".erebus-thread-sync", "v2", "threads"]),
    );
    const chunksPath = yield* effectIo("push", "Could not prepare the v2 chunks", () =>
      ensureManagedDirectory(input.mirrorPath, [".erebus-thread-sync", "v2", "chunks"]),
    );
    const blobsPath = yield* effectIo("push", "Could not prepare the v2 blobs", () =>
      ensureManagedDirectory(input.mirrorPath, [".erebus-thread-sync", "v2", "blobs"]),
    );

    let totalProjectBytes = 0;
    const projectEntries: ThreadSyncV2ProjectEntry[] = [];
    for (const [syncProjectId, project] of projects) {
      const contents = canonicalThreadSyncJson(project);
      const size = Buffer.byteLength(contents, "utf8");
      totalProjectBytes += size;
      if (size > MAX_PROJECT_BYTES || totalProjectBytes > MAX_TOTAL_PROJECT_BYTES) {
        return yield* Effect.fail(
          repositoryV2Error("push", "invalid-snapshot", "V2 projects exceed document limits."),
        );
      }
      const fileName = threadSyncV2ProjectFileName(syncProjectId);
      yield* effectIo("push", "Could not publish a v2 project", () =>
        writeUtf8Atomically(input.mirrorPath, NodePath.join(projectsPath, fileName), contents),
      );
      projectEntries.push({
        syncProjectId,
        fileName,
        sha256: threadSyncV2Sha256(contents),
      });
    }

    const threadEntries: ThreadSyncV2ThreadEntry[] = [...retainedThreads];
    const threadResults = new Map<ThreadId, ThreadSyncV2ThreadWriteResult>();
    const desiredChunks = new Set<string>();
    const previousChunks = new Set<string>();
    const retainedChunkDescriptors = new Map<string, ThreadSyncV2ChunkDescriptor>();
    const referencedBlobHashes = new Set<string>();
    let hasCompleteBlobReachability = true;
    for (const entry of retainedThreads) {
      const retainedManifest = yield* effectIo(
        "push",
        "Could not preserve a retained v2 thread manifest",
        () => readThreadManifestEntry({ mirrorPath: input.mirrorPath, entry }),
      );
      for (const chunk of retainedManifest.chunks) {
        const prior = retainedChunkDescriptors.get(chunk.fileName);
        if (
          prior !== undefined &&
          (prior.sha256 !== chunk.sha256 || prior.sizeBytes !== chunk.sizeBytes)
        ) {
          return yield* Effect.fail(
            repositoryV2Error(
              "push",
              "integrity-failed",
              "Two retained v2 chunks share a path but not a descriptor.",
            ),
          );
        }
        retainedChunkDescriptors.set(chunk.fileName, chunk);
        desiredChunks.add(chunk.fileName);
      }
      if (retainedManifest.blobHashes === undefined) {
        hasCompleteBlobReachability = false;
      } else {
        for (const hash of retainedManifest.blobHashes) referencedBlobHashes.add(hash);
      }
    }
    const previousThreadIds = new Set<ThreadId>();
    for (const entry of previousThreads) {
      if (previousThreadIds.has(entry.threadId)) {
        return yield* Effect.fail(
          repositoryV2Error(
            "push",
            "invalid-snapshot",
            "The prior v2 thread index contains a duplicate thread.",
          ),
        );
      }
      previousThreadIds.add(entry.threadId);
      const previousManifest = yield* effectIo(
        "push",
        "Could not inspect a prior v2 thread manifest",
        () => readThreadManifestEntry({ mirrorPath: input.mirrorPath, entry }),
      );
      for (const chunk of previousManifest.chunks) previousChunks.add(chunk.fileName);
    }
    for (const source of threads) {
      const result = yield* writeThreadSyncV2Thread({
        mirrorPath: input.mirrorPath,
        source,
        ...(input.targetChunkBytes === undefined
          ? {}
          : { targetChunkBytes: input.targetChunkBytes }),
      });
      threadResults.set(source.header.threadId, result);
      for (const chunk of result.manifest.chunks) desiredChunks.add(chunk.fileName);
      for (const hash of result.manifest.blobHashes ?? []) referencedBlobHashes.add(hash);
      threadEntries.push({
        threadId: source.header.threadId,
        syncProjectId: source.header.syncProjectId,
        title: source.header.title,
        manifestPath: result.manifestPath,
        manifestSha256: result.manifestSha256,
        revision: result.manifest.revision,
        sourceKeyHash: result.manifest.sourceKeyHash,
      });
    }

    let blobEntries: ThreadSyncV2BlobEntry[] = [...retainedBlobs];
    for (const source of blobs) {
      const result = yield* writeThreadSyncV2Blob({ mirrorPath: input.mirrorPath, source });
      blobEntries.push(result.entry);
    }
    if (hasCompleteBlobReachability) {
      const available = new Set(blobEntries.map((entry) => entry.sha256));
      for (const hash of referencedBlobHashes) {
        if (!available.has(hash)) {
          return yield* Effect.fail(
            repositoryV2Error(
              "push",
              "integrity-failed",
              `A v2 thread references unavailable blob '${hash}'.`,
            ),
          );
        }
      }
      blobEntries = blobEntries.filter((entry) => referencedBlobHashes.has(entry.sha256));
    }
    const retainedBlobHashes = new Set(retainedBlobs.map((entry) => entry.sha256));
    const finalBlobHashes = new Set(blobEntries.map((entry) => entry.sha256));
    const removedPayloadPaths = [
      ...[...previousChunks]
        .filter((fileName) => !desiredChunks.has(fileName))
        .map((fileName) => `${THREAD_SYNC_V2_CHUNKS_DIRECTORY}/${fileName}`),
      ...retainedBlobs
        .filter((entry) => !finalBlobHashes.has(entry.sha256))
        .map((entry) => `${THREAD_SYNC_V2_BLOBS_DIRECTORY}/${entry.sha256}.blob`),
    ].toSorted();
    const retainedBlobEntries = new Map<string, ThreadSyncV2BlobEntry>(
      blobEntries
        .filter((entry) => retainedBlobHashes.has(entry.sha256))
        .map((entry) => [`${entry.sha256}.blob`, entry] as const),
    );
    const manifest: ThreadSyncV2RepositoryManifest = yield* Effect.try({
      try: () =>
        decodeRepositoryManifest({
          formatVersion: THREAD_SYNC_V2_FORMAT_VERSION,
          kind: "erebus-thread-sync",
          updatedAt: input.source.updatedAt,
          projects: projectEntries,
          threads: threadEntries,
          blobs: blobEntries,
        }),
      catch: (cause) =>
        repositoryV2Error(
          "push",
          "invalid-snapshot",
          `The v2 repository manifest is invalid: ${String(cause)}`,
        ),
    });
    const manifestContents = canonicalThreadSyncJson(manifest);
    if (Buffer.byteLength(manifestContents, "utf8") > MAX_MANIFEST_BYTES) {
      return yield* Effect.fail(
        repositoryV2Error("push", "invalid-snapshot", "The v2 repository manifest is too large."),
      );
    }
    yield* effectIo("push", "Could not publish the v2 repository manifest", () =>
      writeUtf8Atomically(
        input.mirrorPath,
        NodePath.join(namespacePath, "manifest.json"),
        manifestContents,
      ),
    );

    yield* effectIoPromise("push", "Could not reconcile v2 projects", () =>
      reconcileFlatManagedDirectory({
        mirrorPath: input.mirrorPath,
        directoryPath: projectsPath,
        desiredNames: new Set(projectEntries.map((entry) => entry.fileName)),
        pattern: /^[a-f0-9]{64}\.json$/,
      }),
    );
    yield* effectIoPromise("push", "Could not reconcile v2 chunks", () =>
      reconcileFlatManagedDirectory({
        mirrorPath: input.mirrorPath,
        directoryPath: chunksPath,
        desiredNames: desiredChunks,
        pattern: /^[a-f0-9]{64}\.ndjson$/,
        validateDesired: async (fileName, filePath) => {
          const descriptor = retainedChunkDescriptors.get(fileName);
          if (descriptor === undefined) return;
          const digest = await hashFile(filePath);
          if (digest.sha256 !== descriptor.sha256 || digest.size !== descriptor.sizeBytes) {
            throw new Error(`Retained v2 chunk '${fileName}' failed content verification.`);
          }
        },
      }),
    );
    yield* effectIoPromise("push", "Could not reconcile v2 blobs", () =>
      reconcileFlatManagedDirectory({
        mirrorPath: input.mirrorPath,
        directoryPath: blobsPath,
        desiredNames: new Set(blobEntries.map((entry) => `${entry.sha256}.blob`)),
        pattern: /^[a-f0-9]{64}\.blob$/,
        validateDesired: async (fileName, filePath) => {
          const descriptor = retainedBlobEntries.get(fileName);
          if (descriptor === undefined) return;
          const digest = await hashFile(filePath);
          if (digest.sha256 !== descriptor.sha256 || digest.size !== descriptor.sizeBytes) {
            throw new Error(`Retained v2 blob '${fileName}' failed content verification.`);
          }
        },
      }),
    );

    const desiredManifests = new Set(threadEntries.map((entry) => entry.manifestPath));
    yield* effectIoPromise("push", "Could not reconcile v2 thread manifests", async () => {
      for (const directoryName of await NodeFSP.readdir(threadsPath)) {
        if (!/^[a-f0-9]{64}$/.test(directoryName)) {
          throw new Error(`Unexpected v2 thread directory '${directoryName}'.`);
        }
        const directoryPath = NodePath.join(threadsPath, directoryName);
        const directoryInfo = NodeFS.lstatSync(directoryPath);
        if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
          throw new Error("A managed v2 thread path is not a regular directory.");
        }
        const realDirectory = NodeFS.realpathSync(directoryPath);
        if (!isInside(NodeFS.realpathSync(input.mirrorPath), realDirectory)) {
          throw new Error("A managed v2 thread directory escapes its mirror.");
        }
        for (const fileName of await NodeFSP.readdir(directoryPath)) {
          if (!/^[a-f0-9]{64}\.json$/.test(fileName)) {
            throw new Error(`Unexpected v2 thread manifest '${fileName}'.`);
          }
          const filePath = NodePath.join(directoryPath, fileName);
          assertRegularFile(input.mirrorPath, filePath);
          const relative = `${directoryName}/${fileName}`;
          if (!desiredManifests.has(relative)) await NodeFSP.unlink(filePath);
        }
        if ((await NodeFSP.readdir(directoryPath)).length === 0) await NodeFSP.rmdir(directoryPath);
      }
    });
    yield* effectIoPromise("push", "Could not prune orphaned v2 blob partials", () =>
      pruneThreadSyncV2OrphanBlobPartials(input.mirrorPath),
    );
    return { manifest, threadResults, removedPayloadPaths };
  });
}

export interface ThreadSyncV2RepositoryIndex {
  readonly manifest: ThreadSyncV2RepositoryManifest;
  readonly projects: ReadonlyMap<ThreadSyncProjectId, ThreadSyncProjectSnapshot>;
  readonly threads: ReadonlyMap<ThreadId, ThreadSyncV2ThreadEntry>;
  readonly blobs: ReadonlyMap<string, ThreadSyncV2BlobEntry>;
}

export interface ThreadSyncV2ThreadReader {
  readonly manifest: ThreadSyncV2ThreadManifest;
  readonly records: Stream.Stream<ThreadSyncV2Record, ThreadSyncError>;
  readonly recordsFromOrdinal: (
    nextOrdinal: number,
  ) => Stream.Stream<ThreadSyncV2Record, ThreadSyncError>;
}

function readThreadManifestEntry(input: {
  readonly mirrorPath: string;
  readonly entry: ThreadSyncV2ThreadEntry;
}): ThreadSyncV2ThreadManifest {
  const expectedManifestPath = `${threadSyncV2ThreadDirectory(input.entry.threadId)}/${input.entry.manifestSha256}.json`;
  if (input.entry.manifestPath !== expectedManifestPath) {
    throw new Error("A v2 thread manifest path does not match its content address.");
  }
  const manifestPath = NodePath.join(
    input.mirrorPath,
    THREAD_SYNC_V2_THREADS_DIRECTORY,
    ...input.entry.manifestPath.split("/"),
  );
  assertRegularFile(input.mirrorPath, manifestPath);
  const contents = readBoundedUtf8(manifestPath, MAX_MANIFEST_BYTES);
  if (threadSyncV2Sha256(contents) !== input.entry.manifestSha256) {
    throw new Error("A v2 thread manifest failed SHA-256 verification.");
  }
  const manifest = decodeThreadManifest(JSON.parse(contents));
  if (
    manifest.header.threadId !== input.entry.threadId ||
    manifest.header.syncProjectId !== input.entry.syncProjectId ||
    manifest.header.title !== input.entry.title ||
    manifest.revision !== input.entry.revision ||
    (input.entry.sourceKeyHash !== undefined &&
      manifest.sourceKeyHash !== input.entry.sourceKeyHash)
  ) {
    throw new Error("A v2 thread index entry does not match its manifest.");
  }
  if (manifest.chunks.length > MAX_CHUNKS_PER_THREAD || manifest.recordCount > manifest.rowCount) {
    throw new Error("A v2 thread manifest exceeds metadata limits.");
  }
  let nextRowOrdinal = 0;
  let lastRecordOrdinal: number | null = null;
  const chunkFiles = new Set<string>();
  for (const chunk of manifest.chunks) {
    if (
      chunk.firstRowOrdinal !== nextRowOrdinal ||
      chunk.lastRowOrdinal < chunk.firstRowOrdinal ||
      chunk.rowCount !== chunk.lastRowOrdinal - chunk.firstRowOrdinal + 1 ||
      chunk.sizeBytes > THREAD_SYNC_V2_MAX_CHUNK_BYTES ||
      chunk.firstRecordOrdinal > chunk.lastRecordOrdinal ||
      (lastRecordOrdinal === null
        ? chunk.firstRecordOrdinal !== 0
        : chunk.firstRecordOrdinal !== lastRecordOrdinal &&
          chunk.firstRecordOrdinal !== lastRecordOrdinal + 1) ||
      chunk.fileName !== `${chunk.sha256}.ndjson` ||
      chunkFiles.has(chunk.fileName)
    ) {
      throw new Error("A v2 thread manifest contains an invalid chunk sequence.");
    }
    chunkFiles.add(chunk.fileName);
    nextRowOrdinal = chunk.lastRowOrdinal + 1;
    lastRecordOrdinal = chunk.lastRecordOrdinal;
  }
  if (
    nextRowOrdinal !== manifest.rowCount ||
    (manifest.recordCount === 0
      ? manifest.chunks.length !== 0
      : lastRecordOrdinal !== manifest.recordCount - 1)
  ) {
    throw new Error("A v2 thread manifest has an inconsistent row count.");
  }
  if (
    manifest.revision !==
    threadSyncV2ManifestRevision({
      header: manifest.header,
      recordCount: manifest.recordCount,
      rowCount: manifest.rowCount,
      chunks: manifest.chunks,
      ...(manifest.blobHashes === undefined ? {} : { blobHashes: manifest.blobHashes }),
    })
  ) {
    throw new Error("A v2 thread manifest has an invalid descriptor revision.");
  }
  return manifest;
}

/** Reads and verifies the lightweight v2 repository index without thread bodies. */
export function readThreadSyncV2RepositoryIndex(
  mirrorPath: string,
): Effect.Effect<ThreadSyncV2RepositoryIndex | null, ThreadSyncError> {
  return Effect.gen(function* () {
    const manifestPath = NodePath.join(mirrorPath, THREAD_SYNC_V2_MANIFEST_PATH);
    const exists = yield* effectIo("pull", "Could not inspect the v2 repository manifest", () => {
      try {
        assertRegularFile(mirrorPath, manifestPath);
        return true;
      } catch (cause) {
        if (
          typeof cause === "object" &&
          cause !== null &&
          "code" in cause &&
          cause.code === "ENOENT"
        ) {
          return false;
        }
        throw cause;
      }
    });
    if (!exists) return null;

    const manifest = yield* Effect.try({
      try: () => decodeRepositoryManifest(readBoundedJson(manifestPath, MAX_MANIFEST_BYTES)),
      catch: (cause) =>
        repositoryV2Error(
          "pull",
          "invalid-snapshot",
          `The v2 repository manifest is invalid: ${String(cause)}`,
        ),
    });
    if (
      manifest.projects.length + manifest.threads.length > MAX_MANAGED_ENTRY_COUNT ||
      manifest.blobs.length > MAX_MANAGED_ENTRY_COUNT
    ) {
      return yield* Effect.fail(
        repositoryV2Error("pull", "integrity-failed", "The v2 repository has too many entries."),
      );
    }
    const projects = new Map<ThreadSyncProjectId, ThreadSyncProjectSnapshot>();
    const projectFiles = new Set<string>();
    let totalProjectBytes = 0;
    for (const entry of manifest.projects) {
      if (projects.has(entry.syncProjectId) || projectFiles.has(entry.fileName)) {
        return yield* Effect.fail(
          repositoryV2Error("pull", "integrity-failed", "The v2 project index is duplicated."),
        );
      }
      const projectPath = NodePath.join(
        mirrorPath,
        THREAD_SYNC_V2_PROJECTS_DIRECTORY,
        entry.fileName,
      );
      const contents = yield* effectIo("pull", "Could not read a v2 project", () => {
        assertRegularFile(mirrorPath, projectPath);
        const value = readBoundedUtf8(projectPath, MAX_PROJECT_BYTES);
        totalProjectBytes += Buffer.byteLength(value, "utf8");
        if (totalProjectBytes > MAX_TOTAL_PROJECT_BYTES) {
          throw new Error("The v2 repository exceeds the total project document limit.");
        }
        return value;
      });
      if (threadSyncV2Sha256(contents) !== entry.sha256) {
        return yield* Effect.fail(
          repositoryV2Error(
            "pull",
            "integrity-failed",
            `V2 project '${entry.syncProjectId}' failed SHA-256 verification.`,
          ),
        );
      }
      const project = yield* decodeProjectSnapshotJson(contents).pipe(
        Effect.mapError((cause) =>
          repositoryV2Error(
            "pull",
            "invalid-snapshot",
            `A v2 project is invalid: ${String(cause)}`,
          ),
        ),
      );
      if (
        project.syncProjectId !== entry.syncProjectId ||
        threadSyncV2ProjectFileName(project.syncProjectId) !== entry.fileName
      ) {
        return yield* Effect.fail(
          repositoryV2Error(
            "pull",
            "integrity-failed",
            "A v2 project file does not match its index entry.",
          ),
        );
      }
      projects.set(project.syncProjectId, project);
      projectFiles.add(entry.fileName);
    }

    const threads = new Map<ThreadId, ThreadSyncV2ThreadEntry>();
    const threadManifestPaths = new Set<string>();
    for (const entry of manifest.threads) {
      if (threads.has(entry.threadId) || threadManifestPaths.has(entry.manifestPath)) {
        return yield* Effect.fail(
          repositoryV2Error("pull", "integrity-failed", "The v2 thread index is duplicated."),
        );
      }
      if (!projects.has(entry.syncProjectId)) {
        return yield* Effect.fail(
          repositoryV2Error(
            "pull",
            "integrity-failed",
            `V2 thread '${entry.threadId}' references a missing project.`,
          ),
        );
      }
      yield* effectIo("pull", "Could not validate a v2 thread manifest", () =>
        readThreadManifestEntry({ mirrorPath, entry }),
      );
      threads.set(entry.threadId, entry);
      threadManifestPaths.add(entry.manifestPath);
    }

    const blobEntries = new Map<string, ThreadSyncV2BlobEntry>();
    let totalBlobBytes = 0;
    for (const blob of manifest.blobs) {
      if (
        blobEntries.has(blob.sha256) ||
        blob.sizeBytes > MAX_BLOB_BYTES ||
        totalBlobBytes > MAX_TOTAL_BLOB_BYTES - blob.sizeBytes
      ) {
        return yield* Effect.fail(
          repositoryV2Error("pull", "integrity-failed", "The v2 blob index is duplicated."),
        );
      }
      totalBlobBytes += blob.sizeBytes;
      blobEntries.set(blob.sha256, blob);
    }
    return { manifest, projects, threads, blobs: blobEntries };
  });
}

/** Opens one v2 thread as a verified, ordered record stream. */
export function readThreadSyncV2Thread(input: {
  readonly mirrorPath: string;
  readonly entry: ThreadSyncV2ThreadEntry;
}): Effect.Effect<ThreadSyncV2ThreadReader, ThreadSyncError> {
  return Effect.gen(function* () {
    const manifest = yield* effectIo("pull", "Could not read a v2 thread manifest", () =>
      readThreadManifestEntry(input),
    );
    const chunksPath = NodePath.join(input.mirrorPath, THREAD_SYNC_V2_CHUNKS_DIRECTORY);

    async function* iterateRecords(startOrdinal: number): AsyncGenerator<ThreadSyncV2Record> {
      if (
        !Number.isSafeInteger(startOrdinal) ||
        startOrdinal < 0 ||
        startOrdinal > manifest.recordCount
      ) {
        throw repositoryV2Error(
          "pull",
          "integrity-failed",
          "A v2 record resume ordinal is outside the manifest range.",
        );
      }
      if (startOrdinal === manifest.recordCount) {
        return;
      }

      const startChunkIndex = manifest.chunks.findIndex(
        (chunk) => chunk.lastRecordOrdinal >= startOrdinal,
      );
      const startChunk = manifest.chunks[startChunkIndex];
      if (startChunkIndex < 0 || startChunk === undefined) {
        throw repositoryV2Error(
          "pull",
          "integrity-failed",
          "A v2 record resume ordinal has no containing chunk.",
        );
      }

      let nextRecordOrdinal = startChunk.firstRecordOrdinal;
      let nextRowOrdinal = startChunk.firstRowOrdinal;
      let fragmentState: {
        readonly recordOrdinal: number;
        readonly fragmentCount: number;
        readonly sha256: string;
        readonly sizeBytes: number;
        readonly fragments: string[];
        readonly receivedBytes: number;
      } | null = null;
      const chunkFiles = new Set<string>();
      for (const chunk of manifest.chunks.slice(startChunkIndex)) {
        if (
          chunk.firstRowOrdinal !== nextRowOrdinal ||
          chunk.lastRowOrdinal < chunk.firstRowOrdinal ||
          chunk.rowCount !== chunk.lastRowOrdinal - chunk.firstRowOrdinal + 1 ||
          chunk.sizeBytes > THREAD_SYNC_V2_MAX_CHUNK_BYTES ||
          chunk.fileName !== `${chunk.sha256}.ndjson` ||
          chunkFiles.has(chunk.fileName)
        ) {
          throw repositoryV2Error(
            "pull",
            "integrity-failed",
            "A v2 chunk sequence is inconsistent.",
          );
        }
        chunkFiles.add(chunk.fileName);
        const chunkPath = NodePath.join(chunksPath, chunk.fileName);
        const info = assertRegularFile(input.mirrorPath, chunkPath);
        if (info.size !== chunk.sizeBytes) {
          throw repositoryV2Error(
            "pull",
            "integrity-failed",
            `V2 chunk '${chunk.fileName}' failed size or SHA-256 verification.`,
          );
        }

        // Chunks have a hard size cap. Reading each one once into this bounded
        // buffer lets us authenticate it before exposing any record from it,
        // without the former hash pass plus a second parse pass over the file.
        const chunkBytes = await NodeFSP.readFile(chunkPath);
        if (
          chunkBytes.byteLength !== chunk.sizeBytes ||
          threadSyncV2Sha256(chunkBytes) !== chunk.sha256
        ) {
          throw repositoryV2Error(
            "pull",
            "integrity-failed",
            `V2 chunk '${chunk.fileName}' failed size or SHA-256 verification.`,
          );
        }
        let chunkContents: string;
        try {
          chunkContents = new TextDecoder("utf-8", { fatal: true }).decode(chunkBytes);
        } catch (cause) {
          throw repositoryV2Error(
            "pull",
            "invalid-snapshot",
            `V2 chunk '${chunk.fileName}' is not valid UTF-8: ${String(cause)}`,
          );
        }
        if (!chunkContents.endsWith("\n")) {
          throw repositoryV2Error(
            "pull",
            "integrity-failed",
            `V2 chunk '${chunk.fileName}' is missing its final row delimiter.`,
          );
        }

        let chunkRowCount = 0;
        const lines = chunkContents.slice(0, -1).split("\n");
        for (const line of lines) {
          if (
            line.length === 0 ||
            Buffer.byteLength(line, "utf8") + 1 > THREAD_SYNC_V2_MAX_STORED_ROW_BYTES
          ) {
            throw repositoryV2Error(
              "pull",
              "integrity-failed",
              `V2 chunk '${chunk.fileName}' contains an empty or oversized row.`,
            );
          }
          let row: ThreadSyncV2StoredRow;
          try {
            row = decodeStoredRow(JSON.parse(line));
          } catch (cause) {
            throw repositoryV2Error(
              "pull",
              "invalid-snapshot",
              `A v2 storage row is invalid: ${String(cause)}`,
            );
          }
          if (row.rowOrdinal !== nextRowOrdinal) {
            throw repositoryV2Error(
              "pull",
              "integrity-failed",
              "A v2 storage stream contains a duplicate or skipped row ordinal.",
            );
          }
          nextRowOrdinal += 1;
          chunkRowCount += 1;

          if (row.kind === "record") {
            if (fragmentState !== null || row.record.ordinal !== nextRecordOrdinal) {
              throw repositoryV2Error(
                "pull",
                "integrity-failed",
                "A v2 logical record interrupts fragments or has the wrong ordinal.",
              );
            }
            nextRecordOrdinal += 1;
            if (row.record.ordinal >= startOrdinal) yield row.record;
            continue;
          }

          if (row.recordOrdinal !== nextRecordOrdinal || row.fragmentCount < 1) {
            throw repositoryV2Error(
              "pull",
              "integrity-failed",
              "A v2 generic record fragment has inconsistent metadata.",
            );
          }
          if (fragmentState === null) {
            if (row.fragmentIndex !== 0) {
              throw repositoryV2Error(
                "pull",
                "integrity-failed",
                "A v2 generic record starts after fragment zero.",
              );
            }
            if (
              row.sizeBytes > THREAD_SYNC_V2_MAX_LOGICAL_RECORD_BYTES ||
              row.fragmentCount >
                Math.ceil(
                  THREAD_SYNC_V2_MAX_LOGICAL_RECORD_BYTES / THREAD_SYNC_V2_GENERIC_FRAGMENT_BYTES,
                ) +
                  1
            ) {
              throw repositoryV2Error(
                "pull",
                "integrity-failed",
                "A v2 generic record exceeds the hard record limit.",
              );
            }
            fragmentState = {
              recordOrdinal: row.recordOrdinal,
              fragmentCount: row.fragmentCount,
              sha256: row.sha256,
              sizeBytes: row.sizeBytes,
              fragments: [],
              receivedBytes: 0,
            };
          }
          if (
            row.fragmentIndex !== fragmentState.fragments.length ||
            row.fragmentCount !== fragmentState.fragmentCount ||
            row.sha256 !== fragmentState.sha256 ||
            row.sizeBytes !== fragmentState.sizeBytes
          ) {
            throw repositoryV2Error(
              "pull",
              "integrity-failed",
              "A v2 generic record fragment sequence is inconsistent.",
            );
          }
          const fragmentBytes = Buffer.byteLength(row.jsonFragment, "utf8");
          if (
            fragmentState.receivedBytes > fragmentState.sizeBytes - fragmentBytes ||
            fragmentState.receivedBytes > THREAD_SYNC_V2_MAX_LOGICAL_RECORD_BYTES - fragmentBytes
          ) {
            throw repositoryV2Error(
              "pull",
              "integrity-failed",
              "A v2 generic record exceeds its declared or hard size limit.",
            );
          }
          fragmentState = {
            ...fragmentState,
            receivedBytes: fragmentState.receivedBytes + fragmentBytes,
          };
          fragmentState.fragments.push(row.jsonFragment);
          if (fragmentState.fragments.length === fragmentState.fragmentCount) {
            const encoded = fragmentState.fragments.join("");
            if (
              Buffer.byteLength(encoded, "utf8") !== fragmentState.sizeBytes ||
              threadSyncV2Sha256(encoded) !== fragmentState.sha256
            ) {
              throw repositoryV2Error(
                "pull",
                "integrity-failed",
                "A v2 generic record failed size or SHA-256 verification.",
              );
            }
            let record: ThreadSyncV2Record;
            try {
              record = decodeRecord(JSON.parse(encoded));
            } catch (cause) {
              throw repositoryV2Error(
                "pull",
                "invalid-snapshot",
                `A fragmented v2 history record is invalid: ${String(cause)}`,
              );
            }
            if (record.ordinal !== nextRecordOrdinal) {
              throw repositoryV2Error(
                "pull",
                "integrity-failed",
                "A fragmented v2 history record has the wrong ordinal.",
              );
            }
            fragmentState = null;
            nextRecordOrdinal += 1;
            if (record.ordinal >= startOrdinal) yield record;
          }
        }
        if (chunkRowCount !== chunk.rowCount || nextRowOrdinal !== chunk.lastRowOrdinal + 1) {
          throw repositoryV2Error(
            "pull",
            "integrity-failed",
            `V2 chunk '${chunk.fileName}' has an inconsistent record count.`,
          );
        }
      }
      if (
        fragmentState !== null ||
        nextRecordOrdinal !== manifest.recordCount ||
        nextRowOrdinal !== manifest.rowCount
      ) {
        throw repositoryV2Error(
          "pull",
          "integrity-failed",
          "The v2 thread failed record-count or logical-revision verification.",
        );
      }
    }

    const recordsFromOrdinal = (nextOrdinal: number) =>
      StreamRuntime.fromAsyncIterable(iterateRecords(nextOrdinal), (cause) =>
        isThreadSyncError(cause)
          ? cause
          : repositoryV2Error(
              "pull",
              "io-failed",
              `Could not stream a v2 thread: ${String(cause)}`,
            ),
      );

    return {
      manifest,
      records: recordsFromOrdinal(0),
      recordsFromOrdinal,
    };
  });
}

export interface ThreadSyncV2BlobReader {
  readonly entry: ThreadSyncV2BlobEntry;
  readonly bytes: Stream.Stream<Uint8Array, ThreadSyncError>;
}

/** Opens one blob as a bounded stream and verifies its declared digest when drained. */
export function readThreadSyncV2Blob(input: {
  readonly mirrorPath: string;
  readonly entry: ThreadSyncV2BlobEntry;
  readonly offset?: number;
}): Effect.Effect<ThreadSyncV2BlobReader, ThreadSyncError> {
  return Effect.gen(function* () {
    const offset = input.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > input.entry.sizeBytes) {
      return yield* Effect.fail(
        repositoryV2Error("pull", "integrity-failed", "A v2 blob resume offset is invalid."),
      );
    }
    if (input.entry.sizeBytes > MAX_BLOB_BYTES) {
      return yield* Effect.fail(
        repositoryV2Error("pull", "integrity-failed", "A v2 blob exceeds the size limit."),
      );
    }
    const blobPath = NodePath.join(
      input.mirrorPath,
      THREAD_SYNC_V2_BLOBS_DIRECTORY,
      `${input.entry.sha256}.blob`,
    );
    const info = yield* effectIo("pull", "Could not inspect a v2 blob", () =>
      assertRegularFile(input.mirrorPath, blobPath),
    );
    if (info.size !== input.entry.sizeBytes) {
      return yield* Effect.fail(
        repositoryV2Error("pull", "integrity-failed", "A v2 blob has the wrong size."),
      );
    }

    async function* iterateBytes(): AsyncGenerator<Uint8Array> {
      const hash = offset === 0 ? NodeCrypto.createHash("sha256") : null;
      let size = 0;
      for await (const chunk of NodeFS.createReadStream(blobPath, { start: offset })) {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        size += bytes.byteLength;
        if (offset + size > input.entry.sizeBytes) {
          throw repositoryV2Error("pull", "integrity-failed", "A v2 blob grew while reading.");
        }
        hash?.update(bytes);
        yield bytes;
      }
      if (
        offset + size !== input.entry.sizeBytes ||
        (hash !== null && hash.digest("hex") !== input.entry.sha256)
      ) {
        throw repositoryV2Error(
          "pull",
          "integrity-failed",
          "A v2 blob failed size or SHA-256 verification.",
        );
      }
    }

    return {
      entry: input.entry,
      bytes: StreamRuntime.fromAsyncIterable(iterateBytes(), (cause) =>
        isThreadSyncError(cause)
          ? cause
          : repositoryV2Error("pull", "io-failed", `Could not stream a v2 blob: ${String(cause)}`),
      ),
    };
  });
}
