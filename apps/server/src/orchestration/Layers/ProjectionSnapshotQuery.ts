import {
  ChatAttachment,
  CheckpointRef,
  EventId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  OrchestrationCheckpointFile,
  OrchestrationProposedPlanId,
  OrchestrationReadModel,
  OrchestrationThreadSearchSource,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  OrchestrationThreadDetailSnapshot,
  ProjectScript,
  TurnId,
  type OrchestrationCheckpointSummary,
  type OrchestrationLatestTurn,
  type OrchestrationMessage,
  type OrchestrationProjectShell,
  type OrchestrationProposedPlan,
  type OrchestrationProject,
  type OrchestrationSession,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  ModelSelection,
  ProjectId,
  ThreadLinkedPullRequest,
  ThreadId,
} from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  isPersistenceError,
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from "../../persistence/Errors.ts";
import { ProjectionCheckpoint } from "../../persistence/Services/ProjectionCheckpoints.ts";
import { ThreadBackgroundLivenessService } from "../ThreadBackgroundLiveness.ts";
import { ThreadPlanProgressService } from "../ThreadPlanProgress.ts";
import { ProjectionProject } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionState } from "../../persistence/Services/ProjectionState.ts";
import { ProjectionThreadActivity } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { ProjectionThreadMessage } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlan } from "../../persistence/Services/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadSession } from "../../persistence/Services/ProjectionThreadSessions.ts";
import { ProjectionThread } from "../../persistence/Services/ProjectionThreads.ts";
import {
  decodeThreadDetailPageCursor,
  encodeThreadDetailPageCursor,
} from "../threadDetailCursor.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionFullThreadDiffContext,
  type ProjectionSnapshotCounts,
  type ProjectionThreadContinuationSeed,
  type ProjectionThreadContinuationSeedInput,
  type ProjectionThreadCheckpointContext,
  type ProjectionThreadCheckpointHeadContext,
  type ProjectionCheckpointRefPage,
  type ProjectionThreadSyncActivityCursor,
  type ProjectionThreadSyncEntityCursor,
  type ProjectionThreadSyncTurnCursor,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";

const decodeReadModel = Schema.decodeUnknownEffect(OrchestrationReadModel);
const decodeShellSnapshot = Schema.decodeUnknownEffect(OrchestrationShellSnapshot);
const decodeThread = Schema.decodeUnknownEffect(OrchestrationThread);
const decodeChatAttachments = Schema.decodeUnknownSync(Schema.Array(ChatAttachment));
// Keep detail reads consistent with the in-memory projector's retained
// activity window. Applying the limit in SQL avoids decoding an unbounded
// payload_json set before the projector can enforce that invariant.
const THREAD_DETAIL_ACTIVITY_LIMIT = 500;
const THREAD_DETAIL_PROPOSED_PLAN_LIMIT = 200;
const THREAD_DETAIL_CHECKPOINT_LIMIT = 200;
const THREAD_DETAIL_MESSAGE_LIMIT = 200;
const ProjectionProjectDbRowSchema = ProjectionProject.mapFields(
  Struct.assign({
    defaultModelSelection: Schema.NullOr(Schema.fromJsonString(ModelSelection)),
    scripts: Schema.fromJsonString(Schema.Array(ProjectScript)),
  }),
);
const ProjectionThreadMessageDbRowSchema = ProjectionThreadMessage.mapFields(
  Struct.assign({
    isStreaming: Schema.Number,
    attachments: Schema.NullOr(Schema.fromJsonString(Schema.Array(ChatAttachment))),
  }),
);
const ProjectionThreadProposedPlanDbRowSchema = ProjectionThreadProposedPlan;
const ProjectionThreadDbRowSchema = ProjectionThread.mapFields(
  Struct.assign({
    modelSelection: Schema.fromJsonString(ModelSelection),
    linkedPullRequest: Schema.NullOr(Schema.fromJsonString(ThreadLinkedPullRequest)),
  }),
);
const ProjectionThreadActivityDbRowSchema = ProjectionThreadActivity.mapFields(
  Struct.assign({
    payload: Schema.fromJsonString(Schema.Unknown),
    sequence: Schema.NullOr(NonNegativeInt),
  }),
);
const ProjectionThreadSessionDbRowSchema = ProjectionThreadSession;
const ProjectionCheckpointDbRowSchema = ProjectionCheckpoint.mapFields(
  Struct.assign({
    files: Schema.fromJsonString(Schema.Array(OrchestrationCheckpointFile)),
  }),
);
const ProjectionCheckpointHeadDbRowSchema = Schema.Struct({
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: ProjectionCheckpoint.fields.status,
});
const ProjectionLatestTurnDbRowSchema = Schema.Struct({
  threadId: ProjectionThread.fields.threadId,
  turnId: TurnId,
  state: Schema.String,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  assistantMessageId: Schema.NullOr(MessageId),
  sourceProposedPlanThreadId: Schema.NullOr(ThreadId),
  sourceProposedPlanId: Schema.NullOr(OrchestrationProposedPlanId),
});
const ProjectionStateDbRowSchema = ProjectionState;
const ProjectionCountsRowSchema = Schema.Struct({
  projectCount: Schema.Number,
  threadCount: Schema.Number,
});
const ProjectionThreadSyncV1HydrationStatsRowSchema = Schema.Struct({
  projectCount: Schema.Number,
  threadCount: Schema.Number,
  rowCount: Schema.Number,
  estimatedBytes: Schema.Number,
  maxThreadEstimatedBytes: Schema.Number,
});
const ThreadSyncActiveThreadRowSchema = Schema.Struct({ threadId: ThreadId });
const ThreadSyncWatermarkRowSchema = Schema.Struct({
  threadId: ThreadId,
  threadSequence: Schema.Number,
});
const ThreadSyncLatestTurnIdRowSchema = Schema.Struct({
  threadId: ThreadId,
  latestTurnId: Schema.NullOr(TurnId),
});
const CoagentShellRowSchema = Schema.Struct({
  childThreadId: ThreadId,
  parentThreadId: ThreadId,
  creationMode: Schema.Literals(["blank", "fork"]),
  status: Schema.Literals(["preparing", "ready", "failed", "released"]),
});
const ProjectionThreadSearchRequest = Schema.Struct({
  pattern: Schema.String,
  limit: Schema.Int,
});
const ProjectionThreadSearchRow = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  source: OrchestrationThreadSearchSource,
  matchText: Schema.String,
  messageCreatedAt: Schema.NullOr(IsoDateTime),
});
const WorkspaceRootLookupInput = Schema.Struct({
  workspaceRoot: Schema.String,
});
const ProjectIdLookupInput = Schema.Struct({
  projectId: ProjectId,
});
const ThreadIdLookupInput = Schema.Struct({
  threadId: ThreadId,
});
const ThreadAndTurnLookupInput = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
});
const ThreadAndPlanLookupInput = Schema.Struct({
  threadId: ThreadId,
  planId: OrchestrationProposedPlanId,
});
const ProjectionTurnAssistantMessageRowSchema = Schema.Struct({
  assistantMessageId: Schema.NullOr(MessageId),
});
const ThreadCheckpointRefsAfterLookupInput = Schema.Struct({
  threadId: ThreadId,
  afterCheckpointTurnCount: NonNegativeInt,
  cursorCheckpointTurnCount: NonNegativeInt,
  cursorTurnId: Schema.String,
  limit: Schema.Number,
});
const ProjectionCheckpointRefRowSchema = Schema.Struct({
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
});
const ThreadContinuationSeedLookupInput = Schema.Struct({
  threadId: ThreadId,
  currentMessageId: MessageId,
  maxChars: Schema.Int,
});
const ProjectionThreadContinuationMessageDbRowSchema = ProjectionThreadMessageDbRowSchema.mapFields(
  Struct.assign({
    textTruncated: Schema.Number,
    attachmentsTruncated: Schema.Number,
    totalCount: Schema.Number,
  }),
);
// Windowed reads order turns by the stable keyset (anchor, turn key), where
// anchor is requested_at and turn key is
// COALESCE(turn_id, ''). Both are event-derived, so cursors survive the
// revert projector's row-id rewrite and full projection rebuilds.
const ThreadTurnWindowLookupInput = Schema.Struct({
  threadId: ThreadId,
  // Exclusive keyset upper bound. Sentinels "~"/"" mean unbounded ("~" sorts
  // after every ISO timestamp).
  beforeAnchorAt: Schema.String,
  beforeTurnKey: Schema.String,
  userTurnLimit: Schema.Number,
  maxRawTurns: Schema.Number,
});
const ProjectionTurnWindowRowSchema = Schema.Struct({
  // The turn's timeline anchor, used to bound rows that have no turn linkage
  // (user messages and turnless activities) to the same page window.
  anchorAt: Schema.String,
  turnKey: Schema.String,
});
const ThreadTurnlessWindowLookupInput = Schema.Struct({
  threadId: ThreadId,
  beforeAnchorAt: Schema.String,
  beforeItemKey: Schema.String,
  includePinnedPlans: Schema.Number,
  limit: Schema.Number,
});
const ProjectionTurnlessWindowRowSchema = Schema.Struct({
  anchorAt: Schema.String,
  itemKey: Schema.String,
});
const ThreadTurnlessRangeLookupInput = Schema.Struct({
  threadId: ThreadId,
  minAnchorAt: Schema.String,
  minItemKey: Schema.String,
  beforeAnchorAt: Schema.String,
  beforeItemKey: Schema.String,
});
const ThreadTurnlessPlanRangeLookupInput = ThreadTurnlessRangeLookupInput.mapFields(
  Struct.assign({ includePinnedPlans: Schema.Number }),
);
const ThreadTurnRangeLookupInput = Schema.Struct({
  threadId: ThreadId,
  // Turn-linked rows are bounded by the keyset range [min, before) over
  // (anchor, turn key); turnless rows by the matching [minAnchorAt,
  // beforeAnchorAt) time range. Unbounded ends use sentinels: "" for the
  // lower bound, "~" (sorts after ISO dates) for the upper bound.
  minAnchorAt: Schema.String,
  minTurnKey: Schema.String,
  beforeAnchorAt: Schema.String,
  beforeTurnKey: Schema.String,
});
const ThreadTurnPlanPageLookupInput = ThreadTurnRangeLookupInput.mapFields(
  Struct.assign({
    beforePinned: Schema.Number,
    beforeCreatedAt: Schema.String,
    beforeId: Schema.String,
    limit: Schema.Number,
  }),
);
const ThreadTurnMessagePageLookupInput = ThreadTurnRangeLookupInput.mapFields(
  Struct.assign({
    beforeCreatedAt: Schema.String,
    beforeId: Schema.String,
    limit: Schema.Number,
  }),
);
const ThreadTurnActivityPageLookupInput = ThreadTurnRangeLookupInput.mapFields(
  Struct.assign({
    beforeSequence: Schema.Number,
    beforeCreatedAt: Schema.String,
    beforeId: Schema.String,
    limit: Schema.Number,
  }),
);
const ProjectionProjectLookupRowSchema = ProjectionProjectDbRowSchema;
const ProjectionThreadIdLookupRowSchema = Schema.Struct({
  threadId: ThreadId,
});
const ProjectionThreadCheckpointContextThreadRowSchema = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  workspaceRoot: Schema.String,
  worktreePath: Schema.NullOr(Schema.String),
});
const FullThreadDiffContextLookupInput = Schema.Struct({
  threadId: ThreadId,
  checkpointTurnCount: NonNegativeInt,
});
const ProjectionFullThreadDiffContextRowSchema = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  workspaceRoot: Schema.String,
  worktreePath: Schema.NullOr(Schema.String),
  latestCheckpointTurnCount: Schema.NullOr(NonNegativeInt),
  toCheckpointRef: Schema.NullOr(CheckpointRef),
});

const REQUIRED_SNAPSHOT_PROJECTORS = [
  ORCHESTRATION_PROJECTOR_NAMES.projects,
  ORCHESTRATION_PROJECTOR_NAMES.threads,
  ORCHESTRATION_PROJECTOR_NAMES.threadMessages,
  ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans,
  ORCHESTRATION_PROJECTOR_NAMES.threadActivities,
  ORCHESTRATION_PROJECTOR_NAMES.threadSessions,
  ORCHESTRATION_PROJECTOR_NAMES.checkpoints,
] as const;

function maxIso(left: string | null, right: string): string {
  if (left === null) {
    return right;
  }
  return left > right ? left : right;
}

function escapeLikePattern(value: string): string {
  return value.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_");
}

function foldAsciiCase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function buildSearchSnippet(text: string, query: string): string {
  const normalizedText = text.replace(/\s+/g, " ").trim();
  if (normalizedText.length <= 240) {
    return normalizedText;
  }

  const normalizedQuery = foldAsciiCase(query.replace(/\s+/g, " ").trim());
  const matchIndex = foldAsciiCase(normalizedText).indexOf(normalizedQuery);
  const bodyLength = 236;
  const idealStart = Math.max(0, matchIndex - 72);
  const start = Math.min(idealStart, normalizedText.length - bodyLength);
  const end = Math.min(normalizedText.length, start + bodyLength);
  return `${start > 0 ? "…" : ""}${normalizedText.slice(start, end)}${
    end < normalizedText.length ? "…" : ""
  }`;
}

function computeSnapshotSequence(
  stateRows: ReadonlyArray<Schema.Schema.Type<typeof ProjectionStateDbRowSchema>>,
): number {
  if (stateRows.length === 0) {
    return 0;
  }
  const sequenceByProjector = new Map(
    stateRows.map((row) => [row.projector, row.lastAppliedSequence] as const),
  );

  let minSequence = Number.POSITIVE_INFINITY;
  for (const projector of REQUIRED_SNAPSHOT_PROJECTORS) {
    const sequence = sequenceByProjector.get(projector);
    if (sequence === undefined) {
      return 0;
    }
    if (sequence < minSequence) {
      minSequence = sequence;
    }
  }

  return Number.isFinite(minSequence) ? minSequence : 0;
}

function mapLatestTurn(
  row: Schema.Schema.Type<typeof ProjectionLatestTurnDbRowSchema>,
): OrchestrationLatestTurn {
  return {
    turnId: row.turnId,
    state:
      row.state === "error"
        ? "error"
        : row.state === "interrupted"
          ? "interrupted"
          : row.state === "completed"
            ? "completed"
            : "running",
    requestedAt: row.requestedAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    assistantMessageId: row.assistantMessageId,
    ...(row.sourceProposedPlanThreadId !== null && row.sourceProposedPlanId !== null
      ? {
          sourceProposedPlan: {
            threadId: row.sourceProposedPlanThreadId,
            planId: row.sourceProposedPlanId,
          },
        }
      : {}),
  };
}

function mapTitleRegeneration(row: Schema.Schema.Type<typeof ProjectionThreadDbRowSchema>) {
  return row.titleRegenerationRequestId != null && row.titleRegenerationStartedAt != null
    ? {
        requestId: row.titleRegenerationRequestId,
        startedAt: row.titleRegenerationStartedAt,
      }
    : null;
}

function mapSessionRow(
  row: Schema.Schema.Type<typeof ProjectionThreadSessionDbRowSchema>,
): OrchestrationSession {
  return {
    threadId: row.threadId,
    status: row.status,
    providerName: row.providerName,
    ...(row.providerInstanceId !== null ? { providerInstanceId: row.providerInstanceId } : {}),
    runtimeMode: row.runtimeMode,
    activeTurnId: row.activeTurnId,
    lastError: row.lastError,
    updatedAt: row.updatedAt,
  };
}

