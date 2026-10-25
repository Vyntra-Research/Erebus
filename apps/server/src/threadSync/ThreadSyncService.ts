// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ProviderInstanceId,
  type ChatAttachment,
  type IsoDateTime,
  type MessageId,
  type ModelSelection,
  type OrchestrationProposedPlanId,
  type OrchestrationProject,
  type OrchestrationReadModel,
  type OrchestrationEvent,
  type OrchestrationThread,
  type ProjectId,
  type ThreadId,
  type ThreadSyncImportStageId,
  ThreadSyncError,
  type ThreadSyncConfigureInput,
  type ThreadSyncConfigureResult,
  type ThreadSyncBindingUpdate,
  type ThreadSyncConflict,
  type ThreadSyncDisconnectInput,
  type ThreadSyncDisconnectResult,
  type ThreadSyncFetchInput,
  type ThreadSyncFetchResult,
  type ThreadSyncImageAttachment,
  type ThreadSyncImportItem,
  type ThreadSyncLinkProjectInput,
  type ThreadSyncLinkProjectResult,
  type ThreadSyncProjectId,
  type ThreadSyncProjectSnapshot,
  type ThreadSyncPullInput,
  type ThreadSyncPullResult,
  type ThreadSyncPushInput,
  type ThreadSyncPushResult,
  type ThreadSyncRevision,
  type ThreadSyncStatus,
  type ThreadSyncTerminalTurn,
  type ThreadSyncThreadSnapshot,
  type ThreadSyncUnlinkedProject,
  type TurnId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { resolveAttachmentPath, toSafeThreadAttachmentSegment } from "../attachmentStore.ts";
import {
  type ExclusiveFileOwnership,
  removeFileIfOwned,
  writeFileBytesExclusivelyAtomically,
  writeFileStringAtomically,
  writeFileStreamExclusivelyAtomically,
} from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  findThreadSyncImportStageProgress,
  prepareThreadSyncImportStage,
} from "../orchestration/ThreadSyncImportProjection.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { subscribeBeforeSnapshot } from "../utils/subscribeBeforeSnapshot.ts";
import {
  canonicalThreadSyncJson,
  canonicalThreadSyncPlanId,
  canonicalizeThreadSyncThreadSnapshot,
  decideThreadSyncThreeWay,
  emptyThreadSyncRepositoryDocuments,
  threadSyncRevision,
  type ThreadSyncRepositoryDocuments,
  type ThreadSyncThreeWayDecision,
} from "./ThreadSyncDocuments.ts";
import {
  THREAD_SYNC_MAX_BLOB_BYTES,
  THREAD_SYNC_MAX_TOTAL_BLOB_BYTES,
  readThreadSyncAttachmentForExport,
  type ThreadSyncAttachmentExportBudget,
} from "./ThreadSyncAttachmentIO.ts";
import {
  prepareProjectionThreadSyncV2Export,
  projectionThreadSyncV2Header,
  projectionThreadSyncV2SourceKey,
} from "./ThreadSyncExportV2.ts";
import { ThreadSyncGit } from "./ThreadSyncGit.ts";
import {
  readThreadSyncRepositoryIndex,
  readThreadSyncRepository,
  removeThreadSyncV1Repository,
} from "./ThreadSyncRepository.ts";
import {
  stageThreadSyncV2Import,
  threadSyncV2ImportedAttachmentId,
  type ThreadSyncV2AttachmentStage,
  type ThreadSyncV2ImportReferences,
  type ThreadSyncV2ImportSelection,
  type ThreadSyncV2StagedAttachment,
} from "./ThreadSyncImportV2.ts";
import {
  THREAD_SYNC_V2_BLOBS_DIRECTORY,
  THREAD_SYNC_V2_CHUNKS_DIRECTORY,
  readThreadSyncV2Blob,
  readThreadSyncV2RepositoryIndex,
  readThreadSyncV2Thread,
  threadSyncV2Sha256,
  threadSyncV2SourceFromV1Snapshot,
  writeThreadSyncV2Repository,
  type ThreadSyncV2BlobSource,
  type ThreadSyncV2RepositoryIndex,
  type ThreadSyncV2RepositorySource,
  type ThreadSyncV2ThreadEntry,
  type ThreadSyncV2ThreadManifest,
  type ThreadSyncV2ThreadSource,
} from "./ThreadSyncRepositoryV2.ts";
import {
  applyThreadSyncBindingUpdates,
  emptyThreadSyncLocalState,
  loadThreadSyncLocalState,
  resetThreadSyncLocalStateAt,
  saveThreadSyncLocalState,
  type ThreadSyncLocalProjectBinding,
  type ThreadSyncLocalState,
  type ThreadSyncLocalThreadBinding,
} from "./ThreadSyncState.ts";

interface ExportedThreadSyncState extends ThreadSyncRepositoryDocuments {
  readonly activeLocalThreadIds: ReadonlySet<ThreadId>;
  readonly projectBindings: ReadonlyArray<ThreadSyncLocalProjectBinding>;
  readonly threadBindings: ReadonlyArray<ThreadSyncLocalThreadBinding>;
}

interface ThreadSyncV2AttachmentJournalEntry extends ThreadSyncV2StagedAttachment {
  readonly targetThreadId: ThreadId;
  readonly targetMessageId: MessageId;
  readonly ownership: ExclusiveFileOwnership | null;
}

interface ThreadSyncV2AttachmentJournal {
  readonly stageId: ThreadSyncImportStageId;
  readonly prepared: boolean;
  readonly entries: ReadonlyArray<ThreadSyncV2AttachmentJournalEntry>;
}

interface ThreadSyncV2AttachmentReference {
  readonly attachment: Pick<ChatAttachment, "id">;
}

export function threadSyncAttachmentJournalMatchesImportedRecords(input: {
  readonly journal: {
    readonly entries: ReadonlyArray<ThreadSyncV2AttachmentReference>;
  } | null;
  readonly attachments: ReadonlyArray<ThreadSyncV2AttachmentReference>;
}): boolean {
  if (input.journal === null) return input.attachments.length === 0;
  return (
    input.journal.entries.length === input.attachments.length &&
    input.journal.entries.every(
      (entry, index) => entry.attachment.id === input.attachments[index]?.attachment.id,
    )
  );
}

// v1 requires one in-memory projection snapshot. Keep its compatibility path
// well below the on-disk document ceiling so decoding plus canonicalization
// cannot multiply a large local history into an unbounded heap allocation.
const THREAD_SYNC_V1_MAX_HYDRATION_BYTES = 64 * 1024 * 1024;
const THREAD_SYNC_V1_MAX_THREAD_HYDRATION_BYTES = 8 * 1024 * 1024;
const THREAD_SYNC_V1_MAX_HYDRATION_ROWS = 100_000;
const THREAD_SYNC_V1_MAX_DOCUMENTS = 20_000;
const THREAD_SYNC_V2_MAX_BLOB_COUNT = 8_192;

interface ThreadSyncEligibilityCandidate {
  readonly coagent: unknown | null;
  readonly lifecycle: {
    readonly archivedAt: string | null;
    readonly settledAt: string | null;
    readonly deletedAt: string | null;
  };
}

/** Primary threads remain portable until the user archives or deletes them. */
export function isPortablePrimaryThreadForSync(thread: ThreadSyncEligibilityCandidate): boolean {
  return (
    thread.coagent === null &&
    thread.lifecycle.archivedAt === null &&
    thread.lifecycle.deletedAt === null
  );
}

export function resolveRetiredSyncThreadIds(input: {
  readonly threadBindings: ReadonlyArray<ThreadSyncLocalThreadBinding>;
  readonly localThreads: ReadonlyArray<ThreadSyncEligibilityCandidate & { readonly id: ThreadId }>;
  readonly remoteThreadIds: Iterable<ThreadId>;
}): ReadonlySet<ThreadId> {
  const localThreadsById = new Map(
    input.localThreads.map((thread) => [thread.id, thread] as const),
  );
  const boundSyncThreadIds = new Set(input.threadBindings.map((binding) => binding.syncThreadId));
  const retired = new Set<ThreadId>();

  for (const binding of input.threadBindings) {
    const localThread = localThreadsById.get(binding.localThreadId);
    if (localThread === undefined || !isPortablePrimaryThreadForSync(localThread)) {
      retired.add(binding.syncThreadId);
    }
  }

  // Older builds could drop a binding as soon as its same-id local thread was
  // archived. Recover that local removal instead of presenting the surviving
  // remote copy as a new download. An explicit binding always wins because an
  // imported thread may intentionally use a different local identifier.
  for (const syncThreadId of input.remoteThreadIds) {
    if (boundSyncThreadIds.has(syncThreadId)) continue;
    const sameIdLocalThread = localThreadsById.get(syncThreadId);
    if (sameIdLocalThread !== undefined && !isPortablePrimaryThreadForSync(sameIdLocalThread)) {
      retired.add(syncThreadId);
    }
  }

  return retired;
}

function portablePrimaryRemoteThreads(
  repository: ThreadSyncV2RepositoryIndex,
): ReadonlyMap<ThreadId, ThreadSyncV2ThreadEntry> {
  return new Map(
    [...repository.threads].filter(([threadId]) => {
      const manifest = repository.threadManifests.get(threadId);
      return manifest !== undefined && isPortablePrimaryThreadForSync(manifest.header);
    }),
  );
}

export function selectRetainedRemoteThreads<T extends { readonly threadId: ThreadId }>(input: {
  readonly remoteThreads: Iterable<T>;
  readonly retiredSyncThreadIds: ReadonlySet<ThreadId>;
  readonly replacedSyncThreadIds: ReadonlySet<ThreadId>;
}): ReadonlyArray<T> {
  return [...input.remoteThreads].filter(
    (entry) =>
      !input.retiredSyncThreadIds.has(entry.threadId) &&
      !input.replacedSyncThreadIds.has(entry.threadId),
  );
}

interface ThreadSyncAnalysisEntry {
  readonly syncThreadId: ThreadId;
  readonly localThreadId: ThreadId | null;
  readonly syncProjectId: ThreadSyncProjectId | null;
  readonly title: string;
  readonly decision: ThreadSyncThreeWayDecision;
  readonly baseRevision: ThreadSyncRevision | null;
  readonly localRevision: ThreadSyncRevision | null;
  readonly remoteRevision: ThreadSyncRevision | null;
  readonly local: ThreadSyncThreadSnapshot | null;
  readonly remote: ThreadSyncThreadSnapshot | null;
  readonly active: boolean;
}

interface ThreadSyncAnalysis {
  readonly entries: ReadonlyArray<ThreadSyncAnalysisEntry>;
  readonly status: ThreadSyncStatus;
  readonly state: ThreadSyncLocalState;
}

interface ThreadSyncAnalysisWithLocal extends ThreadSyncAnalysis {
  readonly local: ExportedThreadSyncState;
}

interface ExportedThreadSyncV2State {
  readonly index: ProjectionSnapshotQuery.ProjectionThreadSyncExportIndex;
  readonly projects: ReadonlyMap<ThreadSyncProjectId, ThreadSyncProjectSnapshot>;
  readonly sources: ReadonlyMap<ThreadId, ThreadSyncV2ThreadSource<ThreadSyncError>>;
  readonly descriptors: ReadonlyMap<
    ThreadId,
    {
      readonly localThreadId: ThreadId;
      readonly header: ThreadSyncV2ThreadSource["header"];
      readonly sourceKeyHash: string;
      readonly threadSequence: number;
    }
  >;
  readonly revisions: ReadonlyMap<ThreadId, ThreadSyncRevision>;
  readonly blobs: ReadonlyMap<string, ThreadSyncV2BlobSource<ThreadSyncError>>;
  readonly activeLocalThreadIds: ReadonlySet<ThreadId>;
  /** Bound local threads that no longer belong in the active portable set. */
  readonly retiredSyncThreadIds: ReadonlySet<ThreadId>;
  readonly projectBindings: ReadonlyArray<ThreadSyncLocalProjectBinding>;
  readonly threadBindings: ReadonlyArray<ThreadSyncLocalThreadBinding>;
}

export function resolveThreadSyncV2LocalRevision(input: {
  readonly binding: ThreadSyncLocalThreadBinding | undefined;
  readonly descriptor: {
    readonly localThreadId: ThreadId;
    readonly sourceKeyHash: string;
    readonly threadSequence: number;
  };
  readonly remote: ThreadSyncV2ThreadEntry | undefined;
  readonly importWatermark: ProjectionSnapshotQuery.ProjectionThreadSyncImportWatermark | undefined;
}): ThreadSyncRevision {
  const { binding, descriptor, remote, importWatermark } = input;
  if (binding?.sourceKeyHash === descriptor.sourceKeyHash && binding.baseRevision !== null) {
    return binding.baseRevision;
  }
  if (remote?.sourceKeyHash === descriptor.sourceKeyHash) return remote.revision;
  if (
    binding?.baseRevision !== null &&
    binding?.baseRevision !== undefined &&
    importWatermark?.threadSequence === descriptor.threadSequence &&
    importWatermark.sourceRevision === binding.baseRevision
  ) {
    return binding.baseRevision;
  }
  return threadSyncRevision({ formatVersion: 2, sourceKeyHash: descriptor.sourceKeyHash });
}

/** Keep a durable sync mutation running if its WebSocket caller reconnects. */
export function keepThreadSyncOperationAlive<A, E, R>(
  operation: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.gen(function* () {
    const fiber = yield* Effect.forkDetach(operation);
    return yield* Fiber.join(fiber);
  });
}

interface ThreadSyncV2AnalysisEntry {
  readonly syncThreadId: ThreadId;
  readonly localThreadId: ThreadId | null;
  readonly syncProjectId: ThreadSyncProjectId | null;
  readonly title: string;
  readonly decision: ThreadSyncThreeWayDecision;
  readonly baseRevision: ThreadSyncRevision | null;
  readonly localRevision: ThreadSyncRevision | null;
  readonly remoteRevision: ThreadSyncRevision | null;
  readonly local: ProjectionSnapshotQuery.ProjectionThreadSyncExportThread | null;
  readonly remote: ThreadSyncV2ThreadEntry | null;
  readonly active: boolean;
}

interface ThreadSyncV2Analysis {
  readonly entries: ReadonlyArray<ThreadSyncV2AnalysisEntry>;
  readonly status: ThreadSyncStatus;
  readonly state: ThreadSyncLocalState;
  readonly local: ExportedThreadSyncV2State;
}

function emptyThreadSyncV2RepositoryIndex(updatedAt: IsoDateTime): ThreadSyncV2RepositoryIndex {
  return {
    manifest: {
      formatVersion: 2,
      kind: "erebus-thread-sync",
      updatedAt,
      projects: [],
      threads: [],
      blobs: [],
    },
    projects: new Map(),
    threads: new Map(),
    threadManifests: new Map(),
    blobs: new Map(),
  };
}

const BINDING_REPLAY_PAGE_SIZE = 256;

export function replayThreadSyncBindingEvents(
  state: ThreadSyncLocalState,
  events: ReadonlyArray<OrchestrationEvent>,
): ThreadSyncLocalState {
  let bindings = state.threadBindings;
  let lastBindingEventSequence = state.lastBindingEventSequence;
  for (const event of events) {
    if (event.type === "thread.sync-imported") {
      bindings = applyThreadSyncBindingUpdates(bindings, event.payload.bindingUpdates);
    }
    lastBindingEventSequence = Math.max(lastBindingEventSequence ?? 0, event.sequence);
  }
  return { ...state, threadBindings: bindings, lastBindingEventSequence };
}

export interface ThreadSyncSubscription {
  readonly latest: ThreadSyncStatus;
  readonly changes: Stream.Stream<ThreadSyncStatus>;
}

export interface ThreadSyncServiceShape {
  readonly start: Effect.Effect<void, never, Scope.Scope>;
  readonly getStatus: Effect.Effect<ThreadSyncStatus>;
  readonly subscribe: Effect.Effect<ThreadSyncSubscription, never, Scope.Scope>;
  readonly configure: (
    input: ThreadSyncConfigureInput,
  ) => Effect.Effect<ThreadSyncConfigureResult, ThreadSyncError>;
  readonly fetch: (
    input: ThreadSyncFetchInput,
  ) => Effect.Effect<ThreadSyncFetchResult, ThreadSyncError>;
  readonly linkProject: (
    input: ThreadSyncLinkProjectInput,
  ) => Effect.Effect<ThreadSyncLinkProjectResult, ThreadSyncError>;
  readonly disconnect: (
    input: ThreadSyncDisconnectInput,
  ) => Effect.Effect<ThreadSyncDisconnectResult, ThreadSyncError>;
  readonly pull: (
    input: ThreadSyncPullInput,
  ) => Effect.Effect<ThreadSyncPullResult, ThreadSyncError>;
  readonly push: (
    input: ThreadSyncPushInput,
  ) => Effect.Effect<ThreadSyncPushResult, ThreadSyncError>;
}

export class ThreadSyncService extends Context.Service<ThreadSyncService, ThreadSyncServiceShape>()(
  "erebus/threadSync/ThreadSyncService",
) {}

const disconnectedStatus = (lastError: string | null = null): ThreadSyncStatus => ({
  state: lastError === null ? "disconnected" : "error",
  configuration: null,
  baseRevision: null,
  localRevision: null,
  remoteRevision: null,
  lastFetchedAt: null,
  pendingPullCount: 0,
  pendingPushCount: 0,
  conflicts: [],
  unlinkedProjects: [],
  lastError,
});

function syncError(
  operation: ThreadSyncError["operation"],
  code: ThreadSyncError["code"],
  detail: string,
): ThreadSyncError {
  return new ThreadSyncError({ operation, code, detail });
}

function mapUnknownError(operation: ThreadSyncError["operation"], cause: unknown): ThreadSyncError {
  return isThreadSyncError(cause)
    ? cause
    : syncError(operation, "unknown", cause instanceof Error ? cause.message : String(cause));
}

function isThreadSyncError(cause: unknown): cause is ThreadSyncError {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    cause._tag === "ThreadSyncError"
  );
}

