import * as Schema from "effect/Schema";

import {
  EventId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import {
  OrchestrationMessageRole,
  OrchestrationProposedPlanId,
  OrchestrationThreadActivityTone,
} from "./orchestration.ts";

/** Current JSON format stored in the sync repository. */
export const THREAD_SYNC_FORMAT_VERSION = 1 as const;

export const ThreadSyncProjectId = TrimmedNonEmptyString.pipe(Schema.brand("ThreadSyncProjectId"));
export type ThreadSyncProjectId = typeof ThreadSyncProjectId.Type;

export const ThreadSyncRevision = TrimmedNonEmptyString.pipe(Schema.brand("ThreadSyncRevision"));
export type ThreadSyncRevision = typeof ThreadSyncRevision.Type;

/**
 * A slash-normalized path relative to a repository root. `.` represents the
 * repository root. Host paths, drive letters, and parent traversal are not
 * portable and are rejected.
 */
export const ThreadSyncRelativePath = TrimmedNonEmptyString.check(
  Schema.isPattern(/^(?:\.|(?!\/)(?![A-Za-z]:\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\]+)$/),
);
export type ThreadSyncRelativePath = typeof ThreadSyncRelativePath.Type;

/** Repository identity without the local `rootPath` field. */
export const ThreadSyncRepositoryIdentity = Schema.Struct({
  canonicalKey: TrimmedNonEmptyString,
  locator: Schema.Struct({
    source: Schema.Literal("git-remote"),
    remoteName: TrimmedNonEmptyString,
    remoteUrl: TrimmedNonEmptyString,
  }),
  displayName: Schema.NullOr(TrimmedNonEmptyString),
  provider: Schema.NullOr(TrimmedNonEmptyString),
  owner: Schema.NullOr(TrimmedNonEmptyString),
  name: Schema.NullOr(TrimmedNonEmptyString),
});
export type ThreadSyncRepositoryIdentity = typeof ThreadSyncRepositoryIdentity.Type;

/** A project descriptor that can be linked to a different folder on each host. */
export const ThreadSyncProjectSnapshot = Schema.Struct({
  formatVersion: Schema.Literal(THREAD_SYNC_FORMAT_VERSION),
  syncProjectId: ThreadSyncProjectId,
  title: TrimmedNonEmptyString,
  repositoryIdentity: Schema.NullOr(ThreadSyncRepositoryIdentity),
  repositoryRelativePath: Schema.NullOr(ThreadSyncRelativePath),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type ThreadSyncProjectSnapshot = typeof ThreadSyncProjectSnapshot.Type;

export const ThreadSyncImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100), Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt,
  blobHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
export type ThreadSyncImageAttachment = typeof ThreadSyncImageAttachment.Type;

export const ThreadSyncMessage = Schema.Struct({
  id: MessageId,
  role: OrchestrationMessageRole,
  text: Schema.String,
  attachments: Schema.Array(ThreadSyncImageAttachment),
  turnId: Schema.NullOr(TurnId),
  /** Only durable, terminal history may enter the sync repository. */
  streaming: Schema.Literal(false),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ThreadSyncMessage = typeof ThreadSyncMessage.Type;

export const ThreadSyncProposedPlan = Schema.Struct({
  id: OrchestrationProposedPlanId,
  turnId: Schema.NullOr(TurnId),
  planMarkdown: TrimmedNonEmptyString,
  implementedAt: Schema.NullOr(IsoDateTime),
  implementationThreadId: Schema.NullOr(ThreadId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ThreadSyncProposedPlan = typeof ThreadSyncProposedPlan.Type;

/**
 * The portable part of a work-log entry. Provider payloads are deliberately
 * omitted because they may contain host paths, credentials, or runtime state.
 */
export const ThreadSyncActivity = Schema.Struct({
  id: EventId,
  tone: OrchestrationThreadActivityTone,
  kind: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  turnId: Schema.NullOr(TurnId),
  sequence: Schema.NullOr(NonNegativeInt),
  createdAt: IsoDateTime,
});
export type ThreadSyncActivity = typeof ThreadSyncActivity.Type;

export const ThreadSyncTerminalTurnState = Schema.Literals(["interrupted", "completed", "error"]);
export type ThreadSyncTerminalTurnState = typeof ThreadSyncTerminalTurnState.Type;

export const ThreadSyncTerminalTurn = Schema.Struct({
  turnId: TurnId,
  pendingMessageId: Schema.NullOr(MessageId),
  sourceProposedPlanThreadId: Schema.NullOr(ThreadId),
  sourceProposedPlanId: Schema.NullOr(OrchestrationProposedPlanId),
  state: ThreadSyncTerminalTurnState,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: IsoDateTime,
  assistantMessageId: Schema.NullOr(MessageId),
});
export type ThreadSyncTerminalTurn = typeof ThreadSyncTerminalTurn.Type;

export const ThreadSyncThreadLifecycle = Schema.Struct({
  archivedAt: Schema.NullOr(IsoDateTime),
  settledOverride: Schema.NullOr(Schema.Literals(["settled", "active"])),
  settledAt: Schema.NullOr(IsoDateTime),
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type ThreadSyncThreadLifecycle = typeof ThreadSyncThreadLifecycle.Type;

/** Co-agent relations are portable, but importers must remap both thread IDs together. */
export const ThreadSyncCoagent = Schema.Struct({
  parentThreadId: ThreadId,
  creationMode: Schema.Literals(["blank", "fork"]),
  status: Schema.Literals(["ready", "failed", "released"]),
});
export type ThreadSyncCoagent = typeof ThreadSyncCoagent.Type;

/**
 * A provider-independent thread snapshot. It intentionally has no model,
 * provider, session, workspace, worktree, branch, approval, or auth fields.
 */
export const ThreadSyncThreadSnapshot = Schema.Struct({
  formatVersion: Schema.Literal(THREAD_SYNC_FORMAT_VERSION),
  threadId: ThreadId,
  syncProjectId: ThreadSyncProjectId,
  title: TrimmedNonEmptyString,
  coagent: Schema.NullOr(ThreadSyncCoagent),
  latestTurn: Schema.NullOr(ThreadSyncTerminalTurn),
  turns: Schema.Array(ThreadSyncTerminalTurn),
  lifecycle: ThreadSyncThreadLifecycle,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  messages: Schema.Array(ThreadSyncMessage),
  proposedPlans: Schema.Array(ThreadSyncProposedPlan),
  activities: Schema.Array(ThreadSyncActivity),
});
export type ThreadSyncThreadSnapshot = typeof ThreadSyncThreadSnapshot.Type;

export const ThreadSyncConfiguration = Schema.Struct({
  remoteUrl: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
  fetchIntervalSeconds: PositiveInt,
});
export type ThreadSyncConfiguration = typeof ThreadSyncConfiguration.Type;

export const ThreadSyncRunState = Schema.Literals([
  "disconnected",
  "idle",
  "fetching",
  "pulling",
  "pushing",
  "error",
]);
export type ThreadSyncRunState = typeof ThreadSyncRunState.Type;

export const ThreadSyncConflict = Schema.Struct({
  threadId: ThreadId,
  syncProjectId: ThreadSyncProjectId,
  title: TrimmedNonEmptyString,
  baseRevision: Schema.NullOr(ThreadSyncRevision),
  localRevision: Schema.NullOr(ThreadSyncRevision),
  remoteRevision: ThreadSyncRevision,
});
export type ThreadSyncConflict = typeof ThreadSyncConflict.Type;

export const ThreadSyncUnlinkedProjectReason = Schema.Literals([
  "no-match",
  "ambiguous-match",
  "workspace-missing",
]);
export type ThreadSyncUnlinkedProjectReason = typeof ThreadSyncUnlinkedProjectReason.Type;

export const ThreadSyncUnlinkedProject = Schema.Struct({
  project: ThreadSyncProjectSnapshot,
  reason: ThreadSyncUnlinkedProjectReason,
  suggestedProjectId: Schema.NullOr(ProjectId),
});
export type ThreadSyncUnlinkedProject = typeof ThreadSyncUnlinkedProject.Type;

export const ThreadSyncStatus = Schema.Struct({
  state: ThreadSyncRunState,
  configuration: Schema.NullOr(ThreadSyncConfiguration),
  baseRevision: Schema.NullOr(ThreadSyncRevision),
  localRevision: Schema.NullOr(ThreadSyncRevision),
  remoteRevision: Schema.NullOr(ThreadSyncRevision),
  lastFetchedAt: Schema.NullOr(IsoDateTime),
  pendingPullCount: NonNegativeInt,
  pendingPushCount: NonNegativeInt,
  conflicts: Schema.Array(ThreadSyncConflict),
  unlinkedProjects: Schema.Array(ThreadSyncUnlinkedProject),
  lastError: Schema.NullOr(TrimmedNonEmptyString),
});
export type ThreadSyncStatus = typeof ThreadSyncStatus.Type;

export const ThreadSyncConfigureInput = ThreadSyncConfiguration;
export type ThreadSyncConfigureInput = typeof ThreadSyncConfigureInput.Type;

export const ThreadSyncConfigureResult = Schema.Struct({
  status: ThreadSyncStatus,
});
export type ThreadSyncConfigureResult = typeof ThreadSyncConfigureResult.Type;

export const ThreadSyncFetchInput = Schema.Struct({
  expectedRemoteRevision: Schema.NullOr(ThreadSyncRevision),
});
export type ThreadSyncFetchInput = typeof ThreadSyncFetchInput.Type;

export const ThreadSyncFetchResult = Schema.Struct({
  remoteChanged: Schema.Boolean,
  discoveredThreadCount: NonNegativeInt,
  status: ThreadSyncStatus,
});
export type ThreadSyncFetchResult = typeof ThreadSyncFetchResult.Type;

export const ThreadSyncLinkProjectInput = Schema.Struct({
  syncProjectId: ThreadSyncProjectId,
  projectId: ProjectId,
});
export type ThreadSyncLinkProjectInput = typeof ThreadSyncLinkProjectInput.Type;

export const ThreadSyncProjectBinding = Schema.Struct({
  syncProjectId: ThreadSyncProjectId,
  projectId: ProjectId,
  linkedAt: IsoDateTime,
});
export type ThreadSyncProjectBinding = typeof ThreadSyncProjectBinding.Type;

export const ThreadSyncLinkProjectResult = Schema.Struct({
  binding: ThreadSyncProjectBinding,
  status: ThreadSyncStatus,
});
export type ThreadSyncLinkProjectResult = typeof ThreadSyncLinkProjectResult.Type;

export const ThreadSyncDisconnectInput = Schema.Struct({
  removeLocalMirror: Schema.Boolean,
});
export type ThreadSyncDisconnectInput = typeof ThreadSyncDisconnectInput.Type;

export const ThreadSyncDisconnectResult = Schema.Struct({
  disconnected: Schema.Literal(true),
  status: ThreadSyncStatus,
});
export type ThreadSyncDisconnectResult = typeof ThreadSyncDisconnectResult.Type;

export const ThreadSyncPullResolution = Schema.Literals(["use-remote", "keep-both"]);
export type ThreadSyncPullResolution = typeof ThreadSyncPullResolution.Type;

export const ThreadSyncPullThreadStrategy = Schema.Struct({
  threadId: ThreadId,
  resolution: ThreadSyncPullResolution,
});
export type ThreadSyncPullThreadStrategy = typeof ThreadSyncPullThreadStrategy.Type;

export const ThreadSyncPullInput = Schema.Struct({
  expectedRemoteRevision: Schema.NullOr(ThreadSyncRevision),
  strategies: Schema.Array(ThreadSyncPullThreadStrategy),
});
export type ThreadSyncPullInput = typeof ThreadSyncPullInput.Type;

export const ThreadSyncThreadClone = Schema.Struct({
  sourceThreadId: ThreadId,
  clonedThreadId: ThreadId,
});
export type ThreadSyncThreadClone = typeof ThreadSyncThreadClone.Type;

export const ThreadSyncPullResult = Schema.Struct({
  remoteRevision: ThreadSyncRevision,
  appliedThreadIds: Schema.Array(ThreadId),
  keptBoth: Schema.Array(ThreadSyncThreadClone),
  skippedActiveThreadIds: Schema.Array(ThreadId),
  status: ThreadSyncStatus,
});
export type ThreadSyncPullResult = typeof ThreadSyncPullResult.Type;

export const ThreadSyncPushResolution = Schema.Literals([
  "pull-remote",
  "keep-both",
  "replace-remote",
]);
export type ThreadSyncPushResolution = typeof ThreadSyncPushResolution.Type;

export const ThreadSyncPushThreadStrategy = Schema.Struct({
  threadId: ThreadId,
  resolution: ThreadSyncPushResolution,
});
export type ThreadSyncPushThreadStrategy = typeof ThreadSyncPushThreadStrategy.Type;

export const ThreadSyncPushInput = Schema.Struct({
  expectedRemoteRevision: Schema.NullOr(ThreadSyncRevision),
  strategies: Schema.Array(ThreadSyncPushThreadStrategy),
});
export type ThreadSyncPushInput = typeof ThreadSyncPushInput.Type;

export const ThreadSyncPushResult = Schema.Struct({
  remoteRevision: ThreadSyncRevision,
  pushedThreadIds: Schema.Array(ThreadId),
  pulledThreadIds: Schema.Array(ThreadId),
  keptBoth: Schema.Array(ThreadSyncThreadClone),
  skippedActiveThreadIds: Schema.Array(ThreadId),
  status: ThreadSyncStatus,
});
export type ThreadSyncPushResult = typeof ThreadSyncPushResult.Type;

export const ThreadSyncOperation = Schema.Literals([
  "status",
  "configure",
  "fetch",
  "link-project",
  "disconnect",
  "pull",
  "push",
  "export",
  "import",
]);
export type ThreadSyncOperation = typeof ThreadSyncOperation.Type;

export const ThreadSyncErrorCode = Schema.Literals([
  "not-configured",
  "busy",
  "invalid-remote",
  "authentication-failed",
  "remote-unavailable",
  "remote-changed",
  "conflict",
  "invalid-snapshot",
  "unsupported-version",
  "project-unlinked",
  "thread-active",
  "integrity-failed",
  "git-failed",
  "io-failed",
  "unknown",
]);
export type ThreadSyncErrorCode = typeof ThreadSyncErrorCode.Type;

export class ThreadSyncError extends Schema.TaggedErrorClass<ThreadSyncError>()("ThreadSyncError", {
  operation: ThreadSyncOperation,
  code: ThreadSyncErrorCode,
  detail: TrimmedNonEmptyString,
}) {
  override get message(): string {
    return `Thread sync ${this.operation} failed (${this.code}): ${this.detail}`;
  }
}
