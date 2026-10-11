import * as NodeCrypto from "node:crypto";

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
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath, toSafeThreadAttachmentSegment } from "../attachmentStore.ts";
import {
  type ExclusiveFileOwnership,
  removeFileIfOwned,
  writeFileBytesExclusivelyAtomically,
} from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { subscribeBeforeSnapshot } from "../utils/subscribeBeforeSnapshot.ts";
import {
  canonicalThreadSyncPlanId,
  canonicalizeThreadSyncThreadSnapshot,
  decideThreadSyncThreeWay,
  emptyThreadSyncRepositoryDocuments,
  threadSyncRevision,
  type ThreadSyncRepositoryDocuments,
  type ThreadSyncThreeWayDecision,
} from "./ThreadSyncDocuments.ts";
import {
  readThreadSyncAttachmentForExport,
  type ThreadSyncAttachmentExportBudget,
} from "./ThreadSyncAttachmentIO.ts";
import { ThreadSyncGit } from "./ThreadSyncGit.ts";
import {
  readThreadSyncRepository,
  type ThreadSyncRepositoryWriteInput,
  writeThreadSyncRepository,
} from "./ThreadSyncRepository.ts";
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

interface ThreadSyncAnalysisEntry {
  readonly syncThreadId: ThreadId;
  readonly localThreadId: ThreadId | null;
  readonly syncProjectId: ThreadSyncProjectId;
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
    readonly projectId: ProjectId;
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
  readonly projectId: ProjectId;
  readonly sourceRevision: ThreadSyncRevision;
}

