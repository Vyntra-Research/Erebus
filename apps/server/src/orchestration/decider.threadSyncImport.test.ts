import {
  CommandId,
  EventId,
  MessageId,
  OrchestrationProposedPlanId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationCoagentShell,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-10-11T12:00:00.000Z";
const importedAt = "2026-10-11T12:05:00.000Z";
const projectId = ProjectId.make("project-sync");
const threadId = ThreadId.make("thread-sync");
const turnId = TurnId.make("turn-sync");
const userMessageId = MessageId.make("message-user-sync");
const assistantMessageId = MessageId.make("message-assistant-sync");

function event(input: {
  readonly sequence: number;
  readonly type: OrchestrationEvent["type"];
  readonly payload: unknown;
  readonly aggregateId: ProjectId | ThreadId;
  readonly aggregateKind: "project" | "thread";
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.make(`event-${input.sequence}`),
    aggregateKind: input.aggregateKind,
    aggregateId: input.aggregateId,
    type: input.type,
    occurredAt: now,
    commandId: CommandId.make(`command-${input.sequence}`),
    causationEventId: null,
    correlationId: CommandId.make(`command-${input.sequence}`),
    metadata: {},
    payload: input.payload as never,
  } as OrchestrationEvent;
}

const seedProject = projectEvent(
  createEmptyReadModel(now),
  event({
    sequence: 1,
    type: "project.created",
    aggregateKind: "project",
    aggregateId: projectId,
    payload: {
      projectId,
      title: "Sync project",
      workspaceRoot: "C:/work/sync",
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  }),
);

function importCommand(
  mode: "create" | "replace",
  expectedLocalUpdatedAt: string | null,
  targetProjectId: ProjectId = projectId,
  coagent: OrchestrationCoagentShell | null = null,
) {
  return {
    type: "thread.sync.import-batch",
    commandId: CommandId.make(`command-import-${mode}`),
    importedAt,
    imports: [
      {
        mode,
        threadId,
        projectId: targetProjectId,
        expectedLocalUpdatedAt,
        ...(mode === "create"
          ? {
              localState: {
                modelSelection: {
                  instanceId: ProviderInstanceId.make("codex-local"),
                  model: "gpt-local",
                },
                runtimeMode: "full-access" as const,
                interactionMode: "plan" as const,
                branch: "local-branch",
                worktreePath: "C:/work/local",
                linkedPullRequest: null,
              },
            }
          : {}),
        history: {
          title: "Imported title",
          coagent,
          latestTurnId: turnId,
          createdAt: now,
          updatedAt: importedAt,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          deletedAt: null,
          messages: [
            {
              id: userMessageId,
              role: "user" as const,
              text: "portable question",
              attachments: [
                {
                  type: "image" as const,
                  id: "sync-image",
                  name: "evidence.png",
                  mimeType: "image/png",
                  sizeBytes: 12,
                },
              ],
              turnId,
              streaming: false as const,
              createdAt: now,
              updatedAt: now,
            },
            {
              id: assistantMessageId,
              role: "assistant" as const,
              text: "portable answer",
              attachments: [],
              turnId,
              streaming: false as const,
              createdAt: importedAt,
              updatedAt: importedAt,
            },
          ],
          proposedPlans: [
            {
              id: OrchestrationProposedPlanId.make("plan-sync"),
              turnId,
              planMarkdown: "Do the portable work",
              implementedAt: null,
              implementationThreadId: null,
              createdAt: now,
              updatedAt: now,
            },
          ],
          activities: [
            {
              id: EventId.make("activity-sync"),
              tone: "info" as const,
              kind: "tool.completed",
              summary: "Portable work",
              turnId,
              createdAt: now,
            },
          ],
          turns: [
            {
              turnId,
              pendingMessageId: userMessageId,
              sourceProposedPlanThreadId: null,
              sourceProposedPlanId: null,
              assistantMessageId,
              state: "completed" as const,
              requestedAt: now,
              startedAt: now,
              completedAt: importedAt,
            },
          ],
        },
        sourceRevision: "revision-1",
        sourceHash: "hash-1",
        bindingUpdates: [
          {
            syncThreadId: threadId,
            localThreadId: threadId,
            syncProjectId: "portable-project",
            localProjectId: targetProjectId,
            baseRevision: "hash-1",
          },
        ],
      },
    ],
  } satisfies Extract<OrchestrationCommand, { type: "thread.sync.import-batch" }>;
}

function crossProjectImportCommand(
  sourceProjectId: ProjectId,
  relation: "source-plan" | "implementation",
) {
  const base = importCommand("create", null);
  const consumer = base.imports[0]!;
  const sourceThreadId = ThreadId.make("thread-cross-project-source");
  const sourcePlanId = OrchestrationProposedPlanId.make("plan-cross-project-source");
  const source = {
    ...consumer,
    threadId: sourceThreadId,
    projectId: sourceProjectId,
    history: {
      ...consumer.history,
      title: "Cross-project source",
      proposedPlans: [
        {
          ...consumer.history.proposedPlans[0]!,
          id: sourcePlanId,
          implementationThreadId: null,
        },
      ],
    },
    bindingUpdates: [
      {
        ...consumer.bindingUpdates[0]!,
        syncThreadId: sourceThreadId,
        localThreadId: sourceThreadId,
        syncProjectId: "portable-source-project",
        localProjectId: sourceProjectId,
      },
    ],
  };
  const dependent = {
    ...consumer,
    history: {
      ...consumer.history,
      turns: consumer.history.turns.map((turn) => ({
        ...turn,
        sourceProposedPlanThreadId: relation === "source-plan" ? sourceThreadId : null,
        sourceProposedPlanId: relation === "source-plan" ? sourcePlanId : null,
      })),
      proposedPlans: consumer.history.proposedPlans.map((plan) => ({
        ...plan,
        implementationThreadId: relation === "implementation" ? sourceThreadId : null,
      })),
    },
  };
  return {
    ...base,
    imports: [source, dependent],
  } satisfies Extract<OrchestrationCommand, { type: "thread.sync.import-batch" }>;
}

it.layer(NodeServices.layer)("thread sync import decider", (it) => {
  it.effect("materializes a new provider-independent thread with local defaults", () =>
    Effect.gen(function* () {
      const readModel = yield* seedProject;
      const decided = yield* decideOrchestrationCommand({
        command: importCommand("create", null),
        readModel,
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("thread.sync-imported");
      if (events[0]?.type !== "thread.sync-imported") return;
      expect(events[0].payload.thread).toMatchObject({
        id: threadId,
        title: "Imported title",
        modelSelection: { instanceId: "codex-local", model: "gpt-local" },
        runtimeMode: "full-access",
        interactionMode: "plan",
        branch: "local-branch",
        worktreePath: "C:/work/local",
        session: null,
        checkpoints: [],
      });
      expect(events[0].payload.turns).toHaveLength(1);
      expect(events[0].payload.bindingUpdates).toEqual(
        importCommand("create", null).imports[0]!.bindingUpdates,
      );
      expect(events[0].payload.thread.messages[0]?.attachments).toEqual([
        {
          type: "image",
          id: "sync-image",
          name: "evidence.png",
          mimeType: "image/png",
          sizeBytes: 12,
        },
      ]);
    }),
  );

  it.effect("rejects a cross-project source-plan relation", () =>
    Effect.gen(function* () {
      const sourceProjectId = ProjectId.make("project-cross-source");
      let readModel = yield* seedProject;
      readModel = yield* projectEvent(
        readModel,
        event({
          sequence: 2,
          type: "project.created",
          aggregateKind: "project",
          aggregateId: sourceProjectId,
          payload: {
            projectId: sourceProjectId,
            title: "Source project",
            workspaceRoot: "C:/work/source",
            defaultModelSelection: null,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        }),
      );

      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: crossProjectImportCommand(sourceProjectId, "source-plan"),
          readModel,
        }),
      );
      expect(String(error)).toContain("invalid turn reference");
    }),
  );

  it.effect("rejects a cross-project implementation relation", () =>
    Effect.gen(function* () {
      const sourceProjectId = ProjectId.make("project-cross-implementation");
      let readModel = yield* seedProject;
      readModel = yield* projectEvent(
        readModel,
        event({
          sequence: 2,
          type: "project.created",
          aggregateKind: "project",
          aggregateId: sourceProjectId,
          payload: {
            projectId: sourceProjectId,
            title: "Source project",
            workspaceRoot: "C:/work/source",
            defaultModelSelection: null,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        }),
      );

      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: crossProjectImportCommand(sourceProjectId, "implementation"),
          readModel,
        }),
      );
      expect(String(error)).toContain("implementation thread outside its project");
    }),
  );

  it.effect("rejects binding patches that alias one local thread twice", () =>
    Effect.gen(function* () {
      const readModel = yield* seedProject;
      const base = importCommand("create", null);
      const target = base.imports[0]!.bindingUpdates[0]!;
      const command = {
        ...base,
        imports: [
          {
            ...base.imports[0]!,
            bindingUpdates: [target, { ...target, syncThreadId: ThreadId.make("portable-alias") }],
          },
        ],
      } satisfies Extract<OrchestrationCommand, { type: "thread.sync.import-batch" }>;

      const error = yield* Effect.flip(decideOrchestrationCommand({ command, readModel }));
      expect(String(error)).toContain("duplicate portable or local thread bindings");
    }),
  );

  it.effect("keeps both sides when the same portable thread moved across projects", () =>
    Effect.gen(function* () {
      const destinationProjectId = ProjectId.make("project-destination");
      const preservedThreadId = ThreadId.make("thread-preserved");
      const clonedThreadId = ThreadId.make("thread-cloned");
      let readModel = yield* seedProject;
      readModel = yield* projectEvent(
        readModel,
        event({
          sequence: 2,
          type: "project.created",
          aggregateKind: "project",
          aggregateId: destinationProjectId,
          payload: {
            projectId: destinationProjectId,
            title: "Destination",
            workspaceRoot: "C:/work/destination",
            defaultModelSelection: null,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        }),
      );
      readModel = yield* projectEvent(
        readModel,
        event({
          sequence: 3,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: preservedThreadId,
          payload: {
            threadId: preservedThreadId,
            projectId,
            title: "Preserved local copy",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex-existing"),
              model: "gpt-existing",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        }),
      );

      const imported = importCommand("create", null, destinationProjectId).imports[0]!;
      const bindingUpdates = [
        {
          syncThreadId: threadId,
          localThreadId: clonedThreadId,
          syncProjectId: "portable-destination-project",
          localProjectId: destinationProjectId,
          baseRevision: "hash-1",
        },
        {
          syncThreadId: ThreadId.make("thread-preserved-portable"),
          localThreadId: preservedThreadId,
          syncProjectId: "portable-local-project",
          localProjectId: projectId,
          baseRevision: null,
        },
      ] as const;
      const command = {
        ...importCommand("create", null, destinationProjectId),
        imports: [{ ...imported, threadId: clonedThreadId, bindingUpdates }],
      } satisfies Extract<OrchestrationCommand, { type: "thread.sync.import-batch" }>;

      const decided = yield* decideOrchestrationCommand({ command, readModel });
      const importedEvent = (Array.isArray(decided) ? decided : [decided])[0];
      expect(importedEvent?.type).toBe("thread.sync-imported");
      if (importedEvent?.type !== "thread.sync-imported") return;
      expect(importedEvent.payload.thread.projectId).toBe(destinationProjectId);
      expect(importedEvent.payload.bindingUpdates).toEqual(bindingUpdates);
    }),
  );

  it.effect("rejects an imported target binding assigned to another local project", () =>
    Effect.gen(function* () {
      const destinationProjectId = ProjectId.make("project-destination");
      let readModel = yield* seedProject;
      readModel = yield* projectEvent(
        readModel,
        event({
          sequence: 2,
          type: "project.created",
          aggregateKind: "project",
          aggregateId: destinationProjectId,
          payload: {
            projectId: destinationProjectId,
            title: "Destination",
            workspaceRoot: "C:/work/destination",
            defaultModelSelection: null,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        }),
      );
      const base = importCommand("create", null, destinationProjectId);
      const command = {
        ...base,
        imports: [
          {
            ...base.imports[0]!,
            bindingUpdates: [{ ...base.imports[0]!.bindingUpdates[0]!, localProjectId: projectId }],
          },
        ],
      } satisfies Extract<OrchestrationCommand, { type: "thread.sync.import-batch" }>;

      const error = yield* Effect.flip(decideOrchestrationCommand({ command, readModel }));
      expect(error.message).toContain("target binding does not match its local project");
    }),
  );

  it.effect("rejects a preserved binding assigned to a project other than its thread", () =>
    Effect.gen(function* () {
      const destinationProjectId = ProjectId.make("project-destination");
      const wrongPreservedProjectId = ProjectId.make("project-wrong-preserved");
      const preservedThreadId = ThreadId.make("thread-preserved");
      let readModel = yield* seedProject;
      for (const [sequence, nextProjectId] of [
        [2, destinationProjectId],
        [3, wrongPreservedProjectId],
      ] as const) {
        readModel = yield* projectEvent(
          readModel,
          event({
            sequence,
            type: "project.created",
            aggregateKind: "project",
            aggregateId: nextProjectId,
            payload: {
              projectId: nextProjectId,
              title: nextProjectId,
              workspaceRoot: `C:/work/${nextProjectId}`,
              defaultModelSelection: null,
              scripts: [],
              createdAt: now,
              updatedAt: now,
            },
          }),
        );
      }
      readModel = yield* projectEvent(
        readModel,
        event({
          sequence: 4,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: preservedThreadId,
          payload: {
            threadId: preservedThreadId,
            projectId,
            title: "Preserved local copy",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex-existing"),
              model: "gpt-existing",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        }),
      );
      const imported = importCommand("create", null, destinationProjectId).imports[0]!;
      const command = {
        ...importCommand("create", null, destinationProjectId),
        imports: [
          {
            ...imported,
            bindingUpdates: [
              imported.bindingUpdates[0]!,
              {
                syncThreadId: ThreadId.make("thread-preserved-portable"),
                localThreadId: preservedThreadId,
                syncProjectId: "portable-wrong-preserved-project",
                localProjectId: wrongPreservedProjectId,
                baseRevision: null,
              },
            ],
          },
        ],
      } satisfies Extract<OrchestrationCommand, { type: "thread.sync.import-batch" }>;

      const error = yield* Effect.flip(decideOrchestrationCommand({ command, readModel }));
      expect(error.message).toContain("invalid preserved local binding");
    }),
  );

  it.effect("preserves local routing and workspace state when replacing history", () =>
    Effect.gen(function* () {
      let readModel = yield* seedProject;
      readModel = yield* projectEvent(
        readModel,
        event({
          sequence: 2,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: threadId,
          payload: {
            threadId,
            projectId,
            title: "Local title",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex-existing"),
              model: "gpt-existing",
            },
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: "existing-branch",
            worktreePath: "C:/work/existing",
            createdAt: now,
            updatedAt: now,
          },
        }),
      );
      readModel = {
        ...readModel,
        threads: readModel.threads.map((thread) =>
          thread.id === threadId
            ? {
                ...thread,
                pinnedAt: now,
                snoozedAt: now,
                snoozedUntil: "2026-10-12T12:00:00.000Z",
              }
            : thread,
        ),
      };

      const decided = yield* decideOrchestrationCommand({
        command: importCommand("replace", now),
        readModel,
      });
      const imported = (Array.isArray(decided) ? decided : [decided])[0];
      expect(imported?.type).toBe("thread.sync-imported");
      if (imported?.type !== "thread.sync-imported") return;
      expect(imported.payload.thread).toMatchObject({
        title: "Imported title",
        modelSelection: { instanceId: "codex-existing", model: "gpt-existing" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: "existing-branch",
        worktreePath: "C:/work/existing",
        pinnedAt: now,
        snoozedAt: now,
        snoozedUntil: "2026-10-12T12:00:00.000Z",
        session: null,
      });
    }),
  );

  it.effect("clears project-bound runtime state when replacement moves to another project", () =>
    Effect.gen(function* () {
      const destinationProjectId = ProjectId.make("project-destination");
      let readModel = yield* seedProject;
      readModel = yield* projectEvent(
        readModel,
        event({
          sequence: 2,
          type: "project.created",
          aggregateKind: "project",
          aggregateId: destinationProjectId,
          payload: {
            projectId: destinationProjectId,
            title: "Destination",
            workspaceRoot: "C:/work/destination",
            defaultModelSelection: null,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        }),
      );
      readModel = yield* projectEvent(
        readModel,
        event({
          sequence: 3,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: threadId,
          payload: {
            threadId,
            projectId,
            title: "Local title",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex-existing"),
              model: "gpt-existing",
            },
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: "old-project-branch",
            worktreePath: "C:/work/sync/worktree",
            createdAt: now,
            updatedAt: now,
          },
        }),
      );
      readModel = {
        ...readModel,
        threads: readModel.threads.map((thread) =>
          thread.id === threadId
            ? {
                ...thread,
                linkedPullRequest: {
                  projectId,
                  repository: "old-project",
                  number: 42,
                  url: "https://github.com/example/old-project/pull/42",
                },
              }
            : thread,
        ),
      };

      const decided = yield* decideOrchestrationCommand({
        command: importCommand("replace", now, destinationProjectId),
        readModel,
      });
      const imported = (Array.isArray(decided) ? decided : [decided])[0];
      expect(imported?.type).toBe("thread.sync-imported");
      if (imported?.type !== "thread.sync-imported") return;
      expect(imported.payload.thread).toMatchObject({
        projectId: destinationProjectId,
        modelSelection: { instanceId: "codex-existing", model: "gpt-existing" },
        branch: null,
        worktreePath: null,
        linkedPullRequest: null,
      });
    }),
  );

  it.effect("keeps a co-agent relation when parent and child are imported together", () =>
    Effect.gen(function* () {
      const readModel = yield* seedProject;
      const parentThreadId = ThreadId.make("thread-sync-parent");
      const childThreadId = ThreadId.make("thread-sync-child");
      const parent = importCommand("create", null).imports[0]!;
      const child = importCommand("create", null, projectId, {
        parentThreadId,
        creationMode: "fork",
        status: "ready",
      }).imports[0]!;
      const command = {
        ...importCommand("create", null),
        imports: [
          {
            ...child,
            threadId: childThreadId,
            bindingUpdates: [
              {
                ...child.bindingUpdates[0]!,
                syncThreadId: childThreadId,
                localThreadId: childThreadId,
              },
            ],
          },
          {
            ...parent,
            threadId: parentThreadId,
            bindingUpdates: [
              {
                ...parent.bindingUpdates[0]!,
                syncThreadId: parentThreadId,
                localThreadId: parentThreadId,
              },
            ],
          },
        ],
      } satisfies Extract<OrchestrationCommand, { type: "thread.sync.import-batch" }>;

      const decided = yield* decideOrchestrationCommand({ command, readModel });
      const events = Array.isArray(decided) ? decided : [decided];
      const childEvent = events.find((entry) => entry.aggregateId === childThreadId);
      const parentEvent = events.find((entry) => entry.aggregateId === parentThreadId);

      expect(childEvent?.type).toBe("thread.sync-imported");
      expect(parentEvent?.type).toBe("thread.sync-imported");
      if (childEvent?.type !== "thread.sync-imported") return;
      if (parentEvent?.type !== "thread.sync-imported") return;
      expect(childEvent.payload.thread.coagent).toEqual({
        parentThreadId,
        creationMode: "fork",
        status: "ready",
      });
      expect(parentEvent.payload.thread.coagent).toBeNull();
    }),
  );

  it.effect("imports a child as a regular thread when its parent is unavailable", () =>
    Effect.gen(function* () {
      const readModel = yield* seedProject;
      const command = importCommand("create", null, projectId, {
        parentThreadId: ThreadId.make("missing-parent"),
        creationMode: "blank",
        status: "failed",
      });

      const decided = yield* decideOrchestrationCommand({ command, readModel });
      const imported = (Array.isArray(decided) ? decided : [decided])[0];
      expect(imported?.type).toBe("thread.sync-imported");
      if (imported?.type !== "thread.sync-imported") return;
      expect(imported.payload.thread.coagent).toBeNull();
    }),
  );

  it.effect("rejects replacement when the local thread is active", () =>
    Effect.gen(function* () {
      let readModel = yield* seedProject;
      readModel = yield* projectEvent(
        readModel,
        event({
          sequence: 2,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: threadId,
          payload: {
            threadId,
            projectId,
            title: "Active",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        }),
      );
      readModel = yield* projectEvent(
        readModel,
        event({
          sequence: 3,
          type: "thread.session-set",
          aggregateKind: "thread",
          aggregateId: threadId,
          payload: {
            threadId,
            session: {
              threadId,
              status: "running",
              providerName: "codex",
              providerInstanceId: ProviderInstanceId.make("codex"),
              runtimeMode: "full-access",
              activeTurnId: turnId,
              lastError: null,
              updatedAt: now,
            },
          },
        }),
      );

      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: importCommand("replace", now),
          readModel,
        }),
      );
      expect(error.message).toContain("is active and cannot be replaced");
    }),
  );
});