function stableUuid(seed: string): string {
  const bytes = NodeCrypto.createHash("sha256").update(seed, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function threadSyncImportCommandId(
  selections: ReadonlyArray<{
    readonly snapshot: ThreadSyncThreadSnapshot;
    readonly targetThreadId: ThreadId;
    readonly projectId: ProjectId | null;
    readonly mode: "create" | "replace";
    readonly expectedLocalUpdatedAt: IsoDateTime | null;
    readonly sourceRevision: ThreadSyncRevision;
    readonly bindingUpdates: ReadonlyArray<ThreadSyncBindingUpdate>;
  }>,
  resolvedImports: ReadonlyArray<ThreadSyncImportItem> = [],
): CommandId {
  const identities = selections
    .map((selection) =>
      JSON.stringify({
        snapshotThreadId: selection.snapshot.threadId,
        snapshotRevision: threadSyncRevision(selection.snapshot),
        targetThreadId: selection.targetThreadId,
        projectId: selection.projectId,
        mode: selection.mode,
        expectedLocalUpdatedAt: selection.expectedLocalUpdatedAt,
        sourceRevision: selection.sourceRevision,
        bindingUpdates: selection.bindingUpdates.map((binding) => ({
          syncThreadId: binding.syncThreadId,
          localThreadId: binding.localThreadId,
          syncProjectId: binding.syncProjectId,
          localProjectId: binding.localProjectId,
          baseRevision: binding.baseRevision,
        })),
      }),
    )
    .toSorted();
  const resolvedIdentities = resolvedImports.map((item) => JSON.stringify(item)).toSorted();
  return CommandId.make(
    `thread-sync-import-${stableUuid(JSON.stringify({ identities, resolvedIdentities }))}`,
  );
}

export function withThreadSyncAttachmentRollback<A, E, R, Ownership, RemoveR>(input: {
  readonly ownedFiles: ReadonlyArray<Ownership>;
  readonly committed: () => boolean;
  readonly remove: (ownership: Ownership) => Effect.Effect<void, never, RemoveR>;
  readonly effect: Effect.Effect<A, E, R>;
}): Effect.Effect<A, E, R | RemoveR> {
  return input.effect.pipe(
    Effect.onExit((exit) =>
      exit._tag === "Failure" && !input.committed()
        ? Effect.forEach(input.ownedFiles.toReversed(), input.remove, { discard: true })
        : Effect.void,
    ),
  );
}

export function confirmThreadSyncImportDispatch<A, E, R>(
  dispatch: () => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.gen(function* () {
    const first = yield* Effect.result(dispatch());
    if (first._tag === "Success") return first.success;
    // The command receipt is committed in the same transaction as the import.
    // Replaying the stable command id confirms an ambiguous post-commit failure.
    return yield* dispatch();
  });
}

function portableId(prefix: string, seed: string): string {
  return `${prefix}-${stableUuid(seed)}`;
}

function orderedPortableId(prefix: string, ordinal: number, seed: string): string {
  return `${prefix}-${String(ordinal).padStart(8, "0")}-${stableUuid(seed)}`;
}

interface ThreadSyncImportReferenceSelection {
  readonly snapshot: ThreadSyncThreadSnapshot;
  readonly targetThreadId: ThreadId;
  readonly projectId: ProjectId | null;
  readonly sourceRevision: ThreadSyncRevision;
}

export interface ThreadSyncImportReferenceMaps {
  readonly threadIds: ReadonlyMap<ThreadId, ThreadId>;
  readonly projectIds: ReadonlyMap<ThreadId, ProjectId | null>;
  readonly planIds: ReadonlyMap<
    ThreadId,
    ReadonlyMap<OrchestrationProposedPlanId, OrchestrationProposedPlanId>
  >;
}

function importedHistoryIdMaps(
  input: Pick<ThreadSyncImportReferenceSelection, "snapshot" | "targetThreadId" | "sourceRevision">,
) {
  const seed = `${input.snapshot.threadId}\0${input.targetThreadId}\0${input.sourceRevision}`;
  const turnIds = new Map<string, TurnId>();
  const messageIds = new Map<string, MessageId>();
  const planIds = new Map<OrchestrationProposedPlanId, OrchestrationProposedPlanId>();

  for (const [index, turn] of input.snapshot.turns.entries()) {
    turnIds.set(
      turn.turnId,
      orderedPortableId("turn", index, `${seed}\0turn\0${turn.turnId}`) as TurnId,
    );
  }
  for (const [index, message] of input.snapshot.messages.entries()) {
    messageIds.set(
      message.id,
      orderedPortableId("message", index, `${seed}\0message\0${message.id}`) as MessageId,
    );
  }
  for (const [index, plan] of input.snapshot.proposedPlans.entries()) {
    planIds.set(
      plan.id,
      orderedPortableId(
        "plan",
        index,
        `${input.snapshot.threadId}\0${input.targetThreadId}\0plan\0${plan.id}`,
      ) as OrchestrationProposedPlanId,
    );
  }

  return { seed, turnIds, messageIds, planIds };
}

export function buildThreadSyncImportReferenceMaps(input: {
  readonly selections: ReadonlyArray<ThreadSyncImportReferenceSelection>;
  readonly threadBindings: ReadonlyArray<ThreadSyncLocalThreadBinding>;
  readonly localThreads: ReadonlyArray<
    Pick<OrchestrationThread, "id" | "projectId" | "proposedPlans">
  >;
  readonly convergentSyncThreadIds: ReadonlySet<ThreadId>;
}): ThreadSyncImportReferenceMaps {
  const threadIds = new Map<ThreadId, ThreadId>();
  const projectIds = new Map<ThreadId, ProjectId | null>();
  const planIds = new Map<
    ThreadId,
    ReadonlyMap<OrchestrationProposedPlanId, OrchestrationProposedPlanId>
  >();
  const localThreads = new Map(input.localThreads.map((thread) => [thread.id, thread] as const));

  for (const binding of input.threadBindings) {
    if (!input.convergentSyncThreadIds.has(binding.syncThreadId)) continue;
    const localThread = localThreads.get(binding.localThreadId);
    if (localThread === undefined) continue;
    threadIds.set(binding.syncThreadId, binding.localThreadId);
    projectIds.set(binding.syncThreadId, localThread.projectId);
    planIds.set(
      binding.syncThreadId,
      new Map(
        localThread.proposedPlans.map(
          (plan, index) =>
            [canonicalThreadSyncPlanId(binding.syncThreadId, index), plan.id] as const,
        ),
      ),
    );
  }

  // A thread imported in this batch replaces the bound local history. Its final
  // ids must therefore win over any pre-import binding above.
  for (const selection of input.selections) {
    threadIds.set(selection.snapshot.threadId, selection.targetThreadId);
    projectIds.set(selection.snapshot.threadId, selection.projectId);
    planIds.set(selection.snapshot.threadId, importedHistoryIdMaps(selection).planIds);
  }

  return { threadIds, projectIds, planIds };
}

export function validateThreadSyncImportReferences(input: {
  readonly selections: ReadonlyArray<ThreadSyncImportReferenceSelection>;
  readonly references: ThreadSyncImportReferenceMaps;
}): string | null {
  for (const selection of input.selections) {
    for (const turn of selection.snapshot.turns) {
      const sourceThreadId = turn.sourceProposedPlanThreadId;
      const sourcePlanId = turn.sourceProposedPlanId;
      if ((sourceThreadId === null) !== (sourcePlanId === null)) {
        return `Turn '${turn.turnId}' has an incomplete source plan reference.`;
      }
      if (sourceThreadId === null || sourcePlanId === null) continue;
      if (!input.references.threadIds.has(sourceThreadId)) {
        return `Turn '${turn.turnId}' references thread '${sourceThreadId}', which is not available locally.`;
      }
      if (input.references.projectIds.get(sourceThreadId) !== selection.projectId) {
        return `Turn '${turn.turnId}' references source thread '${sourceThreadId}' outside its local project.`;
      }
      if (!input.references.planIds.get(sourceThreadId)?.has(sourcePlanId)) {
        return `Turn '${turn.turnId}' references plan '${sourcePlanId}' outside its source thread '${sourceThreadId}'.`;
      }
    }
    for (const plan of selection.snapshot.proposedPlans) {
      if (
        plan.implementationThreadId !== null &&
        !input.references.threadIds.has(plan.implementationThreadId)
      ) {
        return `Plan '${plan.id}' references implementation thread '${plan.implementationThreadId}', which is not available locally.`;
      }
      if (
        plan.implementationThreadId !== null &&
        input.references.projectIds.get(plan.implementationThreadId) !== selection.projectId
      ) {
        return `Plan '${plan.id}' references implementation thread '${plan.implementationThreadId}' outside its local project.`;
      }
    }
  }
  return null;
}

function aggregateRevision(
  entries: ReadonlyArray<readonly [string, ThreadSyncRevision | null]>,
): ThreadSyncRevision | null {
  if (entries.every(([, revision]) => revision === null)) return null;
  return threadSyncRevision(entries.toSorted(([left], [right]) => left.localeCompare(right)));
}

function normalizeRelativePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  return normalized.length === 0 ? "." : normalized;
}

export function sanitizeThreadSyncRemoteUrl(remoteUrl: string): string {
  try {
    const parsed = new URL(remoteUrl);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return remoteUrl.replace(/^[^/@\s]+@(?=[^/:\s]+:)/, "").replace(/[?#].*$/, "");
  }
}

function publicOperationalRemoteUrl(remoteUrl: string): string {
  try {
    const parsed = new URL(remoteUrl);
    if (parsed.protocol !== "ssh:" || parsed.password.length > 0) {
      parsed.username = "";
    }
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return remoteUrl.replace(/[?#].*$/, "");
  }
}

export function portableRepositoryIdentity(
  repositoryIdentity: NonNullable<OrchestrationProject["repositoryIdentity"]>,
) {
  const remoteUrl = sanitizeThreadSyncRemoteUrl(repositoryIdentity.locator.remoteUrl);
  const isNetworkRemote =
    /^(?:https?|ssh|git):\/\//i.test(remoteUrl) ||
    /^(?![A-Za-z]:[\\/])[^/\\:\s]+:[^\\]+$/.test(remoteUrl);
  if (!isNetworkRemote) return null;
  return {
    canonicalKey: `repository-${NodeCrypto.createHash("sha256")
      .update(sanitizeThreadSyncRemoteUrl(repositoryIdentity.canonicalKey), "utf8")
      .digest("hex")}`,
    locator: {
      ...repositoryIdentity.locator,
      remoteUrl,
    },
    displayName: repositoryIdentity.displayName ?? null,
    provider: repositoryIdentity.provider ?? null,
    owner: repositoryIdentity.owner ?? null,
    name: repositoryIdentity.name ?? null,
  };
}

function publicThreadSyncConfiguration(
  configuration: ThreadSyncConfigureInput | null,
): ThreadSyncConfigureInput | null {
  if (configuration === null) return null;
  const remoteUrl = configuration.remoteUrl;
  const networkRemote =
    /^(?:https?|ssh|git):\/\//i.test(remoteUrl) ||
    /^(?![A-Za-z]:[\\/])[^/\\:\s]+:[^\\]+$/.test(remoteUrl);
  return {
    ...configuration,
    remoteUrl: networkRemote ? publicOperationalRemoteUrl(remoteUrl) : remoteUrl,
  };
}

export function selectPortableProjectDescriptor(input: {
  readonly local: ThreadSyncProjectSnapshot;
  readonly remote: ThreadSyncProjectSnapshot | undefined;
}): ThreadSyncProjectSnapshot {
  return input.remote ?? input.local;
}

export function selectAutoLinkProject(
  remoteProject: ThreadSyncProjectSnapshot,
  localProjects: Iterable<ThreadSyncProjectSnapshot>,
): ThreadSyncProjectSnapshot | null {
  if (remoteProject.deletedAt !== null || remoteProject.repositoryIdentity === null) return null;
  const matches = [...localProjects].filter(
    (localProject) =>
      localProject.deletedAt === null &&
      localProject.repositoryIdentity?.canonicalKey ===
        remoteProject.repositoryIdentity!.canonicalKey &&
      localProject.repositoryRelativePath === remoteProject.repositoryRelativePath,
  );
  return matches.length === 1 ? matches[0]! : null;
}

export function deriveKeepBothThreadIds(input: {
  readonly syncThreadId: ThreadId;
  readonly localThreadId: ThreadId;
  readonly localRevision: ThreadSyncRevision;
  readonly remoteRevision: ThreadSyncRevision;
}): { readonly preservedSyncThreadId: ThreadId; readonly clonedThreadId: ThreadId } {
  const seed = [
    "keep-both",
    input.syncThreadId,
    input.localThreadId,
    input.localRevision,
    input.remoteRevision,
  ].join("\0");
  return {
    preservedSyncThreadId: portableId("copy", seed) as ThreadId,
    clonedThreadId: portableId("thread", seed) as ThreadId,
  };
}

function portableProjectDescriptor(
  project: OrchestrationProject,
  path: Path.Path,
  existing: ThreadSyncLocalProjectBinding | undefined,
): {
  readonly binding: ThreadSyncLocalProjectBinding;
  readonly snapshot: ThreadSyncProjectSnapshot;
} {
  const localRepositoryIdentity = project.repositoryIdentity ?? null;
  const repositoryIdentity =
    localRepositoryIdentity === null ? null : portableRepositoryIdentity(localRepositoryIdentity);
  let repositoryRelativePath: string | null = null;
  if (repositoryIdentity !== null) {
    const rootPath = localRepositoryIdentity?.rootPath ?? project.workspaceRoot;
    const relative = normalizeRelativePath(path.relative(rootPath, project.workspaceRoot));
    repositoryRelativePath =
      relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)
        ? null
        : relative;
  }

  const identitySeed =
    repositoryIdentity === null
      ? `local:${project.id}`
      : `repo:${repositoryIdentity.canonicalKey}\0${repositoryRelativePath ?? "."}`;
  const syncProjectId =
    existing?.syncProjectId ?? (`project-${stableUuid(identitySeed)}` as ThreadSyncProjectId);
  const binding: ThreadSyncLocalProjectBinding = {
    syncProjectId,
    projectId: project.id,
    linkedAt: existing?.linkedAt ?? project.createdAt,
  };
  return {
    binding,
    snapshot: {
      formatVersion: 1,
      syncProjectId,
      title: project.title,
      repositoryIdentity,
      repositoryRelativePath:
        repositoryRelativePath as ThreadSyncProjectSnapshot["repositoryRelativePath"],
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      deletedAt: project.deletedAt,
    },
  };
}

function isThreadActive(
  thread: OrchestrationThread,
  turns: ReadonlyArray<{
    readonly state: string;
    readonly turnId: TurnId | null;
    readonly completedAt: string | null;
  }>,
): boolean {
  return (
    thread.latestTurn?.state === "running" ||
    thread.session?.status === "starting" ||
    thread.session?.status === "running" ||
    (thread.session?.activeTurnId !== null && thread.session?.activeTurnId !== undefined) ||
    thread.messages.some((message) => message.streaming) ||
    turns.some(
      (turn) =>
        turn.turnId === null ||
        turn.completedAt === null ||
        turn.state === "pending" ||
        turn.state === "running",
    )
  );
}

function localModelSelection(
  project: OrchestrationProject,
  threads: ReadonlyArray<OrchestrationThread>,
): ModelSelection {
  return (
    project.defaultModelSelection ??
    threads.find((thread) => thread.projectId === project.id && thread.deletedAt === null)
      ?.modelSelection ?? {
      instanceId: ProviderInstanceId.make("codex"),
      model: DEFAULT_MODEL,
    }
  );
}

export function remapImportedSnapshot(input: {
  readonly snapshot: ThreadSyncThreadSnapshot;
  readonly targetThreadId: ThreadId;
  readonly sourceRevision: ThreadSyncRevision;
  readonly references?: ThreadSyncImportReferenceMaps;
  readonly coagentParentThreadId?: ThreadId | null;
  readonly attachment: (
    messageId: MessageId,
    index: number,
    attachment: ThreadSyncImageAttachment,
  ) => ChatAttachment;
}) {
  const { seed, turnIds, messageIds, planIds } = importedHistoryIdMaps(input);

  const resolveThreadId = (portableThreadId: ThreadId): ThreadId => {
    if (portableThreadId === input.snapshot.threadId) return input.targetThreadId;
    const resolved = input.references?.threadIds.get(portableThreadId);
    if (resolved === undefined) {
      throw new Error(`Cannot materialize synchronized thread reference '${portableThreadId}'.`);
    }
    return resolved;
  };
  const resolvePlanId = (
    portableThreadId: ThreadId,
    portablePlanId: OrchestrationProposedPlanId,
  ): OrchestrationProposedPlanId => {
    const resolved =
      portableThreadId === input.snapshot.threadId
        ? planIds.get(portablePlanId)
        : input.references?.planIds.get(portableThreadId)?.get(portablePlanId);
    if (resolved === undefined) {
      throw new Error(
        `Cannot materialize synchronized plan '${portablePlanId}' from thread '${portableThreadId}'.`,
      );
    }
    return resolved;
  };

  const turns = input.snapshot.turns.map((turn) => {
    const sourceThreadId = turn.sourceProposedPlanThreadId;
    const sourcePlanId = turn.sourceProposedPlanId;
    if ((sourceThreadId === null) !== (sourcePlanId === null)) {
      throw new Error(`Turn '${turn.turnId}' has an incomplete synchronized plan reference.`);
    }
    return {
      turnId: turnIds.get(turn.turnId)!,
      pendingMessageId:
        turn.pendingMessageId === null ? null : (messageIds.get(turn.pendingMessageId) ?? null),
      sourceProposedPlanThreadId: sourceThreadId === null ? null : resolveThreadId(sourceThreadId),
      sourceProposedPlanId:
        sourceThreadId === null || sourcePlanId === null
          ? null
          : resolvePlanId(sourceThreadId, sourcePlanId),
      assistantMessageId:
        turn.assistantMessageId === null ? null : (messageIds.get(turn.assistantMessageId) ?? null),
      state: turn.state,
      requestedAt: turn.requestedAt,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
    };
  });

  return {
    title: input.snapshot.title,
    coagent:
      input.snapshot.coagent !== null && input.coagentParentThreadId != null
        ? {
            parentThreadId: input.coagentParentThreadId,
            creationMode: input.snapshot.coagent.creationMode,
            status: input.snapshot.coagent.status,
          }
        : null,
    latestTurnId:
      input.snapshot.latestTurn === null
        ? null
        : (turnIds.get(input.snapshot.latestTurn.turnId) ?? null),
    createdAt: input.snapshot.createdAt,
    updatedAt: input.snapshot.updatedAt,
    archivedAt: input.snapshot.lifecycle.archivedAt,
    settledOverride: input.snapshot.lifecycle.settledOverride,
    settledAt: input.snapshot.lifecycle.settledAt,
    deletedAt: input.snapshot.lifecycle.deletedAt,
    messages: input.snapshot.messages.map((message) => ({
      id: messageIds.get(message.id)!,
      role: message.role,
      text: message.text,
      attachments: message.attachments.map((attachment, index) =>
        input.attachment(message.id, index, attachment),
      ),
      turnId: message.turnId === null ? null : (turnIds.get(message.turnId) ?? null),
      streaming: false as const,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
    })),
    proposedPlans: input.snapshot.proposedPlans.map((plan) => ({
      id: planIds.get(plan.id)!,
      turnId: plan.turnId === null ? null : (turnIds.get(plan.turnId) ?? null),
      planMarkdown: plan.planMarkdown,
      implementedAt: plan.implementedAt,
      implementationThreadId:
        plan.implementationThreadId === null ? null : resolveThreadId(plan.implementationThreadId),
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
    })),
    activities: input.snapshot.activities.map((activity, index) => ({
      id: orderedPortableId("activity", index, `${seed}\0activity\0${activity.id}`) as never,
      tone: activity.tone,
      kind: activity.kind,
      summary: activity.summary,
      turnId: activity.turnId === null ? null : (turnIds.get(activity.turnId) ?? null),
      ...(activity.sequence === null ? {} : { sequence: activity.sequence }),
      createdAt: activity.createdAt,
    })),
    turns,
  };
}

export function resolveImportedCoagentParent(input: {
  readonly snapshot: ThreadSyncThreadSnapshot;
  readonly targetThreadId: ThreadId;
  readonly projectId: ProjectId | null;
  readonly importedTargets: ReadonlyMap<
    ThreadId,
    {
      readonly threadId: ThreadId;
      readonly projectId: ProjectId | null;
      readonly deletedAt: IsoDateTime | null;
    }
  >;
  readonly threadBindings: ReadonlyArray<ThreadSyncLocalThreadBinding>;
  readonly localThreads: ReadonlyArray<Pick<OrchestrationThread, "id" | "projectId" | "deletedAt">>;
}): ThreadId | null {
  const portableParentId = input.snapshot.coagent?.parentThreadId;
  if (portableParentId === undefined) return null;

  const importedParent = input.importedTargets.get(portableParentId);
  const boundParentId = input.threadBindings.find(
    (binding) => binding.syncThreadId === portableParentId,
  )?.localThreadId;
  const parentThreadId = importedParent?.threadId ?? boundParentId;
  if (parentThreadId === undefined || parentThreadId === input.targetThreadId) return null;

  const parent =
    importedParent ?? input.localThreads.find((thread) => thread.id === parentThreadId);
  return parent !== undefined && parent.projectId === input.projectId && parent.deletedAt === null
    ? parentThreadId
    : null;
}

export function pruneDanglingPortableCoagents(
  threads: ReadonlyMap<string, ThreadSyncThreadSnapshot>,
  retainedParentThreadIds: Iterable<string> = [],
): ReadonlyMap<string, ThreadSyncThreadSnapshot> {
  const exportedThreadIds = new Set([
    ...[...threads.values()]
      .filter((thread) => thread.lifecycle.deletedAt === null)
      .map((thread) => thread.threadId),
    ...retainedParentThreadIds,
  ]);
  return new Map(
    [...threads].map(
      ([threadId, snapshot]) =>
        [
          threadId,
          snapshot.coagent !== null && !exportedThreadIds.has(snapshot.coagent.parentThreadId)
            ? { ...snapshot, coagent: null }
            : snapshot,
        ] as const,
    ),
  );
}

export function reconcileExportedThreadBindings(input: {
  readonly existing: ReadonlyArray<ThreadSyncLocalThreadBinding>;
  readonly threads: ReadonlyArray<Pick<OrchestrationThread, "id" | "projectId">>;
  readonly syncProjectByLocal: ReadonlyMap<ProjectId, ThreadSyncProjectId>;
}): ReadonlyArray<ThreadSyncLocalThreadBinding> {
  const currentBindingsByLocal = new Map(
    input.existing.map((binding) => [binding.localThreadId, binding] as const),
  );
  return input.threads.flatMap((thread) => {
    const current = currentBindingsByLocal.get(thread.id);
    const syncProjectId =
      current !== undefined
        ? current.syncProjectId
        : thread.projectId === null
          ? null
          : (input.syncProjectByLocal.get(thread.projectId) ?? null);
    if (current === undefined && thread.projectId !== null && syncProjectId === null) return [];
    return [
      {
        syncThreadId: current?.syncThreadId ?? thread.id,
        localThreadId: thread.id,
        syncProjectId,
        baseRevision: current?.baseRevision ?? null,
      },
    ];
  });
}

export function restoreSynchronizedThreadProjectIdentity(input: {
  readonly binding: ThreadSyncLocalThreadBinding;
  readonly remote:
    | {
        readonly revision: ThreadSyncRevision;
        readonly syncProjectId: ThreadSyncProjectId | null;
      }
    | undefined;
}): ThreadSyncLocalThreadBinding {
  return input.remote !== undefined &&
    input.binding.baseRevision === input.remote.revision &&
    input.binding.syncProjectId !== input.remote.syncProjectId
    ? { ...input.binding, syncProjectId: input.remote.syncProjectId }
    : input.binding;
}

export function analyzeThreadSyncState(input: {
  readonly local: ExportedThreadSyncState;
  readonly remote: ThreadSyncRepositoryDocuments;
  readonly state: ThreadSyncLocalState;
  readonly runState?: ThreadSyncStatus["state"];
  readonly lastError?: string | null;
}): ThreadSyncAnalysis {
  const localBySyncId = input.local.threads;
  const remoteBySyncId = input.remote.threads;
  const bindingsBySyncId = new Map([
    ...input.state.threadBindings.map((binding) => [binding.syncThreadId, binding] as const),
    ...input.local.threadBindings.map((binding) => [binding.syncThreadId, binding] as const),
  ]);
  const allIds = new Set<string>([...localBySyncId.keys(), ...remoteBySyncId.keys()]);
  const entries: ThreadSyncAnalysisEntry[] = [];

  for (const rawId of [...allIds].toSorted()) {
    const syncThreadId = rawId as ThreadId;
    const binding = bindingsBySyncId.get(syncThreadId);
    const local = localBySyncId.get(rawId) ?? null;
    const remote = remoteBySyncId.get(rawId) ?? null;
    const baseRevision = binding?.baseRevision ?? null;
    const localRevision = local === null ? null : threadSyncRevision(local);
    const remoteRevision = remote === null ? null : threadSyncRevision(remote);
    const active =
      binding !== undefined && input.local.activeLocalThreadIds.has(binding.localThreadId);
    entries.push({
      syncThreadId,
      localThreadId: binding?.localThreadId ?? null,
      syncProjectId: (local ?? remote)!.syncProjectId,
      title: (local ?? remote)!.title,
      decision: decideThreadSyncThreeWay({ baseRevision, localRevision, remoteRevision }),
      baseRevision,
      localRevision,
      remoteRevision,
      local,
      remote,
      active,
    });
  }

  const projectBindings = new Map(
    input.local.projectBindings.map((binding) => [binding.syncProjectId, binding] as const),
  );
  const localProjectBindings = new Map(
    input.local.projectBindings.map(
      (binding) => [binding.syncProjectId, binding.projectId] as const,
    ),
  );
  const unlinkedProjects: ThreadSyncUnlinkedProject[] = [];
  for (const project of input.remote.projects.values()) {
    if (project.deletedAt !== null) continue;
    if (!projectBindings.has(project.syncProjectId)) {
      const repositoryMatches = [...input.local.projects.values()].filter(
        (candidate) =>
          project.repositoryIdentity !== null &&
          candidate.repositoryIdentity?.canonicalKey === project.repositoryIdentity.canonicalKey,
      );
      const exactMatches = repositoryMatches.filter(
        (candidate) => candidate.repositoryRelativePath === project.repositoryRelativePath,
      );
      const uniqueCandidate =
        exactMatches.length === 1
          ? exactMatches[0]!
          : repositoryMatches.length === 1
            ? repositoryMatches[0]!
            : null;
      unlinkedProjects.push({
        project,
        reason:
          exactMatches.length > 1 || repositoryMatches.length > 1
            ? "ambiguous-match"
            : repositoryMatches.length === 1
              ? "workspace-missing"
              : "no-match",
        suggestedProjectId:
          uniqueCandidate === null
            ? null
            : (localProjectBindings.get(uniqueCandidate.syncProjectId) ?? null),
      });
    }
  }

  const conflicts: ThreadSyncConflict[] = entries
    .filter(
      (entry) => !entry.active && entry.decision === "conflict" && entry.remoteRevision !== null,
    )
    .map((entry) => ({
      threadId: entry.localThreadId ?? entry.syncThreadId,
      syncProjectId: entry.syncProjectId,
      title: entry.title,
      baseRevision: entry.baseRevision,
      localRevision: entry.localRevision,
      remoteRevision: entry.remoteRevision!,
    }));
  const activeEntries = entries.filter((entry) => !entry.active);
  const status: ThreadSyncStatus = {
    state: input.runState ?? "idle",
    configuration: publicThreadSyncConfiguration(input.state.configuration),
    baseRevision: aggregateRevision(
      entries.map((entry) => [entry.syncThreadId, entry.baseRevision]),
    ),
    localRevision: aggregateRevision(
      entries.map((entry) => [entry.syncThreadId, entry.localRevision]),
    ),
    remoteRevision: input.state.remoteRevision,
    lastFetchedAt: input.state.lastFetchedAt,
    pendingPullCount: activeEntries.filter((entry) => entry.decision === "pull").length,
    pendingPushCount: activeEntries.filter((entry) => entry.decision === "push").length,
    conflicts,
    unlinkedProjects,
    lastError: input.lastError ?? null,
  };
  return { entries, status, state: input.state };
}

export function analyzeThreadSyncV2State(input: {
  readonly local: ExportedThreadSyncV2State;
  readonly remote: ThreadSyncV2RepositoryIndex;
  readonly state: ThreadSyncLocalState;
  readonly runState?: ThreadSyncStatus["state"];
  readonly lastError?: string | null;
}): ThreadSyncV2Analysis {
  const eligibleRemoteThreads = portablePrimaryRemoteThreads(input.remote);
  const bindingsBySyncId = new Map(
    input.local.threadBindings.map((binding) => [binding.syncThreadId, binding] as const),
  );
  const localThreadsById = new Map(input.local.index.threads.map((thread) => [thread.id, thread]));
  const allIds = new Set<ThreadId>([
    ...input.local.descriptors.keys(),
    ...eligibleRemoteThreads.keys(),
  ]);
  const entries: ThreadSyncV2AnalysisEntry[] = [];
  for (const syncThreadId of [...allIds].toSorted()) {
    const binding = bindingsBySyncId.get(syncThreadId);
    const localDescriptor = input.local.descriptors.get(syncThreadId);
    const metadata = localDescriptor?.header ?? eligibleRemoteThreads.get(syncThreadId) ?? null;
    if (metadata === null) continue;
    const local =
      localDescriptor === undefined || binding === undefined
        ? null
        : (localThreadsById.get(binding.localThreadId) ?? null);
    const remote = eligibleRemoteThreads.get(syncThreadId) ?? null;
    const baseRevision = binding?.baseRevision ?? null;
    const localRevision = input.local.revisions.get(syncThreadId) ?? null;
    const remoteRevision = remote?.revision ?? null;
    entries.push({
      syncThreadId,
      localThreadId: binding?.localThreadId ?? null,
      syncProjectId: metadata.syncProjectId,
      title: metadata.title,
      decision: input.local.retiredSyncThreadIds.has(syncThreadId)
        ? remoteRevision === null
          ? "unchanged"
          : "push"
        : decideThreadSyncThreeWay({ baseRevision, localRevision, remoteRevision }),
      baseRevision,
      localRevision,
      remoteRevision,
      local,
      remote,
      active: binding !== undefined && input.local.activeLocalThreadIds.has(binding.localThreadId),
    });
  }

  const projectBindings = new Map(
    input.local.projectBindings.map((binding) => [binding.syncProjectId, binding] as const),
  );
  const eligibleRemoteProjectIds = new Set(
    [...eligibleRemoteThreads.values()].map((thread) => thread.syncProjectId),
  );
  const localProjectBindings = new Map(
    input.local.projectBindings.map(
      (binding) => [binding.syncProjectId, binding.projectId] as const,
    ),
  );
  const unlinkedProjects: ThreadSyncUnlinkedProject[] = [];
  for (const project of input.remote.projects.values()) {
    if (
      project.deletedAt !== null ||
      !eligibleRemoteProjectIds.has(project.syncProjectId) ||
      projectBindings.has(project.syncProjectId)
    )
      continue;
    const repositoryMatches = [...input.local.projects.values()].filter(
      (candidate) =>
        project.repositoryIdentity !== null &&
        candidate.repositoryIdentity?.canonicalKey === project.repositoryIdentity.canonicalKey,
    );
    const exactMatches = repositoryMatches.filter(
      (candidate) => candidate.repositoryRelativePath === project.repositoryRelativePath,
    );
    const uniqueCandidate =
      exactMatches.length === 1
        ? exactMatches[0]!
        : repositoryMatches.length === 1
          ? repositoryMatches[0]!
          : null;
    unlinkedProjects.push({
      project,
      reason:
        exactMatches.length > 1 || repositoryMatches.length > 1
          ? "ambiguous-match"
          : repositoryMatches.length === 1
            ? "workspace-missing"
            : "no-match",
      suggestedProjectId:
        uniqueCandidate === null
          ? null
          : (localProjectBindings.get(uniqueCandidate.syncProjectId) ?? null),
    });
  }

  const visibleEntries = entries.filter((entry) => !entry.active);
  const status: ThreadSyncStatus = {
    state: input.runState ?? "idle",
    configuration: publicThreadSyncConfiguration(input.state.configuration),
    baseRevision: aggregateRevision(
      entries.map((entry) => [entry.syncThreadId, entry.baseRevision]),
    ),
    localRevision: aggregateRevision(
      entries.map((entry) => [entry.syncThreadId, entry.localRevision]),
    ),
    remoteRevision: input.state.remoteRevision,
    lastFetchedAt: input.state.lastFetchedAt,
    pendingPullCount: visibleEntries.filter((entry) => entry.decision === "pull").length,
    pendingPushCount: visibleEntries.filter((entry) => entry.decision === "push").length,
    conflicts: visibleEntries
      .filter((entry) => entry.decision === "conflict" && entry.remoteRevision !== null)
      .map((entry) => ({
        threadId: entry.localThreadId ?? entry.syncThreadId,
        syncProjectId: entry.syncProjectId,
        title: entry.title,
        baseRevision: entry.baseRevision,
        localRevision: entry.localRevision,
        remoteRevision: entry.remoteRevision!,
      })),
    unlinkedProjects,
    lastError: input.lastError ?? null,
  };
  return { entries, status, state: input.state, local: input.local };
}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sqlClient = yield* Effect.serviceOption(SqlClient.SqlClient);
  const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const turnRepository = yield* ProjectionTurnRepository;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const git = yield* ThreadSyncGit;
  const statePath = path.join(config.stateDir, "thread-sync", "state.json");

  const provideIo = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
  const readRepository = (mirrorPath: string) => provideIo(readThreadSyncRepository(mirrorPath));

  const loaded = yield* Effect.result(provideIo(loadThreadSyncLocalState(statePath)));
  const initialState = loaded._tag === "Success" ? loaded.success : emptyThreadSyncLocalState();
  const initialStatus =
    loaded._tag === "Success"
      ? initialState.configuration === null
        ? disconnectedStatus()
        : {
            ...disconnectedStatus(),
            state: "idle" as const,
            configuration: publicThreadSyncConfiguration(initialState.configuration),
            remoteRevision: initialState.remoteRevision,
            lastFetchedAt: initialState.lastFetchedAt,
          }
      : disconnectedStatus(loaded.failure.detail);
  const stateRef = yield* Ref.make(initialState);
  const stateLoadErrorRef = yield* Ref.make<ThreadSyncError | null>(
    loaded._tag === "Failure" ? loaded.failure : null,
  );
  const remoteRef = yield* Ref.make<ThreadSyncRepositoryDocuments>(
    emptyThreadSyncRepositoryDocuments(),
  );
  const remoteV2Ref = yield* Ref.make<ThreadSyncV2RepositoryIndex | null>(null);
  const statusRef = yield* Ref.make<ThreadSyncStatus>(initialStatus);
  const changes = yield* PubSub.sliding<ThreadSyncStatus>(1);
  const mutex = yield* Semaphore.make(1);
  const startedRef = yield* Ref.make(false);

  const publish = (status: ThreadSyncStatus) =>
    Ref.set(statusRef, status).pipe(Effect.andThen(PubSub.publish(changes, status)), Effect.asVoid);

  const saveState = (
    state: ThreadSyncLocalState,
    options: { readonly resetInvalidLoadedState?: boolean } = {},
  ) =>
    Effect.gen(function* () {
      const loadError = yield* Ref.get(stateLoadErrorRef);
      if (loadError !== null && options.resetInvalidLoadedState !== true) {
        return yield* loadError;
      }
      yield* provideIo(saveThreadSyncLocalState(statePath, state));
      yield* Ref.set(stateRef, state);
      if (options.resetInvalidLoadedState === true) {
        yield* Ref.set(stateLoadErrorRef, null);
      }
    });

  const recoverBindingEvents = Effect.fn("ThreadSyncService.recoverBindingEvents")(function* () {
    const loadError = yield* Ref.get(stateLoadErrorRef);
    if (loadError !== null) return yield* loadError;
    let state = yield* Ref.get(stateRef);
    const latestSequence = yield* engine.latestSequence;
    if (state.lastBindingEventSequence === null) {
      state = { ...state, lastBindingEventSequence: latestSequence };
      yield* saveState(state);
      return state;
    }

    let cursor = state.lastBindingEventSequence;
    while (cursor < latestSequence) {
      const events = yield* Stream.runCollect(
        engine.readEvents(cursor, BINDING_REPLAY_PAGE_SIZE),
      ).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
        Effect.mapError((cause) =>
          syncError("status", "io-failed", `Could not recover sync bindings: ${String(cause)}`),
        ),
      );
      if (events.length === 0) {
        state = { ...state, lastBindingEventSequence: latestSequence };
      } else {
        state = replayThreadSyncBindingEvents(state, events);
      }
      yield* saveState(state);
      cursor = state.lastBindingEventSequence ?? latestSequence;
    }
    return state;
  });

  const assertV1HydrationSafe = Effect.fn("ThreadSyncService.assertV1HydrationSafe")(
    function* (): Effect.fn.Return<void, ThreadSyncError> {
      const readStats = snapshotQuery.getThreadSyncV1HydrationStats;
      if (readStats === undefined) {
        return yield* syncError(
          "export",
          "unsupported-version",
          "Legacy v1 sync is unavailable because bounded compatibility checks are not supported.",
        );
      }
      const stats = yield* readStats().pipe(
        Effect.mapError((cause) =>
          syncError("export", "io-failed", `Could not check legacy v1 sync size: ${String(cause)}`),
        ),
      );
      const documentCount = stats.projectCount + stats.threadCount;
      if (
        stats.estimatedBytes > THREAD_SYNC_V1_MAX_HYDRATION_BYTES ||
        stats.maxThreadEstimatedBytes > THREAD_SYNC_V1_MAX_THREAD_HYDRATION_BYTES ||
        stats.rowCount > THREAD_SYNC_V1_MAX_HYDRATION_ROWS ||
        documentCount > THREAD_SYNC_V1_MAX_DOCUMENTS
      ) {
        return yield* syncError(
          "export",
          "unsupported-version",
          "The local history is too large for the legacy v1 sync format. Configure a new or empty remote to create a bounded v2 repository.",
        );
      }
    },
  );

  const exportLocal = Effect.fn("ThreadSyncService.exportLocal")(function* (
    state: ThreadSyncLocalState,
    authoritativeProjects: ReadonlyMap<ThreadSyncProjectId, ThreadSyncProjectSnapshot> = new Map(),
    authoritativeThreads: ReadonlyMap<string, ThreadSyncThreadSnapshot> = new Map(),
  ): Effect.fn.Return<ExportedThreadSyncState, ThreadSyncError> {
    yield* assertV1HydrationSafe();
    const snapshot = yield* snapshotQuery
      .getSnapshot()
      .pipe(Effect.mapError((cause) => syncError("export", "io-failed", String(cause))));
    const projectBindingsByLocal = new Map(
      state.projectBindings.map((binding) => [binding.projectId, binding] as const),
    );
    const projectBindings: ThreadSyncLocalProjectBinding[] = [];
    const projects = new Map<ThreadSyncProjectId, ThreadSyncProjectSnapshot>();
    const syncProjectByLocal = new Map<ProjectId, ThreadSyncProjectId>();

    for (const project of snapshot.projects) {
      const descriptor = portableProjectDescriptor(
        project,
        path,
        projectBindingsByLocal.get(project.id),
      );
      if (
        projectBindings.some(
          (binding) =>
            binding.syncProjectId === descriptor.binding.syncProjectId ||
            binding.projectId === descriptor.binding.projectId,
        )
      ) {
        return yield* syncError(
          "export",
          "integrity-failed",
          "Two local projects resolve to the same portable project identifier.",
        );
      }
      projectBindings.push(descriptor.binding);
      projects.set(
        descriptor.snapshot.syncProjectId,
        selectPortableProjectDescriptor({
          local: descriptor.snapshot,
          remote: authoritativeProjects.get(descriptor.snapshot.syncProjectId),
        }),
      );
      syncProjectByLocal.set(project.id, descriptor.snapshot.syncProjectId);
    }

    const threadBindings = reconcileExportedThreadBindings({
      existing: state.threadBindings.map((binding) => {
        const remote = authoritativeThreads.get(binding.syncThreadId);
        return restoreSynchronizedThreadProjectIdentity({
          binding,
          remote:
            remote === undefined
              ? undefined
              : {
                  revision: threadSyncRevision(remote),
                  syncProjectId: remote.syncProjectId,
                },
        });
      }),
      threads: snapshot.threads,
      syncProjectByLocal,
    });
    const syncThreadByLocal = new Map(
      threadBindings.map((binding) => [binding.localThreadId, binding.syncThreadId] as const),
    );
    const portablePlanIdsByLocalThread = new Map<
      ThreadId,
      ReadonlyMap<OrchestrationProposedPlanId, OrchestrationProposedPlanId>
    >();
    for (const thread of snapshot.threads) {
      const syncThreadId = syncThreadByLocal.get(thread.id);
      if (syncThreadId === undefined) continue;
      portablePlanIdsByLocalThread.set(
        thread.id,
        new Map(
          thread.proposedPlans.map(
            (plan, index) => [plan.id, canonicalThreadSyncPlanId(syncThreadId, index)] as const,
          ),
        ),
      );
    }
    const threads = new Map<string, ThreadSyncThreadSnapshot>();
    const blobs = new Map<string, Uint8Array>();
    const attachmentExportBudget: ThreadSyncAttachmentExportBudget = { consumedBytes: 0 };
    const exportedAttachmentsByPath = new Map<
      string,
      { readonly blobHash: string; readonly bytes: Uint8Array }
    >();
    const activeLocalThreadIds = new Set<ThreadId>();

    for (const thread of snapshot.threads) {
      const binding = threadBindings.find((entry) => entry.localThreadId === thread.id);
      if (binding === undefined) continue;
      const turns = yield* turnRepository
        .listByThreadId({ threadId: thread.id })
        .pipe(Effect.mapError((cause) => syncError("export", "io-failed", String(cause))));
      if (isThreadActive(thread, turns)) {
        activeLocalThreadIds.add(thread.id);
        continue;
      }

      const terminalTurns: ThreadSyncTerminalTurn[] = [];
      for (const turn of turns) {
        if (
          turn.turnId === null ||
          turn.completedAt === null ||
          (turn.state !== "interrupted" && turn.state !== "completed" && turn.state !== "error")
        ) {
          continue;
        }
        const hasSourceThread = turn.sourceProposedPlanThreadId !== null;
        const hasSourcePlan = turn.sourceProposedPlanId !== null;
        if (hasSourceThread !== hasSourcePlan) {
          return yield* syncError(
            "export",
            "integrity-failed",
            `Turn '${turn.turnId}' has an incomplete source plan reference.`,
          );
        }
        let sourceProposedPlanThreadId: ThreadId | null = null;
        let sourceProposedPlanId: OrchestrationProposedPlanId | null = null;
        if (turn.sourceProposedPlanThreadId !== null && turn.sourceProposedPlanId !== null) {
          const sourceSyncThreadId = syncThreadByLocal.get(turn.sourceProposedPlanThreadId);
          if (sourceSyncThreadId === undefined) {
            return yield* syncError(
              "export",
              "integrity-failed",
              `Turn '${turn.turnId}' references a thread without a portable binding.`,
            );
          }
          const portableSourcePlanId = portablePlanIdsByLocalThread
            .get(turn.sourceProposedPlanThreadId)
            ?.get(turn.sourceProposedPlanId);
          if (portableSourcePlanId === undefined) {
            return yield* syncError(
              "export",
              "integrity-failed",
              `Turn '${turn.turnId}' references a plan outside its source thread.`,
            );
          }
          sourceProposedPlanThreadId = sourceSyncThreadId;
          // Self references are canonicalized with this thread's own plan map.
          // Cross-thread references already need the source thread's portable id.
          sourceProposedPlanId =
            sourceSyncThreadId === binding.syncThreadId
              ? turn.sourceProposedPlanId
              : portableSourcePlanId;
        }
        terminalTurns.push({
          turnId: turn.turnId,
          pendingMessageId: turn.pendingMessageId,
          sourceProposedPlanThreadId,
          sourceProposedPlanId,
          state: turn.state,
          requestedAt: turn.requestedAt,
          startedAt: turn.startedAt,
          completedAt: turn.completedAt,
          assistantMessageId: turn.assistantMessageId,
        });
      }
      const terminalTurnIds = new Set(terminalTurns.map((turn) => turn.turnId));
      const messages = [] as Array<ThreadSyncThreadSnapshot["messages"][number]>;
      for (const message of thread.messages) {
        if (
          message.streaming ||
          (message.turnId !== null && !terminalTurnIds.has(message.turnId))
        ) {
          continue;
        }
        const attachments: ThreadSyncImageAttachment[] = [];
        for (const attachment of message.attachments ?? []) {
          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: config.attachmentsDir,
            attachment,
          });
          if (attachmentPath === null) {
            return yield* syncError(
              "export",
              "integrity-failed",
              `Attachment '${attachment.name}' has an invalid local path.`,
            );
          }
          let exported = exportedAttachmentsByPath.get(attachmentPath);
          if (exported === undefined) {
            const bytes = yield* readThreadSyncAttachmentForExport(
              {
                filePath: attachmentPath,
                name: attachment.name,
                declaredSizeBytes: attachment.sizeBytes,
                budget: attachmentExportBudget,
              },
              (filePath) => fileSystem.readFile(filePath),
            );
            exported = {
              bytes,
              blobHash: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
            };
            exportedAttachmentsByPath.set(attachmentPath, exported);
          }
          const { blobHash, bytes } = exported;
          blobs.set(blobHash, bytes);
          attachments.push({
            type: "image",
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: bytes.byteLength,
            blobHash,
          });
        }
        messages.push({
          id: message.id,
          role: message.role,
          text: message.text,
          attachments,
          turnId: message.turnId,
          streaming: false,
          createdAt: message.createdAt,
          updatedAt: message.updatedAt,
        });
      }

      const latestTurn =
        thread.latestTurn === null || !terminalTurnIds.has(thread.latestTurn.turnId)
          ? null
          : (terminalTurns.find((turn) => turn.turnId === thread.latestTurn?.turnId) ?? null);
      const proposedPlans = [] as Array<ThreadSyncThreadSnapshot["proposedPlans"][number]>;
      for (const plan of thread.proposedPlans) {
        let implementationThreadId: ThreadId | null = null;
        if (plan.implementationThreadId !== null) {
          implementationThreadId = syncThreadByLocal.get(plan.implementationThreadId) ?? null;
          if (implementationThreadId === null) {
            return yield* syncError(
              "export",
              "integrity-failed",
              `Plan '${plan.id}' references an implementation thread without a portable binding.`,
            );
          }
        }
        proposedPlans.push({ ...plan, implementationThreadId });
      }
      threads.set(
        binding.syncThreadId,
        canonicalizeThreadSyncThreadSnapshot({
          formatVersion: 1,
          threadId: binding.syncThreadId,
          syncProjectId: binding.syncProjectId,
          title: thread.title,
          coagent:
            thread.coagent !== undefined &&
            thread.coagent !== null &&
            thread.coagent.status !== "preparing" &&
            syncThreadByLocal.has(thread.coagent.parentThreadId)
              ? {
                  parentThreadId: syncThreadByLocal.get(thread.coagent.parentThreadId)!,
                  creationMode: thread.coagent.creationMode,
                  status: thread.coagent.status,
                }
              : null,
          latestTurn,
          turns: terminalTurns,
          lifecycle: {
            archivedAt: thread.archivedAt,
            settledOverride: thread.settledOverride,
            settledAt: thread.settledAt,
            deletedAt: thread.deletedAt,
          },
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          messages,
          proposedPlans,
          activities: thread.activities.map((activity) => ({
            id: activity.id,
            tone: activity.tone,
            kind: activity.kind,
            summary: activity.summary,
            turnId: activity.turnId,
            sequence: activity.sequence ?? null,
            createdAt: activity.createdAt,
          })),
        }),
      );
    }

    return {
      projects,
      threads: pruneDanglingPortableCoagents(
        threads,
        [...authoritativeThreads.values()]
          .filter((thread) => thread.lifecycle.deletedAt === null)
          .map((thread) => thread.threadId),
      ),
      blobs,
      activeLocalThreadIds,
      projectBindings,
      threadBindings,
    };
  });

  const exportLocalV2 = Effect.fn("ThreadSyncService.exportLocalV2")(function* (
    state: ThreadSyncLocalState,
    remote: ThreadSyncV2RepositoryIndex,
    localThreadIds: ReadonlySet<ThreadId> = new Set(),
  ): Effect.fn.Return<ExportedThreadSyncV2State, ThreadSyncError> {
    const authoritativeProjects = remote.projects;
    const getIndex = snapshotQuery.getThreadSyncExportIndex;
    if (getIndex === undefined) {
      return yield* syncError(
        "export",
        "io-failed",
        "The projection query does not support bounded v2 export.",
      );
    }
    const unfilteredIndex = yield* getIndex().pipe(
      Effect.mapError((cause) => syncError("export", "io-failed", String(cause))),
    );
    const retiredSyncThreadIds = resolveRetiredSyncThreadIds({
      threadBindings: state.threadBindings,
      localThreads: unfilteredIndex.threads,
      remoteThreadIds: remote.threads.keys(),
    });
    const eligibleThreads = unfilteredIndex.threads.filter(isPortablePrimaryThreadForSync);
    const eligibleRemoteProjectIds = new Set(
      [...portablePrimaryRemoteThreads(remote).values()].map((thread) => thread.syncProjectId),
    );
    const eligibleProjectIds = new Set([
      ...eligibleThreads.map((thread) => thread.projectId),
      ...state.projectBindings
        .filter((binding) => eligibleRemoteProjectIds.has(binding.syncProjectId))
        .map((binding) => binding.projectId),
    ]);
    const index: ProjectionSnapshotQuery.ProjectionThreadSyncExportIndex = {
      ...unfilteredIndex,
      projects: unfilteredIndex.projects.filter(
        (project) => project.deletedAt === null && eligibleProjectIds.has(project.id),
      ),
      threads: eligibleThreads,
    };

    const describeProjects = (bindings: ReadonlyArray<ThreadSyncLocalProjectBinding>) => {
      const byLocal = new Map(bindings.map((binding) => [binding.projectId, binding] as const));
      const nextBindings: ThreadSyncLocalProjectBinding[] = [];
      const projects = new Map<ThreadSyncProjectId, ThreadSyncProjectSnapshot>();
      const syncProjectByLocal = new Map<ProjectId, ThreadSyncProjectId>();
      for (const project of index.projects) {
        const descriptor = portableProjectDescriptor(project, path, byLocal.get(project.id));
        if (projects.has(descriptor.binding.syncProjectId)) {
          throw syncError(
            "export",
            "integrity-failed",
            "Two local projects resolve to the same portable project identifier.",
          );
        }
        nextBindings.push(descriptor.binding);
        projects.set(
          descriptor.snapshot.syncProjectId,
          selectPortableProjectDescriptor({
            local: descriptor.snapshot,
            remote: authoritativeProjects.get(descriptor.snapshot.syncProjectId),
          }),
        );
        syncProjectByLocal.set(project.id, descriptor.snapshot.syncProjectId);
      }
      return { bindings: nextBindings, projects, syncProjectByLocal };
    };

    let described = yield* Effect.try({
      try: () => describeProjects(state.projectBindings),
      catch: (cause) =>
        isThreadSyncError(cause) ? cause : syncError("export", "integrity-failed", String(cause)),
    });
    const linkedBindings = [...described.bindings];
    const boundRemote = new Set(linkedBindings.map((binding) => binding.syncProjectId));
    for (const remoteProject of authoritativeProjects.values()) {
      if (remoteProject.deletedAt !== null || boundRemote.has(remoteProject.syncProjectId))
        continue;
      const match = selectAutoLinkProject(remoteProject, described.projects.values());
      if (match === null) continue;
      const localBinding = described.bindings.find(
        (binding) => binding.syncProjectId === match.syncProjectId,
      );
      if (localBinding === undefined) continue;
      const existingIndex = linkedBindings.findIndex(
        (binding) => binding.projectId === localBinding.projectId,
      );
      if (existingIndex >= 0) linkedBindings.splice(existingIndex, 1);
      linkedBindings.push({
        syncProjectId: remoteProject.syncProjectId,
        projectId: localBinding.projectId,
        linkedAt: localBinding.linkedAt,
      });
      boundRemote.add(remoteProject.syncProjectId);
    }
    described = yield* Effect.try({
      try: () => describeProjects(linkedBindings),
      catch: (cause) =>
        isThreadSyncError(cause) ? cause : syncError("export", "integrity-failed", String(cause)),
    });

    const threadBindings = reconcileExportedThreadBindings({
      existing: state.threadBindings.map((binding) =>
        restoreSynchronizedThreadProjectIdentity({
          binding,
          remote: remote.threads.get(binding.syncThreadId),
        }),
      ),
      threads: index.threads,
      syncProjectByLocal: described.syncProjectByLocal,
    });
    const bindingsByLocalThread = new Map(
      threadBindings.map((binding) => [binding.localThreadId, binding] as const),
    );
    const syncThreadByLocal = new Map(
      threadBindings.map((binding) => [binding.localThreadId, binding.syncThreadId] as const),
    );
    const syncProjectByLocalThread = new Map(
      threadBindings.map((binding) => [binding.localThreadId, binding.syncProjectId] as const),
    );
    const descriptors = new Map<
      ThreadId,
      {
        readonly localThreadId: ThreadId;
        readonly header: ThreadSyncV2ThreadSource["header"];
        readonly sourceKeyHash: string;
        readonly threadSequence: number;
      }
    >();
    yield* Effect.try({
      try: () => {
        for (const local of index.threads) {
          const binding = bindingsByLocalThread.get(local.id);
          if (binding === undefined) continue;
          const header = projectionThreadSyncV2Header({
            local,
            syncProjectId: binding.syncProjectId,
            syncThreadId: binding.syncThreadId,
            syncThreadByLocal,
          });
          descriptors.set(binding.syncThreadId, {
            localThreadId: local.id,
            header,
            sourceKeyHash: threadSyncV2Sha256(
              projectionThreadSyncV2SourceKey({
                header,
                threadSequence: local.threadSequence,
              }),
            ),
            threadSequence: local.threadSequence,
          });
        }
      },
      catch: (cause) =>
        isThreadSyncError(cause) ? cause : syncError("export", "integrity-failed", String(cause)),
    });
    const blobs = new Map<string, ThreadSyncV2BlobSource<ThreadSyncError>>();
    const attachmentByPath = new Map<
      string,
      {
        readonly source: ThreadSyncV2BlobSource<ThreadSyncError>;
        readonly before: NodeFS.Stats;
      }
    >();
    let attachmentBytes = 0;
    const sameFile = (left: NodeFS.Stats, right: NodeFS.Stats) =>
      !right.isSymbolicLink() &&
      right.isFile() &&
      left.dev === right.dev &&
      left.ino === right.ino &&
      left.size === right.size;

    const prepared = yield* prepareProjectionThreadSyncV2Export({
      query: snapshotQuery,
      index,
      syncProjectByLocalThread,
      syncThreadByLocal,
      localThreadIds,
      mapAttachments: ({ message }) =>
        Effect.gen(function* () {
          const attachments: ThreadSyncImageAttachment[] = [];
          for (const attachment of message.attachments ?? []) {
            const attachmentPath = resolveAttachmentPath({
              attachmentsDir: config.attachmentsDir,
              attachment,
            });
            if (attachmentPath === null) {
              return yield* syncError(
                "export",
                "integrity-failed",
                `Attachment '${attachment.name}' has an invalid local path.`,
              );
            }
            const localAttachmentPath = attachmentPath;
            let preparedAttachment = attachmentByPath.get(localAttachmentPath);
            if (preparedAttachment === undefined) {
              if (blobs.size >= THREAD_SYNC_V2_MAX_BLOB_COUNT) {
                return yield* syncError(
                  "export",
                  "integrity-failed",
                  "The local v2 export exceeds the attachment count limit.",
                );
              }
              const before = yield* Effect.try({
                try: () => NodeFS.lstatSync(localAttachmentPath),
                catch: (cause) =>
                  syncError(
                    "export",
                    "integrity-failed",
                    `Attachment '${attachment.name}' could not be inspected: ${String(cause)}`,
                  ),
              });
              if (
                before.isSymbolicLink() ||
                !before.isFile() ||
                before.size !== attachment.sizeBytes ||
                before.size > THREAD_SYNC_MAX_BLOB_BYTES ||
                attachmentBytes > THREAD_SYNC_MAX_TOTAL_BLOB_BYTES - before.size
              ) {
                return yield* syncError(
                  "export",
                  "integrity-failed",
                  `Attachment '${attachment.name}' is not a bounded regular file of its declared size.`,
                );
              }
              const blobHash = yield* Effect.tryPromise({
                try: async () => {
                  const hash = NodeCrypto.createHash("sha256");
                  let size = 0;
                  for await (const chunk of NodeFS.createReadStream(localAttachmentPath)) {
                    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
                    size += bytes.byteLength;
                    if (size > before.size) throw new Error("attachment grew while hashing");
                    hash.update(bytes);
                  }
                  const after = NodeFS.lstatSync(localAttachmentPath);
                  if (size !== before.size || !sameFile(before, after)) {
                    throw new Error("attachment changed while hashing");
                  }
                  return hash.digest("hex");
                },
                catch: (cause) =>
                  syncError(
                    "export",
                    "integrity-failed",
                    `Attachment '${attachment.name}' could not be hashed safely: ${String(cause)}`,
                  ),
              });
              const source: ThreadSyncV2BlobSource<ThreadSyncError> = {
                sha256: blobHash,
                sizeBytes: before.size,
                bytes: (offset) => {
                  async function* iterate(): AsyncGenerator<Uint8Array> {
                    const opened = NodeFS.lstatSync(localAttachmentPath);
                    if (!sameFile(before, opened)) {
                      throw syncError(
                        "export",
                        "integrity-failed",
                        `Attachment '${attachment.name}' changed before export.`,
                      );
                    }
                    let size = offset;
                    for await (const chunk of NodeFS.createReadStream(localAttachmentPath, {
                      start: offset,
                    })) {
                      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
                      size += bytes.byteLength;
                      if (size > before.size) {
                        throw syncError(
                          "export",
                          "integrity-failed",
                          `Attachment '${attachment.name}' grew during export.`,
                        );
                      }
                      yield bytes;
                    }
                    const closed = NodeFS.lstatSync(localAttachmentPath);
                    if (size !== before.size || !sameFile(before, closed)) {
                      throw syncError(
                        "export",
                        "integrity-failed",
                        `Attachment '${attachment.name}' changed during export.`,
                      );
                    }
                  }
                  return Stream.fromAsyncIterable(iterate(), (cause) =>
                    isThreadSyncError(cause)
                      ? cause
                      : syncError("export", "io-failed", String(cause)),
                  );
                },
              };
              const duplicate = blobs.get(blobHash);
              if (duplicate !== undefined && duplicate.sizeBytes !== source.sizeBytes) {
                return yield* syncError(
                  "export",
                  "integrity-failed",
                  "Two local attachments share a digest but not a size.",
                );
              }
              blobs.set(blobHash, source);
              attachmentBytes += before.size;
              preparedAttachment = { source, before };
              attachmentByPath.set(localAttachmentPath, preparedAttachment);
            }
            attachments.push({
              type: "image",
              name: attachment.name,
              mimeType: attachment.mimeType,
              sizeBytes: preparedAttachment.source.sizeBytes,
              blobHash: preparedAttachment.source.sha256,
            });
          }
          return attachments;
        }),
    });
    const sources = new Map(prepared.sources.map((source) => [source.header.threadId, source]));
    const revisions = new Map<ThreadId, ThreadSyncRevision>();
    const importWatermarks =
      snapshotQuery.listThreadSyncImportWatermarks === undefined
        ? []
        : yield* snapshotQuery
            .listThreadSyncImportWatermarks()
            .pipe(Effect.mapError((cause) => syncError("export", "io-failed", String(cause))));
    const importWatermarksByThread = new Map(
      importWatermarks.map((watermark) => [watermark.threadId, watermark] as const),
    );
    const bindingsBySyncId = new Map(
      threadBindings.map((binding) => [binding.syncThreadId, binding] as const),
    );
    for (const [threadId, descriptor] of descriptors) {
      const binding = bindingsBySyncId.get(threadId);
      const remoteEntry = remote.threads.get(threadId);
      revisions.set(
        threadId,
        resolveThreadSyncV2LocalRevision({
          binding,
          descriptor,
          remote: remoteEntry,
          importWatermark: importWatermarksByThread.get(descriptor.localThreadId),
        }),
      );
    }
    return {
      index,
      projects: described.projects,
      sources,
      descriptors,
      revisions,
      blobs,
      activeLocalThreadIds: prepared.activeLocalThreadIds,
      retiredSyncThreadIds,
      projectBindings: described.bindings,
      threadBindings,
    };
  });

  const migrateV1RepositoryToV2 = Effect.fn("ThreadSyncService.migrateV1RepositoryToV2")(
    function* (input: {
      readonly mirrorPath: string;
      readonly state: ThreadSyncLocalState;
      readonly remote: ThreadSyncRepositoryDocuments;
      readonly updatedAt: IsoDateTime;
    }) {
      const portableThreads = [...input.remote.threads.values()].filter(
        isPortablePrimaryThreadForSync,
      );
      const portableProjectIds = new Set(portableThreads.map((thread) => thread.syncProjectId));
      const source: ThreadSyncV2RepositorySource<ThreadSyncError> = {
        projects: new Map(
          [...input.remote.projects].filter(
            ([syncProjectId, project]) =>
              project.deletedAt === null && portableProjectIds.has(syncProjectId),
          ),
        ),
        threads: portableThreads.map(threadSyncV2SourceFromV1Snapshot),
        blobs: [...input.remote.blobs.entries()].map(([sha256, bytes]) => ({
          sha256,
          sizeBytes: bytes.byteLength,
          bytes: (offset: number) => Stream.fromIterable([bytes.subarray(offset)]),
        })),
        updatedAt: input.updatedAt,
      };
      const written = yield* writeThreadSyncV2Repository({
        mirrorPath: input.mirrorPath,
        source,
      });
      const remoteV2: ThreadSyncV2RepositoryIndex = {
        manifest: written.manifest,
        projects: new Map(source.projects),
        threads: new Map(written.manifest.threads.map((entry) => [entry.threadId, entry])),
        threadManifests: new Map(
          [...written.threadResults].map(([threadId, result]) => [threadId, result.manifest]),
        ),
        blobs: new Map(written.manifest.blobs.map((entry) => [entry.sha256, entry])),
      };

      // A binding based on the exact v1 remote document still has an unchanged
      // remote side after conversion. Rebase only that known-safe case onto the
      // new v2 revision. A stale or missing base stays stale, so v2 analysis
      // still requires an explicit conflict choice instead of losing either
      // side during the upgrade.
      const state: ThreadSyncLocalState = {
        ...input.state,
        threadBindings: input.state.threadBindings.map((binding) => {
          const prior = input.remote.threads.get(binding.syncThreadId);
          const migrated = remoteV2.threads.get(binding.syncThreadId);
          return prior !== undefined &&
            migrated !== undefined &&
            binding.baseRevision === threadSyncRevision(prior)
            ? { ...binding, baseRevision: migrated.revision }
            : binding;
        }),
      };
      return { remoteV2, state };
    },
  );

  const autoLinkProjects = (
    state: ThreadSyncLocalState,
    local: ExportedThreadSyncState,
    remote: ThreadSyncRepositoryDocuments,
    now: IsoDateTime,
  ): ThreadSyncLocalState => {
    const bindings = [...local.projectBindings];
    const boundRemote = new Set(bindings.map((binding) => binding.syncProjectId));
    for (const remoteProject of remote.projects.values()) {
      if (remoteProject.deletedAt !== null || boundRemote.has(remoteProject.syncProjectId))
        continue;
      const match = selectAutoLinkProject(remoteProject, local.projects.values());
      if (match === null) continue;
      const localBinding = local.projectBindings.find(
        (binding) => binding.syncProjectId === match.syncProjectId,
      );
      if (localBinding === undefined) continue;
      const existingIndex = bindings.findIndex(
        (binding) => binding.projectId === localBinding.projectId,
      );
      if (existingIndex >= 0) bindings.splice(existingIndex, 1);
      bindings.push({
        syncProjectId: remoteProject.syncProjectId,
        projectId: localBinding.projectId,
        linkedAt: now,
      });
      boundRemote.add(remoteProject.syncProjectId);
    }
    return { ...state, projectBindings: bindings };
  };

  const analyze = Effect.fn("ThreadSyncService.analyze")(function* (
    state: ThreadSyncLocalState,
    remote: ThreadSyncRepositoryDocuments,
    runState: ThreadSyncStatus["state"] = "idle",
    lastError: string | null = null,
  ) {
    const local = yield* exportLocal(state, remote.projects, remote.threads);
    const now = DateTime.formatIso(yield* DateTime.now);
    const linkedState = autoLinkProjects(
      { ...state, projectBindings: local.projectBindings, threadBindings: local.threadBindings },
      local,
      remote,
      now,
    );
    const relinkedLocal = yield* exportLocal(linkedState, remote.projects, remote.threads);
    const result = analyzeThreadSyncState({
      local: relinkedLocal,
      remote,
      state: linkedState,
      runState,
      lastError,
    });
    const converged = new Map(
      result.entries
        .filter((entry) => entry.decision === "converged" || entry.decision === "unchanged")
        .map((entry) => [entry.syncThreadId, entry.localRevision] as const),
    );
    const reconciledState = {
      ...linkedState,
      threadBindings: linkedState.threadBindings.map((binding) => ({
        ...binding,
        baseRevision: converged.get(binding.syncThreadId) ?? binding.baseRevision,
      })),
    };
    return {
      ...result,
      state: reconciledState,
      local: relinkedLocal,
      status: {
        ...result.status,
        configuration: publicThreadSyncConfiguration(reconciledState.configuration),
      },
    };
  });

  const analyzePreparedV2 = (
    state: ThreadSyncLocalState,
    remote: ThreadSyncV2RepositoryIndex,
    local: ExportedThreadSyncV2State,
    runState: ThreadSyncStatus["state"] = "idle",
    lastError: string | null = null,
  ): ThreadSyncV2Analysis => {
    const linkedState: ThreadSyncLocalState = {
      ...state,
      projectBindings: local.projectBindings,
      threadBindings: [
        ...state.threadBindings.filter((binding) =>
          local.retiredSyncThreadIds.has(binding.syncThreadId),
        ),
        ...local.threadBindings,
      ],
    };
    const result = analyzeThreadSyncV2State({
      local,
      remote,
      state: linkedState,
      runState,
      lastError,
    });
    const converged = new Map(
      result.entries
        .filter((entry) => entry.decision === "converged" || entry.decision === "unchanged")
        .map((entry) => [entry.syncThreadId, entry.localRevision] as const),
    );
    const reconciledState: ThreadSyncLocalState = {
      ...linkedState,
      threadBindings: linkedState.threadBindings.map((binding) => ({
        ...binding,
        baseRevision: converged.get(binding.syncThreadId) ?? binding.baseRevision,
      })),
    };
    return {
      ...result,
      state: reconciledState,
      status: {
        ...result.status,
        configuration: publicThreadSyncConfiguration(reconciledState.configuration),
      },
    };
  };

  const cacheV2SourceKeys = (
    state: ThreadSyncLocalState,
    local: ExportedThreadSyncV2State,
    localThreadIds: ReadonlySet<ThreadId>,
  ): ThreadSyncLocalState => ({
    ...state,
    threadBindings: state.threadBindings.map((binding) => {
      if (!localThreadIds.has(binding.localThreadId)) return binding;
      const descriptor = local.descriptors.get(binding.syncThreadId);
      return descriptor === undefined
        ? binding
        : { ...binding, sourceKeyHash: descriptor.sourceKeyHash };
    }),
  });

  const analyzeV2 = Effect.fn("ThreadSyncService.analyzeV2")(function* (
    state: ThreadSyncLocalState,
    remote: ThreadSyncV2RepositoryIndex,
    runState: ThreadSyncStatus["state"] = "idle",
    lastError: string | null = null,
  ) {
    const local = yield* exportLocalV2(state, remote);
    return analyzePreparedV2(state, remote, local, runState, lastError);
  });

  interface ImportSelection {
    readonly snapshot: ThreadSyncThreadSnapshot;
    readonly targetThreadId: ThreadId;
    readonly projectId: ProjectId | null;
    readonly mode: "create" | "replace";
    readonly expectedLocalUpdatedAt: IsoDateTime | null;
    readonly sourceRevision: ThreadSyncRevision;
    readonly bindingUpdates: ReadonlyArray<ThreadSyncBindingUpdate>;
  }

  const importV2Selection = Effect.fn("ThreadSyncService.importV2Selection")(function* (input: {
    readonly configuration: NonNullable<ThreadSyncLocalState["configuration"]>;
    readonly mirrorPath: string;
    readonly repository: ThreadSyncV2RepositoryIndex;
    readonly entry: ThreadSyncV2ThreadEntry;
    readonly selection: Omit<ThreadSyncV2ImportSelection, "reader">;
  }) {
    const baseReader = yield* readThreadSyncV2Thread({
      mirrorPath: input.mirrorPath,
      entry: input.entry,
    });
    const materializePayloads = (paths: ReadonlyArray<string>) =>
      paths.length === 0 || git.materializePayloadPaths === undefined
        ? Effect.void
        : git.materializePayloadPaths({
            configuration: input.configuration,
            mirrorPath: input.mirrorPath,
            paths,
          });
    const prunePayloads =
      git.prunePayloads === undefined
        ? Effect.void
        : git
            .prunePayloads({
              configuration: input.configuration,
              mirrorPath: input.mirrorPath,
            })
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Failed to prune synchronized payload files.", {
                  cause: String(cause),
                }),
              ),
            );
    const chunkPathsFromOrdinal = (nextOrdinal: number) =>
      baseReader.manifest.chunks
        .filter((chunk) => chunk.lastRecordOrdinal >= nextOrdinal)
        .map((chunk) => `${THREAD_SYNC_V2_CHUNKS_DIRECTORY}/${chunk.fileName}`);
    const reader: typeof baseReader = {
      ...baseReader,
      records: Stream.unwrap(
        materializePayloads(chunkPathsFromOrdinal(0)).pipe(Effect.as(baseReader.records)),
      ),
      recordsFromOrdinal: (nextOrdinal) =>
        Stream.unwrap(
          materializePayloads(chunkPathsFromOrdinal(nextOrdinal)).pipe(
            Effect.as(baseReader.recordsFromOrdinal(nextOrdinal)),
          ),
        ),
    };
    const threadSegment = toSafeThreadAttachmentSegment(input.selection.targetThreadId);
    if (threadSegment === null) {
      return yield* syncError("import", "invalid-snapshot", "The target thread id is invalid.");
    }
    const staleAttachmentOwnership = new Map<string, ExclusiveFileOwnership>();
    if (input.selection.mode === "replace") {
      const getIndex = snapshotQuery.getThreadSyncExportIndex;
      const listMessages = snapshotQuery.listThreadSyncExportMessagesPage;
      if (getIndex === undefined || listMessages === undefined) {
        return yield* syncError(
          "import",
          "io-failed",
          "The projection query does not support bounded attachment cleanup.",
        );
      }
      const index = yield* getIndex().pipe(
        Effect.mapError((cause) => syncError("import", "io-failed", String(cause))),
      );
      const localThread = index.threads.find(
        (thread) => thread.id === input.selection.targetThreadId,
      );
      if (localThread !== undefined) {
        let after: ProjectionSnapshotQuery.ProjectionThreadSyncEntityCursor | null = null;
        while (true) {
          const page: ProjectionSnapshotQuery.ProjectionThreadSyncPage<
            ProjectionSnapshotQuery.ProjectionThreadSyncExportMessageRow,
            ProjectionSnapshotQuery.ProjectionThreadSyncEntityCursor
          > = yield* listMessages({
            threadSequence: localThread.threadSequence,
            threadId: localThread.id,
            after,
            limit: 128,
            attachmentsOnly: true,
          }).pipe(Effect.mapError((cause) => syncError("import", "io-failed", String(cause))));
          for (const row of page.rows) {
            for (const attachment of row.value.attachments ?? []) {
              const filePath = resolveAttachmentPath({
                attachmentsDir: config.attachmentsDir,
                attachment,
              });
              if (filePath === null || staleAttachmentOwnership.has(filePath)) continue;
              const ownership = yield* Effect.try({
                try: () => {
                  try {
                    const info = NodeFS.lstatSync(filePath);
                    return info.isFile() && !info.isSymbolicLink()
                      ? ({
                          filePath,
                          device: info.dev,
                          inode: Number.isSafeInteger(info.ino) ? info.ino : null,
                        } satisfies ExclusiveFileOwnership)
                      : null;
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
                },
                catch: (cause) =>
                  syncError(
                    "import",
                    "io-failed",
                    `A local attachment could not be inspected safely: ${String(cause)}`,
                  ),
              });
              if (ownership !== null) staleAttachmentOwnership.set(filePath, ownership);
            }
          }
          if (page.next === null) break;
          after = page.next;
        }
      }
    }
    const attachmentJournalRoot = NodePath.join(
      config.stateDir,
      "thread-sync",
      "import-v2-attachments",
    );
    const journalPath = (stageId: ThreadSyncImportStageId) =>
      NodePath.join(
        attachmentJournalRoot,
        `${NodeCrypto.createHash("sha256").update(stageId).digest("hex")}.json`,
      );
    const decodeJournal = (
      contents: string,
      expectedStageId?: ThreadSyncImportStageId,
    ): ThreadSyncV2AttachmentJournal => {
      const value = JSON.parse(contents) as Partial<ThreadSyncV2AttachmentJournal>;
      if (
        typeof value.stageId !== "string" ||
        (expectedStageId !== undefined && value.stageId !== expectedStageId) ||
        typeof value.prepared !== "boolean" ||
        !Array.isArray(value.entries) ||
        value.entries.length > 512
      ) {
        throw new Error("The attachment import journal is invalid.");
      }
      for (const raw of value.entries) {
        const entry = raw as Partial<ThreadSyncV2AttachmentJournalEntry>;
        if (
          entry.attachment?.type !== "image" ||
          typeof entry.attachment.id !== "string" ||
          typeof entry.attachment.name !== "string" ||
          typeof entry.attachment.mimeType !== "string" ||
          !Number.isSafeInteger(entry.attachment.sizeBytes) ||
          entry.attachment.sizeBytes < 0 ||
          typeof entry.blobHash !== "string" ||
          !/^[a-f0-9]{64}$/.test(entry.blobHash) ||
          typeof entry.finalRelativePath !== "string" ||
          NodePath.isAbsolute(entry.finalRelativePath) ||
          entry.finalRelativePath === "" ||
          entry.finalRelativePath === ".." ||
          entry.finalRelativePath.startsWith(`..${NodePath.sep}`) ||
          typeof entry.sourceMessageId !== "string" ||
          typeof entry.targetThreadId !== "string" ||
          typeof entry.targetMessageId !== "string" ||
          typeof entry.index !== "number" ||
          !Number.isSafeInteger(entry.index) ||
          entry.index < 0 ||
          (entry.ownership !== null &&
            (typeof entry.ownership !== "object" ||
              typeof entry.ownership.filePath !== "string" ||
              typeof entry.ownership.device !== "number"))
        ) {
          throw new Error("The attachment import journal contains an invalid entry.");
        }
      }
      return value as ThreadSyncV2AttachmentJournal;
    };
    const readJournalFile = (filePath: string, expectedStageId?: ThreadSyncImportStageId) =>
      Effect.try({
        try: () => {
          try {
            const info = NodeFS.lstatSync(filePath);
            if (info.isSymbolicLink() || !info.isFile() || info.size > 2 * 1024 * 1024) {
              throw new Error("The attachment import journal is not a bounded regular file.");
            }
            return decodeJournal(NodeFS.readFileSync(filePath, "utf8"), expectedStageId);
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
        },
        catch: (cause) => syncError("import", "io-failed", String(cause)),
      });
    const readJournal = (stageId: ThreadSyncImportStageId) =>
      readJournalFile(journalPath(stageId), stageId);
    const writeJournal = (journal: ThreadSyncV2AttachmentJournal) =>
      provideIo(
        writeFileStringAtomically({
          filePath: journalPath(journal.stageId),
          contents: JSON.stringify(journal),
        }),
      ).pipe(Effect.mapError((cause) => syncError("import", "io-failed", String(cause))));
    const removeJournal = (stageId: ThreadSyncImportStageId) =>
      Effect.try({
        try: () => {
          try {
            NodeFS.unlinkSync(journalPath(stageId));
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
        },
        catch: (cause) => syncError("import", "io-failed", String(cause)),
      });
    const targetPathFor = (entry: ThreadSyncV2StagedAttachment) => {
      const targetPath = resolveAttachmentPath({
        attachmentsDir: config.attachmentsDir,
        attachment: entry.attachment,
      });
      if (targetPath === null) throw new Error("A staged attachment path is invalid.");
      const relative = NodePath.relative(config.attachmentsDir, targetPath);
      if (
        relative === "" ||
        NodePath.isAbsolute(relative) ||
        relative === ".." ||
        relative.startsWith(`..${NodePath.sep}`) ||
        relative.replaceAll("\\", "/") !== entry.finalRelativePath
      ) {
        throw new Error("A staged attachment escaped the attachment directory.");
      }
      return targetPath;
    };
    const verifyStagedAttachment = (entry: ThreadSyncV2StagedAttachment) =>
      Effect.tryPromise({
        try: async () => {
          const targetPath = targetPathFor(entry);
          const before = NodeFS.lstatSync(targetPath);
          if (
            before.isSymbolicLink() ||
            !before.isFile() ||
            before.size !== entry.attachment.sizeBytes
          ) {
            throw new Error("A staged attachment is not a regular file of its declared size.");
          }
          const hash = NodeCrypto.createHash("sha256");
          let size = 0;
          for await (const chunk of NodeFS.createReadStream(targetPath)) {
            const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
            size += bytes.byteLength;
            if (size > before.size) throw new Error("A staged attachment grew while hashing.");
            hash.update(bytes);
          }
          const after = NodeFS.lstatSync(targetPath);
          if (
            size !== before.size ||
            after.isSymbolicLink() ||
            !after.isFile() ||
            after.dev !== before.dev ||
            after.ino !== before.ino ||
            hash.digest("hex") !== entry.blobHash
          ) {
            throw new Error("A staged attachment changed or failed digest verification.");
          }
        },
        catch: (cause) => syncError("import", "integrity-failed", String(cause)),
      });
    const isAttachmentReferenced = (entry: ThreadSyncV2AttachmentJournalEntry) =>
      snapshotQuery.getThreadMessageById === undefined
        ? Effect.succeed(false)
        : snapshotQuery.getThreadMessageById(entry.targetThreadId, entry.targetMessageId).pipe(
            Effect.map((message) =>
              Option.isSome(message)
                ? (message.value.attachments ?? []).some(
                    (attachment) => attachment.id === entry.attachment.id,
                  )
                : false,
            ),
            Effect.mapError((cause) => syncError("import", "io-failed", String(cause))),
          );
    const removeOwnedJournalEntries = (
      entries: ReadonlyArray<ThreadSyncV2AttachmentJournalEntry>,
      checkReferences: boolean,
    ) =>
      Effect.forEach(
        entries,
        (entry) =>
          Effect.gen(function* () {
            if (entry.ownership === null) return;
            if (checkReferences && (yield* isAttachmentReferenced(entry))) return;
            yield* provideIo(removeFileIfOwned(entry.ownership)).pipe(
              Effect.asVoid,
              Effect.mapError((cause) => syncError("import", "io-failed", String(cause))),
            );
          }),
        { concurrency: 1, discard: true },
      );

    const attachmentStage: ThreadSyncV2AttachmentStage = {
      recover: ({ limit }) =>
        Effect.gen(function* () {
          const names = yield* Effect.try({
            try: () => {
              NodeFS.mkdirSync(attachmentJournalRoot, { recursive: true });
              return NodeFS.readdirSync(attachmentJournalRoot)
                .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
                .toSorted()
                .slice(0, Math.max(0, Math.min(limit, 32)));
            },
            catch: (cause) => syncError("import", "io-failed", String(cause)),
          });
          for (const name of names) {
            const journal = yield* readJournalFile(NodePath.join(attachmentJournalRoot, name));
            if (journal === null || !journal.prepared) continue;
            const references = yield* Effect.forEach(journal.entries, isAttachmentReferenced, {
              concurrency: 1,
            });
            if (references.every(Boolean)) {
              yield* removeJournal(journal.stageId);
            } else if (references.every((referenced) => !referenced)) {
              yield* removeOwnedJournalEntries(journal.entries, false);
              yield* removeJournal(journal.stageId);
            }
          }
        }),
      list: ({ stageId }) =>
        Effect.gen(function* () {
          const journal = yield* readJournal(stageId);
          if (journal === null) return [];
          yield* Effect.forEach(journal.entries, verifyStagedAttachment, {
            concurrency: 1,
            discard: true,
          });
          return journal.entries;
        }),
      write: (attachmentInput) =>
        Effect.gen(function* () {
          const blobEntry = input.repository.blobs.get(attachmentInput.attachment.blobHash);
          if (
            blobEntry === undefined ||
            blobEntry.sizeBytes !== attachmentInput.attachment.sizeBytes
          ) {
            return yield* syncError(
              "import",
              "integrity-failed",
              `Verified blob ${attachmentInput.attachment.blobHash} is unavailable for import.`,
            );
          }
          const localAttachment: ChatAttachment = {
            type: "image",
            id: threadSyncV2ImportedAttachmentId({
              threadSegment,
              sourceThreadId: attachmentInput.sourceThreadId,
              targetThreadId: attachmentInput.targetThreadId,
              sourceRevision: attachmentInput.sourceRevision,
              sourceMessageId: attachmentInput.sourceMessageId,
              index: attachmentInput.index,
              blobHash: attachmentInput.attachment.blobHash,
            }),
            name: attachmentInput.attachment.name,
            mimeType: attachmentInput.attachment.mimeType,
            sizeBytes: attachmentInput.attachment.sizeBytes,
          };
          const targetPath = resolveAttachmentPath({
            attachmentsDir: config.attachmentsDir,
            attachment: localAttachment,
          });
          if (targetPath === null) {
            return yield* syncError(
              "import",
              "integrity-failed",
              `Attachment '${attachmentInput.attachment.name}' has an invalid destination path.`,
            );
          }
          const staged: ThreadSyncV2AttachmentJournalEntry = {
            attachment: localAttachment,
            blobHash: blobEntry.sha256,
            finalRelativePath: NodePath.relative(config.attachmentsDir, targetPath).replaceAll(
              "\\",
              "/",
            ),
            sourceMessageId: attachmentInput.sourceMessageId,
            index: attachmentInput.index,
            targetThreadId: attachmentInput.targetThreadId,
            targetMessageId: attachmentInput.targetMessageId,
            ownership: null,
          };
          const prior = yield* readJournal(attachmentInput.stageId);
          const existing = prior?.entries.find(
            (entry) =>
              entry.sourceMessageId === staged.sourceMessageId && entry.index === staged.index,
          );
          if (existing !== undefined) {
            if (
              existing.blobHash !== staged.blobHash ||
              existing.attachment.id !== staged.attachment.id
            ) {
              return yield* syncError(
                "import",
                "integrity-failed",
                "A resumed attachment journal conflicts with the remote record.",
              );
            }
            yield* verifyStagedAttachment(existing);
            return existing;
          }
          const journal: ThreadSyncV2AttachmentJournal = prior ?? {
            stageId: attachmentInput.stageId,
            prepared: false,
            entries: [],
          };
          if (journal.prepared) {
            return yield* syncError(
              "import",
              "integrity-failed",
              "A prepared attachment journal cannot accept another entry.",
            );
          }
          const pending = { ...journal, entries: [...journal.entries, staged] };
          yield* writeJournal(pending);
          yield* materializePayloads([
            `${THREAD_SYNC_V2_BLOBS_DIRECTORY}/${blobEntry.sha256}.blob`,
          ]);
          const blob = yield* readThreadSyncV2Blob({
            mirrorPath: input.mirrorPath,
            entry: blobEntry,
          });
          const publication = yield* provideIo(
            writeFileStreamExclusivelyAtomically({ filePath: targetPath, contents: blob.bytes }),
          ).pipe(
            Effect.mapError((cause) =>
              isThreadSyncError(cause) ? cause : syncError("import", "io-failed", String(cause)),
            ),
          );
          const published = publication.created
            ? { ...staged, ownership: publication.ownership }
            : staged;
          yield* verifyStagedAttachment(published);
          yield* writeJournal({
            ...pending,
            entries: pending.entries.map((entry) =>
              entry.sourceMessageId === staged.sourceMessageId && entry.index === staged.index
                ? published
                : entry,
            ),
          });
          return published;
        }),
      prepareCommit: ({ stageId, attachments }) =>
        Effect.gen(function* () {
          const journal = yield* readJournal(stageId);
          if (!threadSyncAttachmentJournalMatchesImportedRecords({ journal, attachments })) {
            return yield* syncError(
              "import",
              "integrity-failed",
              "The staged attachment journal does not match the imported records.",
            );
          }
          if (journal === null) return [];
          yield* Effect.forEach(journal.entries, verifyStagedAttachment, {
            concurrency: 1,
            discard: true,
          });
          yield* writeJournal({ ...journal, prepared: true });
          return journal.entries;
        }),
      completeCommit: ({ stageId }) => removeJournal(stageId),
      abort: ({ stageId, prepared }) =>
        Effect.gen(function* () {
          const journal = yield* readJournal(stageId);
          if (journal !== null) {
            yield* removeOwnedJournalEntries(journal.entries, prepared || journal.prepared);
            yield* removeJournal(stageId);
          }
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Failed to clean a v2 attachment import journal.", {
              cause: String(cause),
            }),
          ),
        ),
    };

    const importedAt = DateTime.formatIso(yield* DateTime.now);
    const result = yield* stageThreadSyncV2Import({
      selection: { ...input.selection, reader },
      importedAt,
      dispatch: (command) => engine.dispatch(command),
      resumeStage: ({ descriptor, now }) =>
        Option.match(sqlClient, {
          onNone: () =>
            Effect.fail(
              syncError("import", "io-failed", "The import staging database is unavailable."),
            ),
          onSome: (client) =>
            findThreadSyncImportStageProgress({ descriptor, now }).pipe(
              Effect.provideService(SqlClient.SqlClient, client),
              Effect.mapError((cause) => syncError("import", "io-failed", String(cause))),
            ),
        }),
      prepareStage: ({ descriptor }) =>
        Option.match(sqlClient, {
          onNone: () =>
            Effect.fail(
              syncError("import", "io-failed", "The import staging database is unavailable."),
            ),
          onSome: (client) =>
            prepareThreadSyncImportStage({ descriptor }).pipe(
              Effect.provideService(SqlClient.SqlClient, client),
              Effect.mapError((cause) => syncError("import", "integrity-failed", String(cause))),
            ),
        }),
      attachmentStage,
    }).pipe(Effect.ensuring(prunePayloads));
    const retainedPaths = new Set(
      result.attachments.flatMap((attachment) => {
        const filePath = resolveAttachmentPath({
          attachmentsDir: config.attachmentsDir,
          attachment,
        });
        return filePath === null ? [] : [filePath];
      }),
    );
    yield* Effect.forEach(
      staleAttachmentOwnership,
      ([filePath, ownership]) =>
        retainedPaths.has(filePath)
          ? Effect.void
          : provideIo(removeFileIfOwned(ownership)).pipe(
              Effect.asVoid,
              Effect.catch((cause) =>
                Effect.logWarning("Failed to prune a stale synchronized attachment.", {
                  cause: String(cause),
                }),
              ),
            ),
      { concurrency: 1 },
    );
    return result;
  });

  const importSelections = Effect.fn("ThreadSyncService.importSelections")(function* (
    selections: ReadonlyArray<ImportSelection>,
    remote: ThreadSyncRepositoryDocuments,
    localSnapshot: OrchestrationReadModel,
    threadBindings: ReadonlyArray<ThreadSyncLocalThreadBinding>,
    convergentSyncThreadIds: ReadonlySet<ThreadId>,
  ): Effect.fn.Return<number | null, ThreadSyncError> {
    if (selections.length === 0) return null;
    const ownedAttachments: ExclusiveFileOwnership[] = [];
    let committed = false;
    const prepared = [] as Array<{
      readonly selection: ImportSelection;
      readonly attachments: ReadonlyMap<string, ChatAttachment>;
    }>;

    return yield* withThreadSyncAttachmentRollback({
      ownedFiles: ownedAttachments,
      committed: () => committed,
      remove: (ownership) =>
        provideIo(removeFileIfOwned(ownership)).pipe(
          Effect.asVoid,
          Effect.catch(() => Effect.void),
        ),
      effect: Effect.gen(function* () {
        for (const selection of selections) {
          const threadSegment = toSafeThreadAttachmentSegment(selection.targetThreadId);
          if (threadSegment === null) {
            return yield* syncError(
              "import",
              "invalid-snapshot",
              "The target thread id is invalid.",
            );
          }
          const attachments = new Map<string, ChatAttachment>();
          for (const message of selection.snapshot.messages) {
            for (const [index, attachment] of message.attachments.entries()) {
              const bytes = remote.blobs.get(attachment.blobHash);
              if (bytes === undefined) {
                return yield* syncError(
                  "import",
                  "integrity-failed",
                  `Verified blob ${attachment.blobHash} is unavailable for import.`,
                );
              }
              const id = `${threadSegment}-${stableUuid(
                `${selection.targetThreadId}\0${selection.sourceRevision}\0${message.id}\0${index}\0${attachment.blobHash}`,
              )}`;
              const localAttachment: ChatAttachment = {
                type: "image",
                id,
                name: attachment.name,
                mimeType: attachment.mimeType,
                sizeBytes: attachment.sizeBytes,
              };
              const targetPath = resolveAttachmentPath({
                attachmentsDir: config.attachmentsDir,
                attachment: localAttachment,
              });
              if (targetPath === null) {
                return yield* syncError(
                  "import",
                  "integrity-failed",
                  `Attachment '${attachment.name}' has an invalid destination path.`,
                );
              }
              const publication = yield* provideIo(
                writeFileBytesExclusivelyAtomically({ filePath: targetPath, contents: bytes }),
              ).pipe(Effect.mapError((cause) => syncError("import", "io-failed", String(cause))));
              if (publication.created) {
                ownedAttachments.push(publication.ownership);
              } else {
                const isSymbolicLink = yield* fileSystem.readLink(targetPath).pipe(
                  Effect.as(true),
                  Effect.orElseSucceed(() => false),
                );
                if (isSymbolicLink) {
                  return yield* syncError(
                    "import",
                    "integrity-failed",
                    "An existing local attachment is a symbolic link.",
                  );
                }
                const info = yield* fileSystem
                  .stat(targetPath)
                  .pipe(
                    Effect.mapError((cause) => syncError("import", "io-failed", String(cause))),
                  );
                if (info.type !== "File") {
                  return yield* syncError(
                    "import",
                    "integrity-failed",
                    "An existing local attachment is not a regular file.",
                  );
                }
                const current = yield* fileSystem
                  .readFile(targetPath)
                  .pipe(
                    Effect.mapError((cause) => syncError("import", "io-failed", String(cause))),
                  );
                const currentHash = NodeCrypto.createHash("sha256").update(current).digest("hex");
                if (currentHash !== attachment.blobHash) {
                  return yield* syncError(
                    "import",
                    "integrity-failed",
                    "An existing local attachment does not match the synchronized blob.",
                  );
                }
              }
              attachments.set(`${message.id}:${index}`, localAttachment);
            }
          }
          prepared.push({ selection, attachments });
        }

        const importedAt = DateTime.formatIso(yield* DateTime.now);
        const importedTargets = new Map(
          prepared.map(
            ({ selection }) =>
              [
                selection.snapshot.threadId,
                {
                  threadId: selection.targetThreadId,
                  projectId: selection.projectId,
                  deletedAt: selection.snapshot.lifecycle.deletedAt,
                },
              ] as const,
          ),
        );
        const referenceMaps = buildThreadSyncImportReferenceMaps({
          selections: prepared.map(({ selection }) => selection),
          threadBindings,
          localThreads: localSnapshot.threads,
          convergentSyncThreadIds,
        });
        const invalidReference = validateThreadSyncImportReferences({
          selections: prepared.map(({ selection }) => selection),
          references: referenceMaps,
        });
        if (invalidReference !== null) {
          return yield* syncError("import", "integrity-failed", invalidReference);
        }
        const imports: ThreadSyncImportItem[] = prepared.map(({ selection, attachments }) => {
          const project = localSnapshot.projects.find((entry) => entry.id === selection.projectId)!;
          const coagentParentThreadId = resolveImportedCoagentParent({
            snapshot: selection.snapshot,
            targetThreadId: selection.targetThreadId,
            projectId: selection.projectId,
            importedTargets,
            threadBindings,
            localThreads: localSnapshot.threads,
          });
          const history = remapImportedSnapshot({
            snapshot: selection.snapshot,
            targetThreadId: selection.targetThreadId,
            sourceRevision: selection.sourceRevision,
            references: referenceMaps,
            coagentParentThreadId,
            attachment: (messageId, index) => attachments.get(`${messageId}:${index}`)!,
          });
          return {
            mode: selection.mode,
            threadId: selection.targetThreadId,
            projectId: selection.projectId,
            expectedLocalUpdatedAt: selection.expectedLocalUpdatedAt,
            ...(selection.mode === "create"
              ? {
                  localState: {
                    modelSelection: localModelSelection(project, localSnapshot.threads),
                    runtimeMode: DEFAULT_RUNTIME_MODE,
                    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
                    branch: null,
                    worktreePath: null,
                    linkedPullRequest: null,
                  },
                }
              : {}),
            history,
            sourceRevision: selection.sourceRevision,
            sourceHash: threadSyncRevision(selection.snapshot),
            bindingUpdates: selection.bindingUpdates,
          };
        });
        const commandId = threadSyncImportCommandId(
          prepared.map(({ selection }) => selection),
          imports,
        );
        const command = {
          type: "thread.sync.import-batch" as const,
          commandId,
          importedAt,
          imports,
        };

        return yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const result = yield* Effect.result(
              confirmThreadSyncImportDispatch(() => engine.dispatch(command)),
            );
            if (result._tag === "Failure") {
              return yield* syncError("import", "conflict", String(result.failure));
            }
            committed = true;
            return result.success.sequence;
          }),
        );
      }),
    });
  });

  const statusFromCurrent = Effect.fn("ThreadSyncService.statusFromCurrent")(function* (
    runState: ThreadSyncStatus["state"] = "idle",
    lastError: string | null = null,
  ) {
    const state = yield* Ref.get(stateRef);
    if (state.configuration === null) return disconnectedStatus(lastError);
    const remoteV2 = yield* Ref.get(remoteV2Ref);
    if (remoteV2 !== null) {
      const analysis = yield* analyzeV2(state, remoteV2, runState, lastError);
      if (analysis.state !== state) yield* saveState(analysis.state);
      return analysis.status;
    }
    const remote = yield* Ref.get(remoteRef);
    const analysis = yield* analyze(state, remote, runState, lastError);
    if (analysis.state !== state) yield* saveState(analysis.state);
    return analysis.status;
  });

  const runLocked = <A>(
    runState: ThreadSyncStatus["state"],
    operation: ThreadSyncError["operation"],
    effect: Effect.Effect<A, ThreadSyncError>,
    options: {
      readonly allowInvalidStateReset?: boolean;
      readonly skipStatusAnalysis?: boolean;
    } = {},
  ): Effect.Effect<A, ThreadSyncError> =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const loadError = yield* Ref.get(stateLoadErrorRef);
        if (loadError !== null && options.allowInvalidStateReset !== true) {
          const error = syncError(operation, loadError.code, loadError.detail);
          const current = yield* Ref.get(statusRef);
          yield* publish({ ...current, state: "error", lastError: error.detail });
          return yield* error;
        }
        if (loadError === null) yield* recoverBindingEvents();
        const busy =
          options.skipStatusAnalysis === true
            ? yield* Ref.get(statusRef).pipe(
                Effect.map((status) => ({ ...status, state: runState })),
              )
            : yield* statusFromCurrent(runState).pipe(
                Effect.catch(() =>
                  Ref.get(statusRef).pipe(Effect.map((status) => ({ ...status, state: runState }))),
                ),
              );
        yield* publish(busy);
        const outcome = yield* Effect.result(effect);
        if (outcome._tag === "Failure") {
          const error = mapUnknownError(operation, outcome.failure);
          const current = yield* Ref.get(statusRef);
          yield* publish({ ...current, state: "error", lastError: error.detail });
          return yield* error;
        }
        return outcome.success;
      }),
    );

  const prepareFetch = Effect.fn("ThreadSyncService.prepareFetch")(function* (
    state: ThreadSyncLocalState,
    input: ThreadSyncFetchInput,
  ) {
    const configuration = state.configuration;
    if (configuration === null) {
      return yield* syncError("fetch", "not-configured", "Thread sync is not configured.");
    }
    const fetched = yield* git.fetch(configuration);
    const remoteChanged = fetched.remoteRevision !== input.expectedRemoteRevision;
    const checkedOut = yield* git.checkoutRemote(configuration, fetched.remoteRevision, fetched);
    const now = DateTime.formatIso(yield* DateTime.now);
    const index =
      checkedOut.remoteRevision === null
        ? {
            projects: new Map<ThreadSyncProjectId, ThreadSyncProjectSnapshot>(),
            threadCount: 0,
            v2: emptyThreadSyncV2RepositoryIndex(now),
          }
        : yield* Effect.gen(function* () {
            const v2 = yield* readThreadSyncV2RepositoryIndex(checkedOut.mirrorPath);
            if (v2 !== null) {
              return {
                projects: v2.projects,
                threadCount: portablePrimaryRemoteThreads(v2).size,
                v2,
              };
            }
            const v1 = yield* provideIo(readThreadSyncRepositoryIndex(checkedOut.mirrorPath));
            return { ...v1, v2: null };
          });
    const nextState: ThreadSyncLocalState = {
      ...state,
      remoteRevision: fetched.remoteRevision,
      lastFetchedAt: now,
    };
    return {
      remoteChanged,
      discoveredThreadCount: index.threadCount,
      projects: index.projects,
      v2: index.v2,
      mirrorPath: checkedOut.mirrorPath,
      state: nextState,
    };
  });

  const analyzePreparedFetch = Effect.fn("ThreadSyncService.analyzePreparedFetch")(function* (
    prepared: Effect.Success<ReturnType<typeof prepareFetch>>,
  ) {
    if (prepared.v2 !== null) {
      const analysis = yield* analyzeV2(prepared.state, prepared.v2);
      return {
        analysis,
        remote: {
          projects: prepared.v2.projects,
          threads: new Map<ThreadId, ThreadSyncThreadSnapshot>(),
          blobs: new Map<string, Uint8Array>(),
        } satisfies ThreadSyncRepositoryDocuments,
        remoteV2: prepared.v2,
      };
    }

    // The legacy format needs full documents. Refuse it before reading either
    // side when the bounded compatibility check says the local state is too large.
    yield* assertV1HydrationSafe();
    const remote = yield* readRepository(prepared.mirrorPath);
    const analysis = yield* analyze(prepared.state, remote);
    return { analysis, remote, remoteV2: null };
  });

  const fetchUnlocked = Effect.fn("ThreadSyncService.fetchUnlocked")(function* (
    input: ThreadSyncFetchInput,
  ): Effect.fn.Return<ThreadSyncFetchResult, ThreadSyncError> {
    const state = yield* Ref.get(stateRef);
    const prepared = yield* prepareFetch(state, input);
    const analyzed = yield* analyzePreparedFetch(prepared);
    yield* saveState(analyzed.analysis.state);
    yield* Ref.set(remoteV2Ref, analyzed.remoteV2);
    yield* Ref.set(remoteRef, analyzed.remote);
    yield* publish(analyzed.analysis.status);
    return {
      remoteChanged: prepared.remoteChanged,
      discoveredThreadCount: prepared.discoveredThreadCount,
      status: analyzed.analysis.status,
    };
  });

  const fetch: ThreadSyncServiceShape["fetch"] = (input) =>
    runLocked("fetching", "fetch", fetchUnlocked(input), { skipStatusAnalysis: true });

  const configure: ThreadSyncServiceShape["configure"] = (input) =>
    runLocked(
      "fetching",
      "configure",
      Effect.gen(function* () {
        const current = yield* Ref.get(stateRef);
        const sameRemote =
          current.configuration?.remoteUrl === input.remoteUrl &&
          current.configuration.branch === input.branch;
        const bindingBaseline = yield* engine.latestSequence;
        const next: ThreadSyncLocalState = sameRemote
          ? { ...current, configuration: input }
          : {
              ...resetThreadSyncLocalStateAt(bindingBaseline),
              configuration: input,
            };
        const prepared = yield* prepareFetch(next, {
          expectedRemoteRevision: sameRemote ? current.remoteRevision : null,
        }).pipe(
          Effect.tapError(() =>
            sameRemote
              ? Effect.void
              : git.removeMirror(input).pipe(
                  Effect.catch((cleanupError) =>
                    Effect.logWarning("Failed to clean an uncommitted thread sync mirror.", {
                      code: cleanupError.code,
                    }),
                  ),
                ),
          ),
        );
        const analyzed = yield* analyzePreparedFetch(prepared);
        yield* saveState(analyzed.analysis.state, { resetInvalidLoadedState: true });
        yield* Ref.set(remoteRef, analyzed.remote);
        yield* Ref.set(remoteV2Ref, analyzed.remoteV2);
        yield* publish(analyzed.analysis.status);
        if (!sameRemote && current.configuration !== null) {
          yield* git.removeMirror(current.configuration).pipe(
            Effect.catch((cleanupError) =>
              Effect.logWarning("Failed to clean the previous thread sync mirror.", {
                code: cleanupError.code,
              }),
            ),
          );
        }
        return { status: analyzed.analysis.status };
      }),
      { allowInvalidStateReset: true, skipStatusAnalysis: true },
    );

  const linkProject: ThreadSyncServiceShape["linkProject"] = (input) =>
    runLocked(
      "idle",
      "link-project",
      Effect.gen(function* () {
        const state = yield* Ref.get(stateRef);
        if (state.configuration === null) {
          return yield* syncError(
            "link-project",
            "not-configured",
            "Thread sync is not configured.",
          );
        }
        const remote = yield* Ref.get(remoteRef);
        if (!remote.projects.has(input.syncProjectId)) {
          return yield* syncError(
            "link-project",
            "invalid-snapshot",
            "The synchronized project does not exist in the fetched revision.",
          );
        }
        const project = yield* snapshotQuery
          .getProjectShellById(input.projectId)
          .pipe(Effect.mapError((cause) => syncError("link-project", "io-failed", String(cause))));
        if (Option.isNone(project)) {
          return yield* syncError(
            "link-project",
            "project-unlinked",
            "The selected local project is unavailable.",
          );
        }
        const now = DateTime.formatIso(yield* DateTime.now);
        const binding = {
          syncProjectId: input.syncProjectId,
          projectId: input.projectId,
          linkedAt: now,
        };
        const next = {
          ...state,
          projectBindings: [
            ...state.projectBindings.filter(
              (entry) =>
                entry.syncProjectId !== input.syncProjectId && entry.projectId !== input.projectId,
            ),
            binding,
          ],
        };
        yield* saveState(next);
        const currentStatus = yield* Ref.get(statusRef);
        const status: ThreadSyncStatus = {
          ...currentStatus,
          state: "idle",
          unlinkedProjects: currentStatus.unlinkedProjects.filter(
            (entry) => entry.project.syncProjectId !== input.syncProjectId,
          ),
          lastError: null,
        };
        yield* publish(status);
        return { binding, status };
      }),
      { skipStatusAnalysis: true },
    );

  const applyRemoteV2Changes = Effect.fn("ThreadSyncService.applyRemoteV2Changes")(
    function* (input: {
      readonly mirrorPath: string;
      readonly analysis: ThreadSyncV2Analysis;
      readonly remote: ThreadSyncV2RepositoryIndex;
      readonly strategies: ReadonlyMap<string, string>;
      readonly pushMode: boolean;
    }) {
      const configuration = input.analysis.state.configuration;
      if (configuration === null) {
        return yield* syncError(
          input.pushMode ? "push" : "pull",
          "not-configured",
          "Thread sync is not configured.",
        );
      }
      const occupiedThreadIds = new Set(
        input.analysis.local.index.threads.map((thread) => thread.id),
      );
      const localThreadsById = new Map(
        input.analysis.local.index.threads.map((thread) => [thread.id, thread] as const),
      );
      const localProjectsById = new Map(
        input.analysis.local.index.projects.map((project) => [project.id, project] as const),
      );
      const bindings = [...input.analysis.state.threadBindings];
      const selections: Array<{
        readonly entry: ThreadSyncV2ThreadEntry;
        readonly targetThreadId: ThreadId;
        readonly projectId: ProjectId | null;
        readonly mode: "create" | "replace";
        readonly expectedLocalUpdatedAt: IsoDateTime | null;
        readonly localState?: NonNullable<ThreadSyncV2ImportSelection["localState"]>;
        readonly bindingUpdates: ReadonlyArray<ThreadSyncBindingUpdate>;
      }> = [];
      const appliedThreadIds: ThreadId[] = [];
      const skippedActiveThreadIds: ThreadId[] = [];
      const keptBoth: Array<{
        readonly sourceThreadId: ThreadId;
        readonly clonedThreadId: ThreadId;
      }> = [];

      const replaceBinding = (next: ThreadSyncLocalThreadBinding) => {
        const index = bindings.findIndex(
          (binding) =>
            binding.syncThreadId === next.syncThreadId ||
            binding.localThreadId === next.localThreadId,
        );
        if (index >= 0) bindings.splice(index, 1);
        bindings.push(next);
      };

      for (const entry of input.analysis.entries) {
        if (entry.active) {
          if (entry.decision !== "unchanged") {
            skippedActiveThreadIds.push(entry.localThreadId ?? entry.syncThreadId);
          }
          continue;
        }
        const strategyKey = entry.localThreadId ?? entry.syncThreadId;
        const strategy = input.strategies.get(strategyKey);
        const shouldPull =
          entry.decision === "pull" ||
          (entry.decision === "conflict" &&
            (strategy === "use-remote" || strategy === "pull-remote" || strategy === "keep-both"));
        if (entry.decision === "conflict" && strategy === undefined) {
          return yield* syncError(
            input.pushMode ? "push" : "pull",
            "conflict",
            `Thread '${entry.title}' needs an explicit conflict resolution.`,
          );
        }
        if (!shouldPull || entry.remote === null || entry.remoteRevision === null) continue;
        const projectBinding = input.analysis.state.projectBindings.find(
          (binding) => binding.syncProjectId === entry.remote!.syncProjectId,
        );
        const localProjectId = projectBinding?.projectId ?? null;
        const existing =
          entry.localThreadId === null ? undefined : localThreadsById.get(entry.localThreadId);

        if (
          strategy === "keep-both" &&
          entry.localThreadId !== null &&
          entry.localRevision !== null
        ) {
          if (existing === undefined) {
            return yield* syncError(
              input.pushMode ? "push" : "pull",
              "conflict",
              `Local thread '${entry.localThreadId}' is unavailable for keep-both resolution.`,
            );
          }
          const { preservedSyncThreadId, clonedThreadId } = deriveKeepBothThreadIds({
            syncThreadId: entry.syncThreadId,
            localThreadId: entry.localThreadId,
            localRevision: entry.localRevision,
            remoteRevision: entry.remoteRevision,
          });
          const preservedStateBinding: ThreadSyncLocalThreadBinding = {
            syncThreadId: preservedSyncThreadId,
            localThreadId: entry.localThreadId,
            syncProjectId: entry.syncProjectId,
            baseRevision: null,
          };
          replaceBinding(preservedStateBinding);
          occupiedThreadIds.add(clonedThreadId);
          const clonedStateBinding: ThreadSyncLocalThreadBinding = {
            syncThreadId: entry.syncThreadId,
            localThreadId: clonedThreadId,
            syncProjectId: entry.remote.syncProjectId,
            baseRevision: entry.remoteRevision,
          };
          replaceBinding(clonedStateBinding);
          selections.push({
            entry: entry.remote,
            targetThreadId: clonedThreadId,
            projectId: localProjectId,
            mode: "create",
            expectedLocalUpdatedAt: null,
            localState: {
              modelSelection: (localProjectId === null
                ? null
                : localProjectsById.get(localProjectId)?.defaultModelSelection) ?? {
                instanceId: ProviderInstanceId.make("codex"),
                model: DEFAULT_MODEL,
              },
              runtimeMode: DEFAULT_RUNTIME_MODE,
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              branch: null,
              worktreePath: null,
              linkedPullRequest: null,
            },
            bindingUpdates: [
              { ...preservedStateBinding, localProjectId: existing.projectId },
              { ...clonedStateBinding, localProjectId },
            ],
          });
          appliedThreadIds.push(clonedThreadId);
          keptBoth.push({ sourceThreadId: entry.localThreadId, clonedThreadId });
          continue;
        }

        let targetThreadId = entry.localThreadId ?? entry.syncThreadId;
        if (existing === undefined && occupiedThreadIds.has(targetThreadId)) {
          targetThreadId = `thread-${NodeCrypto.randomUUID()}` as ThreadId;
        }
        occupiedThreadIds.add(targetThreadId);
        const nextBinding: ThreadSyncLocalThreadBinding = {
          syncThreadId: entry.syncThreadId,
          localThreadId: targetThreadId,
          syncProjectId: entry.remote.syncProjectId,
          baseRevision: entry.remoteRevision,
        };
        replaceBinding(nextBinding);
        const mode = existing === undefined ? "create" : "replace";
        const project = localProjectId === null ? undefined : localProjectsById.get(localProjectId);
        selections.push({
          entry: entry.remote,
          targetThreadId,
          projectId: localProjectId,
          mode,
          expectedLocalUpdatedAt: existing?.updatedAt ?? null,
          ...(mode === "create"
            ? {
                localState: {
                  modelSelection: project?.defaultModelSelection ?? {
                    instanceId: ProviderInstanceId.make("codex"),
                    model: DEFAULT_MODEL,
                  },
                  runtimeMode: DEFAULT_RUNTIME_MODE,
                  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
                  branch: null,
                  worktreePath: null,
                  linkedPullRequest: null,
                },
              }
            : {}),
          bindingUpdates: [{ ...nextBinding, localProjectId }],
        });
        appliedThreadIds.push(targetThreadId);
      }

      const selectedBySource = new Map(
        selections.map((selection) => [selection.entry.threadId, selection]),
      );
      const threadIds = new Map<
        ThreadId,
        {
          readonly localThreadId: ThreadId;
          readonly projectId: ProjectId | null;
          readonly deletedAt: IsoDateTime | null;
        }
      >();
      for (const binding of bindings) {
        const selected = selectedBySource.get(binding.syncThreadId);
        const local = localThreadsById.get(binding.localThreadId);
        if (selected === undefined && local === undefined) continue;
        threadIds.set(binding.syncThreadId, {
          localThreadId: binding.localThreadId,
          projectId: selected?.projectId ?? local?.projectId ?? null,
          deletedAt: selected === undefined ? (local?.lifecycle.deletedAt ?? null) : null,
        });
      }
      for (const selection of selections) {
        threadIds.set(selection.entry.threadId, {
          localThreadId: selection.targetThreadId,
          projectId: selection.projectId,
          deletedAt: null,
        });
      }

      const planIds = new Map<
        ThreadId,
        Map<OrchestrationProposedPlanId, OrchestrationProposedPlanId>
      >();
      const listPlans = snapshotQuery.listThreadSyncExportPlansPage;
      if (listPlans === undefined) {
        return yield* syncError(
          "import",
          "io-failed",
          "The projection query does not support bounded v2 plan references.",
        );
      }
      for (const binding of bindings) {
        if (selectedBySource.has(binding.syncThreadId)) continue;
        const local = localThreadsById.get(binding.localThreadId);
        if (local === undefined) continue;
        const ids = new Map<OrchestrationProposedPlanId, OrchestrationProposedPlanId>();
        let after: ProjectionSnapshotQuery.ProjectionThreadSyncEntityCursor | null = null;
        while (true) {
          const page: {
            readonly rows: ReadonlyArray<ProjectionSnapshotQuery.ProjectionThreadSyncExportPlanRow>;
            readonly next: ProjectionSnapshotQuery.ProjectionThreadSyncEntityCursor | null;
          } = yield* listPlans({
            threadSequence: local.threadSequence,
            threadId: local.id,
            after,
            limit: 128,
          }).pipe(Effect.mapError((cause) => syncError("import", "io-failed", String(cause))));
          for (const row of page.rows) ids.set(row.value.id, row.localId);
          if (page.next === null) break;
          after = page.next;
        }
        planIds.set(binding.syncThreadId, ids);
      }
      const selectedImports = new Map(
        selections.map(
          (selection) =>
            [
              selection.entry.threadId,
              {
                targetThreadId: selection.targetThreadId,
                sourceRevision: selection.entry.revision,
              },
            ] as const,
        ),
      );
      const references: ThreadSyncV2ImportReferences = { threadIds, selectedImports, planIds };
      for (const selection of selections) {
        yield* importV2Selection({
          configuration,
          mirrorPath: input.mirrorPath,
          repository: input.remote,
          entry: selection.entry,
          selection: {
            targetThreadId: selection.targetThreadId,
            projectId: selection.projectId,
            mode: selection.mode,
            expectedLocalUpdatedAt: selection.expectedLocalUpdatedAt,
            ...(selection.localState === undefined ? {} : { localState: selection.localState }),
            bindingUpdates: selection.bindingUpdates,
            references,
          },
        });
      }

      return {
        state: {
          ...input.analysis.state,
          threadBindings: bindings,
          lastBindingEventSequence: input.analysis.state.lastBindingEventSequence,
        },
        appliedThreadIds,
        skippedActiveThreadIds,
        keptBoth,
      };
    },
  );

  const applyRemoteChanges = Effect.fn("ThreadSyncService.applyRemoteChanges")(function* (input: {
    readonly analysis: ThreadSyncAnalysisWithLocal;
    readonly remote: ThreadSyncRepositoryDocuments;
    readonly sourceRevision: ThreadSyncRevision;
    readonly strategies: ReadonlyMap<string, string>;
    readonly pushMode: boolean;
  }) {
    const projection = yield* snapshotQuery
      .getSnapshot()
      .pipe(Effect.mapError((cause) => syncError("import", "io-failed", String(cause))));
    const occupiedThreadIds = new Set(projection.threads.map((thread) => thread.id));
    const bindings = [...input.analysis.state.threadBindings];
    const selections: ImportSelection[] = [];
    const appliedThreadIds: ThreadId[] = [];
    const skippedActiveThreadIds: ThreadId[] = [];
    const keptBoth: Array<{
      readonly sourceThreadId: ThreadId;
      readonly clonedThreadId: ThreadId;
    }> = [];

    const replaceBinding = (next: ThreadSyncLocalThreadBinding) => {
      const index = bindings.findIndex(
        (binding) =>
          binding.syncThreadId === next.syncThreadId ||
          binding.localThreadId === next.localThreadId,
      );
      if (index >= 0) bindings.splice(index, 1);
      bindings.push(next);
    };

    for (const entry of input.analysis.entries) {
      if (entry.active) {
        if (entry.decision !== "unchanged") {
          skippedActiveThreadIds.push(entry.localThreadId ?? entry.syncThreadId);
        }
        continue;
      }
      const strategyKey = entry.localThreadId ?? entry.syncThreadId;
      const strategy = input.strategies.get(strategyKey);
      const shouldPull =
        entry.decision === "pull" ||
        (entry.decision === "conflict" &&
          (strategy === "use-remote" || strategy === "pull-remote" || strategy === "keep-both"));
      if (entry.decision === "conflict" && strategy === undefined) {
        return yield* syncError(
          input.pushMode ? "push" : "pull",
          "conflict",
          `Thread '${entry.title}' needs an explicit conflict resolution.`,
        );
      }
      if (!shouldPull || entry.remote === null || entry.remoteRevision === null) continue;
      const projectBinding = input.analysis.state.projectBindings.find(
        (binding) => binding.syncProjectId === entry.remote!.syncProjectId,
      );
      const localProjectId = projectBinding?.projectId ?? null;
      const existing =
        entry.localThreadId === null
          ? undefined
          : projection.threads.find((thread) => thread.id === entry.localThreadId);

      if (strategy === "keep-both" && entry.localThreadId !== null && entry.local !== null) {
        if (existing === undefined) {
          return yield* syncError(
            input.pushMode ? "push" : "pull",
            "conflict",
            `Local thread '${entry.localThreadId}' is unavailable for keep-both resolution.`,
          );
        }
        const { preservedSyncThreadId, clonedThreadId } = deriveKeepBothThreadIds({
          syncThreadId: entry.syncThreadId,
          localThreadId: entry.localThreadId,
          localRevision: entry.localRevision!,
          remoteRevision: entry.remoteRevision,
        });
        const preservedStateBinding: ThreadSyncLocalThreadBinding = {
          syncThreadId: preservedSyncThreadId,
          localThreadId: entry.localThreadId,
          syncProjectId: entry.local.syncProjectId,
          baseRevision: null,
        };
        replaceBinding(preservedStateBinding);
        occupiedThreadIds.add(clonedThreadId);
        const clonedStateBinding: ThreadSyncLocalThreadBinding = {
          syncThreadId: entry.syncThreadId,
          localThreadId: clonedThreadId,
          syncProjectId: entry.remote.syncProjectId,
          baseRevision: entry.remoteRevision,
        };
        replaceBinding(clonedStateBinding);
        const preservedBinding: ThreadSyncBindingUpdate = {
          ...preservedStateBinding,
          localProjectId: existing.projectId,
        };
        const clonedBinding: ThreadSyncBindingUpdate = {
          ...clonedStateBinding,
          localProjectId,
        };
        selections.push({
          snapshot: entry.remote,
          targetThreadId: clonedThreadId,
          projectId: localProjectId,
          mode: "create",
          expectedLocalUpdatedAt: null,
          sourceRevision: input.sourceRevision,
          bindingUpdates: [preservedBinding, clonedBinding],
        });
        appliedThreadIds.push(clonedThreadId);
        keptBoth.push({ sourceThreadId: entry.localThreadId, clonedThreadId });
        continue;
      }

      let targetThreadId = entry.localThreadId ?? entry.syncThreadId;
      if (existing === undefined && occupiedThreadIds.has(targetThreadId)) {
        targetThreadId = `thread-${NodeCrypto.randomUUID()}` as ThreadId;
      }
      occupiedThreadIds.add(targetThreadId);
      const nextBinding: ThreadSyncLocalThreadBinding = {
        syncThreadId: entry.syncThreadId,
        localThreadId: targetThreadId,
        syncProjectId: entry.remote.syncProjectId,
        baseRevision: entry.remoteRevision,
      };
      replaceBinding(nextBinding);
      const bindingUpdate: ThreadSyncBindingUpdate = {
        ...nextBinding,
        localProjectId,
      };
      selections.push({
        snapshot: entry.remote,
        targetThreadId,
        projectId: localProjectId,
        mode: existing === undefined ? "create" : "replace",
        expectedLocalUpdatedAt: existing?.updatedAt ?? null,
        sourceRevision: input.sourceRevision,
        bindingUpdates: [bindingUpdate],
      });
      appliedThreadIds.push(targetThreadId);
    }

    const convergentSyncThreadIds = new Set(
      input.analysis.entries
        .filter(
          (entry) =>
            entry.local !== null &&
            entry.remote !== null &&
            entry.localRevision !== null &&
            entry.localRevision === entry.remoteRevision,
        )
        .map((entry) => entry.syncThreadId),
    );
    yield* importSelections(
      selections,
      input.remote,
      projection,
      bindings,
      convergentSyncThreadIds,
    );
    const bindingState = {
      ...input.analysis.state,
      threadBindings: bindings,
      // Keep the prior cursor. Other imports may have committed between it and
      // this batch's final sequence; the bounded replay must observe all of them.
      lastBindingEventSequence: input.analysis.state.lastBindingEventSequence,
    };
    return {
      state: bindingState,
      appliedThreadIds,
      skippedActiveThreadIds,
      keptBoth,
    };
  });

  const pull: ThreadSyncServiceShape["pull"] = (input) =>
    keepThreadSyncOperationAlive(
      runLocked(
        "pulling",
        "pull",
        Effect.gen(function* () {
          const state = yield* Ref.get(stateRef);
          const configuration = state.configuration;
          if (configuration === null) {
            return yield* syncError("pull", "not-configured", "Thread sync is not configured.");
          }
          const checkedOut = yield* git.checkoutRemote(configuration, input.expectedRemoteRevision);
          if (checkedOut.remoteRevision === null) {
            return yield* syncError(
              "pull",
              "invalid-snapshot",
              "The sync remote has no history yet.",
            );
          }
          const now = DateTime.formatIso(yield* DateTime.now);
          const fetchedState = {
            ...state,
            remoteRevision: checkedOut.remoteRevision,
            lastFetchedAt: now,
          };
          const strategies = new Map(
            input.strategies.map((strategy) => [strategy.threadId, strategy.resolution]),
          );
          const remoteV2 = yield* readThreadSyncV2RepositoryIndex(checkedOut.mirrorPath);
          if (remoteV2 !== null) {
            const analysis = yield* analyzeV2(fetchedState, remoteV2, "pulling");
            const resolved = yield* applyRemoteV2Changes({
              mirrorPath: checkedOut.mirrorPath,
              analysis,
              remote: remoteV2,
              strategies,
              pushMode: false,
            });
            const importedLocal = yield* exportLocalV2(resolved.state, remoteV2);
            const cachedState = cacheV2SourceKeys(
              resolved.state,
              importedLocal,
              new Set(resolved.appliedThreadIds),
            );
            const finalAnalysis = yield* analyzeV2(cachedState, remoteV2);
            yield* Ref.set(remoteV2Ref, remoteV2);
            yield* Ref.set(remoteRef, {
              projects: remoteV2.projects,
              threads: new Map(),
              blobs: new Map(),
            });
            yield* saveState(finalAnalysis.state);
            yield* publish(finalAnalysis.status);
            return {
              remoteRevision: checkedOut.remoteRevision,
              appliedThreadIds: resolved.appliedThreadIds,
              keptBoth: resolved.keptBoth,
              skippedActiveThreadIds: resolved.skippedActiveThreadIds,
              status: finalAnalysis.status,
            };
          }

          const remote = yield* readRepository(checkedOut.mirrorPath);
          const analysis = yield* analyze(fetchedState, remote, "pulling");
          const resolved = yield* applyRemoteChanges({
            analysis,
            remote,
            sourceRevision: checkedOut.remoteRevision,
            strategies,
            pushMode: false,
          });
          yield* Ref.set(remoteV2Ref, null);
          yield* Ref.set(remoteRef, remote);
          const finalAnalysis = yield* analyze(resolved.state, remote);
          yield* saveState(finalAnalysis.state);
          yield* publish(finalAnalysis.status);
          return {
            remoteRevision: checkedOut.remoteRevision,
            appliedThreadIds: resolved.appliedThreadIds,
            keptBoth: resolved.keptBoth,
            skippedActiveThreadIds: resolved.skippedActiveThreadIds,
            status: finalAnalysis.status,
          };
        }),
        { skipStatusAnalysis: true },
      ),
    );

  const pushV2 = Effect.fn("ThreadSyncService.pushV2")(function* (input: {
    readonly configuration: NonNullable<ThreadSyncLocalState["configuration"]>;
    readonly checkedOut: {
      readonly mirrorPath: string;
      readonly remoteRevision: ThreadSyncRevision | null;
    };
    readonly now: IsoDateTime;
    readonly state: ThreadSyncLocalState;
    readonly remote: ThreadSyncV2RepositoryIndex;
    readonly strategies: ReadonlyMap<string, string>;
    readonly retireV1: boolean;
  }) {
    const initial = yield* analyzeV2(input.state, input.remote, "pushing");
    const resolved = yield* applyRemoteV2Changes({
      mirrorPath: input.checkedOut.mirrorPath,
      analysis: initial,
      remote: input.remote,
      strategies: input.strategies,
      pushMode: true,
    });
    const importedLocal = yield* exportLocalV2(resolved.state, input.remote);
    const cachedResolvedState = cacheV2SourceKeys(
      resolved.state,
      importedLocal,
      new Set(resolved.appliedThreadIds),
    );
    const postImportLocal = yield* exportLocalV2(cachedResolvedState, input.remote);
    const postImportAnalysis = analyzePreparedV2(
      cachedResolvedState,
      input.remote,
      postImportLocal,
      "pushing",
    );
    const localThreadIdsToPush = new Set(
      postImportAnalysis.entries.flatMap((entry) => {
        if (entry.active || entry.localThreadId === null) return [];
        const strategy =
          input.strategies.get(entry.localThreadId) ?? input.strategies.get(entry.syncThreadId);
        return entry.decision === "push" ||
          (entry.decision === "conflict" && strategy === "replace-remote")
          ? [entry.localThreadId]
          : [];
      }),
    );
    const local = yield* exportLocalV2(cachedResolvedState, input.remote, localThreadIdsToPush);
    const eligibleRemoteThreads = portablePrimaryRemoteThreads(input.remote);
    const retainedRemoteThreads = selectRetainedRemoteThreads({
      remoteThreads: eligibleRemoteThreads.values(),
      retiredSyncThreadIds: local.retiredSyncThreadIds,
      replacedSyncThreadIds: new Set(),
    });
    const retainedProjectIds = new Set(
      [
        ...retainedRemoteThreads.map((entry) => entry.syncProjectId),
        ...[...local.sources.values()].map((source) => source.header.syncProjectId),
      ].filter((projectId): projectId is ThreadSyncProjectId => projectId !== null),
    );
    const finalProjects = new Map(
      [...input.remote.projects].filter(
        ([syncProjectId, project]) =>
          project.deletedAt === null && retainedProjectIds.has(syncProjectId),
      ),
    );
    for (const [id, project] of local.projects) {
      if (retainedProjectIds.has(id)) finalProjects.set(id, project);
    }

    for (const [sha256, source] of local.blobs) {
      const prior = input.remote.blobs.get(sha256);
      if (prior !== undefined && prior.sizeBytes !== source.sizeBytes) {
        return yield* syncError(
          "push",
          "integrity-failed",
          "Two v2 attachments share a digest but not a size.",
        );
      }
    }

    const pushedThreadIds: ThreadId[] = [
      ...new Set(
        [...local.sources.keys(), ...local.retiredSyncThreadIds].map(
          (syncThreadId) =>
            cachedResolvedState.threadBindings.find(
              (binding) => binding.syncThreadId === syncThreadId,
            )?.localThreadId ?? syncThreadId,
        ),
      ),
    ];
    const source: ThreadSyncV2RepositorySource<ThreadSyncError> = {
      projects: finalProjects,
      threads: local.sources.values(),
      blobs: local.blobs.values(),
      previousThreads: input.remote.threads.values(),
      retainedThreads: selectRetainedRemoteThreads({
        remoteThreads: retainedRemoteThreads,
        retiredSyncThreadIds: new Set(),
        replacedSyncThreadIds: new Set(local.sources.keys()),
      }),
      retainedBlobs: [...input.remote.blobs.values()].filter(
        (entry) => !local.blobs.has(entry.sha256),
      ),
      updatedAt:
        input.retireV1 || local.sources.size > 0 || local.retiredSyncThreadIds.size > 0
          ? input.now
          : input.remote.manifest.updatedAt,
    };
    let written = yield* writeThreadSyncV2Repository({
      mirrorPath: input.checkedOut.mirrorPath,
      source,
    });
    const rewriteRepository = Effect.fn("ThreadSyncService.rewriteV2Repository")(function* (
      updatedAt: IsoDateTime,
    ) {
      const priorRemovedPayloadPaths = written.removedPayloadPaths;
      const rewritten = yield* writeThreadSyncV2Repository({
        mirrorPath: input.checkedOut.mirrorPath,
        source: {
          ...source,
          previousThreads: written.manifest.threads,
          updatedAt,
        },
      });
      return {
        ...rewritten,
        removedPayloadPaths: [
          ...new Set([...priorRemovedPayloadPaths, ...rewritten.removedPayloadPaths]),
        ].toSorted(),
      };
    });
    const sameRepositoryContents = (left: ThreadSyncV2RepositoryIndex["manifest"]) =>
      canonicalThreadSyncJson({
        ...left,
        updatedAt: input.remote.manifest.updatedAt,
      }) === canonicalThreadSyncJson(input.remote.manifest);
    if (
      sameRepositoryContents(written.manifest) &&
      source.updatedAt !== input.remote.manifest.updatedAt &&
      !input.retireV1
    ) {
      // A replace-remote choice may re-export byte-identical state. Restore
      // the original timestamp so the managed checkout remains clean when the
      // operation short-circuits without a commit.
      written = yield* rewriteRepository(input.remote.manifest.updatedAt);
    } else if (!sameRepositoryContents(written.manifest) && source.updatedAt !== input.now) {
      written = yield* rewriteRepository(input.now);
    }
    const writtenThreadManifests = new Map<ThreadId, ThreadSyncV2ThreadManifest>();
    for (const entry of written.manifest.threads) {
      const threadManifest =
        written.threadResults.get(entry.threadId)?.manifest ??
        input.remote.threadManifests.get(entry.threadId);
      if (threadManifest === undefined) {
        return yield* syncError(
          "push",
          "integrity-failed",
          `The written thread '${entry.threadId}' has no verified manifest.`,
        );
      }
      writtenThreadManifests.set(entry.threadId, threadManifest);
    }
    const writtenV2: ThreadSyncV2RepositoryIndex = {
      manifest: written.manifest,
      projects: finalProjects,
      threads: new Map(written.manifest.threads.map((entry) => [entry.threadId, entry])),
      threadManifests: writtenThreadManifests,
      blobs: new Map(written.manifest.blobs.map((entry) => [entry.sha256, entry])),
    };
    const noRemoteMutation =
      !input.retireV1 &&
      input.checkedOut.remoteRevision !== null &&
      sameRepositoryContents(written.manifest) &&
      written.removedPayloadPaths.length === 0;
    if (input.retireV1) {
      yield* provideIo(removeThreadSyncV1Repository(input.checkedOut.mirrorPath));
    }
    const nextRemoteRevision = noRemoteMutation
      ? input.checkedOut.remoteRevision!
      : yield* git.commitAndPush({
          configuration: input.configuration,
          expectedRemoteRevision: input.checkedOut.remoteRevision,
          message:
            pushedThreadIds.length === 0
              ? "Sync Erebus thread state"
              : `Sync ${pushedThreadIds.length} Erebus thread${pushedThreadIds.length === 1 ? "" : "s"}`,
          removePayloadPaths: written.removedPayloadPaths,
        });
    const nextState: ThreadSyncLocalState = {
      ...cachedResolvedState,
      remoteRevision: nextRemoteRevision,
      lastFetchedAt: input.now,
      projectBindings: local.projectBindings,
      threadBindings: local.threadBindings
        .filter((binding) => !local.retiredSyncThreadIds.has(binding.syncThreadId))
        .map((binding) => {
          const descriptor = local.descriptors.get(binding.syncThreadId);
          const writtenEntry = writtenV2.threads.get(binding.syncThreadId);
          const sourceKeyHash =
            descriptor !== undefined &&
            (local.sources.has(binding.syncThreadId) ||
              writtenEntry?.sourceKeyHash === descriptor.sourceKeyHash)
              ? descriptor.sourceKeyHash
              : binding.sourceKeyHash;
          return {
            ...binding,
            baseRevision: writtenEntry?.revision ?? binding.baseRevision,
            ...(sourceKeyHash === undefined ? {} : { sourceKeyHash }),
          };
        }),
    };
    const finalAnalysis = yield* analyzeV2(nextState, writtenV2);
    yield* Ref.set(remoteV2Ref, writtenV2);
    yield* Ref.set(remoteRef, {
      projects: writtenV2.projects,
      threads: new Map(),
      blobs: new Map(),
    });
    yield* saveState(finalAnalysis.state);
    yield* publish(finalAnalysis.status);
    return {
      remoteRevision: nextRemoteRevision,
      pushedThreadIds,
      pulledThreadIds: resolved.appliedThreadIds,
      keptBoth: resolved.keptBoth,
      skippedActiveThreadIds: resolved.skippedActiveThreadIds,
      status: finalAnalysis.status,
    };
  });

  const push: ThreadSyncServiceShape["push"] = (input) =>
    keepThreadSyncOperationAlive(
      runLocked(
        "pushing",
        "push",
        Effect.gen(function* () {
          const state = yield* Ref.get(stateRef);
          const configuration = state.configuration;
          if (configuration === null) {
            return yield* syncError("push", "not-configured", "Thread sync is not configured.");
          }
          const checkedOut = yield* git.checkoutRemote(configuration, input.expectedRemoteRevision);
          const now = DateTime.formatIso(yield* DateTime.now);
          const fetchedState = {
            ...state,
            remoteRevision: checkedOut.remoteRevision,
            lastFetchedAt: now,
          };
          const strategyMap = new Map(
            input.strategies.map((strategy) => [strategy.threadId, strategy.resolution]),
          );
          const existingV2 =
            checkedOut.remoteRevision === null
              ? null
              : yield* readThreadSyncV2RepositoryIndex(checkedOut.mirrorPath);

          if (checkedOut.remoteRevision === null || existingV2 !== null) {
            const remoteV2 = existingV2 ?? emptyThreadSyncV2RepositoryIndex(now);
            return yield* pushV2({
              configuration,
              checkedOut,
              now,
              state: fetchedState,
              remote: remoteV2,
              strategies: strategyMap,
              retireV1: false,
            });
          }

          const remote = yield* readRepository(checkedOut.mirrorPath);
          const migrated = yield* migrateV1RepositoryToV2({
            mirrorPath: checkedOut.mirrorPath,
            state: fetchedState,
            remote,
            updatedAt: now,
          });
          return yield* pushV2({
            configuration,
            checkedOut,
            now,
            state: migrated.state,
            remote: migrated.remoteV2,
            strategies: strategyMap,
            retireV1: true,
          });
        }),
        { skipStatusAnalysis: true },
      ),
    );

  const disconnect: ThreadSyncServiceShape["disconnect"] = (input) =>
    runLocked(
      "idle",
      "disconnect",
      Effect.gen(function* () {
        const state = yield* Ref.get(stateRef);
        if (input.removeLocalMirror && state.configuration !== null) {
          yield* git.removeMirror(state.configuration);
        }
        const next = resetThreadSyncLocalStateAt(yield* engine.latestSequence);
        yield* saveState(next, { resetInvalidLoadedState: true });
        yield* Ref.set(remoteRef, emptyThreadSyncRepositoryDocuments());
        yield* Ref.set(remoteV2Ref, null);
        const status = disconnectedStatus();
        yield* publish(status);
        return { disconnected: true as const, status };
      }),
      { allowInvalidStateReset: true },
    );

  const periodicLoop = Effect.forever(
    Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);
      const seconds = state.configuration?.fetchIntervalSeconds ?? 30;
      yield* Effect.sleep(Duration.seconds(Math.max(15, seconds)));
      const latest = yield* Ref.get(stateRef);
      if (latest.configuration === null) return;
      yield* fetch({ expectedRemoteRevision: latest.remoteRevision }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Periodic thread sync fetch failed.", {
            code: error.code,
            detail: error.detail,
          }),
        ),
      );
    }),
  );

  const start: ThreadSyncServiceShape["start"] = Effect.gen(function* () {
    const shouldStart = yield* Ref.modify(startedRef, (started) => [!started, true]);
    if (!shouldStart) return;
    const recovery = yield* Effect.result(mutex.withPermits(1)(recoverBindingEvents()));
    if (recovery._tag === "Failure") {
      const current = yield* Ref.get(statusRef);
      yield* publish({
        ...current,
        state: "error",
        lastError: recovery.failure.detail,
      });
      yield* Effect.logWarning("Initial thread sync binding recovery failed.", {
        code: recovery.failure.code,
        detail: recovery.failure.detail,
      });
      yield* Effect.forkScoped(periodicLoop);
      return;
    }
    const state = yield* Ref.get(stateRef);
    if (state.configuration !== null) {
      yield* Effect.forkScoped(
        fetch({ expectedRemoteRevision: state.remoteRevision }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Initial thread sync fetch failed.", {
              code: error.code,
              detail: error.detail,
            }),
          ),
        ),
      );
    }
    yield* Effect.forkScoped(periodicLoop);
  });

  return ThreadSyncService.of({
    start,
    getStatus: Ref.get(statusRef),
    subscribe: subscribeBeforeSnapshot(changes, Ref.get(statusRef), mutex),
    configure,
    fetch,
    linkProject,
    disconnect,
    pull,
    push,
  });
});

export const layer = Layer.effect(ThreadSyncService, make);