function mapProjectShellRow(
  row: Schema.Schema.Type<typeof ProjectionProjectDbRowSchema>,
  repositoryIdentity: OrchestrationProject["repositoryIdentity"],
): OrchestrationProjectShell {
  return {
    id: row.projectId,
    title: row.title,
    workspaceRoot: row.workspaceRoot,
    repositoryIdentity,
    defaultModelSelection: row.defaultModelSelection,
    defaultThreadEnvMode: row.defaultThreadEnvMode,
    faviconPath: row.faviconPath ?? null,
    scripts: row.scripts,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapProposedPlanRow(
  row: Schema.Schema.Type<typeof ProjectionThreadProposedPlanDbRowSchema>,
): OrchestrationProposedPlan {
  return {
    id: row.planId,
    turnId: row.turnId,
    planMarkdown: row.planMarkdown,
    implementedAt: row.implementedAt,
    implementationThreadId: row.implementationThreadId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ProjectionRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeProjectionSnapshotQuery = Effect.gen(function* () {
  const threadBackgroundLiveness = yield* ThreadBackgroundLivenessService;
  const threadPlanProgress = yield* ThreadPlanProgressService;
  const sql = yield* SqlClient.SqlClient;
  const repositoryIdentityResolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const repositoryIdentityResolutionConcurrency = 4;
  const resolveRepositoryIdentitiesForProjects = Effect.fn(
    "ProjectionSnapshotQuery.resolveRepositoryIdentitiesForProjects",
  )(function* (
    projectRows: ReadonlyArray<Schema.Schema.Type<typeof ProjectionProjectDbRowSchema>>,
    options?: {
      readonly includeDeleted?: boolean;
    },
  ) {
    const filteredProjectRows =
      options?.includeDeleted === true
        ? projectRows
        : projectRows.filter((row) => row.deletedAt === null);
    const uniqueWorkspaceRoots = [...new Set(filteredProjectRows.map((row) => row.workspaceRoot))];
    const repositoryIdentityByWorkspaceRoot = new Map(
      yield* Effect.forEach(
        uniqueWorkspaceRoots,
        (workspaceRoot) =>
          repositoryIdentityResolver
            .resolve(workspaceRoot)
            .pipe(Effect.map((identity) => [workspaceRoot, identity] as const)),
        { concurrency: repositoryIdentityResolutionConcurrency },
      ),
    );

    return new Map(
      filteredProjectRows.map((row) => [
        row.projectId,
        repositoryIdentityByWorkspaceRoot.get(row.workspaceRoot) ?? null,
      ]),
    );
  });

  const listProjectRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionProjectDbRowSchema,
    execute: () =>
      sql`
        SELECT
          project_id AS "projectId",
          title,
          workspace_root AS "workspaceRoot",
          default_model_selection_json AS "defaultModelSelection",
          default_thread_env_mode AS "defaultThreadEnvMode",
          favicon_path AS "faviconPath",
          scripts_json AS "scripts",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        ORDER BY created_at ASC, project_id ASC
      `,
  });

  const listThreadRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          linked_pull_request_json AS "linkedPullRequest",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          settled_override AS "settledOverride",
          settled_at AS "settledAt",
          unsettled_at AS "unsettledAt",
          snoozed_until AS "snoozedUntil",
          snoozed_at AS "snoozedAt",
          pinned_at AS "pinnedAt",
          pin_order_key AS "pinOrderKey",
          title_regeneration_request_id AS "titleRegenerationRequestId",
          title_regeneration_started_at AS "titleRegenerationStartedAt",
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          deleted_at AS "deletedAt"
        FROM projection_threads
        ORDER BY created_at ASC, thread_id ASC
      `,
  });

  const listActiveThreadRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          linked_pull_request_json AS "linkedPullRequest",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          settled_override AS "settledOverride",
          settled_at AS "settledAt",
          unsettled_at AS "unsettledAt",
          snoozed_until AS "snoozedUntil",
          snoozed_at AS "snoozedAt",
          pinned_at AS "pinnedAt",
          pin_order_key AS "pinOrderKey",
          title_regeneration_request_id AS "titleRegenerationRequestId",
          title_regeneration_started_at AS "titleRegenerationStartedAt",
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE deleted_at IS NULL
          AND archived_at IS NULL
        ORDER BY project_id ASC, created_at ASC, thread_id ASC
      `,
  });

  const listActiveCoagentRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: CoagentShellRowSchema,
    execute: () => sql`
      SELECT
        child_thread_id AS "childThreadId",
        parent_thread_id AS "parentThreadId",
        creation_mode AS "creationMode",
        status
      FROM coagent_threads
      WHERE status != 'released'
    `,
  });

  const listCoagentRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: CoagentShellRowSchema,
    execute: () => sql`
      SELECT
        child_thread_id AS "childThreadId",
        parent_thread_id AS "parentThreadId",
        creation_mode AS "creationMode",
        status
      FROM coagent_threads
    `,
  });

  const getCoagentRowByChild = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: CoagentShellRowSchema,
    execute: ({ threadId }) => sql`
      SELECT
        child_thread_id AS "childThreadId",
        parent_thread_id AS "parentThreadId",
        creation_mode AS "creationMode",
        status
      FROM coagent_threads
      WHERE child_thread_id = ${threadId}
      LIMIT 1
    `,
  });

  const getActiveCoagentRowByChild = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: CoagentShellRowSchema,
    execute: ({ threadId }) => sql`
      SELECT
        child_thread_id AS "childThreadId",
        parent_thread_id AS "parentThreadId",
        creation_mode AS "creationMode",
        status
      FROM coagent_threads
      WHERE child_thread_id = ${threadId}
        AND status != 'released'
      LIMIT 1
    `,
  });

  const listArchivedThreadRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          linked_pull_request_json AS "linkedPullRequest",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          settled_override AS "settledOverride",
          settled_at AS "settledAt",
          unsettled_at AS "unsettledAt",
          snoozed_until AS "snoozedUntil",
          snoozed_at AS "snoozedAt",
          pinned_at AS "pinnedAt",
          pin_order_key AS "pinOrderKey",
          title_regeneration_request_id AS "titleRegenerationRequestId",
          title_regeneration_started_at AS "titleRegenerationStartedAt",
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE deleted_at IS NULL
          AND archived_at IS NOT NULL
        ORDER BY project_id ASC, archived_at DESC, thread_id DESC
      `,
  });

  const listThreadMessageRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: () =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        ORDER BY thread_id ASC, created_at ASC, message_id ASC
      `,
  });

  // The command decider only needs to know whether a thread has streaming
  // messages. Read every active metadata row; message bodies and attachments
  // stay on the paged detail path.
  const listCommandStreamingMessageRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: () =>
      sql`
        SELECT
          messages.message_id AS "messageId",
          messages.thread_id AS "threadId",
          messages.turn_id AS "turnId",
          messages.role,
          '' AS text,
          NULL AS attachments,
          messages.is_streaming AS "isStreaming",
          messages.created_at AS "createdAt",
          messages.updated_at AS "updatedAt"
        FROM projection_thread_messages AS messages
        INNER JOIN projection_threads AS threads
          ON threads.thread_id = messages.thread_id
        WHERE messages.is_streaming = 1
          AND threads.deleted_at IS NULL
        ORDER BY messages.thread_id ASC, messages.updated_at ASC, messages.message_id ASC
      `,
  });

  // Load one compact, real activity row for each unresolved request ID. The
  // lifecycle tables make this proportional to actionable state, not total
  // activity history.
  const listCommandBlockingActivityRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: () =>
      sql`
        WITH blocking_activity_ids AS (
          SELECT (
            SELECT activity.activity_id
            FROM projection_thread_activities AS activity
            WHERE activity.thread_id = approval.thread_id
              AND activity.kind = 'approval.requested'
              AND json_extract(activity.payload_json, '$.requestId') = approval.request_id
            ORDER BY activity.created_at DESC, activity.activity_id DESC
            LIMIT 1
          ) AS activity_id,
          approval.request_id
          FROM projection_pending_approvals AS approval
          INNER JOIN projection_threads AS threads
            ON threads.thread_id = approval.thread_id
          WHERE approval.status = 'pending'
            AND threads.deleted_at IS NULL
          UNION ALL
          SELECT pending.request_activity_id AS activity_id, pending.request_id
          FROM projection_pending_user_inputs AS pending
          INNER JOIN projection_threads AS threads
            ON threads.thread_id = pending.thread_id
          WHERE threads.deleted_at IS NULL
        )
        SELECT
          activity.activity_id AS "activityId",
          activity.thread_id AS "threadId",
          activity.turn_id AS "turnId",
          activity.tone,
          activity.kind,
          'Pending request' AS summary,
          json_object('requestId', blocking.request_id) AS payload,
          activity.sequence,
          activity.created_at AS "createdAt"
        FROM blocking_activity_ids AS blocking
        INNER JOIN projection_thread_activities AS activity
          ON activity.activity_id = blocking.activity_id
        WHERE blocking.activity_id IS NOT NULL
        ORDER BY activity.thread_id ASC, activity.created_at ASC, activity.activity_id ASC
      `,
  });

  const listThreadProposedPlanRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadProposedPlanDbRowSchema,
    execute: () =>
      sql`
        SELECT
          plan_id AS "planId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          plan_markdown AS "planMarkdown",
          implemented_at AS "implementedAt",
          implementation_thread_id AS "implementationThreadId",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_proposed_plans
        ORDER BY thread_id ASC, created_at ASC, plan_id ASC
      `,
  });

  // The command model only needs a bounded recent set of plans that can still
  // be selected as the source of a new implementation turn. Exact older
  // selections are loaded on demand by the engine. Historical plan bodies
  // remain in the projection and are loaded by paged detail/sync queries
  // instead of at process startup.
  const listActionableThreadProposedPlanRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadProposedPlanDbRowSchema,
    execute: () =>
      sql`
        WITH ranked_plan_keys AS (
          SELECT
            plans.plan_id,
            plans.thread_id,
            ROW_NUMBER() OVER (
              PARTITION BY plans.thread_id
              ORDER BY plans.created_at DESC, plans.plan_id DESC
            ) AS plan_rank
          FROM projection_thread_proposed_plans AS plans
          INNER JOIN projection_threads AS threads
            ON threads.thread_id = plans.thread_id
          INNER JOIN projection_projects AS projects
            ON projects.project_id = threads.project_id
          WHERE plans.implemented_at IS NULL
            AND threads.archived_at IS NULL
            AND threads.deleted_at IS NULL
            AND projects.deleted_at IS NULL
        )
        SELECT
          plans.plan_id AS "planId",
          plans.thread_id AS "threadId",
          plans.turn_id AS "turnId",
          plans.plan_markdown AS "planMarkdown",
          plans.implemented_at AS "implementedAt",
          plans.implementation_thread_id AS "implementationThreadId",
          plans.created_at AS "createdAt",
          plans.updated_at AS "updatedAt"
        FROM ranked_plan_keys AS ranked
        INNER JOIN projection_thread_proposed_plans AS plans
          ON plans.plan_id = ranked.plan_id
          AND plans.thread_id = ranked.thread_id
        WHERE ranked.plan_rank <= 200
        ORDER BY plans.thread_id ASC, plans.created_at ASC, plans.plan_id ASC
      `,
  });

  const listThreadActivityRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: () =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM projection_thread_activities
        ORDER BY
          thread_id ASC,
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  const listThreadSessionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          status,
          provider_name AS "providerName",
          provider_instance_id AS "providerInstanceId",
          provider_session_id AS "providerSessionId",
          provider_thread_id AS "providerThreadId",
          runtime_mode AS "runtimeMode",
          active_turn_id AS "activeTurnId",
          last_error AS "lastError",
          updated_at AS "updatedAt"
        FROM projection_thread_sessions
        ORDER BY thread_id ASC
      `,
  });

  const listActiveThreadSessionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: () =>
      sql`
        SELECT
          sessions.thread_id AS "threadId",
          sessions.status,
          sessions.provider_name AS "providerName",
          sessions.provider_instance_id AS "providerInstanceId",
          sessions.provider_session_id AS "providerSessionId",
          sessions.provider_thread_id AS "providerThreadId",
          sessions.runtime_mode AS "runtimeMode",
          sessions.active_turn_id AS "activeTurnId",
          sessions.last_error AS "lastError",
          sessions.updated_at AS "updatedAt"
        FROM projection_thread_sessions sessions
        INNER JOIN projection_threads threads
          ON threads.thread_id = sessions.thread_id
        WHERE threads.deleted_at IS NULL
          AND threads.archived_at IS NULL
        ORDER BY sessions.thread_id ASC
      `,
  });

  const listArchivedThreadSessionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: () =>
      sql`
        SELECT
          sessions.thread_id AS "threadId",
          sessions.status,
          sessions.provider_name AS "providerName",
          sessions.provider_instance_id AS "providerInstanceId",
          sessions.provider_session_id AS "providerSessionId",
          sessions.provider_thread_id AS "providerThreadId",
          sessions.runtime_mode AS "runtimeMode",
          sessions.active_turn_id AS "activeTurnId",
          sessions.last_error AS "lastError",
          sessions.updated_at AS "updatedAt"
        FROM projection_thread_sessions sessions
        INNER JOIN projection_threads threads
          ON threads.thread_id = sessions.thread_id
        WHERE threads.deleted_at IS NULL
          AND threads.archived_at IS NOT NULL
        ORDER BY sessions.thread_id ASC
      `,
  });

  const listCheckpointRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionCheckpointDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "status",
          checkpoint_files_json AS "files",
          assistant_message_id AS "assistantMessageId",
          completed_at AS "completedAt"
        FROM projection_turns
        WHERE checkpoint_turn_count IS NOT NULL
        ORDER BY thread_id ASC, checkpoint_turn_count ASC
      `,
  });

  const listLatestTurnRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: () =>
      sql`
        SELECT
          turns.thread_id AS "threadId",
          turns.turn_id AS "turnId",
          turns.state,
          turns.requested_at AS "requestedAt",
          turns.started_at AS "startedAt",
          turns.completed_at AS "completedAt",
          turns.assistant_message_id AS "assistantMessageId",
          turns.source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          turns.source_proposed_plan_id AS "sourceProposedPlanId"
        FROM projection_threads threads
        JOIN projection_turns turns
          ON turns.thread_id = threads.thread_id
          AND turns.turn_id = threads.latest_turn_id
        WHERE threads.latest_turn_id IS NOT NULL
        ORDER BY turns.thread_id ASC
      `,
  });

  const listActiveLatestTurnRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: () =>
      sql`
        SELECT
          turns.thread_id AS "threadId",
          turns.turn_id AS "turnId",
          turns.state,
          turns.requested_at AS "requestedAt",
          turns.started_at AS "startedAt",
          turns.completed_at AS "completedAt",
          turns.assistant_message_id AS "assistantMessageId",
          turns.source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          turns.source_proposed_plan_id AS "sourceProposedPlanId"
        FROM projection_threads threads
        JOIN projection_turns turns
          ON turns.thread_id = threads.thread_id
          AND turns.turn_id = threads.latest_turn_id
        WHERE threads.deleted_at IS NULL
          AND threads.archived_at IS NULL
          AND threads.latest_turn_id IS NOT NULL
        ORDER BY turns.thread_id ASC
      `,
  });

  const listArchivedLatestTurnRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: () =>
      sql`
        SELECT
          turns.thread_id AS "threadId",
          turns.turn_id AS "turnId",
          turns.state,
          turns.requested_at AS "requestedAt",
          turns.started_at AS "startedAt",
          turns.completed_at AS "completedAt",
          turns.assistant_message_id AS "assistantMessageId",
          turns.source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          turns.source_proposed_plan_id AS "sourceProposedPlanId"
        FROM projection_threads threads
        JOIN projection_turns turns
          ON turns.thread_id = threads.thread_id
          AND turns.turn_id = threads.latest_turn_id
        WHERE threads.deleted_at IS NULL
          AND threads.archived_at IS NOT NULL
          AND threads.latest_turn_id IS NOT NULL
        ORDER BY turns.thread_id ASC
      `,
  });

  const listProjectionStateRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionStateDbRowSchema,
    execute: () =>
      sql`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence",
          updated_at AS "updatedAt"
        FROM projection_state
      `,
  });

  const listThreadSyncActiveThreadRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ThreadSyncActiveThreadRowSchema,
    execute: () => sql`
      SELECT threads.thread_id AS "threadId"
      FROM projection_threads AS threads
      WHERE EXISTS (
        SELECT 1
        FROM projection_turns AS turns
        WHERE turns.thread_id = threads.thread_id
          AND (
            turns.turn_id IS NULL
            OR turns.completed_at IS NULL
            OR turns.state IN ('pending', 'running')
          )
      ) OR EXISTS (
        SELECT 1
        FROM projection_thread_messages AS messages
        WHERE messages.thread_id = threads.thread_id
          AND messages.is_streaming = 1
      ) OR EXISTS (
        SELECT 1
        FROM projection_thread_sessions AS sessions
        WHERE sessions.thread_id = threads.thread_id
          AND (
            sessions.status IN ('starting', 'running')
            OR sessions.active_turn_id IS NOT NULL
          )
      )
      ORDER BY threads.thread_id ASC
    `,
  });

  const listThreadSyncWatermarkRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ThreadSyncWatermarkRowSchema,
    execute: () => sql`
      SELECT
        threads.thread_id AS "threadId",
        COALESCE(MAX(events.sequence), 0) AS "threadSequence"
      FROM projection_threads AS threads
      LEFT JOIN orchestration_events AS events
        ON events.aggregate_kind = 'thread'
        AND events.stream_id = threads.thread_id
      GROUP BY threads.thread_id
      ORDER BY threads.thread_id ASC
    `,
  });

  const listThreadSyncLatestTurnIdRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ThreadSyncLatestTurnIdRowSchema,
    execute: () => sql`
      SELECT
        threads.thread_id AS "threadId",
        COALESCE(turns.sync_portable_id, turns.turn_id) AS "latestTurnId"
      FROM projection_threads AS threads
      LEFT JOIN projection_turns AS turns
        ON turns.thread_id = threads.thread_id
        AND turns.turn_id = threads.latest_turn_id
        AND turns.completed_at IS NOT NULL
        AND turns.state IN ('interrupted', 'completed', 'error')
      ORDER BY threads.thread_id ASC
    `,
  });

  const readProjectionCounts = SqlSchema.findOne({
    Request: Schema.Void,
    Result: ProjectionCountsRowSchema,
    execute: () =>
      sql`
        SELECT
          (SELECT COUNT(*) FROM projection_projects) AS "projectCount",
          (SELECT COUNT(*) FROM projection_threads) AS "threadCount"
      `,
  });

  const searchActiveThreadRows = SqlSchema.findAll({
    Request: ProjectionThreadSearchRequest,
    Result: ProjectionThreadSearchRow,
    execute: ({ pattern, limit }) =>
      sql`
        WITH ranked AS (
          SELECT
            threads.thread_id AS thread_id,
            threads.project_id AS project_id,
            CASE messages.role
              WHEN 'user' THEN 'user'
              ELSE 'assistant'
            END AS source,
            messages.text AS match_text,
            messages.created_at AS message_created_at,
            CASE messages.role
              WHEN 'user' THEN 0
              ELSE 1
            END AS match_rank,
            threads.updated_at AS thread_updated_at,
            ROW_NUMBER() OVER (
              PARTITION BY threads.thread_id
              ORDER BY
                CASE messages.role
                  WHEN 'user' THEN 0
                  ELSE 1
                END ASC,
                messages.created_at DESC,
                messages.message_id ASC
            ) AS thread_match_rank
          FROM projection_thread_messages AS messages
          INNER JOIN projection_threads AS threads
            ON threads.thread_id = messages.thread_id
          INNER JOIN projection_projects AS projects
            ON projects.project_id = threads.project_id
          WHERE threads.deleted_at IS NULL
            AND threads.archived_at IS NULL
            AND projects.deleted_at IS NULL
            AND messages.is_streaming = 0
            AND (
              messages.role = 'user'
              OR (
                messages.role = 'assistant'
                AND messages.message_id IN (
                  SELECT turns.assistant_message_id
                  FROM projection_turns AS turns
                  WHERE turns.assistant_message_id IS NOT NULL
                )
              )
            )
            AND messages.text LIKE ${pattern} ESCAPE '!'
        )
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          source,
          match_text AS "matchText",
          message_created_at AS "messageCreatedAt"
        FROM ranked
        WHERE thread_match_rank = 1
        ORDER BY
          match_rank ASC,
          thread_updated_at DESC,
          thread_id ASC
        LIMIT ${limit}
      `,
  });

  const getActiveProjectRowByWorkspaceRoot = SqlSchema.findOneOption({
    Request: WorkspaceRootLookupInput,
    Result: ProjectionProjectLookupRowSchema,
    execute: ({ workspaceRoot }) =>
      sql`
        SELECT
          project_id AS "projectId",
          title,
          workspace_root AS "workspaceRoot",
          default_model_selection_json AS "defaultModelSelection",
          default_thread_env_mode AS "defaultThreadEnvMode",
          favicon_path AS "faviconPath",
          scripts_json AS "scripts",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        WHERE workspace_root = ${workspaceRoot}
          AND deleted_at IS NULL
        ORDER BY created_at ASC, project_id ASC
        LIMIT 1
      `,
  });

  const getActiveProjectRowById = SqlSchema.findOneOption({
    Request: ProjectIdLookupInput,
    Result: ProjectionProjectLookupRowSchema,
    execute: ({ projectId }) =>
      sql`
        SELECT
          project_id AS "projectId",
          title,
          workspace_root AS "workspaceRoot",
          default_model_selection_json AS "defaultModelSelection",
          default_thread_env_mode AS "defaultThreadEnvMode",
          favicon_path AS "faviconPath",
          scripts_json AS "scripts",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        WHERE project_id = ${projectId}
          AND deleted_at IS NULL
        LIMIT 1
      `,
  });

  const getFirstActiveThreadIdByProject = SqlSchema.findOneOption({
    Request: ProjectIdLookupInput,
    Result: ProjectionThreadIdLookupRowSchema,
    execute: ({ projectId }) =>
      sql`
        SELECT
          thread_id AS "threadId"
        FROM projection_threads
        WHERE project_id = ${projectId}
          AND deleted_at IS NULL
          AND archived_at IS NULL
        ORDER BY created_at ASC, thread_id ASC
        LIMIT 1
      `,
  });

  const getThreadCheckpointContextThreadRow = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadCheckpointContextThreadRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          threads.thread_id AS "threadId",
          threads.project_id AS "projectId",
          projects.workspace_root AS "workspaceRoot",
          threads.worktree_path AS "worktreePath"
        FROM projection_threads AS threads
        INNER JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE threads.thread_id = ${threadId}
          AND threads.deleted_at IS NULL
        LIMIT 1
      `,
  });

  const getActiveThreadRowById = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          linked_pull_request_json AS "linkedPullRequest",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          settled_override AS "settledOverride",
          settled_at AS "settledAt",
          unsettled_at AS "unsettledAt",
          snoozed_until AS "snoozedUntil",
          snoozed_at AS "snoozedAt",
          pinned_at AS "pinnedAt",
          pin_order_key AS "pinOrderKey",
          title_regeneration_request_id AS "titleRegenerationRequestId",
          title_regeneration_started_at AS "titleRegenerationStartedAt",
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE thread_id = ${threadId}
          AND deleted_at IS NULL
          AND archived_at IS NULL
        LIMIT 1
      `,
  });

  const listThreadMessageRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, message_id ASC
      `,
  });

  const getThreadContinuationCurrentMessage = SqlSchema.findOneOption({
    Request: ThreadContinuationSeedLookupInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId, currentMessageId }) =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
          AND message_id = ${currentMessageId}
        LIMIT 1
      `,
  });

  const getFirstUserMessageRowByThread = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
          AND role = 'user'
          AND is_streaming = 0
        ORDER BY created_at ASC, message_id ASC
        LIMIT 1
      `,
  });

  const listThreadContinuationPriorMessages = SqlSchema.findAll({
    Request: ThreadContinuationSeedLookupInput,
    Result: ProjectionThreadContinuationMessageDbRowSchema,
    execute: ({ threadId, currentMessageId, maxChars }) =>
      sql`
        WITH current_message AS (
          SELECT created_at, message_id
          FROM projection_thread_messages
          WHERE thread_id = ${threadId}
            AND message_id = ${currentMessageId}
          LIMIT 1
        ), candidates AS (
          SELECT
            messages.message_id AS "messageId",
            messages.created_at AS "createdAt",
            length(messages.text) AS "textChars",
            COALESCE(length(messages.attachments_json), 0) AS "attachmentChars"
          FROM projection_thread_messages AS messages
          CROSS JOIN current_message AS current
          WHERE messages.thread_id = ${threadId}
            AND messages.is_streaming = 0
            AND (
              messages.created_at < current.created_at OR
              (messages.created_at = current.created_at AND messages.message_id < current.message_id)
            )
          ORDER BY messages.created_at DESC, messages.message_id DESC
          LIMIT 2001
        ), ordered AS (
          SELECT
            *,
            MAX(
              1,
              MIN(
                "textChars" + "attachmentChars" + 128,
                ${maxChars} + 1
              )
            ) AS "rowCost",
            COUNT(*) OVER () AS "totalCount"
          FROM candidates
        ), budgeted AS (
          SELECT
            *,
            COALESCE(
              SUM("rowCost") OVER (
                ORDER BY "createdAt" DESC, "messageId" DESC
                ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
              ),
              0
            ) AS "spentBefore"
          FROM ordered
        )
        SELECT
          messages.message_id AS "messageId",
          messages.thread_id AS "threadId",
          messages.turn_id AS "turnId",
          messages.role,
          substr(
            messages.text,
            -MIN("textChars", MAX(0, ${maxChars} - "spentBefore"))
          ) AS text,
          CASE
            WHEN messages.attachments_json IS NOT NULL
              AND "attachmentChars" <= MAX(
                0,
                ${maxChars} - "spentBefore" - MIN("textChars", MAX(0, ${maxChars} - "spentBefore"))
              )
            THEN messages.attachments_json
            ELSE NULL
          END AS "attachments",
          messages.is_streaming AS "isStreaming",
          messages.created_at AS "createdAt",
          messages.updated_at AS "updatedAt",
          CASE WHEN "textChars" > MAX(0, ${maxChars} - "spentBefore") THEN 1 ELSE 0 END
            AS "textTruncated",
          CASE
            WHEN messages.attachments_json IS NOT NULL
              AND "attachmentChars" > MAX(
                0,
                ${maxChars} - "spentBefore" - MIN("textChars", MAX(0, ${maxChars} - "spentBefore"))
              )
            THEN 1
            ELSE 0
          END AS "attachmentsTruncated",
          "totalCount"
        FROM budgeted
        INNER JOIN projection_thread_messages AS messages
          ON messages.thread_id = ${threadId}
          AND messages.message_id = budgeted."messageId"
        WHERE "spentBefore" < ${maxChars}
        ORDER BY budgeted."createdAt" DESC, budgeted."messageId" DESC
        LIMIT 2000
      `,
  });

  const listThreadProposedPlanRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadProposedPlanDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          plan_id AS "planId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          plan_markdown AS "planMarkdown",
          implemented_at AS "implementedAt",
          implementation_thread_id AS "implementationThreadId",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_proposed_plans
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, plan_id ASC
      `,
  });

  const getThreadProposedPlanRowById = SqlSchema.findOneOption({
    Request: ThreadAndPlanLookupInput,
    Result: ProjectionThreadProposedPlanDbRowSchema,
    execute: ({ threadId, planId }) =>
      sql`
        SELECT
          plan_id AS "planId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          plan_markdown AS "planMarkdown",
          implemented_at AS "implementedAt",
          implementation_thread_id AS "implementationThreadId",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_proposed_plans
        WHERE thread_id = ${threadId}
          AND plan_id = ${planId}
        LIMIT 1
      `,
  });

  const listThreadProposedPlanRowsByTurnWindow = SqlSchema.findAll({
    Request: ThreadTurnPlanPageLookupInput,
    Result: ProjectionThreadProposedPlanDbRowSchema,
    execute: ({
      threadId,
      minAnchorAt,
      minTurnKey,
      beforeAnchorAt,
      beforeTurnKey,
      beforePinned,
      beforeCreatedAt,
      beforeId,
      limit,
    }) =>
      sql`
        WITH candidate_keys AS (
          SELECT
            plans.plan_id,
            plans.created_at,
            CASE WHEN plans.implemented_at IS NULL THEN 1 ELSE 0 END AS pinned
          FROM projection_thread_proposed_plans AS plans
          LEFT JOIN projection_turns AS turns
            ON turns.thread_id = plans.thread_id
            AND turns.turn_id = plans.turn_id
          WHERE plans.thread_id = ${threadId}
            AND (
              plans.implemented_at IS NULL
              OR (
                turns.turn_id IS NOT NULL
                AND (
                  turns.requested_at > ${minAnchorAt}
                  OR (
                    turns.requested_at = ${minAnchorAt}
                    AND COALESCE(turns.turn_id, '') >= ${minTurnKey}
                  )
                )
                AND (
                  turns.requested_at < ${beforeAnchorAt}
                  OR (
                    turns.requested_at = ${beforeAnchorAt}
                    AND COALESCE(turns.turn_id, '') < ${beforeTurnKey}
                  )
                )
              )
              OR (
                turns.turn_id IS NULL
                AND plans.created_at >= ${minAnchorAt}
                AND plans.created_at < ${beforeAnchorAt}
              )
            )
            AND (
              CASE WHEN plans.implemented_at IS NULL THEN 1 ELSE 0 END < ${beforePinned}
              OR (
                CASE WHEN plans.implemented_at IS NULL THEN 1 ELSE 0 END = ${beforePinned}
                AND plans.created_at < ${beforeCreatedAt}
              )
              OR (
                CASE WHEN plans.implemented_at IS NULL THEN 1 ELSE 0 END = ${beforePinned}
                AND plans.created_at = ${beforeCreatedAt}
                AND plans.plan_id < ${beforeId}
              )
            )
          ORDER BY pinned DESC, plans.created_at DESC, plans.plan_id DESC
          LIMIT ${limit}
        )
        SELECT
          plans.plan_id AS "planId",
          plans.thread_id AS "threadId",
          plans.turn_id AS "turnId",
          plans.plan_markdown AS "planMarkdown",
          plans.implemented_at AS "implementedAt",
          plans.implementation_thread_id AS "implementationThreadId",
          plans.created_at AS "createdAt",
          plans.updated_at AS "updatedAt"
        FROM candidate_keys AS keys
        INNER JOIN projection_thread_proposed_plans AS plans
          ON plans.thread_id = ${threadId}
          AND plans.plan_id = keys.plan_id
        ORDER BY keys.pinned DESC, keys.created_at DESC, keys.plan_id DESC
      `,
  });

  const listThreadProposedPlanRowsByTurnlessWindow = SqlSchema.findAll({
    Request: ThreadTurnlessPlanRangeLookupInput,
    Result: ProjectionThreadProposedPlanDbRowSchema,
    execute: ({
      threadId,
      minAnchorAt,
      minItemKey,
      beforeAnchorAt,
      beforeItemKey,
      includePinnedPlans,
    }) =>
      sql`
        SELECT
          plan_id AS "planId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          plan_markdown AS "planMarkdown",
          implemented_at AS "implementedAt",
          implementation_thread_id AS "implementationThreadId",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_proposed_plans
        WHERE thread_id = ${threadId}
          AND (
            turn_id IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM projection_turns AS linked_turn
              WHERE linked_turn.thread_id = ${threadId}
                AND linked_turn.turn_id = projection_thread_proposed_plans.turn_id
            )
          )
          AND (${includePinnedPlans} = 1 OR implemented_at IS NOT NULL)
          AND (
            created_at > ${minAnchorAt}
            OR (created_at = ${minAnchorAt} AND 'p:' || plan_id >= ${minItemKey})
          )
          AND (
            created_at < ${beforeAnchorAt}
            OR (created_at = ${beforeAnchorAt} AND 'p:' || plan_id < ${beforeItemKey})
          )
        ORDER BY created_at ASC, plan_id ASC
      `,
  });

  const listThreadActivityRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM (
          SELECT
            activity_id,
            thread_id,
            turn_id,
            tone,
            kind,
            summary,
            payload_json,
            sequence,
            created_at
          FROM projection_thread_activities
          WHERE thread_id = ${threadId}
          ORDER BY
            sequence DESC,
            created_at DESC,
            activity_id DESC
          LIMIT ${THREAD_DETAIL_ACTIVITY_LIMIT}
        ) AS recent_activities
        ORDER BY
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  const getThreadSessionRowByThread = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          status,
          provider_name AS "providerName",
          provider_instance_id AS "providerInstanceId",
          runtime_mode AS "runtimeMode",
          active_turn_id AS "activeTurnId",
          last_error AS "lastError",
          updated_at AS "updatedAt"
        FROM projection_thread_sessions
        WHERE thread_id = ${threadId}
        LIMIT 1
      `,
  });

  const getLatestTurnRowByThread = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          turns.thread_id AS "threadId",
          turns.turn_id AS "turnId",
          turns.state,
          turns.requested_at AS "requestedAt",
          turns.started_at AS "startedAt",
          turns.completed_at AS "completedAt",
          turns.assistant_message_id AS "assistantMessageId",
          turns.source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          turns.source_proposed_plan_id AS "sourceProposedPlanId"
        FROM projection_threads threads
        JOIN projection_turns turns
          ON turns.thread_id = threads.thread_id
          AND turns.turn_id = threads.latest_turn_id
        WHERE threads.thread_id = ${threadId}
          AND threads.deleted_at IS NULL
          AND threads.archived_at IS NULL
        LIMIT 1
      `,
  });

  const listCheckpointRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionCheckpointDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "status",
          checkpoint_files_json AS "files",
          assistant_message_id AS "assistantMessageId",
          completed_at AS "completedAt"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND checkpoint_turn_count IS NOT NULL
        ORDER BY checkpoint_turn_count ASC
      `,
  });

  const listCheckpointRowsByTurnWindow = SqlSchema.findAll({
    Request: ThreadTurnRangeLookupInput,
    Result: ProjectionCheckpointDbRowSchema,
    execute: ({ threadId, minAnchorAt, minTurnKey, beforeAnchorAt, beforeTurnKey }) =>
      sql`
        WITH candidates AS (
          SELECT
            thread_id,
            turn_id,
            checkpoint_turn_count,
            checkpoint_ref,
            checkpoint_status,
            checkpoint_files_json,
            assistant_message_id,
            completed_at,
            CASE WHEN checkpoint_turn_count = (
              SELECT MAX(latest.checkpoint_turn_count)
              FROM projection_turns AS latest
              WHERE latest.thread_id = ${threadId}
                AND latest.checkpoint_turn_count IS NOT NULL
            ) THEN 1 ELSE 0 END AS pinned
          FROM projection_turns
          WHERE thread_id = ${threadId}
            AND checkpoint_turn_count IS NOT NULL
            AND (
              checkpoint_turn_count = (
                SELECT MAX(latest.checkpoint_turn_count)
                FROM projection_turns AS latest
                WHERE latest.thread_id = ${threadId}
                  AND latest.checkpoint_turn_count IS NOT NULL
              )
              OR (
                (
                  requested_at > ${minAnchorAt}
                  OR (
                    requested_at = ${minAnchorAt}
                    AND COALESCE(turn_id, '') >= ${minTurnKey}
                  )
                )
                AND (
                  requested_at < ${beforeAnchorAt}
                  OR (
                    requested_at = ${beforeAnchorAt}
                    AND COALESCE(turn_id, '') < ${beforeTurnKey}
                  )
                )
              )
            )
          ORDER BY pinned DESC, checkpoint_turn_count DESC
          LIMIT ${THREAD_DETAIL_CHECKPOINT_LIMIT}
        )
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "status",
          checkpoint_files_json AS "files",
          assistant_message_id AS "assistantMessageId",
          completed_at AS "completedAt"
        FROM candidates
        ORDER BY checkpoint_turn_count ASC
      `,
  });

  const listLatestCheckpointRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionCheckpointDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "status",
          checkpoint_files_json AS "files",
          assistant_message_id AS "assistantMessageId",
          completed_at AS "completedAt"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND checkpoint_turn_count IS NOT NULL
        ORDER BY checkpoint_turn_count DESC
        LIMIT 1
      `,
  });

  const getLatestCheckpointHeadRowByThread = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionCheckpointHeadDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "status"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND checkpoint_turn_count IS NOT NULL
        ORDER BY checkpoint_turn_count DESC
        LIMIT 1
      `,
  });

  const getCheckpointHeadRowByTurn = SqlSchema.findOneOption({
    Request: ThreadAndTurnLookupInput,
    Result: ProjectionCheckpointHeadDbRowSchema,
    execute: ({ threadId, turnId }) =>
      sql`
        SELECT
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "status"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND turn_id = ${turnId}
          AND checkpoint_turn_count IS NOT NULL
        LIMIT 1
      `,
  });

  const getTurnAssistantMessageRow = SqlSchema.findOneOption({
    Request: ThreadAndTurnLookupInput,
    Result: ProjectionTurnAssistantMessageRowSchema,
    execute: ({ threadId, turnId }) =>
      sql`
        SELECT assistant_message_id AS "assistantMessageId"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND turn_id = ${turnId}
        LIMIT 1
      `,
  });

  const listCheckpointRefRowsAfter = SqlSchema.findAll({
    Request: ThreadCheckpointRefsAfterLookupInput,
    Result: ProjectionCheckpointRefRowSchema,
    execute: ({
      threadId,
      afterCheckpointTurnCount,
      cursorCheckpointTurnCount,
      cursorTurnId,
      limit,
    }) =>
      sql`
        SELECT
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND checkpoint_turn_count > ${afterCheckpointTurnCount}
          AND (
            checkpoint_turn_count > ${cursorCheckpointTurnCount}
            OR (
              checkpoint_turn_count = ${cursorCheckpointTurnCount}
              AND turn_id > ${cursorTurnId}
            )
          )
        ORDER BY checkpoint_turn_count ASC, turn_id ASC
        LIMIT ${limit}
      `,
  });

  // Resolves a page of recent turns for a windowed thread detail read. Walks
  // back from the exclusive (beforeAnchorAt, beforeTurnKey) keyset boundary
  // (sentinels "~"/"" mean unbounded, i.e. the first page) until it has seen
  // `userTurnLimit` user-anchored turns — turns whose pending message is a
  // user message; subagent/fan-out turns between them ride along — or hits the
  // `maxRawTurns` ceiling that bounds pathological fan-out. The `candidates`
  // CTE applies the keyset bound and LIMIT before the window functions run;
  // its ORDER BY uses raw columns so the migration-037
  // (thread_id, requested_at, turn_id) index serves both range and order with
  // no temp B-tree — the scan is genuinely bounded by the LIMIT. (Raw
  // turn_id DESC places NULLs exactly where COALESCE-to-'' would, below every
  // real id.) The caller derives the continuation cursor from the oldest
  // returned row.
  // Highest thread-DETAIL event sequence for this thread that the projection
  // has applied (bounded by the global snapshot sequence read in the same
  // transaction). This is the thread-scoped watermark a windowed page carries
  // so clients can defer merging until their live subscription has caught up;
  // the global sequence is not waitable per-thread. The event_type filter
  // must match ws.ts's isThreadDetailEvent exactly: the subscription only
  // delivers these types, so a watermark counting any other event could
  // never be reached by the client and would park the page forever. Served
  // by the event store's (aggregate_kind, stream_id, sequence) index.
  const getThreadEventWatermarkRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ threadId: ThreadId, maxSequence: Schema.Number }),
    Result: Schema.Struct({ threadSequence: Schema.NullOr(Schema.Number) }),
    execute: ({ threadId, maxSequence }) =>
      sql`
        SELECT MAX(sequence) AS "threadSequence"
        FROM orchestration_events
        WHERE aggregate_kind = 'thread'
          AND stream_id = ${threadId}
          AND sequence <= ${maxSequence}
          AND event_type IN (
            'thread.message-sent',
            'thread.proposed-plan-upserted',
            'thread.activity-appended',
            'thread.turn-diff-completed',
            'thread.reverted',
            'thread.session-set'
          )
      `,
  });

  const listTurnWindowRows = SqlSchema.findAll({
    Request: ThreadTurnWindowLookupInput,
    Result: ProjectionTurnWindowRowSchema,
    execute: ({ threadId, beforeAnchorAt, beforeTurnKey, userTurnLimit, maxRawTurns }) =>
      sql`
        WITH candidates AS (
          SELECT
            turns.requested_at AS anchor_at,
            COALESCE(turns.turn_id, '') AS turn_key,
            turns.pending_message_id
          FROM projection_turns AS turns
          WHERE turns.thread_id = ${threadId}
            AND (
              turns.requested_at < ${beforeAnchorAt}
              OR (
                turns.requested_at = ${beforeAnchorAt}
                AND COALESCE(turns.turn_id, '') < ${beforeTurnKey}
              )
            )
          ORDER BY turns.requested_at DESC, turns.turn_id DESC
          LIMIT ${maxRawTurns}
        ),
        walked AS (
          SELECT
            candidates.anchor_at,
            candidates.turn_key,
            CASE WHEN messages.role = 'user' THEN 1 ELSE 0 END AS is_user_turn,
            SUM(CASE WHEN messages.role = 'user' THEN 1 ELSE 0 END) OVER (
              ORDER BY candidates.anchor_at DESC, candidates.turn_key DESC
            ) AS user_turns_seen
          FROM candidates
          LEFT JOIN projection_thread_messages AS messages
            ON messages.message_id = candidates.pending_message_id
        )
        SELECT
          anchor_at AS "anchorAt",
          turn_key AS "turnKey"
        FROM walked
        WHERE user_turns_seen < ${userTurnLimit}
          OR (user_turns_seen = ${userTurnLimit} AND is_user_turn = 1)
        ORDER BY anchor_at ASC, turn_key ASC
      `,
  });

  // Legacy and imported projections can contain messages or activities before
  // their turn rows exist. Page those rows by a shared timeline key instead of
  // falling back to the unbounded full-thread queries.
  const listTurnlessWindowRows = SqlSchema.findAll({
    Request: ThreadTurnlessWindowLookupInput,
    Result: ProjectionTurnlessWindowRowSchema,
    execute: ({ threadId, beforeAnchorAt, beforeItemKey, includePinnedPlans, limit }) =>
      sql`
        WITH message_candidates AS (
          SELECT created_at AS anchor_at, 'm:' || message_id AS item_key
          FROM projection_thread_messages
          WHERE thread_id = ${threadId}
            AND (
              turn_id IS NULL
              OR NOT EXISTS (
                SELECT 1 FROM projection_turns AS linked_turn
                WHERE linked_turn.thread_id = ${threadId}
                  AND linked_turn.turn_id = projection_thread_messages.turn_id
              )
            )
            AND (
              created_at < ${beforeAnchorAt}
              OR (created_at = ${beforeAnchorAt} AND 'm:' || message_id < ${beforeItemKey})
            )
          ORDER BY created_at DESC, message_id DESC
          LIMIT ${limit}
        ), activity_candidates AS (
          SELECT created_at AS anchor_at, 'a:' || activity_id AS item_key
          FROM projection_thread_activities
          WHERE thread_id = ${threadId}
            AND (
              turn_id IS NULL
              OR NOT EXISTS (
                SELECT 1 FROM projection_turns AS linked_turn
                WHERE linked_turn.thread_id = ${threadId}
                  AND linked_turn.turn_id = projection_thread_activities.turn_id
              )
            )
            AND (
              created_at < ${beforeAnchorAt}
              OR (created_at = ${beforeAnchorAt} AND 'a:' || activity_id < ${beforeItemKey})
            )
          ORDER BY created_at DESC, activity_id DESC
          LIMIT ${limit}
        ), plan_candidates AS (
          SELECT created_at AS anchor_at, 'p:' || plan_id AS item_key
          FROM projection_thread_proposed_plans
          WHERE thread_id = ${threadId}
            AND (
              turn_id IS NULL
              OR NOT EXISTS (
                SELECT 1 FROM projection_turns AS linked_turn
                WHERE linked_turn.thread_id = ${threadId}
                  AND linked_turn.turn_id = projection_thread_proposed_plans.turn_id
              )
            )
            AND (${includePinnedPlans} = 1 OR implemented_at IS NOT NULL)
            AND (
              created_at < ${beforeAnchorAt}
              OR (created_at = ${beforeAnchorAt} AND 'p:' || plan_id < ${beforeItemKey})
            )
          ORDER BY created_at DESC, plan_id DESC
          LIMIT ${limit}
        ), selected AS (
          SELECT anchor_at, item_key
          FROM (
            SELECT anchor_at, item_key FROM message_candidates
            UNION ALL
            SELECT anchor_at, item_key FROM activity_candidates
            UNION ALL
            SELECT anchor_at, item_key FROM plan_candidates
          )
          ORDER BY anchor_at DESC, item_key DESC
          LIMIT ${limit}
        )
        SELECT anchor_at AS "anchorAt", item_key AS "itemKey"
        FROM selected
        ORDER BY anchor_at ASC, item_key ASC
      `,
  });

  const listThreadMessageRowsByTurnlessWindow = SqlSchema.findAll({
    Request: ThreadTurnlessRangeLookupInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId, minAnchorAt, minItemKey, beforeAnchorAt, beforeItemKey }) =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
          AND (
            turn_id IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM projection_turns AS linked_turn
              WHERE linked_turn.thread_id = ${threadId}
                AND linked_turn.turn_id = projection_thread_messages.turn_id
            )
          )
          AND (
            created_at > ${minAnchorAt}
            OR (created_at = ${minAnchorAt} AND 'm:' || message_id >= ${minItemKey})
          )
          AND (
            created_at < ${beforeAnchorAt}
            OR (created_at = ${beforeAnchorAt} AND 'm:' || message_id < ${beforeItemKey})
          )
        ORDER BY created_at ASC, message_id ASC
      `,
  });

  const listThreadActivityRowsByTurnlessWindow = SqlSchema.findAll({
    Request: ThreadTurnlessRangeLookupInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId, minAnchorAt, minItemKey, beforeAnchorAt, beforeItemKey }) =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
          AND (
            turn_id IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM projection_turns AS linked_turn
              WHERE linked_turn.thread_id = ${threadId}
                AND linked_turn.turn_id = projection_thread_activities.turn_id
            )
          )
          AND (
            created_at > ${minAnchorAt}
            OR (created_at = ${minAnchorAt} AND 'a:' || activity_id >= ${minItemKey})
          )
          AND (
            created_at < ${beforeAnchorAt}
            OR (created_at = ${beforeAnchorAt} AND 'a:' || activity_id < ${beforeItemKey})
          )
        ORDER BY sequence ASC, created_at ASC, activity_id ASC
      `,
  });

  // Windowed variants of the heavy collections. Turn-linked rows are
  // bounded by the page's (anchor, turn key) keyset range over
  // projection_turns; rows with no turn linkage (user messages always, and
  // turnless activities like pre-turn context-window updates) are bounded by
  // the matching turn-anchor time range so they land on the same page as the
  // turns around them. Proposed plans use the same bounded keyset; checkpoints
  // keep their separate bounded summary path.
  const listThreadMessageRowsByThreadWindow = SqlSchema.findAll({
    Request: ThreadTurnMessagePageLookupInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({
      threadId,
      minAnchorAt,
      minTurnKey,
      beforeAnchorAt,
      beforeTurnKey,
      beforeCreatedAt,
      beforeId,
      limit,
    }) =>
      sql`
        WITH candidate_keys AS (
          SELECT messages.message_id, messages.created_at
          FROM projection_thread_messages AS messages
          WHERE messages.thread_id = ${threadId}
            AND (
              messages.turn_id IN (
                SELECT turn_id FROM projection_turns
                WHERE thread_id = ${threadId}
                  AND turn_id IS NOT NULL
                  AND (
                    requested_at > ${minAnchorAt}
                    OR (requested_at = ${minAnchorAt} AND turn_id >= ${minTurnKey})
                  )
                  AND (
                    requested_at < ${beforeAnchorAt}
                    OR (requested_at = ${beforeAnchorAt} AND turn_id < ${beforeTurnKey})
                  )
              )
              OR (
                (
                  messages.turn_id IS NULL
                  OR NOT EXISTS (
                    SELECT 1 FROM projection_turns AS linked_turn
                    WHERE linked_turn.thread_id = ${threadId}
                      AND linked_turn.turn_id = messages.turn_id
                  )
                )
                AND messages.created_at >= ${minAnchorAt}
                AND messages.created_at < ${beforeAnchorAt}
              )
            )
            AND (
              messages.created_at < ${beforeCreatedAt}
              OR (
                messages.created_at = ${beforeCreatedAt}
                AND messages.message_id < ${beforeId}
              )
            )
          ORDER BY messages.created_at DESC, messages.message_id DESC
          LIMIT ${limit}
        )
        SELECT
          messages.message_id AS "messageId",
          messages.thread_id AS "threadId",
          messages.turn_id AS "turnId",
          messages.role,
          messages.text,
          messages.attachments_json AS "attachments",
          messages.is_streaming AS "isStreaming",
          messages.created_at AS "createdAt",
          messages.updated_at AS "updatedAt"
        FROM candidate_keys AS keys
        INNER JOIN projection_thread_messages AS messages
          ON messages.thread_id = ${threadId}
          AND messages.message_id = keys.message_id
        ORDER BY keys.created_at DESC, keys.message_id DESC
      `,
  });

  // Blocking request payloads must remain available even if they predate the
  // recent activity window. Each CTE returns at most one unresolved row per
  // request, so the merge below stays bounded by actionable work.
  const listPinnedThreadActivityRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        WITH pending_approval_requests AS (
          SELECT request_id, thread_id
          FROM projection_pending_approvals
          WHERE thread_id = ${threadId}
            AND status = 'pending'
        ),
        pending_approval_activities AS (
          SELECT
            activity.activity_id,
            ROW_NUMBER() OVER (
              PARTITION BY pending.request_id
              ORDER BY activity.created_at DESC, activity.activity_id DESC
            ) AS request_order
          FROM pending_approval_requests AS pending
          CROSS JOIN projection_thread_activities AS activity
          WHERE activity.thread_id = pending.thread_id
            AND activity.kind = 'approval.requested'
            AND json_extract(activity.payload_json, '$.requestId') = pending.request_id
        ),
        pending_user_input_thread AS (
          SELECT thread_id
          FROM projection_threads
          WHERE thread_id = ${threadId}
            AND pending_user_input_count > 0
        ),
        user_input_lifecycle AS (
          SELECT
            activity.activity_id,
            activity.kind,
            ROW_NUMBER() OVER (
              PARTITION BY json_extract(activity.payload_json, '$.requestId')
              ORDER BY activity.created_at DESC, activity.activity_id DESC
            ) AS request_order
          FROM pending_user_input_thread AS pending
          CROSS JOIN projection_thread_activities AS activity
          WHERE activity.thread_id = pending.thread_id
            AND (
              activity.kind IN ('user-input.requested', 'user-input.resolved')
              OR (
                activity.kind = 'provider.user-input.respond.failed'
                AND (
                  lower(COALESCE(json_extract(activity.payload_json, '$.detail'), ''))
                    LIKE '%stale pending user-input request%'
                  OR lower(COALESCE(json_extract(activity.payload_json, '$.detail'), ''))
                    LIKE '%unknown pending user-input request%'
                  OR lower(COALESCE(json_extract(activity.payload_json, '$.detail'), ''))
                    LIKE '%unknown pending user input request%'
                  OR lower(COALESCE(json_extract(activity.payload_json, '$.detail'), ''))
                    LIKE '%unknown pending codex user input request%'
                )
              )
            )
            AND json_extract(activity.payload_json, '$.requestId') IS NOT NULL
        ),
        pinned_activity_ids AS (
          SELECT activity_id
          FROM pending_approval_activities
          WHERE request_order = 1
          UNION ALL
          SELECT activity_id
          FROM user_input_lifecycle
          WHERE request_order = 1
            AND kind = 'user-input.requested'
        )
        SELECT
          activity.activity_id AS "activityId",
          activity.thread_id AS "threadId",
          activity.turn_id AS "turnId",
          activity.tone,
          activity.kind,
          activity.summary,
          activity.payload_json AS "payload",
          activity.sequence,
          activity.created_at AS "createdAt"
        FROM pinned_activity_ids AS pinned
        INNER JOIN projection_thread_activities AS activity
          ON activity.activity_id = pinned.activity_id
        ORDER BY activity.created_at ASC, activity.activity_id ASC
      `,
  });

  const listThreadActivityRowsByThreadWindow = SqlSchema.findAll({
    Request: ThreadTurnActivityPageLookupInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({
      threadId,
      minAnchorAt,
      minTurnKey,
      beforeAnchorAt,
      beforeTurnKey,
      beforeSequence,
      beforeCreatedAt,
      beforeId,
      limit,
    }) =>
      sql`
        WITH candidate_keys AS (
          SELECT
            activity_id,
            COALESCE(sequence, -1) AS normalized_sequence,
            created_at
          FROM projection_thread_activities
          WHERE thread_id = ${threadId}
            AND (
              turn_id IN (
                SELECT turn_id FROM projection_turns
                WHERE thread_id = ${threadId}
                  AND turn_id IS NOT NULL
                  AND (
                    requested_at > ${minAnchorAt}
                    OR (requested_at = ${minAnchorAt} AND turn_id >= ${minTurnKey})
                  )
                  AND (
                    requested_at < ${beforeAnchorAt}
                    OR (requested_at = ${beforeAnchorAt} AND turn_id < ${beforeTurnKey})
                  )
              )
              OR (
                (
                  turn_id IS NULL
                  OR NOT EXISTS (
                    SELECT 1 FROM projection_turns AS linked_turn
                    WHERE linked_turn.thread_id = ${threadId}
                      AND linked_turn.turn_id = projection_thread_activities.turn_id
                  )
                )
                AND created_at >= ${minAnchorAt}
                AND created_at < ${beforeAnchorAt}
              )
            )
            AND (
              COALESCE(sequence, -1) < ${beforeSequence}
              OR (
                COALESCE(sequence, -1) = ${beforeSequence}
                AND created_at < ${beforeCreatedAt}
              )
              OR (
                COALESCE(sequence, -1) = ${beforeSequence}
                AND created_at = ${beforeCreatedAt}
                AND activity_id < ${beforeId}
              )
            )
          ORDER BY COALESCE(sequence, -1) DESC, created_at DESC, activity_id DESC
          LIMIT ${limit}
        )
        SELECT
          activities.activity_id AS "activityId",
          activities.thread_id AS "threadId",
          activities.turn_id AS "turnId",
          activities.tone,
          activities.kind,
          activities.summary,
          activities.payload_json AS "payload",
          activities.sequence,
          activities.created_at AS "createdAt"
        FROM candidate_keys AS keys
        INNER JOIN projection_thread_activities AS activities
          ON activities.thread_id = ${threadId}
          AND activities.activity_id = keys.activity_id
        ORDER BY keys.normalized_sequence DESC, keys.created_at DESC, keys.activity_id DESC
      `,
  });

  const getFullThreadDiffContextRow = SqlSchema.findOneOption({
    Request: FullThreadDiffContextLookupInput,
    Result: ProjectionFullThreadDiffContextRowSchema,
    execute: ({ threadId, checkpointTurnCount }) =>
      sql`
        SELECT
          threads.thread_id AS "threadId",
          threads.project_id AS "projectId",
          projects.workspace_root AS "workspaceRoot",
          threads.worktree_path AS "worktreePath",
          (
            SELECT MAX(turns.checkpoint_turn_count)
            FROM projection_turns AS turns
            WHERE turns.thread_id = threads.thread_id
              AND turns.checkpoint_turn_count IS NOT NULL
          ) AS "latestCheckpointTurnCount",
          (
            SELECT turns.checkpoint_ref
            FROM projection_turns AS turns
            WHERE turns.thread_id = threads.thread_id
              AND turns.checkpoint_turn_count = ${checkpointTurnCount}
            LIMIT 1
          ) AS "toCheckpointRef"
        FROM projection_threads AS threads
        INNER JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE threads.thread_id = ${threadId}
          AND threads.deleted_at IS NULL
        LIMIT 1
      `,
  });

  const getSnapshot: ProjectionSnapshotQueryShape["getSnapshot"] = () =>
    sql
      .withTransaction(
        Effect.all([
          listProjectRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listProjects:query",
                "ProjectionSnapshotQuery.getSnapshot:listProjects:decodeRows",
              ),
            ),
          ),
          listThreadRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreads:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreads:decodeRows",
              ),
            ),
          ),
          listCoagentRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listCoagents:query",
                "ProjectionSnapshotQuery.getSnapshot:listCoagents:decodeRows",
              ),
            ),
          ),
          listThreadMessageRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreadMessages:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreadMessages:decodeRows",
              ),
            ),
          ),
          listThreadProposedPlanRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreadProposedPlans:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreadProposedPlans:decodeRows",
              ),
            ),
          ),
          listThreadActivityRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreadActivities:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreadActivities:decodeRows",
              ),
            ),
          ),
          listThreadSessionRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreadSessions:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreadSessions:decodeRows",
              ),
            ),
          ),
          listCheckpointRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listCheckpoints:query",
                "ProjectionSnapshotQuery.getSnapshot:listCheckpoints:decodeRows",
              ),
            ),
          ),
          listLatestTurnRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listLatestTurns:query",
                "ProjectionSnapshotQuery.getSnapshot:listLatestTurns:decodeRows",
              ),
            ),
          ),
          listProjectionStateRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listProjectionState:query",
                "ProjectionSnapshotQuery.getSnapshot:listProjectionState:decodeRows",
              ),
            ),
          ),
        ]),
      )
      .pipe(
        Effect.flatMap(
          ([
            projectRows,
            threadRows,
            coagentRows,
            messageRows,
            proposedPlanRows,
            activityRows,
            sessionRows,
            checkpointRows,
            latestTurnRows,
            stateRows,
          ]) =>
            Effect.gen(function* () {
              const messagesByThread = new Map<string, Array<OrchestrationMessage>>();
              const proposedPlansByThread = new Map<string, Array<OrchestrationProposedPlan>>();
              const activitiesByThread = new Map<string, Array<OrchestrationThreadActivity>>();
              const checkpointsByThread = new Map<string, Array<OrchestrationCheckpointSummary>>();
              const sessionsByThread = new Map<string, OrchestrationSession>();
              const latestTurnByThread = new Map<string, OrchestrationLatestTurn>();
              const coagentByThread = new Map(
                coagentRows.map((row) => [row.childThreadId, row] as const),
              );

              let updatedAt: string | null = null;

              for (const row of projectRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of threadRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of stateRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }

              for (const row of messageRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
                const threadMessages = messagesByThread.get(row.threadId) ?? [];
                threadMessages.push({
                  id: row.messageId,
                  role: row.role,
                  text: row.text,
                  ...(row.attachments !== null ? { attachments: row.attachments } : {}),
                  turnId: row.turnId,
                  streaming: row.isStreaming === 1,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                });
                messagesByThread.set(row.threadId, threadMessages);
              }

              for (const row of proposedPlanRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
                const threadProposedPlans = proposedPlansByThread.get(row.threadId) ?? [];
                threadProposedPlans.push({
                  id: row.planId,
                  turnId: row.turnId,
                  planMarkdown: row.planMarkdown,
                  implementedAt: row.implementedAt,
                  implementationThreadId: row.implementationThreadId,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                });
                proposedPlansByThread.set(row.threadId, threadProposedPlans);
              }

              for (const row of activityRows) {
                updatedAt = maxIso(updatedAt, row.createdAt);
                const threadActivities = activitiesByThread.get(row.threadId) ?? [];
                threadActivities.push({
                  id: row.activityId,
                  tone: row.tone,
                  kind: row.kind,
                  summary: row.summary,
                  payload: row.payload,
                  turnId: row.turnId,
                  ...(row.sequence !== null ? { sequence: row.sequence } : {}),
                  createdAt: row.createdAt,
                });
                activitiesByThread.set(row.threadId, threadActivities);
              }

              for (const row of checkpointRows) {
                updatedAt = maxIso(updatedAt, row.completedAt);
                const threadCheckpoints = checkpointsByThread.get(row.threadId) ?? [];
                threadCheckpoints.push({
                  turnId: row.turnId,
                  checkpointTurnCount: row.checkpointTurnCount,
                  checkpointRef: row.checkpointRef,
                  status: row.status,
                  files: row.files,
                  assistantMessageId: row.assistantMessageId,
                  completedAt: row.completedAt,
                });
                checkpointsByThread.set(row.threadId, threadCheckpoints);
              }

              for (const row of latestTurnRows) {
                updatedAt = maxIso(updatedAt, row.requestedAt);
                if (row.startedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.startedAt);
                }
                if (row.completedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.completedAt);
                }
                if (latestTurnByThread.has(row.threadId)) {
                  continue;
                }
                latestTurnByThread.set(row.threadId, {
                  turnId: row.turnId,
                  state:
                    row.state === "error"
                      ? "error"
                      : row.state === "interrupted"
                        ? "interrupted"
                        : row.state === "completed"
                          ? "completed"
                          : "running",
                  requestedAt: row.requestedAt,
                  startedAt: row.startedAt,
                  completedAt: row.completedAt,
                  assistantMessageId: row.assistantMessageId,
                  ...(row.sourceProposedPlanThreadId !== null && row.sourceProposedPlanId !== null
                    ? {
                        sourceProposedPlan: {
                          threadId: row.sourceProposedPlanThreadId,
                          planId: row.sourceProposedPlanId,
                        },
                      }
                    : {}),
                });
              }

              for (const row of sessionRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
                sessionsByThread.set(row.threadId, {
                  threadId: row.threadId,
                  status: row.status,
                  providerName: row.providerName,
                  ...(row.providerInstanceId !== null
                    ? { providerInstanceId: row.providerInstanceId }
                    : {}),
                  runtimeMode: row.runtimeMode,
                  activeTurnId: row.activeTurnId,
                  lastError: row.lastError,
                  updatedAt: row.updatedAt,
                });
              }

              const repositoryIdentities = yield* resolveRepositoryIdentitiesForProjects(
                projectRows,
                { includeDeleted: true },
              );

              const projects: ReadonlyArray<OrchestrationProject> = projectRows.map((row) => ({
                id: row.projectId,
                title: row.title,
                workspaceRoot: row.workspaceRoot,
                repositoryIdentity: repositoryIdentities.get(row.projectId) ?? null,
                defaultModelSelection: row.defaultModelSelection,
                defaultThreadEnvMode: row.defaultThreadEnvMode,
                faviconPath: row.faviconPath ?? null,
                scripts: row.scripts,
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
                deletedAt: row.deletedAt,
              }));

              const threads: ReadonlyArray<OrchestrationThread> = threadRows.map((row) => ({
                id: row.threadId,
                projectId: row.projectId,
                title: row.title,
                coagent: coagentByThread.has(row.threadId)
                  ? {
                      parentThreadId: coagentByThread.get(row.threadId)!.parentThreadId,
                      creationMode: coagentByThread.get(row.threadId)!.creationMode,
                      status: coagentByThread.get(row.threadId)!.status,
                    }
                  : null,
                modelSelection: row.modelSelection,
                runtimeMode: row.runtimeMode,
                interactionMode: row.interactionMode,
                branch: row.branch,
                worktreePath: row.worktreePath,
                ...(row.linkedPullRequest === null
                  ? {}
                  : { linkedPullRequest: row.linkedPullRequest }),
                latestTurn: latestTurnByThread.get(row.threadId) ?? null,
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
                archivedAt: row.archivedAt,
                settledOverride: row.settledOverride,
                settledAt: row.settledAt,
                unsettledAt: row.unsettledAt,
                snoozedUntil: row.snoozedUntil,
                snoozedAt: row.snoozedAt,
                pinnedAt: row.pinnedAt,
                pinOrderKey: row.pinOrderKey ?? null,
                titleRegeneration: mapTitleRegeneration(row),
                deletedAt: row.deletedAt,
                messages: messagesByThread.get(row.threadId) ?? [],
                proposedPlans: proposedPlansByThread.get(row.threadId) ?? [],
                activities: activitiesByThread.get(row.threadId) ?? [],
                checkpoints: checkpointsByThread.get(row.threadId) ?? [],
                session: sessionsByThread.get(row.threadId) ?? null,
              }));

              const snapshot = {
                snapshotSequence: computeSnapshotSequence(stateRows),
                projects,
                threads,
                updatedAt: updatedAt ?? "1970-01-01T00:00:00.000Z",
              };

              return yield* decodeReadModel(snapshot).pipe(
                Effect.mapError(
                  toPersistenceDecodeError("ProjectionSnapshotQuery.getSnapshot:decodeReadModel"),
                ),
              );
            }),
        ),
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getSnapshot:query")(error);
        }),
      );

  const getCommandReadModel: ProjectionSnapshotQueryShape["getCommandReadModel"] = () =>
    sql
      .withTransaction(
        Effect.all([
          listProjectRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listProjects:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listProjects:decodeRows",
              ),
            ),
          ),
          listThreadRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listThreads:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listThreads:decodeRows",
              ),
            ),
          ),
          listActionableThreadProposedPlanRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listThreadProposedPlans:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listThreadProposedPlans:decodeRows",
              ),
            ),
          ),
          listThreadSessionRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listThreadSessions:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listThreadSessions:decodeRows",
              ),
            ),
          ),
          listLatestTurnRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listLatestTurns:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listLatestTurns:decodeRows",
              ),
            ),
          ),
          listCommandStreamingMessageRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listStreamingMessages:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listStreamingMessages:decodeRows",
              ),
            ),
          ),
          listCommandBlockingActivityRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listBlockingActivities:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listBlockingActivities:decodeRows",
              ),
            ),
          ),
          listProjectionStateRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listProjectionState:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listProjectionState:decodeRows",
              ),
            ),
          ),
        ]),
      )
      .pipe(
        Effect.flatMap(
          ([
            projectRows,
            threadRows,
            proposedPlanRows,
            sessionRows,
            latestTurnRows,
            streamingMessageRows,
            blockingActivityRows,
            stateRows,
          ]) =>
            Effect.sync(() => {
              let updatedAt: string | null = null;
              const projects: OrchestrationProject[] = [];
              const threads: OrchestrationThread[] = [];

              for (let index = 0; index < projectRows.length; index += 1) {
                const row = projectRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.updatedAt);
                projects.push({
                  id: row.projectId,
                  title: row.title,
                  workspaceRoot: row.workspaceRoot,
                  defaultModelSelection: row.defaultModelSelection,
                  defaultThreadEnvMode: row.defaultThreadEnvMode,
                  faviconPath: row.faviconPath ?? null,
                  scripts: row.scripts,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                  deletedAt: row.deletedAt,
                });
              }
              for (let index = 0; index < threadRows.length; index += 1) {
                const row = threadRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (let index = 0; index < proposedPlanRows.length; index += 1) {
                const row = proposedPlanRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (let index = 0; index < sessionRows.length; index += 1) {
                const row = sessionRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (let index = 0; index < latestTurnRows.length; index += 1) {
                const row = latestTurnRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.requestedAt);
                if (row.startedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.startedAt);
                }
                if (row.completedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.completedAt);
                }
              }
              for (let index = 0; index < streamingMessageRows.length; index += 1) {
                const row = streamingMessageRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (let index = 0; index < blockingActivityRows.length; index += 1) {
                const row = blockingActivityRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.createdAt);
              }
              for (let index = 0; index < stateRows.length; index += 1) {
                const row = stateRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }

              const latestTurnByThread = new Map<string, OrchestrationLatestTurn>();
              for (let index = 0; index < latestTurnRows.length; index += 1) {
                const row = latestTurnRows[index];
                if (!row) {
                  continue;
                }
                latestTurnByThread.set(row.threadId, mapLatestTurn(row));
              }
              const proposedPlansByThread = new Map<string, Array<OrchestrationProposedPlan>>();
              const sessionByThread = new Map<string, OrchestrationSession>();
              const streamingMessagesByThread = new Map<string, Array<OrchestrationMessage>>();
              const blockingActivitiesByThread = new Map<
                string,
                Array<OrchestrationThreadActivity>
              >();

              for (let index = 0; index < sessionRows.length; index += 1) {
                const row = sessionRows[index];
                if (!row) {
                  continue;
                }
                sessionByThread.set(row.threadId, mapSessionRow(row));
              }

              for (let index = 0; index < proposedPlanRows.length; index += 1) {
                const row = proposedPlanRows[index];
                if (!row) {
                  continue;
                }
                const threadProposedPlans = proposedPlansByThread.get(row.threadId) ?? [];
                threadProposedPlans.push(mapProposedPlanRow(row));
                proposedPlansByThread.set(row.threadId, threadProposedPlans);
              }

              for (let index = 0; index < streamingMessageRows.length; index += 1) {
                const row = streamingMessageRows[index];
                if (!row) {
                  continue;
                }
                const threadMessages = streamingMessagesByThread.get(row.threadId) ?? [];
                threadMessages.push({
                  id: row.messageId,
                  role: row.role,
                  text: "",
                  turnId: row.turnId,
                  streaming: true,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                });
                streamingMessagesByThread.set(row.threadId, threadMessages);
              }

              for (let index = 0; index < blockingActivityRows.length; index += 1) {
                const row = blockingActivityRows[index];
                if (!row) {
                  continue;
                }
                const threadActivities = blockingActivitiesByThread.get(row.threadId) ?? [];
                threadActivities.push({
                  id: row.activityId,
                  tone: row.tone,
                  kind: row.kind,
                  summary: row.summary,
                  payload: row.payload,
                  turnId: row.turnId,
                  ...(row.sequence !== null ? { sequence: row.sequence } : {}),
                  createdAt: row.createdAt,
                });
                blockingActivitiesByThread.set(row.threadId, threadActivities);
              }

              for (let index = 0; index < threadRows.length; index += 1) {
                const row = threadRows[index];
                if (!row) {
                  continue;
                }
                // These compact witnesses carry only the safety facts used by
                // the decider after restart. The detail/export paths retain the
                // real records and bodies.
                const commandMessages: Array<OrchestrationMessage> = [];
                if (row.latestUserMessageAt !== null) {
                  commandMessages.push({
                    id: MessageId.make(`command-latest-user:${row.threadId}`),
                    role: "user",
                    text: "",
                    turnId: null,
                    streaming: false,
                    createdAt: row.latestUserMessageAt,
                    updatedAt: row.latestUserMessageAt,
                  });
                }
                commandMessages.push(...(streamingMessagesByThread.get(row.threadId) ?? []));
                threads.push({
                  id: row.threadId,
                  projectId: row.projectId,
                  title: row.title,
                  modelSelection: row.modelSelection,
                  runtimeMode: row.runtimeMode,
                  interactionMode: row.interactionMode,
                  branch: row.branch,
                  worktreePath: row.worktreePath,
                  ...(row.linkedPullRequest === null
                    ? {}
                    : { linkedPullRequest: row.linkedPullRequest }),
                  latestTurn: latestTurnByThread.get(row.threadId) ?? null,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                  archivedAt: row.archivedAt,
                  settledOverride: row.settledOverride,
                  settledAt: row.settledAt,
                  unsettledAt: row.unsettledAt,
                  snoozedUntil: row.snoozedUntil,
                  snoozedAt: row.snoozedAt,
                  pinnedAt: row.pinnedAt,
                  pinOrderKey: row.pinOrderKey ?? null,
                  titleRegeneration: mapTitleRegeneration(row),
                  deletedAt: row.deletedAt,
                  messages: commandMessages,
                  proposedPlans: proposedPlansByThread.get(row.threadId) ?? [],
                  activities: blockingActivitiesByThread.get(row.threadId) ?? [],
                  checkpoints: [],
                  session: sessionByThread.get(row.threadId) ?? null,
                });
              }

              return {
                snapshotSequence: computeSnapshotSequence(stateRows),
                projects,
                threads,
                updatedAt: updatedAt ?? "1970-01-01T00:00:00.000Z",
              } satisfies OrchestrationReadModel;
            }),
        ),
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getCommandReadModel:query")(error);
        }),
      );

  const getShellSnapshot: ProjectionSnapshotQueryShape["getShellSnapshot"] = () =>
    sql
      .withTransaction(
        Effect.all([
          listProjectRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listProjects:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listProjects:decodeRows",
              ),
            ),
          ),
          listActiveThreadRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listThreads:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listThreads:decodeRows",
              ),
            ),
          ),
          listActiveCoagentRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listCoagents:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listCoagents:decodeRows",
              ),
            ),
          ),
          listActiveThreadSessionRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listThreadSessions:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listThreadSessions:decodeRows",
              ),
            ),
          ),
          listActiveLatestTurnRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listLatestTurns:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listLatestTurns:decodeRows",
              ),
            ),
          ),
          listProjectionStateRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listProjectionState:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listProjectionState:decodeRows",
              ),
            ),
          ),
        ]),
      )
      .pipe(
        Effect.flatMap(
          ([projectRows, threadRows, coagentRows, sessionRows, latestTurnRows, stateRows]) =>
            Effect.gen(function* () {
              let updatedAt: string | null = null;
              for (const row of projectRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of threadRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of sessionRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of latestTurnRows) {
                updatedAt = maxIso(updatedAt, row.requestedAt);
                if (row.startedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.startedAt);
                }
                if (row.completedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.completedAt);
                }
              }
              for (const row of stateRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }

              const repositoryIdentities =
                yield* resolveRepositoryIdentitiesForProjects(projectRows);
              const latestTurnByThread = new Map(
                latestTurnRows.map((row) => [row.threadId, mapLatestTurn(row)] as const),
              );
              const sessionByThread = new Map(
                sessionRows.map((row) => [row.threadId, mapSessionRow(row)] as const),
              );
              const coagentByThread = new Map(
                coagentRows.map((row) => [row.childThreadId, row] as const),
              );

              const snapshot = {
                snapshotSequence: computeSnapshotSequence(stateRows),
                projects: Arr.filterMap(projectRows, (row) =>
                  row.deletedAt === null
                    ? Result.succeed(
                        mapProjectShellRow(row, repositoryIdentities.get(row.projectId) ?? null),
                      )
                    : Result.failVoid,
                ),
                threads: Arr.filterMap(threadRows, (row) =>
                  row.deletedAt === null
                    ? Result.succeed({
                        id: row.threadId,
                        projectId: row.projectId,
                        title: row.title,
                        coagent: coagentByThread.has(row.threadId)
                          ? {
                              parentThreadId: coagentByThread.get(row.threadId)!.parentThreadId,
                              creationMode: coagentByThread.get(row.threadId)!.creationMode,
                              status: coagentByThread.get(row.threadId)!.status,
                            }
                          : null,
                        modelSelection: row.modelSelection,
                        runtimeMode: row.runtimeMode,
                        interactionMode: row.interactionMode,
                        branch: row.branch,
                        worktreePath: row.worktreePath,
                        ...(row.linkedPullRequest === null
                          ? {}
                          : { linkedPullRequest: row.linkedPullRequest }),
                        latestTurn: latestTurnByThread.get(row.threadId) ?? null,
                        createdAt: row.createdAt,
                        updatedAt: row.updatedAt,
                        archivedAt: row.archivedAt,
                        settledOverride: row.settledOverride,
                        settledAt: row.settledAt,
                        unsettledAt: row.unsettledAt,
                        snoozedUntil: row.snoozedUntil,
                        snoozedAt: row.snoozedAt,
                        pinnedAt: row.pinnedAt,
                        pinOrderKey: row.pinOrderKey ?? null,
                        titleRegeneration: mapTitleRegeneration(row),
                        session: sessionByThread.get(row.threadId) ?? null,
                        latestUserMessageAt: row.latestUserMessageAt,
                        hasPendingApprovals: row.pendingApprovalCount > 0,
                        hasPendingUserInput: row.pendingUserInputCount > 0,
                        hasActionableProposedPlan: row.hasActionableProposedPlan > 0,
                        backgroundLiveness: threadBackgroundLiveness.getThreadBackgroundLiveness(
                          row.threadId,
                        ),
                        planProgress: threadPlanProgress.getThreadPlanProgress(row.threadId),
                      } satisfies OrchestrationThreadShell)
                    : Result.failVoid,
                ),
                updatedAt: updatedAt ?? "1970-01-01T00:00:00.000Z",
              };

              return yield* decodeShellSnapshot(snapshot).pipe(
                Effect.mapError(
                  toPersistenceDecodeError(
                    "ProjectionSnapshotQuery.getShellSnapshot:decodeShellSnapshot",
                  ),
                ),
              );
            }),
        ),
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getShellSnapshot:query")(error);
        }),
      );

  const getArchivedShellSnapshot: ProjectionSnapshotQueryShape["getArchivedShellSnapshot"] = () =>
    sql
      .withTransaction(
        Effect.all([
          listProjectRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listProjects:query",
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listProjects:decodeRows",
              ),
            ),
          ),
          listArchivedThreadRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listThreads:query",
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listThreads:decodeRows",
              ),
            ),
          ),
          listArchivedThreadSessionRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listThreadSessions:query",
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listThreadSessions:decodeRows",
              ),
            ),
          ),
          listArchivedLatestTurnRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listLatestTurns:query",
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listLatestTurns:decodeRows",
              ),
            ),
          ),
          listProjectionStateRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listProjectionState:query",
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listProjectionState:decodeRows",
              ),
            ),
          ),
        ]),
      )
      .pipe(
        Effect.flatMap(([projectRows, threadRows, sessionRows, latestTurnRows, stateRows]) =>
          Effect.gen(function* () {
            let updatedAt: string | null = null;
            for (const row of projectRows) {
              updatedAt = maxIso(updatedAt, row.updatedAt);
            }
            for (const row of threadRows) {
              updatedAt = maxIso(updatedAt, row.updatedAt);
            }
            for (const row of sessionRows) {
              updatedAt = maxIso(updatedAt, row.updatedAt);
            }
            for (const row of latestTurnRows) {
              updatedAt = maxIso(updatedAt, row.requestedAt);
              if (row.startedAt !== null) {
                updatedAt = maxIso(updatedAt, row.startedAt);
              }
              if (row.completedAt !== null) {
                updatedAt = maxIso(updatedAt, row.completedAt);
              }
            }
            for (const row of stateRows) {
              updatedAt = maxIso(updatedAt, row.updatedAt);
            }

            const activeProjectIds = new Set(threadRows.map((row) => row.projectId));
            const repositoryIdentities = yield* resolveRepositoryIdentitiesForProjects(
              projectRows.filter((row) => activeProjectIds.has(row.projectId)),
            );
            const latestTurnByThread = new Map(
              latestTurnRows.map((row) => [row.threadId, mapLatestTurn(row)] as const),
            );
            const sessionByThread = new Map(
              sessionRows.map((row) => [row.threadId, mapSessionRow(row)] as const),
            );

            const snapshot = {
              snapshotSequence: computeSnapshotSequence(stateRows),
              projects: Arr.filterMap(projectRows, (row) =>
                row.deletedAt === null && activeProjectIds.has(row.projectId)
                  ? Result.succeed(
                      mapProjectShellRow(row, repositoryIdentities.get(row.projectId) ?? null),
                    )
                  : Result.failVoid,
              ),
              threads: threadRows.map(
                (row): OrchestrationThreadShell => ({
                  id: row.threadId,
                  projectId: row.projectId,
                  title: row.title,
                  modelSelection: row.modelSelection,
                  runtimeMode: row.runtimeMode,
                  interactionMode: row.interactionMode,
                  branch: row.branch,
                  worktreePath: row.worktreePath,
                  ...(row.linkedPullRequest === null
                    ? {}
                    : { linkedPullRequest: row.linkedPullRequest }),
                  latestTurn: latestTurnByThread.get(row.threadId) ?? null,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                  archivedAt: row.archivedAt,
                  settledOverride: row.settledOverride,
                  settledAt: row.settledAt,
                  unsettledAt: row.unsettledAt,
                  snoozedUntil: row.snoozedUntil,
                  snoozedAt: row.snoozedAt,
                  pinnedAt: row.pinnedAt,
                  pinOrderKey: row.pinOrderKey ?? null,
                  titleRegeneration: mapTitleRegeneration(row),
                  session: sessionByThread.get(row.threadId) ?? null,
                  latestUserMessageAt: row.latestUserMessageAt,
                  hasPendingApprovals: row.pendingApprovalCount > 0,
                  hasPendingUserInput: row.pendingUserInputCount > 0,
                  hasActionableProposedPlan: row.hasActionableProposedPlan > 0,
                  backgroundLiveness: threadBackgroundLiveness.getThreadBackgroundLiveness(
                    row.threadId,
                  ),
                  planProgress: threadPlanProgress.getThreadPlanProgress(row.threadId),
                }),
              ),
              updatedAt: updatedAt ?? "1970-01-01T00:00:00.000Z",
            };

            return yield* decodeShellSnapshot(snapshot).pipe(
              Effect.mapError(
                toPersistenceDecodeError(
                  "ProjectionSnapshotQuery.getArchivedShellSnapshot:decodeShellSnapshot",
                ),
              ),
            );
          }),
        ),
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getArchivedShellSnapshot:query")(
            error,
          );
        }),
      );

  const getSnapshotSequence: ProjectionSnapshotQueryShape["getSnapshotSequence"] = () =>
    listProjectionStateRows(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getSnapshotSequence:query",
          "ProjectionSnapshotQuery.getSnapshotSequence:decodeRows",
        ),
      ),
      Effect.map((stateRows) => ({
        snapshotSequence: computeSnapshotSequence(stateRows),
      })),
    );

  const getCounts: ProjectionSnapshotQueryShape["getCounts"] = () =>
    readProjectionCounts(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getCounts:query",
          "ProjectionSnapshotQuery.getCounts:decodeRow",
        ),
      ),
      Effect.map(
        (row): ProjectionSnapshotCounts => ({
          projectCount: row.projectCount,
          threadCount: row.threadCount,
        }),
      ),
    );

  const searchThreads: ProjectionSnapshotQueryShape["searchThreads"] = Effect.fn(
    "ProjectionSnapshotQuery.searchThreads",
  )(function* (input) {
    const escapedQuery = escapeLikePattern(input.query);
    const rows = yield* searchActiveThreadRows({
      pattern: `%${escapedQuery}%`,
      limit: input.limit ?? 50,
    }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.searchThreads:query",
          "ProjectionSnapshotQuery.searchThreads:decodeRows",
        ),
      ),
    );
    return {
      matches: rows.map((row) => ({
        threadId: row.threadId,
        projectId: row.projectId,
        source: row.source,
        snippet: buildSearchSnippet(row.matchText, input.query),
        messageCreatedAt: row.messageCreatedAt,
      })),
    };
  });

  const getActiveProjectByWorkspaceRoot: ProjectionSnapshotQueryShape["getActiveProjectByWorkspaceRoot"] =
    (workspaceRoot) =>
      getActiveProjectRowByWorkspaceRoot({ workspaceRoot }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getActiveProjectByWorkspaceRoot:query",
            "ProjectionSnapshotQuery.getActiveProjectByWorkspaceRoot:decodeRow",
          ),
        ),
        Effect.flatMap((option) =>
          Option.isNone(option)
            ? Effect.succeed(Option.none<OrchestrationProject>())
            : repositoryIdentityResolver.resolve(option.value.workspaceRoot).pipe(
                Effect.map((repositoryIdentity) =>
                  Option.some({
                    id: option.value.projectId,
                    title: option.value.title,
                    workspaceRoot: option.value.workspaceRoot,
                    repositoryIdentity,
                    defaultModelSelection: option.value.defaultModelSelection,
                    defaultThreadEnvMode: option.value.defaultThreadEnvMode,
                    faviconPath: option.value.faviconPath ?? null,
                    scripts: option.value.scripts,
                    createdAt: option.value.createdAt,
                    updatedAt: option.value.updatedAt,
                    deletedAt: option.value.deletedAt,
                  } satisfies OrchestrationProject),
                ),
              ),
        ),
      );

  const getProjectShellById: ProjectionSnapshotQueryShape["getProjectShellById"] = (projectId) =>
    getActiveProjectRowById({ projectId }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getProjectShellById:query",
          "ProjectionSnapshotQuery.getProjectShellById:decodeRow",
        ),
      ),
      Effect.flatMap((option) =>
        Option.isNone(option)
          ? Effect.succeed(Option.none<OrchestrationProjectShell>())
          : repositoryIdentityResolver
              .resolve(option.value.workspaceRoot)
              .pipe(
                Effect.map((repositoryIdentity) =>
                  Option.some(mapProjectShellRow(option.value, repositoryIdentity)),
                ),
              ),
      ),
    );

  const getFirstActiveThreadIdByProjectId: ProjectionSnapshotQueryShape["getFirstActiveThreadIdByProjectId"] =
    (projectId) =>
      getFirstActiveThreadIdByProject({ projectId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getFirstActiveThreadIdByProjectId:query",
            "ProjectionSnapshotQuery.getFirstActiveThreadIdByProjectId:decodeRow",
          ),
        ),
        Effect.map(Option.map((row) => row.threadId)),
      );

  const getThreadCheckpointContext: ProjectionSnapshotQueryShape["getThreadCheckpointContext"] = (
    threadId,
  ) =>
    Effect.gen(function* () {
      const threadRow = yield* getThreadCheckpointContextThreadRow({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadCheckpointContext:getThread:query",
            "ProjectionSnapshotQuery.getThreadCheckpointContext:getThread:decodeRow",
          ),
        ),
      );
      if (Option.isNone(threadRow)) {
        return Option.none<ProjectionThreadCheckpointContext>();
      }

      const checkpointRows = yield* listCheckpointRowsByThread({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadCheckpointContext:listCheckpoints:query",
            "ProjectionSnapshotQuery.getThreadCheckpointContext:listCheckpoints:decodeRows",
          ),
        ),
      );

      return Option.some({
        threadId: threadRow.value.threadId,
        projectId: threadRow.value.projectId,
        workspaceRoot: threadRow.value.workspaceRoot,
        worktreePath: threadRow.value.worktreePath,
        checkpoints: checkpointRows.map(
          (row): OrchestrationCheckpointSummary => ({
            turnId: row.turnId,
            checkpointTurnCount: row.checkpointTurnCount,
            checkpointRef: row.checkpointRef,
            status: row.status,
            files: row.files,
            assistantMessageId: row.assistantMessageId,
            completedAt: row.completedAt,
          }),
        ),
      });
    });

  const getThreadCheckpointHeadContext: NonNullable<
    ProjectionSnapshotQueryShape["getThreadCheckpointHeadContext"]
  > = (threadId, turnId) =>
    Effect.gen(function* () {
      const [threadRow, latestRow, turnCheckpointRow, turnAssistantRow] = yield* Effect.all([
        getThreadCheckpointContextThreadRow({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadCheckpointHeadContext:getThread:query",
              "ProjectionSnapshotQuery.getThreadCheckpointHeadContext:getThread:decodeRow",
            ),
          ),
        ),
        getLatestCheckpointHeadRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadCheckpointHeadContext:getLatest:query",
              "ProjectionSnapshotQuery.getThreadCheckpointHeadContext:getLatest:decodeRow",
            ),
          ),
        ),
        turnId === undefined
          ? Effect.succeed(Option.none<typeof ProjectionCheckpointHeadDbRowSchema.Type>())
          : getCheckpointHeadRowByTurn({ threadId, turnId }).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getThreadCheckpointHeadContext:getTurn:query",
                  "ProjectionSnapshotQuery.getThreadCheckpointHeadContext:getTurn:decodeRow",
                ),
              ),
            ),
        turnId === undefined
          ? Effect.succeed(Option.none<typeof ProjectionTurnAssistantMessageRowSchema.Type>())
          : getTurnAssistantMessageRow({ threadId, turnId }).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getThreadCheckpointHeadContext:getAssistant:query",
                  "ProjectionSnapshotQuery.getThreadCheckpointHeadContext:getAssistant:decodeRow",
                ),
              ),
            ),
      ]);
      if (Option.isNone(threadRow)) {
        return Option.none<ProjectionThreadCheckpointHeadContext>();
      }

      return Option.some({
        threadId: threadRow.value.threadId,
        projectId: threadRow.value.projectId,
        workspaceRoot: threadRow.value.workspaceRoot,
        worktreePath: threadRow.value.worktreePath,
        latestCheckpoint: Option.getOrNull(latestRow),
        turnCheckpoint: Option.isNone(turnCheckpointRow) ? null : turnCheckpointRow.value,
        turnAssistantMessageId: Option.isNone(turnAssistantRow)
          ? null
          : turnAssistantRow.value.assistantMessageId,
      });
    });

  const listThreadCheckpointRefsAfter: NonNullable<
    ProjectionSnapshotQueryShape["listThreadCheckpointRefsAfter"]
  > = (input) => {
    const afterCheckpointTurnCount = Math.max(0, Math.trunc(input.afterCheckpointTurnCount));
    const limit = Math.max(1, Math.min(256, Math.trunc(input.limit)));
    const cursorCheckpointTurnCount = Math.max(
      afterCheckpointTurnCount,
      Math.trunc(input.cursor?.checkpointTurnCount ?? afterCheckpointTurnCount),
    );
    return listCheckpointRefRowsAfter({
      threadId: input.threadId,
      afterCheckpointTurnCount,
      cursorCheckpointTurnCount,
      cursorTurnId: input.cursor?.turnId ?? "",
      limit: limit + 1,
    }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.listThreadCheckpointRefsAfter:query",
          "ProjectionSnapshotQuery.listThreadCheckpointRefsAfter:decodeRows",
        ),
      ),
      Effect.map((rows): ProjectionCheckpointRefPage => {
        const pageRows = rows.slice(0, limit);
        const last = pageRows.at(-1);
        return {
          checkpointRefs: pageRows.map((row) => row.checkpointRef),
          nextCursor:
            rows.length > limit && last !== undefined
              ? {
                  checkpointTurnCount: last.checkpointTurnCount,
                  turnId: last.turnId,
                }
              : null,
        };
      }),
    );
  };

  const getFullThreadDiffContext: NonNullable<
    ProjectionSnapshotQueryShape["getFullThreadDiffContext"]
  > = (threadId, toTurnCount) =>
    Effect.gen(function* () {
      const row = yield* getFullThreadDiffContextRow({
        threadId,
        checkpointTurnCount: toTurnCount,
      }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getFullThreadDiffContext:query",
            "ProjectionSnapshotQuery.getFullThreadDiffContext:decodeRow",
          ),
        ),
      );
      if (Option.isNone(row)) {
        return Option.none<ProjectionFullThreadDiffContext>();
      }

      return Option.some({
        threadId: row.value.threadId,
        projectId: row.value.projectId,
        workspaceRoot: row.value.workspaceRoot,
        worktreePath: row.value.worktreePath,
        latestCheckpointTurnCount: row.value.latestCheckpointTurnCount ?? 0,
        toCheckpointRef: row.value.toCheckpointRef,
      });
    });

  const getThreadShellById: ProjectionSnapshotQueryShape["getThreadShellById"] = (threadId) =>
    Effect.gen(function* () {
      const [threadRow, latestTurnRow, sessionRow, coagentRow] = yield* Effect.all([
        getActiveThreadRowById({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadShellById:getThread:query",
              "ProjectionSnapshotQuery.getThreadShellById:getThread:decodeRow",
            ),
          ),
        ),
        getLatestTurnRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadShellById:getLatestTurn:query",
              "ProjectionSnapshotQuery.getThreadShellById:getLatestTurn:decodeRow",
            ),
          ),
        ),
        getThreadSessionRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadShellById:getSession:query",
              "ProjectionSnapshotQuery.getThreadShellById:getSession:decodeRow",
            ),
          ),
        ),
        getActiveCoagentRowByChild({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadShellById:getCoagent:query",
              "ProjectionSnapshotQuery.getThreadShellById:getCoagent:decodeRow",
            ),
          ),
        ),
      ]);

      if (Option.isNone(threadRow)) {
        return Option.none<OrchestrationThreadShell>();
      }

      return Option.some({
        id: threadRow.value.threadId,
        projectId: threadRow.value.projectId,
        title: threadRow.value.title,
        coagent: Option.isSome(coagentRow)
          ? {
              parentThreadId: coagentRow.value.parentThreadId,
              creationMode: coagentRow.value.creationMode,
              status: coagentRow.value.status,
            }
          : null,
        modelSelection: threadRow.value.modelSelection,
        runtimeMode: threadRow.value.runtimeMode,
        interactionMode: threadRow.value.interactionMode,
        branch: threadRow.value.branch,
        worktreePath: threadRow.value.worktreePath,
        ...(threadRow.value.linkedPullRequest === null
          ? {}
          : { linkedPullRequest: threadRow.value.linkedPullRequest }),
        latestTurn: Option.isSome(latestTurnRow) ? mapLatestTurn(latestTurnRow.value) : null,
        createdAt: threadRow.value.createdAt,
        updatedAt: threadRow.value.updatedAt,
        archivedAt: threadRow.value.archivedAt,
        settledOverride: threadRow.value.settledOverride,
        settledAt: threadRow.value.settledAt,
        unsettledAt: threadRow.value.unsettledAt,
        snoozedUntil: threadRow.value.snoozedUntil,
        snoozedAt: threadRow.value.snoozedAt,
        pinnedAt: threadRow.value.pinnedAt,
        pinOrderKey: threadRow.value.pinOrderKey ?? null,
        titleRegeneration: mapTitleRegeneration(threadRow.value),
        session: Option.isSome(sessionRow) ? mapSessionRow(sessionRow.value) : null,
        latestUserMessageAt: threadRow.value.latestUserMessageAt,
        hasPendingApprovals: threadRow.value.pendingApprovalCount > 0,
        hasPendingUserInput: threadRow.value.pendingUserInputCount > 0,
        hasActionableProposedPlan: threadRow.value.hasActionableProposedPlan > 0,
        backgroundLiveness: threadBackgroundLiveness.getThreadBackgroundLiveness(
          threadRow.value.threadId,
        ),
        planProgress: threadPlanProgress.getThreadPlanProgress(threadRow.value.threadId),
      } satisfies OrchestrationThreadShell);
    });

  const getThreadContinuationSeedById: ProjectionSnapshotQueryShape["getThreadContinuationSeedById"] =
    (input: ProjectionThreadContinuationSeedInput) =>
      Effect.gen(function* () {
        const boundedInput = {
          ...input,
          maxChars: Number.isFinite(input.maxChars)
            ? Math.max(1, Math.min(5_000_000, Math.trunc(input.maxChars)))
            : 1,
        };
        const [currentRow, priorRows] = yield* Effect.all([
          getThreadContinuationCurrentMessage(boundedInput).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getThreadContinuationSeedById:getCurrent:query",
                "ProjectionSnapshotQuery.getThreadContinuationSeedById:getCurrent:decodeRow",
              ),
            ),
          ),
          listThreadContinuationPriorMessages(boundedInput).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getThreadContinuationSeedById:listPrior:query",
                "ProjectionSnapshotQuery.getThreadContinuationSeedById:listPrior:decodeRows",
              ),
            ),
          ),
        ]);
        if (Option.isNone(currentRow)) {
          return Option.none<ProjectionThreadContinuationSeed>();
        }
        const current = currentRow.value;
        const currentMessage = {
          id: current.messageId,
          role: current.role,
          text: current.text,
          ...(current.attachments === null ? {} : { attachments: current.attachments }),
          turnId: current.turnId,
          streaming: current.isStreaming === 1,
          createdAt: current.createdAt,
          updatedAt: current.updatedAt,
        };
        const priorMessagesNewestFirst = priorRows.map((row) => ({
          id: row.messageId,
          role: row.role,
          text: row.text,
          ...(row.attachments === null ? {} : { attachments: row.attachments }),
          streaming: false,
          createdAt: row.createdAt,
          textTruncated: row.textTruncated === 1,
          attachmentsTruncated: row.attachmentsTruncated === 1,
        }));
        const totalCount = priorRows[0]?.totalCount ?? 0;
        return Option.some({
          currentMessage,
          priorMessagesNewestFirst,
          hasEarlier:
            totalCount > priorRows.length ||
            priorMessagesNewestFirst.some(
              (message) => message.textTruncated || message.attachmentsTruncated,
            ),
        } satisfies ProjectionThreadContinuationSeed);
      });

  const getThreadMessageById: ProjectionSnapshotQueryShape["getThreadMessageById"] = (
    threadId,
    messageId,
  ) =>
    getThreadContinuationCurrentMessage({
      threadId,
      currentMessageId: messageId,
      maxChars: 1,
    }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getThreadMessageById:query",
          "ProjectionSnapshotQuery.getThreadMessageById:decodeRow",
        ),
      ),
      Effect.map(
        Option.map((row) => ({
          id: row.messageId,
          role: row.role,
          text: row.text,
          ...(row.attachments === null ? {} : { attachments: row.attachments }),
          turnId: row.turnId,
          streaming: row.isStreaming === 1,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        })),
      ),
    );

  const getThreadProposedPlanById: NonNullable<
    ProjectionSnapshotQueryShape["getThreadProposedPlanById"]
  > = (threadId, planId) =>
    getThreadProposedPlanRowById({ threadId, planId }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getThreadProposedPlanById:query",
          "ProjectionSnapshotQuery.getThreadProposedPlanById:decodeRow",
        ),
      ),
      Effect.map(Option.map(mapProposedPlanRow)),
    );

  const getFirstUserMessageByThreadId: ProjectionSnapshotQueryShape["getFirstUserMessageByThreadId"] =
    (threadId) =>
      getFirstUserMessageRowByThread({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getFirstUserMessageByThreadId:query",
            "ProjectionSnapshotQuery.getFirstUserMessageByThreadId:decodeRow",
          ),
        ),
        Effect.map(
          Option.map((row) => ({
            id: row.messageId,
            role: row.role,
            text: row.text,
            ...(row.attachments === null ? {} : { attachments: row.attachments }),
            turnId: row.turnId,
            streaming: false,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          })),
        ),
      );

  // Contiguous turn range bounding a windowed detail read; undefined loads the
  // full thread. Resolved from a window request inside the snapshot
  // transaction (see getThreadDetailSnapshot).
  type ThreadDetailBounds =
    | {
        readonly kind: "turn";
        readonly minAnchorAt: string;
        readonly minTurnKey: string;
        readonly beforeAnchorAt: string;
        readonly beforeTurnKey: string;
        readonly includeBase: boolean;
        readonly includePinnedPlans: boolean;
        readonly messageDone: boolean;
        readonly messageBefore?: {
          readonly createdAt: string;
          readonly id: string;
        };
        readonly activityDone: boolean;
        readonly activityBefore?: {
          readonly sequence: number;
          readonly createdAt: string;
          readonly id: string;
        };
        readonly planDone: boolean;
        readonly planBefore?: {
          readonly pinned: number;
          readonly createdAt: string;
          readonly id: string;
        };
      }
    | {
        readonly kind: "turnless";
        readonly minAnchorAt: string;
        readonly minItemKey: string;
        readonly beforeAnchorAt: string;
        readonly beforeItemKey: string;
        readonly includePinnedPlans: boolean;
      };

  interface ThreadDetailTurnPageState {
    readonly messageDone: boolean;
    readonly messageBefore?: {
      readonly createdAt: string;
      readonly id: string;
    };
    readonly activityDone: boolean;
    readonly activityBefore?: {
      readonly sequence: number;
      readonly createdAt: string;
      readonly id: string;
    };
    readonly planDone: boolean;
    readonly planBefore?: {
      readonly pinned: number;
      readonly createdAt: string;
      readonly id: string;
    };
  }

  interface ThreadDetailRead {
    readonly thread: OrchestrationThread;
    readonly turnPageState?: ThreadDetailTurnPageState;
  }

  const getThreadDetailByIdBounded = (threadId: ThreadId, bounds: ThreadDetailBounds | undefined) =>
    Effect.gen(function* () {
      const [
        threadRow,
        messageRows,
        proposedPlanRows,
        activityRows,
        pinnedActivityRows,
        checkpointRows,
        latestTurnRow,
        sessionRow,
        coagentRow,
      ] = yield* Effect.all([
        getActiveThreadRowById({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:getThread:query",
              "ProjectionSnapshotQuery.getThreadDetailById:getThread:decodeRow",
            ),
          ),
        ),
        (bounds === undefined
          ? listThreadMessageRowsByThread({ threadId })
          : bounds.kind === "turn"
            ? bounds.messageDone
              ? Effect.succeed([])
              : listThreadMessageRowsByThreadWindow({
                  threadId,
                  ...bounds,
                  beforeCreatedAt: bounds.messageBefore?.createdAt ?? ANCHOR_UNBOUNDED,
                  beforeId: bounds.messageBefore?.id ?? ANCHOR_UNBOUNDED,
                  limit: THREAD_DETAIL_MESSAGE_LIMIT + 1,
                })
            : listThreadMessageRowsByTurnlessWindow({ threadId, ...bounds })
        ).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:listMessages:query",
              "ProjectionSnapshotQuery.getThreadDetailById:listMessages:decodeRows",
            ),
          ),
        ),
        (bounds === undefined
          ? listThreadProposedPlanRowsByThread({ threadId })
          : bounds.kind === "turn"
            ? bounds.planDone
              ? Effect.succeed([])
              : listThreadProposedPlanRowsByTurnWindow({
                  threadId,
                  ...bounds,
                  beforePinned: bounds.planBefore?.pinned ?? (bounds.includePinnedPlans ? 2 : 1),
                  beforeCreatedAt:
                    bounds.planBefore?.createdAt ??
                    (bounds.includePinnedPlans ? ANCHOR_UNBOUNDED : ""),
                  beforeId: bounds.planBefore?.id ?? ANCHOR_UNBOUNDED,
                  limit: THREAD_DETAIL_PROPOSED_PLAN_LIMIT + 1,
                })
            : listThreadProposedPlanRowsByTurnlessWindow({
                threadId,
                minAnchorAt: bounds.minAnchorAt,
                minItemKey: bounds.minItemKey,
                beforeAnchorAt: bounds.beforeAnchorAt,
                beforeItemKey: bounds.beforeItemKey,
                includePinnedPlans: bounds.includePinnedPlans ? 1 : 0,
              })
        ).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:listPlans:query",
              "ProjectionSnapshotQuery.getThreadDetailById:listPlans:decodeRows",
            ),
          ),
        ),
        (bounds === undefined
          ? listThreadActivityRowsByThread({ threadId })
          : bounds.kind === "turn"
            ? bounds.activityDone
              ? Effect.succeed([])
              : listThreadActivityRowsByThreadWindow({
                  threadId,
                  ...bounds,
                  beforeSequence: bounds.activityBefore?.sequence ?? Number.MAX_SAFE_INTEGER,
                  beforeCreatedAt: bounds.activityBefore?.createdAt ?? ANCHOR_UNBOUNDED,
                  beforeId: bounds.activityBefore?.id ?? ANCHOR_UNBOUNDED,
                  limit: THREAD_DETAIL_ACTIVITY_LIMIT + 1,
                })
            : listThreadActivityRowsByTurnlessWindow({ threadId, ...bounds })
        ).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:listActivities:query",
              "ProjectionSnapshotQuery.getThreadDetailById:listActivities:decodeRows",
            ),
          ),
        ),
        (bounds?.kind === "turn" && !bounds.includeBase
          ? Effect.succeed([])
          : listPinnedThreadActivityRowsByThread({ threadId })
        ).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:listPinnedActivities:query",
              "ProjectionSnapshotQuery.getThreadDetailById:listPinnedActivities:decodeRows",
            ),
          ),
        ),
        (bounds === undefined
          ? listCheckpointRowsByThread({ threadId })
          : bounds.kind === "turn"
            ? bounds.includeBase
              ? listCheckpointRowsByTurnWindow({ threadId, ...bounds })
              : Effect.succeed([])
            : listLatestCheckpointRowsByThread({ threadId })
        ).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:listCheckpoints:query",
              "ProjectionSnapshotQuery.getThreadDetailById:listCheckpoints:decodeRows",
            ),
          ),
        ),
        getLatestTurnRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:getLatestTurn:query",
              "ProjectionSnapshotQuery.getThreadDetailById:getLatestTurn:decodeRow",
            ),
          ),
        ),
        getThreadSessionRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:getSession:query",
              "ProjectionSnapshotQuery.getThreadDetailById:getSession:decodeRow",
            ),
          ),
        ),
        getCoagentRowByChild({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:getCoagent:query",
              "ProjectionSnapshotQuery.getThreadDetailById:getCoagent:decodeRow",
            ),
          ),
        ),
      ]);

      if (Option.isNone(threadRow)) {
        return Option.none<ThreadDetailRead>();
      }

      const selectedMessageRows =
        bounds?.kind === "turn" ? messageRows.slice(0, THREAD_DETAIL_MESSAGE_LIMIT) : messageRows;
      const selectedProposedPlanRows =
        bounds?.kind === "turn"
          ? proposedPlanRows.slice(0, THREAD_DETAIL_PROPOSED_PLAN_LIMIT)
          : proposedPlanRows;
      const selectedWindowActivityRows =
        bounds?.kind === "turn"
          ? activityRows.slice(0, THREAD_DETAIL_ACTIVITY_LIMIT)
          : activityRows;

      const selectedActivityRows = [
        ...new Map(
          [...selectedWindowActivityRows, ...pinnedActivityRows].map(
            (row) => [row.activityId, row] as const,
          ),
        ).values(),
      ].toSorted(
        (left, right) =>
          (left.sequence ?? -1) - (right.sequence ?? -1) ||
          left.createdAt.localeCompare(right.createdAt) ||
          left.activityId.localeCompare(right.activityId),
      );

      const thread = {
        id: threadRow.value.threadId,
        projectId: threadRow.value.projectId,
        title: threadRow.value.title,
        coagent: Option.isSome(coagentRow)
          ? {
              parentThreadId: coagentRow.value.parentThreadId,
              creationMode: coagentRow.value.creationMode,
              status: coagentRow.value.status,
            }
          : null,
        modelSelection: threadRow.value.modelSelection,
        runtimeMode: threadRow.value.runtimeMode,
        interactionMode: threadRow.value.interactionMode,
        branch: threadRow.value.branch,
        worktreePath: threadRow.value.worktreePath,
        ...(threadRow.value.linkedPullRequest === null
          ? {}
          : { linkedPullRequest: threadRow.value.linkedPullRequest }),
        latestTurn: Option.isSome(latestTurnRow) ? mapLatestTurn(latestTurnRow.value) : null,
        createdAt: threadRow.value.createdAt,
        updatedAt: threadRow.value.updatedAt,
        archivedAt: threadRow.value.archivedAt,
        settledOverride: threadRow.value.settledOverride,
        settledAt: threadRow.value.settledAt,
        unsettledAt: threadRow.value.unsettledAt,
        snoozedUntil: threadRow.value.snoozedUntil,
        snoozedAt: threadRow.value.snoozedAt,
        pinnedAt: threadRow.value.pinnedAt,
        pinOrderKey: threadRow.value.pinOrderKey ?? null,
        titleRegeneration: mapTitleRegeneration(threadRow.value),
        deletedAt: null,
        messages: selectedMessageRows
          .toSorted(
            (left, right) =>
              left.createdAt.localeCompare(right.createdAt) ||
              left.messageId.localeCompare(right.messageId),
          )
          .map((row) => {
            const message = {
              id: row.messageId,
              role: row.role,
              text: row.text,
              turnId: row.turnId,
              streaming: row.isStreaming === 1,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
            };
            if (row.attachments !== null) {
              return Object.assign(message, { attachments: row.attachments });
            }
            return message;
          }),
        proposedPlans: selectedProposedPlanRows
          .toSorted(
            (left, right) =>
              left.createdAt.localeCompare(right.createdAt) ||
              left.planId.localeCompare(right.planId),
          )
          .map(mapProposedPlanRow),
        activities: selectedActivityRows.map((row) => {
          const activity = {
            id: row.activityId,
            tone: row.tone,
            kind: row.kind,
            summary: row.summary,
            payload: row.payload,
            turnId: row.turnId,
            createdAt: row.createdAt,
          };
          if (row.sequence !== null) {
            return Object.assign(activity, { sequence: row.sequence });
          }
          return activity;
        }),
        checkpoints: checkpointRows.map((row) => ({
          turnId: row.turnId,
          checkpointTurnCount: row.checkpointTurnCount,
          checkpointRef: row.checkpointRef,
          status: row.status,
          files: row.files,
          assistantMessageId: row.assistantMessageId,
          completedAt: row.completedAt,
        })),
        session: Option.isSome(sessionRow) ? mapSessionRow(sessionRow.value) : null,
      };

      const decodedThread = yield* decodeThread(thread).pipe(
        Effect.mapError(
          toPersistenceDecodeError("ProjectionSnapshotQuery.getThreadDetailById:decodeThread"),
        ),
      );
      if (bounds?.kind !== "turn") {
        return Option.some<ThreadDetailRead>({ thread: decodedThread });
      }

      const oldestMessage = selectedMessageRows.at(-1);
      const oldestActivity = selectedWindowActivityRows.at(-1);
      const oldestPlan = selectedProposedPlanRows.at(-1);
      return Option.some<ThreadDetailRead>({
        thread: decodedThread,
        turnPageState: {
          messageDone: messageRows.length <= THREAD_DETAIL_MESSAGE_LIMIT,
          ...(messageRows.length > THREAD_DETAIL_MESSAGE_LIMIT && oldestMessage !== undefined
            ? {
                messageBefore: {
                  createdAt: oldestMessage.createdAt,
                  id: oldestMessage.messageId,
                },
              }
            : {}),
          activityDone: activityRows.length <= THREAD_DETAIL_ACTIVITY_LIMIT,
          ...(activityRows.length > THREAD_DETAIL_ACTIVITY_LIMIT && oldestActivity !== undefined
            ? {
                activityBefore: {
                  sequence: oldestActivity.sequence ?? -1,
                  createdAt: oldestActivity.createdAt,
                  id: oldestActivity.activityId,
                },
              }
            : {}),
          planDone: proposedPlanRows.length <= THREAD_DETAIL_PROPOSED_PLAN_LIMIT,
          ...(proposedPlanRows.length > THREAD_DETAIL_PROPOSED_PLAN_LIMIT &&
          oldestPlan !== undefined
            ? {
                planBefore: {
                  pinned: oldestPlan.implementedAt === null ? 1 : 0,
                  createdAt: oldestPlan.createdAt,
                  id: oldestPlan.planId,
                },
              }
            : {}),
        },
      });
    });

  const getThreadDetailById: ProjectionSnapshotQueryShape["getThreadDetailById"] = (threadId) =>
    getThreadDetailByIdBounded(threadId, undefined).pipe(
      Effect.map(Option.map((read) => read.thread)),
    );

  // Bounds pathological fan-out: one user turn that spawned hundreds of
  // subagent turns still pages in bounded chunks, at the cost of splitting the
  // fan-out group across pages (the cursor continues the same group). Also
  // structurally bounds the window scan via the candidates CTE's LIMIT.
  const THREAD_DETAIL_MAX_RAW_TURNS_PER_PAGE = 150;
  // Sentinels for unbounded keyset ends; "~" sorts after any ISO timestamp.
  const ANCHOR_UNBOUNDED = "~";

  const getThreadDetailSnapshot: ProjectionSnapshotQueryShape["getThreadDetailSnapshot"] = (
    threadId,
    window,
  ) =>
    // Read the thread detail and the snapshot sequence within a single
    // transaction so the sequence is consistent with the returned state; a
    // projector update landing between two separate reads could otherwise return
    // a sequence ahead of the thread detail, causing the client to resume from
    // too far and drop events. Window resolution runs inside the same
    // transaction so the page boundary is consistent with the returned rows.
    sql
      .withTransaction(
        Effect.gen(function* () {
          if (window?.turnLimit === undefined) {
            const thread = yield* getThreadDetailById(threadId);
            if (Option.isNone(thread)) {
              return Option.none<OrchestrationThreadDetailSnapshot>();
            }
            const { snapshotSequence } = yield* getSnapshotSequence();
            return Option.some({ snapshotSequence, thread: thread.value });
          }

          // A malformed or foreign-thread cursor falls back to the first page
          // rather than failing: the client's stale cursor after a revert or
          // reconnect should degrade to "reload recent history", not error.
          const decodedCursor =
            window.beforeCursor === undefined
              ? null
              : decodeThreadDetailPageCursor(window.beforeCursor);
          const cursor = decodedCursor?.threadId === threadId ? decodedCursor : null;

          const spill = cursor?.mode === "turn-spill" ? cursor.spill : undefined;
          const windowRows =
            spill === undefined
              ? yield* listTurnWindowRows({
                  threadId,
                  beforeAnchorAt: cursor?.beforeAnchorAt ?? ANCHOR_UNBOUNDED,
                  beforeTurnKey: cursor?.beforeTurnId ?? "",
                  userTurnLimit: window.turnLimit,
                  maxRawTurns: THREAD_DETAIL_MAX_RAW_TURNS_PER_PAGE,
                }).pipe(
                  Effect.mapError(
                    toPersistenceSqlOrDecodeError(
                      "ProjectionSnapshotQuery.getThreadDetailSnapshot:listTurnWindow:query",
                      "ProjectionSnapshotQuery.getThreadDetailSnapshot:listTurnWindow:decodeRows",
                    ),
                  ),
                )
              : [];

          const hasTurnlessCursor =
            cursor !== null &&
            (cursor.mode === "turnless" ||
              cursor.beforeTurnId.startsWith("m:") ||
              cursor.beforeTurnId.startsWith("a:"));
          const useTurnlessWindow =
            (spill === undefined && hasTurnlessCursor) ||
            (cursor === null && windowRows.length === 0);
          const includeTurnlessPinnedPlans =
            cursor === null
              ? true
              : cursor.mode === "turnless" && cursor.includeTurnlessPinnedPlans === true;
          const turnlessRows = useTurnlessWindow
            ? yield* listTurnlessWindowRows({
                threadId,
                beforeAnchorAt: cursor?.beforeAnchorAt ?? ANCHOR_UNBOUNDED,
                beforeItemKey: cursor?.beforeTurnId ?? ANCHOR_UNBOUNDED,
                includePinnedPlans: includeTurnlessPinnedPlans ? 1 : 0,
                limit: Math.max(
                  1,
                  Math.min(THREAD_DETAIL_MAX_RAW_TURNS_PER_PAGE, window.turnLimit),
                ),
              }).pipe(
                Effect.mapError(
                  toPersistenceSqlOrDecodeError(
                    "ProjectionSnapshotQuery.getThreadDetailSnapshot:listTurnlessWindow:query",
                    "ProjectionSnapshotQuery.getThreadDetailSnapshot:listTurnlessWindow:decodeRows",
                  ),
                ),
              )
            : [];
          const oldestTurn =
            spill === undefined
              ? windowRows[0]
              : { anchorAt: cursor!.beforeAnchorAt, turnKey: cursor!.beforeTurnId };
          const oldestTurnless = turnlessRows[0];
          const bounds: ThreadDetailBounds = useTurnlessWindow
            ? {
                kind: "turnless",
                minAnchorAt: oldestTurnless?.anchorAt ?? "",
                minItemKey: oldestTurnless?.itemKey ?? "",
                beforeAnchorAt:
                  oldestTurnless === undefined ? "" : (cursor?.beforeAnchorAt ?? ANCHOR_UNBOUNDED),
                beforeItemKey:
                  oldestTurnless === undefined ? "" : (cursor?.beforeTurnId ?? ANCHOR_UNBOUNDED),
                includePinnedPlans: includeTurnlessPinnedPlans,
              }
            : spill === undefined
              ? {
                  kind: "turn",
                  minAnchorAt: oldestTurn?.anchorAt ?? "",
                  minTurnKey: oldestTurn?.turnKey ?? "",
                  beforeAnchorAt:
                    oldestTurn === undefined ? "" : (cursor?.beforeAnchorAt ?? ANCHOR_UNBOUNDED),
                  beforeTurnKey: oldestTurn === undefined ? "" : (cursor?.beforeTurnId ?? ""),
                  includeBase: true,
                  includePinnedPlans: cursor === null,
                  messageDone: false,
                  activityDone: false,
                  planDone: false,
                }
              : {
                  kind: "turn",
                  minAnchorAt: spill.minAnchorAt,
                  minTurnKey: spill.minTurnKey,
                  beforeAnchorAt: spill.rangeBeforeAnchorAt,
                  beforeTurnKey: spill.rangeBeforeTurnKey,
                  includeBase: false,
                  includePinnedPlans: spill.includePinnedPlans,
                  messageDone: spill.messageDone,
                  ...(spill.messageBefore === undefined
                    ? {}
                    : { messageBefore: spill.messageBefore }),
                  activityDone: spill.activityDone,
                  ...(spill.activityBefore === undefined
                    ? {}
                    : { activityBefore: spill.activityBefore }),
                  planDone: spill.planDone,
                  ...(spill.planBefore === undefined ? {} : { planBefore: spill.planBefore }),
                };

          const detail = yield* getThreadDetailByIdBounded(threadId, bounds);
          if (Option.isNone(detail)) {
            return Option.none<OrchestrationThreadDetailSnapshot>();
          }
          const turnPageState = detail.value.turnPageState;
          const hasEntitySpill =
            bounds.kind === "turn" &&
            turnPageState !== undefined &&
            (!turnPageState.messageDone || !turnPageState.activityDone || !turnPageState.planDone);

          const hasOlderTurns =
            !useTurnlessWindow &&
            !hasEntitySpill &&
            oldestTurn !== undefined &&
            (yield* listTurnWindowRows({
              threadId,
              beforeAnchorAt: oldestTurn.anchorAt,
              beforeTurnKey: oldestTurn.turnKey,
              userTurnLimit: 1,
              maxRawTurns: 1,
            }).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getThreadDetailSnapshot:probeOlder:query",
                  "ProjectionSnapshotQuery.getThreadDetailSnapshot:probeOlder:decodeRows",
                ),
              ),
            )).length > 0;
          const turnlessProbeBoundary = useTurnlessWindow
            ? oldestTurnless
            : oldestTurn === undefined
              ? undefined
              : { anchorAt: oldestTurn.anchorAt, itemKey: "" };
          const hasOlderTurnless =
            !hasEntitySpill &&
            !hasOlderTurns &&
            turnlessProbeBoundary !== undefined &&
            (yield* listTurnlessWindowRows({
              threadId,
              beforeAnchorAt: turnlessProbeBoundary.anchorAt,
              beforeItemKey: turnlessProbeBoundary.itemKey,
              includePinnedPlans: useTurnlessWindow && includeTurnlessPinnedPlans ? 1 : 0,
              limit: 1,
            }).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getThreadDetailSnapshot:probeOlderTurnless:query",
                  "ProjectionSnapshotQuery.getThreadDetailSnapshot:probeOlderTurnless:decodeRows",
                ),
              ),
            )).length > 0;
          const hasMore = hasEntitySpill || hasOlderTurns || hasOlderTurnless;

          const { snapshotSequence } = yield* getSnapshotSequence();
          const watermarkRow = yield* getThreadEventWatermarkRow({
            threadId,
            maxSequence: snapshotSequence,
          }).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getThreadDetailSnapshot:threadWatermark:query",
                "ProjectionSnapshotQuery.getThreadDetailSnapshot:threadWatermark:decodeRow",
              ),
            ),
          );
          const threadSequence = Option.match(watermarkRow, {
            onNone: () => 0,
            onSome: (row) => row.threadSequence ?? 0,
          });
          return Option.some({
            snapshotSequence,
            thread: detail.value.thread,
            page: {
              beforeCursor: hasEntitySpill
                ? encodeThreadDetailPageCursor({
                    threadId,
                    beforeAnchorAt: oldestTurn!.anchorAt,
                    beforeTurnId: oldestTurn!.turnKey,
                    mode: "turn-spill",
                    spill: {
                      minAnchorAt: bounds.kind === "turn" ? bounds.minAnchorAt : "",
                      minTurnKey: bounds.kind === "turn" ? bounds.minTurnKey : "",
                      rangeBeforeAnchorAt: bounds.kind === "turn" ? bounds.beforeAnchorAt : "",
                      rangeBeforeTurnKey: bounds.kind === "turn" ? bounds.beforeTurnKey : "",
                      includePinnedPlans:
                        bounds.kind === "turn" ? bounds.includePinnedPlans : false,
                      messageDone: turnPageState!.messageDone,
                      ...(turnPageState!.messageBefore === undefined
                        ? {}
                        : { messageBefore: turnPageState!.messageBefore }),
                      activityDone: turnPageState!.activityDone,
                      ...(turnPageState!.activityBefore === undefined
                        ? {}
                        : { activityBefore: turnPageState!.activityBefore }),
                      planDone: turnPageState!.planDone,
                      ...(turnPageState!.planBefore === undefined
                        ? {}
                        : { planBefore: turnPageState!.planBefore }),
                    },
                  })
                : hasOlderTurns
                  ? encodeThreadDetailPageCursor({
                      threadId,
                      beforeAnchorAt: oldestTurn!.anchorAt,
                      beforeTurnId: oldestTurn!.turnKey,
                      mode: "turn",
                    })
                  : hasOlderTurnless
                    ? encodeThreadDetailPageCursor({
                        threadId,
                        beforeAnchorAt: turnlessProbeBoundary!.anchorAt,
                        beforeTurnId: turnlessProbeBoundary!.itemKey,
                        mode: "turnless",
                        includeTurnlessPinnedPlans: useTurnlessWindow && includeTurnlessPinnedPlans,
                      })
                    : null,
              hasMore,
              snapshotSequence,
              threadSequence,
            },
          });
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          isPersistenceError(error)
            ? error
            : toPersistenceSqlError("ProjectionSnapshotQuery.getThreadDetailSnapshot:transaction")(
                error,
              ),
        ),
      );

  const requireThreadSyncExportSequence = (
    threadId: ThreadId,
    expected: number,
    operation: string,
  ): Effect.Effect<void, ProjectionRepositoryError> =>
    sql<{ readonly threadSequence: number }>`
      SELECT COALESCE(MAX(sequence), 0) AS "threadSequence"
      FROM orchestration_events
      WHERE aggregate_kind = 'thread'
        AND stream_id = ${threadId}
    `.pipe(
      Effect.flatMap((rows) => {
        const actual = rows[0]?.threadSequence ?? 0;
        return actual === expected
          ? Effect.void
          : Effect.fail(
              toPersistenceSqlError(operation)(
                new Error(
                  `Thread projection changed during export (${String(expected)} -> ${String(actual)}).`,
                ),
              ),
            );
      }),
      Effect.mapError((error) =>
        isPersistenceError(error) ? error : toPersistenceSqlError(operation)(error),
      ),
    );

  const getThreadSyncExportIndex: NonNullable<
    ProjectionSnapshotQueryShape["getThreadSyncExportIndex"]
  > = () =>
    sql
      .withTransaction(
        Effect.all([
          listProjectRows(undefined),
          listThreadRows(undefined),
          listCoagentRows(undefined),
          listThreadSyncActiveThreadRows(undefined),
          listThreadSyncWatermarkRows(undefined),
          listThreadSyncLatestTurnIdRows(undefined),
          listProjectionStateRows(undefined),
        ]),
      )
      .pipe(
        Effect.flatMap(
          ([
            projectRows,
            threadRows,
            coagentRows,
            activeRows,
            watermarkRows,
            latestTurnRows,
            stateRows,
          ]) =>
            Effect.gen(function* () {
              const repositoryIdentities = yield* resolveRepositoryIdentitiesForProjects(
                projectRows,
                { includeDeleted: true },
              );
              const coagentByThread = new Map(
                coagentRows.map((row) => [row.childThreadId, row] as const),
              );
              const activeThreadIds = new Set(activeRows.map((row) => row.threadId));
              const watermarkByThread = new Map(
                watermarkRows.map((row) => [row.threadId, row.threadSequence] as const),
              );
              const latestTurnByThread = new Map(
                latestTurnRows.map((row) => [row.threadId, row.latestTurnId] as const),
              );
              let updatedAt: string | null = null;
              for (const row of projectRows) updatedAt = maxIso(updatedAt, row.updatedAt);
              for (const row of threadRows) updatedAt = maxIso(updatedAt, row.updatedAt);
              for (const row of stateRows) updatedAt = maxIso(updatedAt, row.updatedAt);

              return {
                snapshotSequence: computeSnapshotSequence(stateRows),
                updatedAt: updatedAt ?? "1970-01-01T00:00:00.000Z",
                projects: projectRows.map((row) => ({
                  id: row.projectId,
                  title: row.title,
                  workspaceRoot: row.workspaceRoot,
                  repositoryIdentity: repositoryIdentities.get(row.projectId) ?? null,
                  defaultModelSelection: row.defaultModelSelection,
                  defaultThreadEnvMode: row.defaultThreadEnvMode,
                  faviconPath: row.faviconPath ?? null,
                  scripts: row.scripts,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                  deletedAt: row.deletedAt,
                })),
                threads: threadRows.map((row) => {
                  const coagent = coagentByThread.get(row.threadId);
                  return {
                    id: row.threadId,
                    projectId: row.projectId,
                    title: row.title,
                    coagent:
                      coagent === undefined
                        ? null
                        : {
                            parentThreadId: coagent.parentThreadId,
                            creationMode: coagent.creationMode,
                            status: coagent.status,
                          },
                    latestTurnId: latestTurnByThread.get(row.threadId) ?? null,
                    threadSequence: watermarkByThread.get(row.threadId) ?? 0,
                    lifecycle: {
                      archivedAt: row.archivedAt,
                      settledOverride: row.settledOverride,
                      settledAt: row.settledAt,
                      deletedAt: row.deletedAt,
                    },
                    createdAt: row.createdAt,
                    updatedAt: row.updatedAt,
                    active: activeThreadIds.has(row.threadId),
                  };
                }),
              };
            }),
        ),
        Effect.mapError((error) =>
          isPersistenceError(error)
            ? error
            : Schema.isSchemaError(error)
              ? toPersistenceDecodeError("ProjectionSnapshotQuery.getThreadSyncExportIndex:decode")(
                  error,
                )
              : toPersistenceSqlError("ProjectionSnapshotQuery.getThreadSyncExportIndex:query")(
                  error,
                ),
        ),
      );

  const getThreadSyncV1HydrationStats: NonNullable<
    ProjectionSnapshotQueryShape["getThreadSyncV1HydrationStats"]
  > = () => {
    const readStats = SqlSchema.findOneOption({
      Request: Schema.Void,
      Result: ProjectionThreadSyncV1HydrationStatsRowSchema,
      execute: () => sql`
        WITH thread_components(thread_id, row_count, estimated_bytes) AS (
          SELECT
            thread_id,
            COUNT(*),
            SUM(
              256 +
              length(CAST(message_id AS BLOB)) +
              length(CAST(role AS BLOB)) +
              length(CAST(text AS BLOB)) +
              COALESCE(length(CAST(attachments_json AS BLOB)), 0)
            )
          FROM projection_thread_messages
          GROUP BY thread_id

          UNION ALL

          SELECT
            thread_id,
            COUNT(*),
            SUM(
              192 +
              length(CAST(plan_id AS BLOB)) +
              length(CAST(plan_markdown AS BLOB))
            )
          FROM projection_thread_proposed_plans
          GROUP BY thread_id

          UNION ALL

          SELECT
            thread_id,
            COUNT(*),
            SUM(
              256 +
              length(CAST(activity_id AS BLOB)) +
              length(CAST(summary AS BLOB)) +
              length(CAST(payload_json AS BLOB))
            )
          FROM projection_thread_activities
          GROUP BY thread_id

          UNION ALL

          SELECT
            thread_id,
            COUNT(*),
            SUM(
              256 +
              COALESCE(length(CAST(turn_id AS BLOB)), 0) +
              COALESCE(length(CAST(checkpoint_files_json AS BLOB)), 0)
            )
          FROM projection_turns
          GROUP BY thread_id

          UNION ALL

          SELECT
            thread_id,
            COUNT(*),
            SUM(512 + COALESCE(length(CAST(last_error AS BLOB)), 0))
          FROM projection_thread_sessions
          GROUP BY thread_id

          UNION ALL

          SELECT
            thread_id,
            1,
            2048 +
              length(CAST(thread_id AS BLOB)) +
              length(CAST(project_id AS BLOB)) +
              length(CAST(title AS BLOB)) +
              COALESCE(length(CAST(branch AS BLOB)), 0) +
              COALESCE(length(CAST(worktree_path AS BLOB)), 0)
          FROM projection_threads
        ), thread_totals AS (
          SELECT
            thread_id,
            SUM(row_count) AS row_count,
            SUM(estimated_bytes) AS estimated_bytes
          FROM thread_components
          GROUP BY thread_id
        ), project_totals AS (
          SELECT
            COUNT(*) AS project_count,
            COALESCE(
              SUM(
                2048 +
                length(CAST(project_id AS BLOB)) +
                length(CAST(title AS BLOB)) +
                length(CAST(workspace_root AS BLOB)) +
                length(CAST(scripts_json AS BLOB))
              ),
              0
            ) AS estimated_bytes
          FROM projection_projects
        )
        SELECT
          project_totals.project_count AS "projectCount",
          (SELECT COUNT(*) FROM projection_threads) AS "threadCount",
          project_totals.project_count +
            COALESCE((SELECT SUM(row_count) FROM thread_totals), 0) AS "rowCount",
          project_totals.estimated_bytes +
            COALESCE((SELECT SUM(estimated_bytes) FROM thread_totals), 0) AS "estimatedBytes",
          COALESCE((SELECT MAX(estimated_bytes) FROM thread_totals), 0)
            AS "maxThreadEstimatedBytes"
        FROM project_totals
      `,
    });
    return readStats(undefined).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              toPersistenceSqlError("ProjectionSnapshotQuery.getThreadSyncV1HydrationStats:empty")(
                new Error("The v1 hydration size query returned no row."),
              ),
            ),
          onSome: Effect.succeed,
        }),
      ),
      Effect.mapError((error) =>
        isPersistenceError(error)
          ? error
          : Schema.isSchemaError(error)
            ? toPersistenceDecodeError(
                "ProjectionSnapshotQuery.getThreadSyncV1HydrationStats:decode",
              )(error)
            : toPersistenceSqlError("ProjectionSnapshotQuery.getThreadSyncV1HydrationStats:query")(
                error,
              ),
      ),
    );
  };

  const listThreadSyncExportTurnsPage: NonNullable<
    ProjectionSnapshotQueryShape["listThreadSyncExportTurnsPage"]
  > = (input) => {
    const limit = Math.max(1, Math.min(256, Math.trunc(input.limit)));
    const after = input.after;
    const requestedAt = after?.requestedAt ?? "";
    const startedAt = after?.startedAt ?? "";
    const completedAt = after?.completedAt ?? "";
    const turnId = after?.turnId ?? "";
    return sql
      .withTransaction(
        Effect.gen(function* () {
          yield* requireThreadSyncExportSequence(
            input.threadId,
            input.threadSequence,
            "ProjectionSnapshotQuery.listThreadSyncExportTurnsPage:stale",
          );
          const rows = yield* sql<{
            readonly turnId: string;
            readonly localTurnId: string;
            readonly pendingMessageId: string | null;
            readonly sourceProposedPlanThreadId: string | null;
            readonly sourceProposedPlanId: string | null;
            readonly state: string;
            readonly requestedAt: string;
            readonly startedAt: string | null;
            readonly completedAt: string;
            readonly assistantMessageId: string | null;
          }>`
            SELECT
              COALESCE(turns.sync_portable_id, turns.turn_id) AS "turnId",
              turns.turn_id AS "localTurnId",
              COALESCE(pending.sync_portable_id, turns.pending_message_id) AS "pendingMessageId",
              turns.source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
              COALESCE(source_plan.sync_portable_id, turns.source_proposed_plan_id) AS "sourceProposedPlanId",
              turns.state,
              turns.requested_at AS "requestedAt",
              turns.started_at AS "startedAt",
              turns.completed_at AS "completedAt",
              COALESCE(assistant.sync_portable_id, turns.assistant_message_id) AS "assistantMessageId"
            FROM projection_turns AS turns
            LEFT JOIN projection_thread_messages AS pending
              ON pending.thread_id = turns.thread_id
              AND pending.message_id = turns.pending_message_id
            LEFT JOIN projection_thread_messages AS assistant
              ON assistant.thread_id = turns.thread_id
              AND assistant.message_id = turns.assistant_message_id
            LEFT JOIN projection_thread_proposed_plans AS source_plan
              ON source_plan.thread_id = turns.source_proposed_plan_thread_id
              AND source_plan.plan_id = turns.source_proposed_plan_id
            WHERE turns.thread_id = ${input.threadId}
              AND turns.turn_id IS NOT NULL
              AND turns.completed_at IS NOT NULL
              AND turns.state IN ('interrupted', 'completed', 'error')
              AND (
                turns.requested_at > ${requestedAt}
                OR (turns.requested_at = ${requestedAt} AND COALESCE(turns.started_at, '') > ${startedAt})
                OR (
                  turns.requested_at = ${requestedAt}
                  AND COALESCE(turns.started_at, '') = ${startedAt}
                  AND turns.completed_at > ${completedAt}
                )
                OR (
                  turns.requested_at = ${requestedAt}
                  AND COALESCE(turns.started_at, '') = ${startedAt}
                  AND turns.completed_at = ${completedAt}
                  AND turns.turn_id > ${turnId}
                )
              )
            ORDER BY turns.requested_at ASC, COALESCE(turns.started_at, '') ASC, turns.completed_at ASC, turns.turn_id ASC
            LIMIT ${limit}
          `;
          const mapped = rows.map((row) => ({
            cursor: {
              requestedAt: row.requestedAt,
              startedAt: row.startedAt ?? "",
              completedAt: row.completedAt,
              turnId: row.localTurnId as TurnId,
            },
            value: {
              turnId: row.turnId as TurnId,
              pendingMessageId: row.pendingMessageId as MessageId | null,
              sourceProposedPlanThreadId: row.sourceProposedPlanThreadId as ThreadId | null,
              sourceProposedPlanId: row.sourceProposedPlanId as OrchestrationProposedPlanId | null,
              state: row.state as "interrupted" | "completed" | "error",
              requestedAt: row.requestedAt,
              startedAt: row.startedAt,
              completedAt: row.completedAt,
              assistantMessageId: row.assistantMessageId as MessageId | null,
            },
          }));
          const last = rows.at(-1);
          return {
            rows: mapped,
            next:
              last === undefined || rows.length < limit
                ? null
                : ({
                    requestedAt: last.requestedAt,
                    startedAt: last.startedAt ?? "",
                    completedAt: last.completedAt,
                    turnId: last.localTurnId as TurnId,
                  } satisfies ProjectionThreadSyncTurnCursor),
          };
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          isPersistenceError(error)
            ? error
            : toPersistenceSqlError("ProjectionSnapshotQuery.listThreadSyncExportTurnsPage:query")(
                error,
              ),
        ),
      ) as ReturnType<typeof listThreadSyncExportTurnsPage>;
  };

  const listThreadSyncExportMessagesPage: NonNullable<
    ProjectionSnapshotQueryShape["listThreadSyncExportMessagesPage"]
  > = (input) => {
    const limit = Math.max(1, Math.min(256, Math.trunc(input.limit)));
    const createdAt = input.after?.createdAt ?? "";
    const messageId = input.after?.id ?? "";
    return sql
      .withTransaction(
        Effect.gen(function* () {
          yield* requireThreadSyncExportSequence(
            input.threadId,
            input.threadSequence,
            "ProjectionSnapshotQuery.listThreadSyncExportMessagesPage:stale",
          );
          const rows = yield* sql<{
            readonly messageId: string;
            readonly localMessageId: string;
            readonly turnId: string | null;
            readonly role: string;
            readonly attachmentsJson: string | null;
            readonly createdAt: string;
            readonly updatedAt: string;
          }>`
            SELECT
              COALESCE(messages.sync_portable_id, messages.message_id) AS "messageId",
              messages.message_id AS "localMessageId",
              COALESCE(linked_turn.sync_portable_id, messages.turn_id) AS "turnId",
              messages.role,
              messages.attachments_json AS "attachmentsJson",
              messages.created_at AS "createdAt",
              messages.updated_at AS "updatedAt"
            FROM projection_thread_messages AS messages
            LEFT JOIN projection_turns AS linked_turn
              ON linked_turn.thread_id = messages.thread_id
              AND linked_turn.turn_id = messages.turn_id
            WHERE messages.thread_id = ${input.threadId}
              AND messages.is_streaming = 0
              AND (
                ${input.attachmentsOnly === true ? 1 : 0} = 0
                OR (
                  messages.attachments_json IS NOT NULL
                  AND messages.attachments_json <> '[]'
                )
              )
              AND (
                messages.turn_id IS NULL
                OR EXISTS (
                  SELECT 1
                  FROM projection_turns AS turns
                  WHERE turns.thread_id = messages.thread_id
                    AND turns.turn_id = messages.turn_id
                    AND turns.completed_at IS NOT NULL
                    AND turns.state IN ('interrupted', 'completed', 'error')
                )
              )
              AND (
                messages.created_at > ${createdAt}
                OR (messages.created_at = ${createdAt} AND messages.message_id > ${messageId})
              )
            ORDER BY messages.created_at ASC, messages.message_id ASC
            LIMIT ${limit}
          `;
          const mapped = rows.map((row) => ({
            localId: row.localMessageId as MessageId,
            cursor: { createdAt: row.createdAt, id: row.localMessageId },
            value: {
              id: row.messageId as MessageId,
              role: row.role as OrchestrationMessage["role"],
              ...(row.attachmentsJson === null
                ? {}
                : { attachments: decodeChatAttachments(JSON.parse(row.attachmentsJson)) }),
              turnId: row.turnId as TurnId | null,
              streaming: false as const,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
            },
          }));
          const last = rows.at(-1);
          return {
            rows: mapped,
            next:
              last === undefined || rows.length < limit
                ? null
                : ({
                    createdAt: last.createdAt,
                    id: last.localMessageId,
                  } satisfies ProjectionThreadSyncEntityCursor),
          };
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          isPersistenceError(error)
            ? error
            : Schema.isSchemaError(error)
              ? toPersistenceDecodeError(
                  "ProjectionSnapshotQuery.listThreadSyncExportMessagesPage:decode",
                )(error)
              : toPersistenceSqlError(
                  "ProjectionSnapshotQuery.listThreadSyncExportMessagesPage:query",
                )(error),
        ),
      ) as ReturnType<typeof listThreadSyncExportMessagesPage>;
  };

  const listThreadSyncExportPlansPage: NonNullable<
    ProjectionSnapshotQueryShape["listThreadSyncExportPlansPage"]
  > = (input) => {
    const limit = Math.max(1, Math.min(256, Math.trunc(input.limit)));
    const createdAt = input.after?.createdAt ?? "";
    const planId = input.after?.id ?? "";
    return sql
      .withTransaction(
        Effect.gen(function* () {
          yield* requireThreadSyncExportSequence(
            input.threadId,
            input.threadSequence,
            "ProjectionSnapshotQuery.listThreadSyncExportPlansPage:stale",
          );
          const rows = yield* sql<{
            readonly planId: string;
            readonly localPlanId: string;
            readonly turnId: string | null;
            readonly implementedAt: string | null;
            readonly implementationThreadId: string | null;
            readonly createdAt: string;
            readonly updatedAt: string;
          }>`
            SELECT
              COALESCE(plans.sync_portable_id, plans.plan_id) AS "planId",
              plans.plan_id AS "localPlanId",
              COALESCE(linked_turn.sync_portable_id, plans.turn_id) AS "turnId",
              plans.implemented_at AS "implementedAt",
              plans.implementation_thread_id AS "implementationThreadId",
              plans.created_at AS "createdAt",
              plans.updated_at AS "updatedAt"
            FROM projection_thread_proposed_plans AS plans
            LEFT JOIN projection_turns AS linked_turn
              ON linked_turn.thread_id = plans.thread_id
              AND linked_turn.turn_id = plans.turn_id
            WHERE plans.thread_id = ${input.threadId}
              AND (
                plans.created_at > ${createdAt}
                OR (plans.created_at = ${createdAt} AND plans.plan_id > ${planId})
              )
            ORDER BY plans.created_at ASC, plans.plan_id ASC
            LIMIT ${limit}
          `;
          const mapped = rows.map((row) => ({
            localId: row.localPlanId as OrchestrationProposedPlanId,
            cursor: { createdAt: row.createdAt, id: row.localPlanId },
            value: {
              id: row.planId as OrchestrationProposedPlanId,
              turnId: row.turnId as TurnId | null,
              implementedAt: row.implementedAt,
              implementationThreadId: row.implementationThreadId as ThreadId | null,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
            },
          }));
          const last = rows.at(-1);
          return {
            rows: mapped,
            next:
              last === undefined || rows.length < limit
                ? null
                : ({
                    createdAt: last.createdAt,
                    id: last.localPlanId,
                  } satisfies ProjectionThreadSyncEntityCursor),
          };
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          isPersistenceError(error)
            ? error
            : toPersistenceSqlError("ProjectionSnapshotQuery.listThreadSyncExportPlansPage:query")(
                error,
              ),
        ),
      ) as ReturnType<typeof listThreadSyncExportPlansPage>;
  };

  const listThreadSyncExportActivitiesPage: NonNullable<
    ProjectionSnapshotQueryShape["listThreadSyncExportActivitiesPage"]
  > = (input) => {
    const limit = Math.max(1, Math.min(256, Math.trunc(input.limit)));
    const sequence = input.after?.sequence ?? -1;
    const createdAt = input.after?.createdAt ?? "";
    const activityId = input.after?.id ?? "";
    return sql
      .withTransaction(
        Effect.gen(function* () {
          yield* requireThreadSyncExportSequence(
            input.threadId,
            input.threadSequence,
            "ProjectionSnapshotQuery.listThreadSyncExportActivitiesPage:stale",
          );
          const rows = yield* sql<{
            readonly activityId: string;
            readonly localActivityId: string;
            readonly turnId: string | null;
            readonly tone: string;
            readonly kind: string;
            readonly sequence: number | null;
            readonly createdAt: string;
          }>`
            SELECT
              COALESCE(activities.sync_portable_id, activities.activity_id) AS "activityId",
              activities.activity_id AS "localActivityId",
              COALESCE(linked_turn.sync_portable_id, activities.turn_id) AS "turnId",
              activities.tone,
              activities.kind,
              activities.sequence,
              activities.created_at AS "createdAt"
            FROM projection_thread_activities AS activities
            LEFT JOIN projection_turns AS linked_turn
              ON linked_turn.thread_id = activities.thread_id
              AND linked_turn.turn_id = activities.turn_id
            WHERE activities.thread_id = ${input.threadId}
              AND (
                COALESCE(activities.sequence, -1) > ${sequence}
                OR (
                  COALESCE(activities.sequence, -1) = ${sequence}
                  AND activities.created_at > ${createdAt}
                )
                OR (
                  COALESCE(activities.sequence, -1) = ${sequence}
                  AND activities.created_at = ${createdAt}
                  AND activities.activity_id > ${activityId}
                )
              )
            ORDER BY COALESCE(activities.sequence, -1) ASC, activities.created_at ASC, activities.activity_id ASC
            LIMIT ${limit}
          `;
          const mapped = rows.map((row) => ({
            localId: row.localActivityId as EventId,
            cursor: {
              sequence: row.sequence,
              createdAt: row.createdAt,
              id: row.localActivityId,
            },
            value: {
              id: row.activityId as EventId,
              tone: row.tone as OrchestrationThreadActivity["tone"],
              kind: row.kind,
              turnId: row.turnId as TurnId | null,
              ...(row.sequence === null ? {} : { sequence: row.sequence }),
              createdAt: row.createdAt,
            },
          }));
          const last = rows.at(-1);
          return {
            rows: mapped,
            next:
              last === undefined || rows.length < limit
                ? null
                : ({
                    sequence: last.sequence,
                    createdAt: last.createdAt,
                    id: last.localActivityId,
                  } satisfies ProjectionThreadSyncActivityCursor),
          };
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          isPersistenceError(error)
            ? error
            : toPersistenceSqlError(
                "ProjectionSnapshotQuery.listThreadSyncExportActivitiesPage:query",
              )(error),
        ),
      ) as ReturnType<typeof listThreadSyncExportActivitiesPage>;
  };

  const readThreadSyncExportTextChunk: NonNullable<
    ProjectionSnapshotQueryShape["readThreadSyncExportTextChunk"]
  > = (input) => {
    const offset = Math.max(0, Math.trunc(input.offset));
    const maxBytes = Math.max(4, Math.min(256 * 1024, Math.trunc(input.maxBytes)));
    const readBytes = maxBytes + 4;
    return sql
      .withTransaction(
        Effect.gen(function* () {
          yield* requireThreadSyncExportSequence(
            input.threadId,
            input.threadSequence,
            "ProjectionSnapshotQuery.readThreadSyncExportTextChunk:stale",
          );
          const rows =
            input.field === "message-text"
              ? yield* sql<{ readonly hexBytes: string }>`
                  SELECT hex(substr(CAST(text AS BLOB), ${offset + 1}, ${readBytes})) AS "hexBytes"
                  FROM projection_thread_messages
                  WHERE thread_id = ${input.threadId}
                    AND message_id = ${input.ownerId}
                    AND is_streaming = 0
                  LIMIT 1
                `
              : input.field === "plan-markdown"
                ? yield* sql<{ readonly hexBytes: string }>`
                    SELECT hex(substr(CAST(plan_markdown AS BLOB), ${offset + 1}, ${readBytes})) AS "hexBytes"
                    FROM projection_thread_proposed_plans
                    WHERE thread_id = ${input.threadId}
                      AND plan_id = ${input.ownerId}
                    LIMIT 1
                  `
                : yield* sql<{ readonly hexBytes: string }>`
                    SELECT hex(substr(CAST(summary AS BLOB), ${offset + 1}, ${readBytes})) AS "hexBytes"
                    FROM projection_thread_activities
                    WHERE thread_id = ${input.threadId}
                      AND activity_id = ${input.ownerId}
                    LIMIT 1
                  `;
          const row = rows[0];
          if (row === undefined) return Option.none();
          const available = Buffer.from(row.hexBytes, "hex");
          let bytes = available.subarray(0, maxBytes);
          if (bytes.byteLength > 0) {
            const decoder = new TextDecoder("utf-8", { fatal: true });
            let decoded = false;
            for (let trailingBytes = 0; trailingBytes <= 3; trailingBytes += 1) {
              const candidate = bytes.subarray(0, bytes.byteLength - trailingBytes);
              try {
                decoder.decode(candidate);
                bytes = candidate;
                decoded = true;
                break;
              } catch {
                // A BLOB page can end in the middle of one UTF-8 code point.
              }
            }
            if (!decoded || bytes.byteLength === 0) {
              return yield* Effect.fail(
                toPersistenceSqlError("ProjectionSnapshotQuery.readThreadSyncExportTextChunk:utf8")(
                  new Error("Projection text is not valid UTF-8."),
                ),
              );
            }
          }
          return Option.some({
            bytes: new Uint8Array(bytes),
            nextOffset: offset + bytes.byteLength,
            done: available.byteLength <= bytes.byteLength,
          });
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          isPersistenceError(error)
            ? error
            : toPersistenceSqlError("ProjectionSnapshotQuery.readThreadSyncExportTextChunk:query")(
                error,
              ),
        ),
      );
  };

  return {
    getCommandReadModel,
    getSnapshot,
    getShellSnapshot,
    getArchivedShellSnapshot,
    searchThreads,
    getSnapshotSequence,
    getCounts,
    getActiveProjectByWorkspaceRoot,
    getProjectShellById,
    getFirstActiveThreadIdByProjectId,
    getThreadCheckpointContext,
    getThreadCheckpointHeadContext,
    listThreadCheckpointRefsAfter,
    getFullThreadDiffContext,
    getThreadShellById,
    getThreadContinuationSeedById,
    getThreadMessageById,
    getThreadProposedPlanById,
    getFirstUserMessageByThreadId,
    getThreadSyncExportIndex,
    getThreadSyncV1HydrationStats,
    listThreadSyncExportTurnsPage,
    listThreadSyncExportMessagesPage,
    listThreadSyncExportPlansPage,
    listThreadSyncExportActivitiesPage,
    readThreadSyncExportTextChunk,
    getThreadDetailById,
    getThreadDetailSnapshot,
  } satisfies ProjectionSnapshotQueryShape;
});

export const OrchestrationProjectionSnapshotQueryLive = Layer.effect(
  ProjectionSnapshotQuery,
  makeProjectionSnapshotQuery,
);
