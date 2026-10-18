import {
  EventId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type ProjectId,
  type ThreadSyncImportV2Descriptor,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import {
  listThreadsByProjectId,
  requireActiveProjectWorkspaceRootAbsent,
  requireProject,
  requireProjectAbsent,
  requireThread,
  requireThreadArchived,
  requireThreadAbsent,
  requireThreadNotArchived,
} from "./commandInvariants.ts";
import { projectEvent } from "./projector.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

// Session adoption takes seconds; a user message still unadopted after this
// window is a failed/stale start, not pending work. Mirrors the client's
// QUEUED_TURN_START_GRACE_MS in client-runtime threadSettled.ts.
const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;

/**
 * Blocked-on-you work derived from the thread's retained activities: an
 * approval or user-input request with no later resolution for the same
 * requestId. The server-side twin of the shell's hasPendingApprovals /
 * hasPendingUserInput flags, which the decider read model does not carry.
 * The clearing rules MUST match ProjectionPipeline's pending accounting —
 * resolved activities always clear, respond.failed clears only when the
 * failure detail marks the request stale/unknown — or settle would be
 * rejected on threads whose shell flags read as clear.
 */
function isStaleRequestFailureDetail(payload: Record<string, unknown> | null): boolean {
  const detail = typeof payload?.detail === "string" ? payload.detail.toLowerCase() : null;
  if (detail === null) return false;
  return (
    detail.includes("stale pending approval request") ||
    detail.includes("unknown pending approval request") ||
    detail.includes("unknown pending permission request") ||
    detail.includes("stale pending user-input request") ||
    detail.includes("unknown pending user-input request") ||
    detail.includes("unknown pending user input request") ||
    detail.includes("unknown pending codex user input request")
  );
}

// Scans the read model's activities, which the projector caps at the most
// recent 500. That bound is safe here: an OPEN approval/user-input request
// blocks its turn, so the thread cannot accumulate hundreds of later
// activities while one is outstanding — a request that has scrolled out of
// the window is one whose turn kept running, i.e. it was resolved or went
// stale. (The projection pipeline's pendingApprovalCount reads the same
// capped stream and stays consistent with this view.)
function hasOpenBlockingRequest(thread: {
  readonly activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>;
}): boolean {
  const openRequestIds = new Set<string>();
  for (const activity of thread.activities) {
    const payload =
      typeof activity.payload === "object" && activity.payload !== null
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : null;
    if (requestId === null) continue;
    if (activity.kind === "approval.requested" || activity.kind === "user-input.requested") {
      openRequestIds.add(requestId);
    } else if (activity.kind === "approval.resolved" || activity.kind === "user-input.resolved") {
      openRequestIds.delete(requestId);
    } else if (
      (activity.kind === "provider.approval.respond.failed" ||
        activity.kind === "provider.user-input.respond.failed") &&
      isStaleRequestFailureDetail(payload)
    ) {
      openRequestIds.delete(requestId);
    }
  }
  return openRequestIds.size > 0;
}

/**
 * A queued turn start — a user message no turn has picked up yet — is work
 * in flight even though session is still null (turn.start emits
 * message-sent + turn-start-requested; the session arrives later). Detection
 * mirrors the client's hasQueuedTurnStart: the newest user message is
 * strictly newer than every latestTurn timestamp (adoption stamps the new
 * turn's requestedAt with the message time, clearing this), and only within
 * the adoption grace window — historical threads whose last user message
 * postdates their turn timestamps (older-server data, mid-turn messages)
 * must not be blocked forever. A failed session start (status "error")
 * clears the block immediately.
 *
 * The age check is bounded on BOTH sides: message timestamps are
 * client-supplied, so a client clock ahead of the server yields a negative
 * age. Without the lower bound that negative age satisfies `<= grace` for
 * as long as the skew lasts, extending the block far past the intended two
 * minutes.
 */
function threadHasQueuedTurnStart(
  thread: {
    readonly messages: ReadonlyArray<{ readonly role: string; readonly createdAt: string }>;
    readonly latestTurn: {
      readonly requestedAt: string;
      readonly startedAt: string | null;
      readonly completedAt: string | null;
    } | null;
    readonly session: { readonly status: string } | null;
  },
  occurredAt: string,
): boolean {
  const latestUserMessageAtMs = thread.messages.reduce(
    (latest, message) =>
      message.role === "user" ? Math.max(latest, Date.parse(message.createdAt)) : latest,
    Number.NEGATIVE_INFINITY,
  );
  const latestTurnAtMs =
    thread.latestTurn === null
      ? Number.NEGATIVE_INFINITY
      : Math.max(
          ...[
            thread.latestTurn.requestedAt,
            thread.latestTurn.startedAt,
            thread.latestTurn.completedAt,
          ].map((candidate) =>
            candidate == null ? Number.NEGATIVE_INFINITY : Date.parse(candidate),
          ),
        );
  const queuedAgeMs = Date.parse(occurredAt) - latestUserMessageAtMs;
  return (
    thread.session?.status !== "error" &&
    Number.isFinite(latestUserMessageAtMs) &&
    latestUserMessageAtMs > latestTurnAtMs &&
    Math.abs(queuedAgeMs) <= QUEUED_TURN_START_GRACE_MS
  );
}

function threadBlocksSyncImport(thread: OrchestrationThread, occurredAt: string): boolean {
  return (
    thread.session?.status === "starting" ||
    thread.session?.status === "running" ||
    thread.session?.activeTurnId != null ||
    thread.latestTurn?.state === "running" ||
    thread.messages.some((message) => message.streaming) ||
    thread.titleRegeneration != null ||
    hasOpenBlockingRequest(thread) ||
    threadHasQueuedTurnStart(thread, occurredAt)
  );
}

function firstDuplicate(values: ReadonlyArray<string>): string | null {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return null;
}

const validateThreadSyncImportV2Descriptor = Effect.fn("validateThreadSyncImportV2Descriptor")(
  function* (input: {
    readonly commandType: string;
    readonly descriptor: ThreadSyncImportV2Descriptor;
    readonly readModel: OrchestrationReadModel;
    readonly occurredAt: string;
  }) {
    const { descriptor } = input;
    if (descriptor.projectId !== null) {
      const project = input.readModel.projects.find((entry) => entry.id === descriptor.projectId);
      if (project === undefined || project.deletedAt !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: input.commandType,
          detail: `Project '${descriptor.projectId}' cannot receive imported threads.`,
        });
      }
    }

    const targetBindings = descriptor.bindingUpdates.filter(
      (binding) => binding.localThreadId === descriptor.threadId,
    );
    if (targetBindings.length !== 1 || targetBindings[0]?.localProjectId !== descriptor.projectId) {
      return yield* new OrchestrationCommandInvariantError({
        commandType: input.commandType,
        detail: `Imported thread '${descriptor.threadId}' requires one matching target binding.`,
      });
    }
    if (
      firstDuplicate(descriptor.bindingUpdates.map((binding) => binding.syncThreadId)) !== null ||
      firstDuplicate(descriptor.bindingUpdates.map((binding) => binding.localThreadId)) !== null
    ) {
      return yield* new OrchestrationCommandInvariantError({
        commandType: input.commandType,
        detail: "sync import bindings must be unique",
      });
    }
    const localProjectBySyncProject = new Map<string, ProjectId>();
    const syncProjectByLocalProject = new Map<ProjectId, string>();
    for (const binding of descriptor.bindingUpdates) {
      if (binding.syncProjectId === null || binding.localProjectId === null) continue;
      const mappedLocalProject = localProjectBySyncProject.get(binding.syncProjectId);
      const mappedSyncProject = syncProjectByLocalProject.get(binding.localProjectId);
      if (
        (mappedLocalProject !== undefined && mappedLocalProject !== binding.localProjectId) ||
        (mappedSyncProject !== undefined && mappedSyncProject !== binding.syncProjectId)
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: input.commandType,
          detail: "sync import bindings must preserve a one-to-one project mapping",
        });
      }
      localProjectBySyncProject.set(binding.syncProjectId, binding.localProjectId);
      syncProjectByLocalProject.set(binding.localProjectId, binding.syncProjectId);
    }
    for (const binding of descriptor.bindingUpdates) {
      if (binding.localThreadId === descriptor.threadId) continue;
      const preserved = input.readModel.threads.find(
        (thread) => thread.id === binding.localThreadId,
      );
      if (
        preserved === undefined ||
        preserved.projectId !== binding.localProjectId ||
        preserved.deletedAt !== null
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: input.commandType,
          detail: `Imported thread '${descriptor.threadId}' references an invalid preserved local binding.`,
        });
      }
    }

    const existing = input.readModel.threads.find((thread) => thread.id === descriptor.threadId);
    if (descriptor.mode === "create") {
      if (
        existing !== undefined ||
        descriptor.expectedLocalUpdatedAt !== null ||
        descriptor.localState === undefined
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: input.commandType,
          detail: `New imported thread '${descriptor.threadId}' requires an absent target, localState, and null expectedLocalUpdatedAt.`,
        });
      }
    } else {
      if (
        existing === undefined ||
        descriptor.expectedLocalUpdatedAt === null ||
        descriptor.expectedLocalUpdatedAt !== existing.updatedAt
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: input.commandType,
          detail: `Thread '${descriptor.threadId}' changed after sync conflict resolution.`,
        });
      }
      if (threadBlocksSyncImport(existing, input.occurredAt)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: input.commandType,
          detail: `Thread '${descriptor.threadId}' is active and cannot be replaced by sync.`,
        });
      }
    }

    return existing ?? null;
  },
);

