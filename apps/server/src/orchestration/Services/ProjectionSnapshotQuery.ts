/**
 * ProjectionSnapshotQuery - Read-model snapshot query service interface.
 *
 * Exposes the current orchestration projection snapshot for read-only API
 * access.
 *
 * @module ProjectionSnapshotQuery
 */
import type {
  CheckpointRef,
  MessageId,
  OrchestrationMessage,
  OrchestrationCheckpointSummary,
  OrchestrationProject,
  OrchestrationProjectShell,
  OrchestrationReadModel,
  OrchestrationSearchThreadsInput,
  OrchestrationSearchThreadsResult,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  OrchestrationThreadActivity,
  OrchestrationThreadDetailSnapshot,
  OrchestrationThreadDetailWindow,
  OrchestrationThreadShell,
  ProjectId,
  ThreadId,
  ThreadSyncTerminalTurn,
  TurnId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Option from "effect/Option";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export interface ProjectionSnapshotCounts {
  readonly projectCount: number;
  readonly threadCount: number;
}

export interface ProjectionSnapshotSequence {
  readonly snapshotSequence: number;
}

export interface ProjectionThreadCheckpointContext {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>;
}

export interface ProjectionCheckpointHead {
  readonly turnId: TurnId;
  readonly checkpointTurnCount: number;
  readonly checkpointRef: CheckpointRef;
  readonly status: OrchestrationCheckpointSummary["status"];
}

/** Constant-size checkpoint state for ordinary runtime paths. */
export interface ProjectionThreadCheckpointHeadContext {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly latestCheckpoint: ProjectionCheckpointHead | null;
  readonly turnCheckpoint: ProjectionCheckpointHead | null;
  readonly turnAssistantMessageId: MessageId | null;
}

export interface ProjectionCheckpointRefCursor {
  readonly checkpointTurnCount: number;
  readonly turnId: TurnId;
}

export interface ProjectionCheckpointRefPage {
  readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
  readonly nextCursor: ProjectionCheckpointRefCursor | null;
}

export interface ProjectionFullThreadDiffContext {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly latestCheckpointTurnCount: number;
  readonly toCheckpointRef: CheckpointRef | null;
}

export interface ProjectionThreadContinuationSeedInput {
  readonly threadId: ThreadId;
  readonly currentMessageId: MessageId;
  /** Hard upper bound for prior message text and attachment JSON returned by the query. */
  readonly maxChars: number;
}

export interface ProjectionThreadContinuationMessage extends Pick<
  OrchestrationMessage,
  "id" | "role" | "text" | "attachments" | "streaming" | "createdAt"
> {
  readonly textTruncated: boolean;
  readonly attachmentsTruncated: boolean;
}

export interface ProjectionThreadContinuationSeed {
  readonly currentMessage: OrchestrationMessage;
  /** Prior durable messages in newest-first order. */
  readonly priorMessagesNewestFirst: ReadonlyArray<ProjectionThreadContinuationMessage>;
  readonly hasEarlier: boolean;
}

export interface ProjectionThreadSyncExportThread {
  readonly id: ThreadId;
  readonly projectId: ProjectId | null;
  readonly title: string;
  readonly coagent: OrchestrationThread["coagent"];
  readonly latestTurnId: ThreadSyncTerminalTurn["turnId"] | null;
  /** Thread-scoped event watermark used to keep long exports stable. */
  readonly threadSequence: number;
  readonly lifecycle: {
    readonly archivedAt: string | null;
    readonly settledOverride: OrchestrationThread["settledOverride"];
    readonly settledAt: string | null;
    readonly deletedAt: string | null;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Active threads are indexed but their bodies must not be exported. */
  readonly active: boolean;
}

export interface ProjectionThreadSyncExportIndex {
  readonly snapshotSequence: number;
  readonly updatedAt: string;
  readonly projects: ReadonlyArray<OrchestrationProject>;
  readonly threads: ReadonlyArray<ProjectionThreadSyncExportThread>;
}

/**
 * Last durable sync import for a thread. If its sequence is still the thread
 * watermark, the local projection has not changed since that import.
 */
export interface ProjectionThreadSyncImportWatermark {
  readonly threadId: ThreadId;
  readonly threadSequence: number;
  readonly sourceRevision: string;
}

/**
 * Conservative metadata-only estimate used to decide whether the legacy v1
 * exporter may safely hydrate the full projection snapshot.
 */
export interface ProjectionThreadSyncV1HydrationStats {
  readonly projectCount: number;
  readonly threadCount: number;
  readonly rowCount: number;
  readonly estimatedBytes: number;
  readonly maxThreadEstimatedBytes: number;
}

export interface ProjectionThreadSyncTurnCursor {
  readonly requestedAt: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly turnId: ThreadSyncTerminalTurn["turnId"];
}

export interface ProjectionThreadSyncEntityCursor {
  readonly createdAt: string;
  readonly id: string;
}

export interface ProjectionThreadSyncActivityCursor {
  readonly sequence: number | null;
  readonly createdAt: string;
  readonly id: string;
}

export interface ProjectionThreadSyncPageInput<Cursor> {
  readonly threadSequence: number;
  readonly threadId: ThreadId;
  readonly after: Cursor | null;
  readonly limit: number;
}

export interface ProjectionThreadSyncMessagePageInput extends ProjectionThreadSyncPageInput<ProjectionThreadSyncEntityCursor> {
  /** Limits attachment preflight to rows that can register a blob. */
  readonly attachmentsOnly?: boolean;
}

export interface ProjectionThreadSyncPage<Row, Cursor> {
  readonly rows: ReadonlyArray<Row>;
  readonly next: Cursor | null;
}

export type ProjectionThreadSyncMessageMetadata = Omit<OrchestrationMessage, "text">;
export type ProjectionThreadSyncPlanMetadata = Omit<
  OrchestrationThread["proposedPlans"][number],
  "planMarkdown"
>;
export type ProjectionThreadSyncActivityMetadata = Omit<
  OrchestrationThreadActivity,
  "summary" | "payload"
>;

export interface ProjectionThreadSyncExportMessageRow {
  readonly localId: MessageId;
  readonly cursor: ProjectionThreadSyncEntityCursor;
  readonly value: ProjectionThreadSyncMessageMetadata;
}

export interface ProjectionThreadSyncExportPlanRow {
  readonly localId: OrchestrationThread["proposedPlans"][number]["id"];
  readonly cursor: ProjectionThreadSyncEntityCursor;
  readonly value: ProjectionThreadSyncPlanMetadata;
}

export interface ProjectionThreadSyncExportActivityRow {
  readonly localId: OrchestrationThreadActivity["id"];
  readonly cursor: ProjectionThreadSyncActivityCursor;
  readonly value: ProjectionThreadSyncActivityMetadata;
}

export interface ProjectionThreadSyncExportTurnRow {
  readonly cursor: ProjectionThreadSyncTurnCursor;
  readonly value: ThreadSyncTerminalTurn;
}

export interface ProjectionThreadSyncTextChunkInput {
  readonly threadSequence: number;
  readonly threadId: ThreadId;
  readonly field: "message-text" | "plan-markdown" | "activity-summary";
  readonly ownerId: string;
  readonly offset: number;
  readonly maxBytes: number;
}

export interface ProjectionThreadSyncTextChunk {
  readonly bytes: Uint8Array;
  readonly nextOffset: number;
  readonly done: boolean;
}

/**
 * ProjectionSnapshotQueryShape - Service API for read-model snapshots.
 */
export interface ProjectionSnapshotQueryShape {
  /**
   * Read the lightweight command snapshot used to bootstrap the in-memory
   * orchestration engine without hydrating message/activity/checkpoint bodies.
   */
  readonly getCommandReadModel: () => Effect.Effect<
    OrchestrationReadModel,
    ProjectionRepositoryError
  >;

  /**
   * Read the latest orchestration projection snapshot.
   *
   * Rehydrates from projection tables and derives snapshot sequence from
   * projector cursor state.
   */
  readonly getSnapshot: () => Effect.Effect<OrchestrationReadModel, ProjectionRepositoryError>;

  /**
   * Read the latest orchestration shell snapshot.
   *
   * Returns only projects and thread shell summaries so clients can bootstrap
   * lightweight navigation state without hydrating every thread body.
   */
  readonly getShellSnapshot: () => Effect.Effect<
    OrchestrationShellSnapshot,
    ProjectionRepositoryError
  >;

  /**
   * Read archived thread shell summaries for the archive page.
   *
   * This query is separate from the main shell snapshot so archived threads
   * are never bootstrapped into normal navigation state.
   */
  readonly getArchivedShellSnapshot: () => Effect.Effect<
    OrchestrationShellSnapshot,
    ProjectionRepositoryError
  >;

  /**
   * Search active thread navigation metadata, user messages, and canonical
   * assistant outputs without hydrating thread detail snapshots.
   */
  readonly searchThreads: (
    input: OrchestrationSearchThreadsInput,
  ) => Effect.Effect<OrchestrationSearchThreadsResult, ProjectionRepositoryError>;

  /**
   * Read the latest projection snapshot sequence without hydrating read-model
   * entities.
   */
  readonly getSnapshotSequence: () => Effect.Effect<
    ProjectionSnapshotSequence,
    ProjectionRepositoryError
  >;

  /**
   * Read aggregate projection counts without hydrating the full read model.
   */
  readonly getCounts: () => Effect.Effect<ProjectionSnapshotCounts, ProjectionRepositoryError>;

  /**
   * Read the active project for an exact workspace root match.
   */
  readonly getActiveProjectByWorkspaceRoot: (
    workspaceRoot: string,
  ) => Effect.Effect<Option.Option<OrchestrationProject>, ProjectionRepositoryError>;

  /**
   * Read a single active project shell row by id.
   */
  readonly getProjectShellById: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<OrchestrationProjectShell>, ProjectionRepositoryError>;

  /**
   * Read the earliest active thread for a project.
   */
  readonly getFirstActiveThreadIdByProjectId: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<ThreadId>, ProjectionRepositoryError>;

  /**
   * Read the checkpoint context needed to resolve a single thread diff.
   */
  readonly getThreadCheckpointContext: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ProjectionThreadCheckpointContext>, ProjectionRepositoryError>;

  /**
   * Read the latest checkpoint plus, when requested, the checkpoint and
   * assistant message for one exact turn. This never hydrates checkpoint
   * history.
   */
  readonly getThreadCheckpointHeadContext?: (
    threadId: ThreadId,
    turnId?: TurnId,
  ) => Effect.Effect<
    Option.Option<ProjectionThreadCheckpointHeadContext>,
    ProjectionRepositoryError
  >;

  /** Page checkpoint refs newer than a target count without loading file JSON. */
  readonly listThreadCheckpointRefsAfter?: (input: {
    readonly threadId: ThreadId;
    readonly afterCheckpointTurnCount: number;
    readonly cursor?: ProjectionCheckpointRefCursor;
    readonly limit: number;
  }) => Effect.Effect<ProjectionCheckpointRefPage, ProjectionRepositoryError>;

  /**
   * Read only the narrow context needed to compute a full-thread diff from
   * checkpoint 0 to a specific turn count.
   */
  readonly getFullThreadDiffContext: (
    threadId: ThreadId,
    toTurnCount: number,
  ) => Effect.Effect<Option.Option<ProjectionFullThreadDiffContext>, ProjectionRepositoryError>;

  /**
   * Read a single active thread shell row by id.
   */
  readonly getThreadShellById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThreadShell>, ProjectionRepositoryError>;

  /**
   * Reads the exact current message and a byte-bounded recent prefix of prior
   * durable messages without hydrating the thread body.
   */
  readonly getThreadContinuationSeedById?: (
    input: ProjectionThreadContinuationSeedInput,
  ) => Effect.Effect<Option.Option<ProjectionThreadContinuationSeed>, ProjectionRepositoryError>;

  /** Read one exact message row without scanning the thread history. */
  readonly getThreadMessageById?: (
    threadId: ThreadId,
    messageId: MessageId,
  ) => Effect.Effect<Option.Option<OrchestrationMessage>, ProjectionRepositoryError>;

  /** Read one exact proposed plan without hydrating the thread history. */
  readonly getThreadProposedPlanById?: (
    threadId: ThreadId,
    planId: OrchestrationThread["proposedPlans"][number]["id"],
  ) => Effect.Effect<
    Option.Option<OrchestrationThread["proposedPlans"][number]>,
    ProjectionRepositoryError
  >;

  /** Read the first durable user message without hydrating the thread body. */
  readonly getFirstUserMessageByThreadId?: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationMessage>, ProjectionRepositoryError>;

  /** Metadata-only sync index. No message, plan, or activity body is read. */
  readonly getThreadSyncExportIndex?: () => Effect.Effect<
    ProjectionThreadSyncExportIndex,
    ProjectionRepositoryError
  >;

  /** Metadata-only import watermarks used to recover interrupted sync state. */
  readonly listThreadSyncImportWatermarks?: () => Effect.Effect<
    ReadonlyArray<ProjectionThreadSyncImportWatermark>,
    ProjectionRepositoryError
  >;

  /** Reads only aggregate sizes and counts; it never returns projection bodies. */
  readonly getThreadSyncV1HydrationStats?: () => Effect.Effect<
    ProjectionThreadSyncV1HydrationStats,
    ProjectionRepositoryError
  >;

  readonly listThreadSyncExportTurnsPage?: (
    input: ProjectionThreadSyncPageInput<ProjectionThreadSyncTurnCursor>,
  ) => Effect.Effect<
    ProjectionThreadSyncPage<ProjectionThreadSyncExportTurnRow, ProjectionThreadSyncTurnCursor>,
    ProjectionRepositoryError
  >;

  readonly listThreadSyncExportMessagesPage?: (
    input: ProjectionThreadSyncMessagePageInput,
  ) => Effect.Effect<
    ProjectionThreadSyncPage<
      ProjectionThreadSyncExportMessageRow,
      ProjectionThreadSyncEntityCursor
    >,
    ProjectionRepositoryError
  >;

  readonly listThreadSyncExportPlansPage?: (
    input: ProjectionThreadSyncPageInput<ProjectionThreadSyncEntityCursor>,
  ) => Effect.Effect<
    ProjectionThreadSyncPage<ProjectionThreadSyncExportPlanRow, ProjectionThreadSyncEntityCursor>,
    ProjectionRepositoryError
  >;

  readonly listThreadSyncExportActivitiesPage?: (
    input: ProjectionThreadSyncPageInput<ProjectionThreadSyncActivityCursor>,
  ) => Effect.Effect<
    ProjectionThreadSyncPage<
      ProjectionThreadSyncExportActivityRow,
      ProjectionThreadSyncActivityCursor
    >,
    ProjectionRepositoryError
  >;

  /** Reads a byte-bounded UTF-8 slice without materializing the complete text value. */
  readonly readThreadSyncExportTextChunk?: (
    input: ProjectionThreadSyncTextChunkInput,
  ) => Effect.Effect<Option.Option<ProjectionThreadSyncTextChunk>, ProjectionRepositoryError>;

  /**
   * Read a single active thread detail snapshot by id.
   */
  readonly getThreadDetailById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThread>, ProjectionRepositoryError>;

  /**
   * Read a single active thread detail together with the projection snapshot
   * sequence in one consistent transaction, so the returned `snapshotSequence`
   * exactly matches the state reflected in `thread` (no interleaving projector
   * update between the two reads).
   *
   * When `window` is provided, the thread's messages, activities, proposed
   * plans, and checkpoints are bounded to a page of recent turns and the
   * response carries `page` metadata (see `OrchestrationThreadDetailWindow`).
   * Without a window the full thread is returned with no `page` field —
   * pagination is strictly opt-in.
   */
  readonly getThreadDetailSnapshot: (
    threadId: ThreadId,
    window?: OrchestrationThreadDetailWindow,
  ) => Effect.Effect<Option.Option<OrchestrationThreadDetailSnapshot>, ProjectionRepositoryError>;
}

/**
 * ProjectionSnapshotQuery - Service tag for projection snapshot queries.
 */
export class ProjectionSnapshotQuery extends Context.Service<
  ProjectionSnapshotQuery,
  ProjectionSnapshotQueryShape
>()("erebus/orchestration/Services/ProjectionSnapshotQuery") {}