export interface ThreadSyncImportReferenceMaps {
  readonly threadIds: ReadonlyMap<ThreadId, ThreadId>;
  readonly projectIds: ReadonlyMap<ThreadId, ProjectId>;
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
  const projectIds = new Map<ThreadId, ProjectId>();
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
  readonly projectId: ProjectId;
  readonly importedTargets: ReadonlyMap<
    ThreadId,
    {
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
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
    const syncProjectId = input.syncProjectByLocal.get(thread.projectId);
    if (syncProjectId === undefined) return [];
    const current = currentBindingsByLocal.get(thread.id);
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

export function analyzeThreadSyncState(input: {
  readonly local: ExportedThreadSyncState;
  readonly remote: ThreadSyncRepositoryDocuments;
  readonly state: ThreadSyncLocalState;
  readonly runState?: ThreadSyncStatus["state"];
  readonly lastError?: string | null;
}): ThreadSyncAnalysis {
  const localBySyncId = input.local.threads;
  const remoteBySyncId = input.remote.threads;
  const bindingsBySyncId = new Map(
    input.local.threadBindings.map((binding) => [binding.syncThreadId, binding] as const),
  );
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

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
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
  const writeRepository = (input: ThreadSyncRepositoryWriteInput) =>
    provideIo(writeThreadSyncRepository(input));

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

  const exportLocal = Effect.fn("ThreadSyncService.exportLocal")(function* (
    state: ThreadSyncLocalState,
    authoritativeProjects: ReadonlyMap<ThreadSyncProjectId, ThreadSyncProjectSnapshot> = new Map(),
    authoritativeThreads: ReadonlyMap<string, ThreadSyncThreadSnapshot> = new Map(),
  ): Effect.fn.Return<ExportedThreadSyncState, ThreadSyncError> {
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
      existing: state.threadBindings,
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

  interface ImportSelection {
    readonly snapshot: ThreadSyncThreadSnapshot;
    readonly targetThreadId: ThreadId;
    readonly projectId: ProjectId;
    readonly mode: "create" | "replace";
    readonly expectedLocalUpdatedAt: IsoDateTime | null;
    readonly sourceRevision: ThreadSyncRevision;
    readonly bindingUpdates: ReadonlyArray<ThreadSyncBindingUpdate>;
  }

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
    const remote = yield* Ref.get(remoteRef);
    const analysis = yield* analyze(state, remote, runState, lastError);
    if (analysis.state !== state) yield* saveState(analysis.state);
    return analysis.status;
  });

  const runLocked = <A>(
    runState: ThreadSyncStatus["state"],
    operation: ThreadSyncError["operation"],
    effect: Effect.Effect<A, ThreadSyncError>,
    options: { readonly allowInvalidStateReset?: boolean } = {},
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
        const busy = yield* statusFromCurrent(runState).pipe(
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
    const checkedOut = yield* git.checkoutRemote(configuration, fetched.remoteRevision);
    const remote =
      checkedOut.remoteRevision === null
        ? emptyThreadSyncRepositoryDocuments()
        : yield* readRepository(checkedOut.mirrorPath);
    const now = DateTime.formatIso(yield* DateTime.now);
    let nextState: ThreadSyncLocalState = {
      ...state,
      remoteRevision: fetched.remoteRevision,
      lastFetchedAt: now,
    };
    const local = yield* exportLocal(nextState, remote.projects, remote.threads);
    nextState = autoLinkProjects(
      {
        ...nextState,
        projectBindings: local.projectBindings,
        threadBindings: local.threadBindings,
      },
      local,
      remote,
      now,
    );
    const analysis = yield* analyze(nextState, remote);
    return {
      remoteChanged,
      discoveredThreadCount: remote.threads.size,
      remote,
      analysis,
    };
  });

  const fetchUnlocked = Effect.fn("ThreadSyncService.fetchUnlocked")(function* (
    input: ThreadSyncFetchInput,
  ): Effect.fn.Return<ThreadSyncFetchResult, ThreadSyncError> {
    const state = yield* Ref.get(stateRef);
    const prepared = yield* prepareFetch(state, input);
    yield* saveState(prepared.analysis.state);
    yield* Ref.set(remoteRef, prepared.remote);
    yield* publish(prepared.analysis.status);
    return {
      remoteChanged: prepared.remoteChanged,
      discoveredThreadCount: prepared.discoveredThreadCount,
      status: prepared.analysis.status,
    };
  });

  const fetch: ThreadSyncServiceShape["fetch"] = (input) =>
    runLocked("fetching", "fetch", fetchUnlocked(input));

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
          expectedRemoteRevision: next.remoteRevision,
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
        yield* saveState(prepared.analysis.state, { resetInvalidLoadedState: true });
        yield* Ref.set(remoteRef, prepared.remote);
        yield* publish(prepared.analysis.status);
        if (!sameRemote && current.configuration !== null) {
          yield* git.removeMirror(current.configuration).pipe(
            Effect.catch((cleanupError) =>
              Effect.logWarning("Failed to clean the previous thread sync mirror.", {
                code: cleanupError.code,
              }),
            ),
          );
        }
        return { status: prepared.analysis.status };
      }),
      { allowInvalidStateReset: true },
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
        const snapshot = yield* snapshotQuery
          .getSnapshot()
          .pipe(Effect.mapError((cause) => syncError("link-project", "io-failed", String(cause))));
        if (
          !snapshot.projects.some(
            (project) => project.id === input.projectId && project.deletedAt === null,
          )
        ) {
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
        const analysis = yield* analyze(next, remote);
        yield* saveState(analysis.state);
        yield* publish(analysis.status);
        return { binding, status: analysis.status };
      }),
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
      if (projectBinding === undefined) continue;
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
          localProjectId: projectBinding.projectId,
        };
        selections.push({
          snapshot: entry.remote,
          targetThreadId: clonedThreadId,
          projectId: projectBinding.projectId,
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
        localProjectId: projectBinding.projectId,
      };
      selections.push({
        snapshot: entry.remote,
        targetThreadId,
        projectId: projectBinding.projectId,
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
        const remote = yield* readRepository(checkedOut.mirrorPath);
        const now = DateTime.formatIso(yield* DateTime.now);
        const fetchedState = {
          ...state,
          remoteRevision: checkedOut.remoteRevision,
          lastFetchedAt: now,
        };
        const analysis = yield* analyze(fetchedState, remote, "pulling");
        const resolved = yield* applyRemoteChanges({
          analysis,
          remote,
          sourceRevision: checkedOut.remoteRevision,
          strategies: new Map(
            input.strategies.map((strategy) => [strategy.threadId, strategy.resolution]),
          ),
          pushMode: false,
        });
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
    );

  const push: ThreadSyncServiceShape["push"] = (input) =>
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
        const remote =
          checkedOut.remoteRevision === null
            ? emptyThreadSyncRepositoryDocuments()
            : yield* readRepository(checkedOut.mirrorPath);
        const now = DateTime.formatIso(yield* DateTime.now);
        const fetchedState = {
          ...state,
          remoteRevision: checkedOut.remoteRevision,
          lastFetchedAt: now,
        };
        const initial = yield* analyze(fetchedState, remote, "pushing");
        const strategyMap = new Map(
          input.strategies.map((strategy) => [strategy.threadId, strategy.resolution]),
        );
        const sourceRevision = checkedOut.remoteRevision ?? ("empty-remote" as ThreadSyncRevision);
        const resolved = yield* applyRemoteChanges({
          analysis: initial,
          remote,
          sourceRevision,
          strategies: strategyMap,
          pushMode: true,
        });
        const local = yield* exportLocal(resolved.state, remote.projects, remote.threads);
        const finalProjects = new Map(remote.projects);
        const finalThreads = new Map(remote.threads);
        const finalBlobs = new Map(remote.blobs);
        for (const [id, project] of local.projects) finalProjects.set(id, project);
        const pushedThreadIds: ThreadId[] = [];
        for (const [id, thread] of local.threads) {
          const prior = remote.threads.get(id);
          if (prior === undefined || threadSyncRevision(prior) !== threadSyncRevision(thread)) {
            pushedThreadIds.push(
              local.threadBindings.find((binding) => binding.syncThreadId === id)?.localThreadId ??
                (id as ThreadId),
            );
          }
          finalThreads.set(id, thread);
        }
        for (const [hash, bytes] of local.blobs) finalBlobs.set(hash, bytes);
        yield* writeRepository({
          mirrorPath: checkedOut.mirrorPath,
          projects: finalProjects,
          threads: finalThreads,
          blobs: finalBlobs,
          updatedAt: now,
        });
        const nextRemoteRevision = yield* git.commitAndPush({
          configuration,
          expectedRemoteRevision: checkedOut.remoteRevision,
          message: `Sync ${pushedThreadIds.length} Erebus thread${pushedThreadIds.length === 1 ? "" : "s"}`,
        });
        const nextBindings = local.threadBindings.map((binding) => ({
          ...binding,
          baseRevision: local.threads.has(binding.syncThreadId)
            ? threadSyncRevision(local.threads.get(binding.syncThreadId)!)
            : binding.baseRevision,
        }));
        const nextState = {
          ...resolved.state,
          remoteRevision: nextRemoteRevision,
          lastFetchedAt: now,
          projectBindings: local.projectBindings,
          threadBindings: nextBindings,
        };
        const nextRemote: ThreadSyncRepositoryDocuments = {
          projects: finalProjects,
          threads: finalThreads,
          blobs: finalBlobs,
        };
        yield* Ref.set(remoteRef, nextRemote);
        const finalAnalysis = yield* analyze(nextState, nextRemote);
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
      }),
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