function withEventBase(
  input: Pick<OrchestrationCommand, "commandId"> & {
    readonly aggregateKind: OrchestrationEvent["aggregateKind"];
    readonly aggregateId: OrchestrationEvent["aggregateId"];
    readonly occurredAt: string;
    readonly metadata?: OrchestrationEvent["metadata"];
  },
): Effect.Effect<
  Omit<OrchestrationEvent, "sequence" | "type" | "payload">,
  PlatformError.PlatformError,
  Crypto.Crypto
> {
  return Crypto.Crypto.pipe(
    Effect.flatMap((crypto) =>
      crypto.randomUUIDv4.pipe(
        Effect.map((eventId) => ({
          eventId: EventId.make(eventId),
          aggregateKind: input.aggregateKind,
          aggregateId: input.aggregateId,
          occurredAt: input.occurredAt,
          commandId: input.commandId,
          causationEventId: null,
          correlationId: input.commandId,
          metadata: input.metadata ?? {},
        })),
      ),
    ),
  );
}

type PlannedOrchestrationEvent = Omit<OrchestrationEvent, "sequence">;

type DecideOrchestrationCommandResult =
  | PlannedOrchestrationEvent
  | ReadonlyArray<PlannedOrchestrationEvent>;

const decideCommandSequence = Effect.fn("decideCommandSequence")(function* ({
  commands,
  readModel,
}: {
  readonly commands: ReadonlyArray<OrchestrationCommand>;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  ReadonlyArray<PlannedOrchestrationEvent>,
  OrchestrationCommandInvariantError | PlatformError.PlatformError,
  Crypto.Crypto
> {
  let nextReadModel = readModel;
  let nextSequence = readModel.snapshotSequence;
  const plannedEvents: PlannedOrchestrationEvent[] = [];

  for (const nextCommand of commands) {
    const decided = yield* decideOrchestrationCommand({
      command: nextCommand,
      readModel: nextReadModel,
    });
    const nextEvents = Array.isArray(decided) ? decided : [decided];
    for (const nextEvent of nextEvents) {
      plannedEvents.push(nextEvent);
      nextSequence += 1;
      nextReadModel = yield* projectEvent(nextReadModel, {
        ...nextEvent,
        sequence: nextSequence,
      }).pipe(Effect.orDie);
    }
  }

  return plannedEvents;
});

export const decideOrchestrationCommand = Effect.fn("decideOrchestrationCommand")(function* ({
  command,
  readModel,
}: {
  readonly command: OrchestrationCommand;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  DecideOrchestrationCommandResult,
  OrchestrationCommandInvariantError | PlatformError.PlatformError,
  Crypto.Crypto
> {
  switch (command.type) {
    case "project.create": {
      yield* requireProjectAbsent({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireActiveProjectWorkspaceRootAbsent({
        readModel,
        command,
        workspaceRoot: command.workspaceRoot,
        exceptProjectId: command.projectId,
      });

      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "project.created",
        payload: {
          projectId: command.projectId,
          title: command.title,
          workspaceRoot: command.workspaceRoot,
          defaultModelSelection: command.defaultModelSelection ?? null,
          faviconPath: null,
          scripts: [],
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "project.meta.update": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      if (command.workspaceRoot !== undefined) {
        yield* requireActiveProjectWorkspaceRootAbsent({
          readModel,
          command,
          workspaceRoot: command.workspaceRoot,
          exceptProjectId: command.projectId,
        });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "project.meta-updated",
        payload: {
          projectId: command.projectId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.workspaceRoot !== undefined ? { workspaceRoot: command.workspaceRoot } : {}),
          ...(command.defaultModelSelection !== undefined
            ? { defaultModelSelection: command.defaultModelSelection }
            : {}),
          ...(command.defaultThreadEnvMode !== undefined
            ? { defaultThreadEnvMode: command.defaultThreadEnvMode }
            : {}),
          ...(command.faviconPath !== undefined ? { faviconPath: command.faviconPath } : {}),
          ...(command.scripts !== undefined ? { scripts: command.scripts } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "project.delete": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const activeThreads = listThreadsByProjectId(readModel, command.projectId).filter(
        (thread) => thread.deletedAt === null,
      );
      if (activeThreads.length > 0 && command.force !== true) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Project '${command.projectId}' is not empty and cannot be deleted without force=true.`,
        });
      }
      if (activeThreads.length > 0) {
        return yield* decideCommandSequence({
          readModel,
          commands: [
            ...activeThreads.map(
              (thread): Extract<OrchestrationCommand, { type: "thread.delete" }> => ({
                type: "thread.delete",
                commandId: command.commandId,
                threadId: thread.id,
              }),
            ),
            {
              type: "project.delete",
              commandId: command.commandId,
              projectId: command.projectId,
            },
          ],
        });
      }

      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "project.deleted" as const,
        payload: {
          projectId: command.projectId,
          deletedAt: occurredAt,
        },
      };
    }

    case "thread.create": {
      if (command.projectId !== null) {
        yield* requireProject({
          readModel,
          command,
          projectId: command.projectId,
        });
      }
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.created",
        payload: {
          threadId: command.threadId,
          projectId: command.projectId,
          title: command.title,
          modelSelection: command.modelSelection,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          branch: command.branch,
          worktreePath: command.worktreePath,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.sync.import-v2.start": {
      if (command.descriptor.stagedHash !== undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "A staged import cannot declare its final hash before all chunks arrive.",
        });
      }
      yield* validateThreadSyncImportV2Descriptor({
        commandType: command.type,
        descriptor: command.descriptor,
        readModel,
        occurredAt: command.startedAt,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.descriptor.threadId,
          occurredAt: command.startedAt,
          commandId: command.commandId,
        })),
        type: "thread.sync-import-v2.started",
        payload: {
          descriptor: command.descriptor,
          startedAt: command.startedAt,
        },
      };
    }

    case "thread.sync.import-v2.chunk": {
      const ordinals = command.records.map((record) => record.ordinal);
      const duplicateOrdinal = firstDuplicate(ordinals.map(String));
      const outOfOrder = ordinals.some(
        (ordinal, index) => index > 0 && ordinal !== ordinals[index - 1]! + 1,
      );
      if (duplicateOrdinal !== null || outOfOrder) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Staged import chunk for '${command.threadId}' must contain unique contiguous ordinals.`,
        });
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.appendedAt,
          commandId: command.commandId,
        })),
        type: "thread.sync-import-v2.chunk-appended",
        payload: {
          stageId: command.stageId,
          threadId: command.threadId,
          chunkIndex: command.chunkIndex,
          chunkHash: command.chunkHash,
          firstOrdinal: ordinals[0]!,
          lastOrdinal: ordinals.at(-1)!,
          recordCount: command.records.length,
          appendedAt: command.appendedAt,
        },
      };
    }

    case "thread.sync.import-v2.validate":
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.descriptor.threadId,
          occurredAt: command.validatedAt,
          commandId: command.commandId,
        })),
        type: "thread.sync-import-v2.validated",
        payload: {
          stageId: command.descriptor.stageId,
          threadId: command.descriptor.threadId,
          recordCount: command.descriptor.recordCount,
          descriptorHash: command.descriptorHash,
          stagedHash: command.stagedHash,
          validatedAt: command.validatedAt,
        },
      };

    case "thread.sync.import-v2.commit": {
      const existing = yield* validateThreadSyncImportV2Descriptor({
        commandType: command.type,
        descriptor: command.descriptor,
        readModel,
        occurredAt: command.importedAt,
      });
      const { descriptor, visibleHistory } = command;
      if (descriptor.stagedHash === undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Staged import '${descriptor.stageId}' requires a final staged hash.`,
        });
      }
      if (
        (descriptor.header.latestTurnId === null) !== (visibleHistory.latestTurn === null) ||
        (descriptor.header.latestTurnId !== null &&
          visibleHistory.latestTurn?.turnId !== descriptor.header.latestTurnId)
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Staged import '${descriptor.stageId}' does not carry its declared latest turn.`,
        });
      }
      const duplicateVisibleId =
        firstDuplicate(visibleHistory.messages.map((message) => message.id)) ??
        firstDuplicate(visibleHistory.proposedPlans.map((plan) => plan.id)) ??
        firstDuplicate(visibleHistory.activities.map((activity) => activity.id));
      if (duplicateVisibleId !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Staged import '${descriptor.stageId}' has duplicate visible history id '${duplicateVisibleId}'.`,
        });
      }

      const keepsProjectRuntime = existing?.projectId === descriptor.projectId;
      const localState =
        existing === null
          ? descriptor.localState!
          : {
              modelSelection: existing.modelSelection,
              runtimeMode: existing.runtimeMode,
              interactionMode: existing.interactionMode,
              branch: keepsProjectRuntime ? existing.branch : null,
              worktreePath: keepsProjectRuntime ? existing.worktreePath : null,
              linkedPullRequest: keepsProjectRuntime ? (existing.linkedPullRequest ?? null) : null,
            };
      const requestedCoagent = descriptor.header.coagent;
      const parent =
        requestedCoagent === null
          ? undefined
          : readModel.threads.find((thread) => thread.id === requestedCoagent.parentThreadId);
      const coagent =
        requestedCoagent !== null &&
        requestedCoagent.parentThreadId !== descriptor.threadId &&
        parent !== undefined &&
        parent.projectId === descriptor.projectId &&
        parent.deletedAt === null
          ? requestedCoagent
          : null;
      const latestTurn = visibleHistory.latestTurn;
      const materializedThread: OrchestrationThread = {
        id: descriptor.threadId,
        projectId: descriptor.projectId,
        title: descriptor.header.title,
        coagent,
        modelSelection: localState.modelSelection,
        runtimeMode: localState.runtimeMode,
        interactionMode: localState.interactionMode,
        branch: localState.branch,
        worktreePath: localState.worktreePath,
        linkedPullRequest: localState.linkedPullRequest,
        latestTurn:
          latestTurn === null
            ? null
            : {
                turnId: latestTurn.turnId,
                state: latestTurn.state,
                requestedAt: latestTurn.requestedAt,
                startedAt: latestTurn.startedAt,
                completedAt: latestTurn.completedAt,
                assistantMessageId: latestTurn.assistantMessageId,
                ...(latestTurn.sourceProposedPlanThreadId !== null &&
                latestTurn.sourceProposedPlanId !== null
                  ? {
                      sourceProposedPlan: {
                        threadId: latestTurn.sourceProposedPlanThreadId,
                        planId: latestTurn.sourceProposedPlanId,
                      },
                    }
                  : {}),
              },
        createdAt: descriptor.header.createdAt,
        updatedAt: descriptor.header.updatedAt,
        archivedAt: descriptor.header.lifecycle.archivedAt,
        settledOverride: descriptor.header.lifecycle.settledOverride,
        settledAt: descriptor.header.lifecycle.settledAt,
        unsettledAt: existing?.unsettledAt ?? null,
        snoozedUntil: existing?.snoozedUntil ?? null,
        snoozedAt: existing?.snoozedAt ?? null,
        pinnedAt: existing?.pinnedAt ?? null,
        pinOrderKey: existing?.pinOrderKey ?? null,
        titleRegeneration: null,
        deletedAt: descriptor.header.lifecycle.deletedAt,
        messages: visibleHistory.messages.map((message) => ({ ...message })),
        proposedPlans: visibleHistory.proposedPlans.map((plan) => ({ ...plan })),
        activities: visibleHistory.activities.map((activity) => ({
          ...activity,
          payload: null,
        })),
        checkpoints: [],
        session: null,
      };

      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: descriptor.threadId,
          occurredAt: command.importedAt,
          commandId: command.commandId,
        })),
        type: "thread.sync-imported",
        payload: {
          threadId: descriptor.threadId,
          sourceRevision: descriptor.sourceRevision,
          sourceHash: descriptor.sourceHash,
          importedAt: command.importedAt,
          thread: materializedThread,
          turns: [],
          bindingUpdates: descriptor.bindingUpdates,
          stagedImport: {
            stageId: descriptor.stageId,
            recordCount: descriptor.recordCount,
            stagedHash: descriptor.stagedHash,
          },
        },
      };
    }

    case "thread.sync.import-batch": {
      const duplicateThreadId = firstDuplicate(command.imports.map((entry) => entry.threadId));
      if (duplicateThreadId !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `imports must not contain duplicate target thread '${duplicateThreadId}'`,
        });
      }
      const bindingUpdates = command.imports.flatMap((entry) => entry.bindingUpdates);
      const duplicateSyncBinding = firstDuplicate(
        bindingUpdates.map((binding) => binding.syncThreadId),
      );
      const duplicateLocalBinding = firstDuplicate(
        bindingUpdates.map((binding) => binding.localThreadId),
      );
      if (duplicateSyncBinding !== null || duplicateLocalBinding !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "sync imports must not contain duplicate portable or local thread bindings",
        });
      }
      const localProjectBySyncProject = new Map<string, ProjectId>();
      const syncProjectByLocalProject = new Map<ProjectId, string>();
      for (const binding of bindingUpdates) {
        if (binding.syncProjectId === null || binding.localProjectId === null) continue;
        const mappedLocalProject = localProjectBySyncProject.get(binding.syncProjectId);
        const mappedSyncProject = syncProjectByLocalProject.get(binding.localProjectId);
        if (
          (mappedLocalProject !== undefined && mappedLocalProject !== binding.localProjectId) ||
          (mappedSyncProject !== undefined && mappedSyncProject !== binding.syncProjectId)
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "sync imports must preserve a one-to-one portable and local project mapping",
          });
        }
        localProjectBySyncProject.set(binding.syncProjectId, binding.localProjectId);
        syncProjectByLocalProject.set(binding.localProjectId, binding.syncProjectId);
      }

      const importedTargets = new Map(
        command.imports.map(
          (entry) =>
            [
              entry.threadId,
              {
                projectId: entry.projectId,
                deletedAt: entry.history.deletedAt,
              },
            ] as const,
        ),
      );
      const importsByThreadId = new Map(
        command.imports.map((entry) => [entry.threadId, entry] as const),
      );

      let nextReadModel = readModel;
      const plannedEvents: PlannedOrchestrationEvent[] = [];

      for (const imported of command.imports) {
        if (imported.projectId !== null) {
          const project = yield* requireProject({
            readModel: nextReadModel,
            command,
            projectId: imported.projectId,
          });
          if (project.deletedAt !== null) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: `Project '${imported.projectId}' is deleted and cannot receive imported threads.`,
            });
          }
        }

        const targetBindings = imported.bindingUpdates.filter(
          (binding) => binding.localThreadId === imported.threadId,
        );
        if (targetBindings.length !== 1) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Imported thread '${imported.threadId}' requires exactly one target binding.`,
          });
        }
        const targetBinding = targetBindings[0]!;
        if (targetBinding.localProjectId !== imported.projectId) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Imported thread '${imported.threadId}' target binding does not match its local project.`,
          });
        }
        for (const binding of imported.bindingUpdates) {
          if (binding.localThreadId === imported.threadId) continue;
          const boundThread = nextReadModel.threads.find(
            (thread) => thread.id === binding.localThreadId,
          );
          if (
            boundThread === undefined ||
            boundThread.projectId !== binding.localProjectId ||
            boundThread.deletedAt !== null
          ) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: `Imported thread '${imported.threadId}' references an invalid preserved local binding.`,
            });
          }
        }

        const existing = nextReadModel.threads.find((thread) => thread.id === imported.threadId);
        if (imported.mode === "create") {
          if (existing !== undefined) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: `Thread '${imported.threadId}' already exists and cannot be imported as new.`,
            });
          }
          if (imported.expectedLocalUpdatedAt !== null || imported.localState === undefined) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: `New imported thread '${imported.threadId}' requires localState and a null expectedLocalUpdatedAt.`,
            });
          }
        } else {
          if (existing === undefined) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: `Thread '${imported.threadId}' does not exist and cannot be replaced.`,
            });
          }
          if (
            imported.expectedLocalUpdatedAt === null ||
            imported.expectedLocalUpdatedAt !== existing.updatedAt
          ) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: `Thread '${imported.threadId}' changed after sync conflict resolution.`,
            });
          }
          if (threadBlocksSyncImport(existing, command.importedAt)) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: `Thread '${imported.threadId}' is active and cannot be replaced by sync.`,
            });
          }
        }

        const duplicateMessageId = firstDuplicate(
          imported.history.messages.map((message) => message.id),
        );
        const duplicatePlanId = firstDuplicate(
          imported.history.proposedPlans.map((plan) => plan.id),
        );
        const duplicateActivityId = firstDuplicate(
          imported.history.activities.map((activity) => activity.id),
        );
        const duplicateTurnId = firstDuplicate(imported.history.turns.map((turn) => turn.turnId));
        const duplicate =
          duplicateMessageId ?? duplicatePlanId ?? duplicateActivityId ?? duplicateTurnId;
        if (duplicate !== null) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Imported thread '${imported.threadId}' contains duplicate history id '${duplicate}'.`,
          });
        }

        const turnsById = new Map(
          imported.history.turns.map((turn) => [turn.turnId, turn] as const),
        );
        const messagesById = new Map(
          imported.history.messages.map((message) => [message.id, message] as const),
        );
        const missingTurnReference = [
          ...imported.history.messages.map((message) => message.turnId),
          ...imported.history.proposedPlans.map((plan) => plan.turnId),
          ...imported.history.activities.map((activity) => activity.turnId),
        ].find((turnId) => turnId !== null && !turnsById.has(turnId));
        if (missingTurnReference !== undefined) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Imported thread '${imported.threadId}' references missing turn '${missingTurnReference}'.`,
          });
        }

        for (const turn of imported.history.turns) {
          const pendingMessage =
            turn.pendingMessageId === null ? undefined : messagesById.get(turn.pendingMessageId);
          const assistantMessage =
            turn.assistantMessageId === null
              ? undefined
              : messagesById.get(turn.assistantMessageId);
          const hasSourceThread = turn.sourceProposedPlanThreadId !== null;
          const hasSourcePlan = turn.sourceProposedPlanId !== null;
          const sourceImport =
            turn.sourceProposedPlanThreadId === null
              ? undefined
              : importsByThreadId.get(turn.sourceProposedPlanThreadId);
          const sourceThread =
            turn.sourceProposedPlanThreadId === null
              ? undefined
              : nextReadModel.threads.find(
                  (thread) => thread.id === turn.sourceProposedPlanThreadId,
                );
          const sourcePlanExists =
            turn.sourceProposedPlanId === null
              ? !hasSourceThread
              : (sourceImport?.history.proposedPlans.some(
                  (plan) => plan.id === turn.sourceProposedPlanId,
                ) ??
                sourceThread?.proposedPlans.some((plan) => plan.id === turn.sourceProposedPlanId) ??
                false);
          const sourceProjectMatches =
            !hasSourceThread && !hasSourcePlan
              ? true
              : (sourceImport?.projectId ?? sourceThread?.projectId) === imported.projectId;
          if (
            (turn.pendingMessageId !== null && pendingMessage?.role !== "user") ||
            (turn.assistantMessageId !== null && assistantMessage?.role !== "assistant") ||
            hasSourceThread !== hasSourcePlan ||
            !sourcePlanExists ||
            !sourceProjectMatches
          ) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: `Imported thread '${imported.threadId}' contains an invalid turn reference for '${turn.turnId}'.`,
            });
          }
        }
        for (const plan of imported.history.proposedPlans) {
          const importedImplementation =
            plan.implementationThreadId === null
              ? undefined
              : importedTargets.get(plan.implementationThreadId);
          const existingImplementation =
            plan.implementationThreadId === null
              ? undefined
              : nextReadModel.threads.find((thread) => thread.id === plan.implementationThreadId);
          if (
            plan.implementationThreadId !== null &&
            (importedImplementation ?? existingImplementation) === undefined
          ) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: `Imported plan '${plan.id}' references missing implementation thread '${plan.implementationThreadId}'.`,
            });
          }
          if (
            plan.implementationThreadId !== null &&
            (importedImplementation?.projectId ?? existingImplementation?.projectId) !==
              imported.projectId
          ) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: `Imported plan '${plan.id}' references an implementation thread outside its project.`,
            });
          }
        }

        const latestTurn =
          imported.history.latestTurnId === null
            ? null
            : (turnsById.get(imported.history.latestTurnId) ?? null);
        if (imported.history.latestTurnId !== null && latestTurn === null) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Imported thread '${imported.threadId}' has an unknown latestTurnId.`,
          });
        }

        const keepsProjectRuntime = existing?.projectId === imported.projectId;
        const localState =
          existing === undefined
            ? imported.localState!
            : {
                modelSelection: existing.modelSelection,
                runtimeMode: existing.runtimeMode,
                interactionMode: existing.interactionMode,
                branch: keepsProjectRuntime ? existing.branch : null,
                worktreePath: keepsProjectRuntime ? existing.worktreePath : null,
                linkedPullRequest: keepsProjectRuntime
                  ? (existing.linkedPullRequest ?? null)
                  : null,
              };
        const requestedCoagent = imported.history.coagent ?? null;
        const importedParent =
          requestedCoagent === null
            ? undefined
            : importedTargets.get(requestedCoagent.parentThreadId);
        const existingParent =
          requestedCoagent === null
            ? undefined
            : nextReadModel.threads.find((thread) => thread.id === requestedCoagent.parentThreadId);
        const hasValidParent =
          requestedCoagent !== null &&
          requestedCoagent.parentThreadId !== imported.threadId &&
          ((importedParent !== undefined &&
            importedParent.projectId === imported.projectId &&
            importedParent.deletedAt === null) ||
            (importedParent === undefined &&
              existingParent !== undefined &&
              existingParent.projectId === imported.projectId &&
              existingParent.deletedAt === null));
        const materializedThread: OrchestrationThread = {
          id: imported.threadId,
          projectId: imported.projectId,
          title: imported.history.title,
          coagent: hasValidParent ? requestedCoagent : null,
          modelSelection: localState.modelSelection,
          runtimeMode: localState.runtimeMode,
          interactionMode: localState.interactionMode,
          branch: localState.branch,
          worktreePath: localState.worktreePath,
          linkedPullRequest: localState.linkedPullRequest,
          latestTurn:
            latestTurn === null
              ? null
              : {
                  turnId: latestTurn.turnId,
                  state: latestTurn.state,
                  requestedAt: latestTurn.requestedAt,
                  startedAt: latestTurn.startedAt,
                  completedAt: latestTurn.completedAt,
                  assistantMessageId: latestTurn.assistantMessageId,
                  ...(latestTurn.sourceProposedPlanThreadId !== null &&
                  latestTurn.sourceProposedPlanId !== null
                    ? {
                        sourceProposedPlan: {
                          threadId: latestTurn.sourceProposedPlanThreadId,
                          planId: latestTurn.sourceProposedPlanId,
                        },
                      }
                    : {}),
                },
          createdAt: imported.history.createdAt,
          updatedAt: imported.history.updatedAt,
          archivedAt: imported.history.archivedAt,
          settledOverride: imported.history.settledOverride,
          settledAt: imported.history.settledAt,
          unsettledAt: existing?.unsettledAt ?? null,
          snoozedUntil: existing?.snoozedUntil ?? null,
          snoozedAt: existing?.snoozedAt ?? null,
          pinnedAt: existing?.pinnedAt ?? null,
          pinOrderKey: existing?.pinOrderKey ?? null,
          titleRegeneration: null,
          deletedAt: imported.history.deletedAt,
          messages: imported.history.messages.map((message) => ({ ...message })),
          proposedPlans: imported.history.proposedPlans.map((plan) => ({ ...plan })),
          activities: imported.history.activities.map((activity) => ({
            ...activity,
            payload: null,
          })),
          checkpoints: [],
          session: null,
        };
        const nextEvent: PlannedOrchestrationEvent = {
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: imported.threadId,
            occurredAt: command.importedAt,
            commandId: command.commandId,
          })),
          type: "thread.sync-imported",
          payload: {
            threadId: imported.threadId,
            sourceRevision: imported.sourceRevision,
            sourceHash: imported.sourceHash,
            importedAt: command.importedAt,
            thread: materializedThread,
            turns: imported.history.turns,
            bindingUpdates: imported.bindingUpdates,
          },
        };
        plannedEvents.push(nextEvent);
        nextReadModel = yield* projectEvent(nextReadModel, {
          ...nextEvent,
          sequence: nextReadModel.snapshotSequence + 1,
        } as OrchestrationEvent).pipe(Effect.orDie);
      }

      return plannedEvents;
    }

    case "thread.delete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.deleted",
        payload: {
          threadId: command.threadId,
          deletedAt: occurredAt,
        },
      };
    }

    case "thread.archived.delete-all": {
      if (new Set(command.threadIds).size !== command.threadIds.length) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "threadIds must not contain duplicates.",
        });
      }
      for (const threadId of command.threadIds) {
        yield* requireThreadArchived({
          readModel,
          command,
          threadId,
        });
      }
      return yield* decideCommandSequence({
        readModel,
        commands: command.threadIds.map(
          (threadId): Extract<OrchestrationCommand, { type: "thread.delete" }> => ({
            type: "thread.delete",
            commandId: command.commandId,
            threadId,
          }),
        ),
      });
    }

    case "thread.archive": {
      yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.archived",
        payload: {
          threadId: command.threadId,
          archivedAt: occurredAt,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.unarchive": {
      yield* requireThreadArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.unarchived",
        payload: {
          threadId: command.threadId,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.settle": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Server-side twin of the client's canSettle session check: a stale
      // or raced client must not settle a thread whose session is coming
      // alive or working.
      if (thread.session?.status === "starting" || thread.session?.status === "running") {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} has an active session and cannot be settled`,
          }),
        );
      }
      // Pending approval / user-input requests are blocked-on-you work: a
      // raced or stale client must not park them behind a settled override
      // that would surface only after the request resolves.
      if (hasOpenBlockingRequest(thread)) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} has a pending approval or user-input request and cannot be settled`,
          }),
        );
      }
      const occurredAt = yield* nowIso;
      // Settling inside the adoption window would hide just-requested work.
      if (threadHasQueuedTurnStart(thread, occurredAt)) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} has a queued turn start and cannot be settled`,
          }),
        );
      }
      // Settling an already-settled thread re-emits with the original
      // settledAt: the engine rejects zero-event commands, and bulk-settle /
      // double-click must stay silent no-ops rather than surface errors.
      const alreadySettled = thread.settledOverride === "settled" && thread.settledAt !== null;
      const settledEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.settled" as const,
        payload: {
          threadId: command.threadId,
          settledAt: alreadySettled ? thread.settledAt : occurredAt,
          // A re-emission is a projected no-op: keep the existing updatedAt
          // so duplicate settles neither rewind nor churn ordering. A fresh
          // settle stamps the command time.
          updatedAt: alreadySettled ? thread.updatedAt : occurredAt,
        },
      };
      // Settling is "I'm done with this": clear states that would keep the
      // row pinned or snoozed instead of showing the new settled state.
      const companionEvents: Array<Omit<OrchestrationEvent, "sequence">> = [];
      if (thread.pinnedAt != null) {
        companionEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.unpinned" as const,
          payload: {
            threadId: command.threadId,
            updatedAt: occurredAt,
          },
        });
      }
      if (thread.snoozedUntil != null) {
        companionEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.unsnoozed",
          payload: {
            threadId: command.threadId,
            reason: "user",
            updatedAt: occurredAt,
          },
        });
      }
      return companionEvents.length > 0 ? [settledEvent, ...companionEvents] : settledEvent;
    }

    case "thread.unsettle": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Idempotent by re-emission (see thread.settle): reducing the event a
      // second time lands on the same override state. A re-emission keeps
      // the existing updatedAt so duplicates do not churn ordering.
      const alreadyPinnedActive = thread.settledOverride === "active";
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.unsettled",
        payload: {
          threadId: command.threadId,
          reason: command.reason,
          updatedAt: alreadyPinnedActive ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.snooze": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      // A wake time in the past would create a thread that is snoozed and
      // woken at once — the row would never leave the inbox but still carry
      // snooze state. Reject instead of silently normalizing. The negated
      // comparison also catches unparseable wake times (IsoDateTime is
      // structurally just a string): NaN fails every comparison, and an
      // unparseable snoozedUntil must never persist.
      if (!(Date.parse(command.snoozedUntil) > Date.parse(occurredAt))) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} snooze wake time ${command.snoozedUntil} is not in the future`,
          }),
        );
      }
      // Blocked-on-you work must not be snoozed away: a pending approval or
      // user-input request is the agent waiting on the user, and hiding it
      // defeats the request. (A running session IS snoozable — snooze only
      // affects visibility, never the agent.)
      if (hasOpenBlockingRequest(thread)) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} has a pending approval or user-input request and cannot be snoozed`,
          }),
        );
      }
      // A queued turn start — a user message no turn has adopted yet — is
      // invisible pending work: no session, no pending flags. Snoozing in
      // that window would hide a just-requested turn exactly the way settle
      // would.
      if (threadHasQueuedTurnStart(thread, occurredAt)) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} has a queued turn start and cannot be snoozed`,
          }),
        );
      }
      // Re-snoozing an already-snoozed thread to the SAME wake time is a
      // duplicate (double-click, raced clients): re-emit with the original
      // timestamps so the projection is a no-op. A different wake time is a
      // real change and stamps fresh.
      const existingSnoozedAt =
        thread.snoozedUntil === command.snoozedUntil && thread.snoozedAt != null
          ? thread.snoozedAt
          : null;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.snoozed",
        payload: {
          threadId: command.threadId,
          snoozedUntil: command.snoozedUntil,
          snoozedAt: existingSnoozedAt ?? occurredAt,
          updatedAt: existingSnoozedAt !== null ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.unsnooze": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Idempotent by re-emission (see thread.settle): waking a thread that
      // is not snoozed lands on the same null state without churning
      // updatedAt.
      const alreadyAwake = thread.snoozedUntil == null;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.unsnoozed",
        payload: {
          threadId: command.threadId,
          reason: command.reason,
          updatedAt: alreadyAwake ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.pin": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      // Re-pinning an already-pinned thread is a duplicate (double-click,
      // raced clients): re-emit with the original timestamps so the
      // projection is a no-op. Pinning has no lifecycle invariants — a pin
      // only ever promotes visibility, so it can never hide pending work.
      const existingPinnedAt = thread.pinnedAt ?? null;
      const pinnedEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.pinned" as const,
        payload: {
          threadId: command.threadId,
          pinnedAt: existingPinnedAt ?? occurredAt,
          // A fresh pin takes the client's slot in the arranged order; on a
          // re-pin the existing key wins so raced duplicates cannot move a
          // thread the user already placed.
          ...(existingPinnedAt === null && command.orderKey !== undefined
            ? { pinOrderKey: command.orderKey }
            : {}),
          updatedAt: existingPinnedAt !== null ? thread.updatedAt : occurredAt,
        },
      };
      // Pinning is a promotion: it clears the parked states rather than
      // silently outranking them. An explicit settle un-settles (reason
      // "user", same override the un-settle button stamps), and a snooze's
      // return ticket is spent — the thread is on top NOW, not on Tuesday.
      const promotionEvents: Array<Omit<OrchestrationEvent, "sequence">> = [];
      if (thread.settledOverride === "settled") {
        promotionEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.unsettled",
          payload: {
            threadId: command.threadId,
            reason: "user",
            updatedAt: occurredAt,
          },
        });
      }
      if (thread.snoozedUntil != null) {
        promotionEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.unsnoozed",
          payload: {
            threadId: command.threadId,
            reason: "user",
            updatedAt: occurredAt,
          },
        });
      }
      return promotionEvents.length > 0 ? [pinnedEvent, ...promotionEvents] : pinnedEvent;
    }

    case "thread.unpin": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Idempotent by re-emission (see thread.settle): unpinning a thread
      // that is not pinned lands on the same null state without churning
      // updatedAt.
      const alreadyUnpinned = thread.pinnedAt == null;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.unpinned",
        payload: {
          threadId: command.threadId,
          updatedAt: alreadyUnpinned ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.pin.reorder": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Only pinned threads have a slot in the arranged order. Rejecting
      // (rather than silently pinning) keeps a raced reorder-after-unpin
      // from resurrecting a pin the user just cleared.
      if (thread.pinnedAt == null) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} is not pinned and cannot be reordered`,
          }),
        );
      }
      // Idempotent by re-emission (see thread.settle): a duplicate drop on
      // the same slot keeps the existing updatedAt so it projects as a no-op.
      const keyUnchanged = thread.pinOrderKey === command.orderKey;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.pin-reordered",
        payload: {
          threadId: command.threadId,
          orderKey: command.orderKey,
          updatedAt: keyUnchanged ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.meta.update": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (command.projectId !== undefined && command.projectId !== thread.projectId) {
        if (thread.coagent != null) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Co-agent thread '${command.threadId}' cannot be moved independently of its parent.`,
          });
        }
        if (thread.latestTurn?.state === "running") {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Thread '${command.threadId}' cannot be moved while a turn is active.`,
          });
        }
        if (command.projectId !== null) {
          yield* requireProject({
            readModel,
            command,
            projectId: command.projectId,
          });
        }
      }
      const branch =
        command.branch !== undefined &&
        command.expectedBranch !== undefined &&
        thread.branch !== command.expectedBranch
          ? thread.branch
          : command.branch;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          ...(command.projectId !== undefined && command.projectId !== thread.projectId
            ? {
                projectId: command.projectId,
                branch: null,
                worktreePath: null,
                linkedPullRequest: null,
              }
            : {}),
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.regenerateTitle === true
            ? {
                regenerateTitle: true as const,
                previousTitle: thread.title,
                titleRegeneration: {
                  requestId: command.commandId,
                  startedAt: occurredAt,
                },
              }
            : {}),
          ...(command.title !== undefined && thread.titleRegeneration != null
            ? { titleRegeneration: null }
            : {}),
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(branch !== undefined ? { branch } : {}),
          ...(command.worktreePath !== undefined ? { worktreePath: command.worktreePath } : {}),
          ...(command.linkedPullRequest !== undefined
            ? { linkedPullRequest: command.linkedPullRequest }
            : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.title.regeneration.complete": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const requestIsCurrent = thread.titleRegeneration?.requestId === command.requestId;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          ...(requestIsCurrent && command.title !== undefined ? { title: command.title } : {}),
          ...(requestIsCurrent ? { titleRegeneration: null } : {}),
          updatedAt: requestIsCurrent ? occurredAt : thread.updatedAt,
        },
      };
    }

    case "thread.runtime-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.runtime-mode-set",
        payload: {
          threadId: command.threadId,
          runtimeMode: command.runtimeMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.interaction-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.interaction-mode-set",
        payload: {
          threadId: command.threadId,
          interactionMode: command.interactionMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.turn.start": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const sourceProposedPlan = command.sourceProposedPlan;
      const sourceThread = sourceProposedPlan
        ? yield* requireThread({
            readModel,
            command,
            threadId: sourceProposedPlan.threadId,
          })
        : null;
      const sourcePlan =
        sourceProposedPlan && sourceThread
          ? sourceThread.proposedPlans.find((entry) => entry.id === sourceProposedPlan.planId)
          : null;
      if (sourceProposedPlan && !sourcePlan) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan.planId}' does not exist on thread '${sourceProposedPlan.threadId}'.`,
        });
      }
      if (sourceThread && sourceThread.projectId !== targetThread.projectId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan?.planId}' belongs to thread '${sourceThread.id}' in a different project.`,
        });
      }
      const userMessageEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          role: "user",
          text: command.message.text,
          attachments: command.message.attachments,
          turnId: null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const turnStartRequestedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        causationEventId: userMessageEvent.eventId,
        type: "thread.turn-start-requested",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.titleSeed !== undefined ? { titleSeed: command.titleSeed } : {}),
          runtimeMode: targetThread.runtimeMode,
          interactionMode: targetThread.interactionMode,
          ...(sourceProposedPlan !== undefined ? { sourceProposedPlan } : {}),
          createdAt: command.createdAt,
        },
      };
      // Real activity resets ANY override: it wakes an explicitly settled
      // thread, and it clears a keep-active pin back to neutral so the
      // thread can auto-settle again after this burst of work goes stale.
      // A snooze clears the same way — sending a message to a snoozed
      // thread is the user re-engaging, so the return ticket is spent.
      const lifecycleResetEvents: Array<Omit<OrchestrationEvent, "sequence">> = [];
      if (targetThread.settledOverride !== null) {
        lifecycleResetEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "thread.unsettled",
          payload: {
            threadId: command.threadId,
            reason: "activity",
            updatedAt: command.createdAt,
          },
        });
      }
      if (targetThread.snoozedUntil != null) {
        lifecycleResetEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "thread.unsnoozed",
          payload: {
            threadId: command.threadId,
            reason: "activity",
            updatedAt: command.createdAt,
          },
        });
      }
      return [...lifecycleResetEvents, userMessageEvent, turnStartRequestedEvent];
    }

    case "thread.turn.interrupt": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.turn-interrupt-requested",
        payload: {
          threadId: command.threadId,
          ...(command.turnId !== undefined ? { turnId: command.turnId } : {}),
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.goal.status.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.goal-status-set-requested",
        payload: {
          threadId: command.threadId,
          status: command.status,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.goal.clear": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.goal-clear-requested",
        payload: {
          threadId: command.threadId,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.approval.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        })),
        type: "thread.approval-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          decision: command.decision,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.user-input.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        })),
        type: "thread.user-input-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          answers: command.answers,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.checkpoint.revert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.checkpoint-revert-requested",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.stop": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Settle-cleanup stops are conditional: between the settle landing and
      // this command, another client may have re-engaged the thread (a turn
      // start unsettles it and brings the session alive). Commands are
      // decided serially against this read model, so checking here — not in
      // the dispatcher's pre-settle snapshot — closes that race.
      if (command.onlyIfSettled === true) {
        const sessionComingAlive =
          thread.session?.status === "starting" || thread.session?.status === "running";
        if (
          thread.settledOverride !== "settled" ||
          sessionComingAlive ||
          threadHasQueuedTurnStart(thread, command.createdAt)
        ) {
          return yield* Effect.fail(
            new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: `thread ${command.threadId} was re-engaged after settle; skipping session stop`,
            }),
          );
        }
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.session-stop-requested",
        payload: {
          threadId: command.threadId,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.set": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const sessionSetEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {},
        })),
        type: "thread.session-set",
        payload: {
          threadId: command.threadId,
          session: command.session,
        },
      };
      // Only a session coming alive is activity worth waking a settled thread
      // for — status writes like ready/stopped/error arrive after the fact and
      // must not fight a user's explicit settle. Snooze is deliberately NOT
      // cleared here: snooze never pauses the agent, so its session starting
      // or erroring is not the user re-engaging. Blocked/failed work still
      // surfaces immediately — effectiveSnoozed refuses to classify a thread
      // with a raised hand (approval / input / failure / fresh completion)
      // as snoozed, without spending the return ticket.
      const isSessionActivity =
        command.session.status === "starting" || command.session.status === "running";
      // Real activity resets ANY override (settled wakes, active unpins).
      if (thread.settledOverride === null || !isSessionActivity) {
        return sessionSetEvent;
      }
      const unsettledEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.unsettled",
        payload: {
          threadId: command.threadId,
          reason: "activity",
          updatedAt: command.createdAt,
        },
      };
      return [unsettledEvent, sessionSetEvent];
    }

    case "thread.import-context.consume": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.import-context-consumed",
        payload: {
          threadId: command.threadId,
          consumedAt: command.createdAt,
        },
      };
    }

    case "thread.message.assistant.delta": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: command.delta,
          turnId: command.turnId ?? null,
          streaming: true,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.message.assistant.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: "",
          turnId: command.turnId ?? null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.proposed-plan.upsert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.proposed-plan-upserted",
        payload: {
          threadId: command.threadId,
          proposedPlan: command.proposedPlan,
        },
      };
    }

    case "thread.turn.diff.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.turn-diff-completed",
        payload: {
          threadId: command.threadId,
          turnId: command.turnId,
          checkpointTurnCount: command.checkpointTurnCount,
          checkpointRef: command.checkpointRef,
          status: command.status,
          files: command.files,
          assistantMessageId: command.assistantMessageId ?? null,
          completedAt: command.completedAt,
        },
      };
    }

    case "thread.revert.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.reverted",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
        },
      };
    }

    case "thread.activity.append": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const requestId =
        typeof command.activity.payload === "object" &&
        command.activity.payload !== null &&
        "requestId" in command.activity.payload &&
        typeof (command.activity.payload as { requestId?: unknown }).requestId === "string"
          ? ((command.activity.payload as { requestId: string })
              .requestId as OrchestrationEvent["metadata"]["requestId"])
          : undefined;
      const activityAppendedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          ...(requestId !== undefined ? { metadata: { requestId } } : {}),
        })),
        type: "thread.activity-appended",
        payload: {
          threadId: command.threadId,
          activity: command.activity,
        },
      };
      // An approval or user-input request is blocked-on-you work — it must
      // never stay hidden inside a settled slim row.
      const wakesSettledThread =
        command.activity.kind === "approval.requested" ||
        command.activity.kind === "user-input.requested";
      // Real activity resets ANY override (settled wakes, active unpins).
      if (thread.settledOverride === null || !wakesSettledThread) {
        return activityAppendedEvent;
      }
      const unsettledEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.unsettled",
        payload: {
          threadId: command.threadId,
          reason: "activity",
          updatedAt: command.createdAt,
        },
      };
      return [unsettledEvent, activityAppendedEvent];
    }

    default: {
      command satisfies never;
      const fallback = command as never as { type: string };
      return yield* new OrchestrationCommandInvariantError({
        commandType: fallback.type,
        detail: `Unknown command type: ${fallback.type}`,
      });
    }
  }
});
