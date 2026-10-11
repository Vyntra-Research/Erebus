import {
  CommandId,
  EventId,
  MessageId,
  OrchestrationProposedPlanId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCoagentShell,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";

const TestLayer = OrchestrationProjectionPipelineLive.pipe(
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-sync-import-test-" })),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

const now = "2026-10-11T12:00:00.000Z";
const importedAt = "2026-10-11T12:05:00.000Z";
const projectId = ProjectId.make("project-sync-pipeline");
const threadId = ThreadId.make("thread-sync-pipeline");
const turnId = TurnId.make("turn-imported");

function importedThread(
  id: ThreadId,
  title: string,
  coagent: OrchestrationCoagentShell | null,
): OrchestrationThread {
  return {
    id,
    projectId,
    title,
    coagent,
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex-local"),
      model: "gpt-local",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    linkedPullRequest: null,
    latestTurn: null,
    createdAt: now,
    updatedAt: importedAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    unsettledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    titleRegeneration: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  };
}

it.layer(TestLayer)("thread sync import projection", (it) => {
  it.effect("replaces every owned history table at the event boundary during replay", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const pipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;

      yield* eventStore.append({
        eventId: EventId.make("event-project"),
        aggregateKind: "project",
        aggregateId: projectId,
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.make("command-project"),
        causationEventId: null,
        correlationId: CommandId.make("command-project"),
        metadata: {},
        payload: {
          projectId,
          title: "Sync project",
          workspaceRoot: "C:/work/sync",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* eventStore.append({
        eventId: EventId.make("event-thread"),
        aggregateKind: "thread",
        aggregateId: threadId,
        type: "thread.created",
        occurredAt: now,
        commandId: CommandId.make("command-thread"),
        causationEventId: null,
        correlationId: CommandId.make("command-thread"),
        metadata: {},
        payload: {
          threadId,
          projectId,
          title: "Old title",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex-local"),
            model: "gpt-local",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "local-branch",
          worktreePath: "C:/work/local",
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* eventStore.append({
        eventId: EventId.make("event-old-message"),
        aggregateKind: "thread",
        aggregateId: threadId,
        type: "thread.message-sent",
        occurredAt: now,
        commandId: CommandId.make("command-old-message"),
        causationEventId: null,
        correlationId: CommandId.make("command-old-message"),
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.make("message-old"),
          role: "user",
          text: "obsolete",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* eventStore.append({
        eventId: EventId.make("event-old-turn"),
        aggregateKind: "thread",
        aggregateId: threadId,
        type: "thread.turn-start-requested",
        occurredAt: now,
        commandId: CommandId.make("command-old-turn"),
        causationEventId: null,
        correlationId: CommandId.make("command-old-turn"),
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.make("message-old"),
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: now,
        },
      });
      yield* eventStore.append({
        eventId: EventId.make("event-old-plan"),
        aggregateKind: "thread",
        aggregateId: threadId,
        type: "thread.proposed-plan-upserted",
        occurredAt: now,
        commandId: CommandId.make("command-old-plan"),
        causationEventId: null,
        correlationId: CommandId.make("command-old-plan"),
        metadata: {},
        payload: {
          threadId,
          proposedPlan: {
            id: OrchestrationProposedPlanId.make("plan-old"),
            turnId: null,
            planMarkdown: "obsolete plan",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: now,
            updatedAt: now,
          },
        },
      });
      yield* eventStore.append({
        eventId: EventId.make("event-old-approval"),
        aggregateKind: "thread",
        aggregateId: threadId,
        type: "thread.activity-appended",
        occurredAt: now,
        commandId: CommandId.make("command-old-approval"),
        causationEventId: null,
        correlationId: CommandId.make("command-old-approval"),
        metadata: {},
        payload: {
          threadId,
          activity: {
            id: EventId.make("activity-old-approval"),
            tone: "approval",
            kind: "approval.requested",
            summary: "Old approval",
            payload: { requestId: "approval-old" },
            turnId: null,
            createdAt: now,
          },
        },
      });
      yield* eventStore.append({
        eventId: EventId.make("event-old-session"),
        aggregateKind: "thread",
        aggregateId: threadId,
        type: "thread.session-set",
        occurredAt: now,
        commandId: CommandId.make("command-old-session"),
        causationEventId: null,
        correlationId: CommandId.make("command-old-session"),
        metadata: {},
        payload: {
          threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "codex",
            providerInstanceId: ProviderInstanceId.make("codex-local"),
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      });

      yield* eventStore.append({
        eventId: EventId.make("event-import"),
        aggregateKind: "thread",
        aggregateId: threadId,
        type: "thread.sync-imported",
        occurredAt: importedAt,
        commandId: CommandId.make("command-import"),
        causationEventId: null,
        correlationId: CommandId.make("command-import"),
        metadata: {},
        payload: {
          threadId,
          sourceRevision: "revision-1",
          sourceHash: "hash-1",
          importedAt,
          thread: {
            id: threadId,
            projectId,
            title: "Imported title",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex-local"),
              model: "gpt-local",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: "local-branch",
            worktreePath: "C:/work/local",
            linkedPullRequest: null,
            latestTurn: {
              turnId,
              state: "completed",
              requestedAt: now,
              startedAt: now,
              completedAt: importedAt,
              assistantMessageId: MessageId.make("message-imported-assistant"),
            },
            createdAt: now,
            updatedAt: importedAt,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            unsettledAt: null,
            snoozedUntil: null,
            snoozedAt: null,
            pinnedAt: null,
            pinOrderKey: null,
            titleRegeneration: null,
            deletedAt: null,
            messages: [
              {
                id: MessageId.make("message-imported-user"),
                role: "user",
                text: "imported question",
                attachments: [
                  {
                    type: "image",
                    id: "sync-image",
                    name: "evidence.png",
                    mimeType: "image/png",
                    sizeBytes: 12,
                  },
                ],
                turnId,
                streaming: false,
                createdAt: now,
                updatedAt: now,
              },
              {
                id: MessageId.make("message-imported-assistant"),
                role: "assistant",
                text: "imported answer",
                attachments: [],
                turnId,
                streaming: false,
                createdAt: importedAt,
                updatedAt: importedAt,
              },
            ],
            proposedPlans: [],
            activities: [
              {
                id: EventId.make("activity-imported"),
                tone: "info",
                kind: "tool.completed",
                summary: "Imported work",
                payload: null,
                turnId,
                createdAt: importedAt,
              },
            ],
            checkpoints: [],
            session: null,
          },
          turns: [
            {
              turnId,
              pendingMessageId: MessageId.make("message-imported-user"),
              sourceProposedPlanThreadId: null,
              sourceProposedPlanId: null,
              assistantMessageId: MessageId.make("message-imported-assistant"),
              state: "completed",
              requestedAt: now,
              startedAt: now,
              completedAt: importedAt,
            },
          ],
          bindingUpdates: [],
        },
      });
      yield* eventStore.append({
        eventId: EventId.make("event-post-import-message"),
        aggregateKind: "thread",
        aggregateId: threadId,
        type: "thread.message-sent",
        occurredAt: "2026-10-11T12:06:00.000Z",
        commandId: CommandId.make("command-post-import-message"),
        causationEventId: null,
        correlationId: CommandId.make("command-post-import-message"),
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.make("message-after-import"),
          role: "assistant",
          text: "continued locally",
          turnId: null,
          streaming: false,
          createdAt: "2026-10-11T12:06:00.000Z",
          updatedAt: "2026-10-11T12:06:00.000Z",
        },
      });

      yield* pipeline.bootstrap;

      const messages = yield* sql<{ readonly messageId: string; readonly text: string }>`
        SELECT message_id AS "messageId", text
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, message_id ASC
      `;
      assert.deepEqual(messages, [
        { messageId: "message-imported-user", text: "imported question" },
        { messageId: "message-imported-assistant", text: "imported answer" },
        { messageId: "message-after-import", text: "continued locally" },
      ]);

      const importedAttachments = yield* sql<{ readonly attachmentsJson: string | null }>`
        SELECT attachments_json AS "attachmentsJson"
        FROM projection_thread_messages
        WHERE message_id = ${"message-imported-user"}
      `;
      assert.equal(
        importedAttachments[0]?.attachmentsJson,
        '[{"type":"image","id":"sync-image","name":"evidence.png","mimeType":"image/png","sizeBytes":12}]',
      );

      const sessions = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM projection_thread_sessions
        WHERE thread_id = ${threadId}
      `;
      const approvals = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM projection_pending_approvals
        WHERE thread_id = ${threadId}
      `;
      const turns = yield* sql<{ readonly turnId: string; readonly state: string }>`
        SELECT turn_id AS "turnId", state
        FROM projection_turns
        WHERE thread_id = ${threadId}
      `;
      const activities = yield* sql<{ readonly activityId: string }>`
        SELECT activity_id AS "activityId"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
      `;
      const plans = yield* sql<{ readonly planId: string }>`
        SELECT plan_id AS "planId"
        FROM projection_thread_proposed_plans
        WHERE thread_id = ${threadId}
      `;
      const threads = yield* sql<{
        readonly title: string;
        readonly modelSelection: string;
        readonly branch: string | null;
      }>`
        SELECT title, model_selection_json AS "modelSelection", branch
        FROM projection_threads
        WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(sessions, [{ count: 0 }]);
      assert.deepEqual(approvals, [{ count: 0 }]);
      assert.deepEqual(turns, [{ turnId: "turn-imported", state: "completed" }]);
      assert.deepEqual(activities, [{ activityId: "activity-imported" }]);
      assert.deepEqual(plans, []);
      assert.equal(threads[0]?.title, "Imported title");
      assert.equal(threads[0]?.branch, "local-branch");
      assert.match(threads[0]?.modelSelection ?? "", /gpt-local/);
    }),
  );

  it.effect("materializes an imported parent-child relation in projection state", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const pipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      const parentThreadId = ThreadId.make("thread-sync-parent");
      const childThreadId = ThreadId.make("thread-sync-child");

      yield* eventStore.append({
        eventId: EventId.make("event-coagent-project"),
        aggregateKind: "project",
        aggregateId: projectId,
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.make("command-coagent-project"),
        causationEventId: null,
        correlationId: CommandId.make("command-coagent-project"),
        metadata: {},
        payload: {
          projectId,
          title: "Sync project",
          workspaceRoot: "C:/work/sync",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });
      for (const [id, thread] of [
        [parentThreadId, importedThread(parentThreadId, "Parent", null)],
        [
          childThreadId,
          importedThread(childThreadId, "Child", {
            parentThreadId,
            creationMode: "fork",
            status: "ready",
          }),
        ],
      ] as const) {
        yield* eventStore.append({
          eventId: EventId.make(`event-import-${id}`),
          aggregateKind: "thread",
          aggregateId: id,
          type: "thread.sync-imported",
          occurredAt: importedAt,
          commandId: CommandId.make(`command-import-${id}`),
          causationEventId: null,
          correlationId: CommandId.make(`command-import-${id}`),
          metadata: {},
          payload: {
            threadId: id,
            sourceRevision: "revision-coagent",
            sourceHash: `hash-${id}`,
            importedAt,
            thread,
            turns: [],
            bindingUpdates: [],
          },
        });
      }

      yield* pipeline.bootstrap;

      const rows = yield* sql<{
        readonly childThreadId: string;
        readonly parentThreadId: string;
        readonly projectId: string;
        readonly creationMode: string;
        readonly status: string;
      }>`
        SELECT
          child_thread_id AS "childThreadId",
          parent_thread_id AS "parentThreadId",
          project_id AS "projectId",
          creation_mode AS "creationMode",
          status
        FROM coagent_threads
        WHERE child_thread_id = ${childThreadId}
      `;
      assert.deepEqual(rows, [
        {
          childThreadId,
          parentThreadId,
          projectId,
          creationMode: "fork",
          status: "ready",
        },
      ]);
    }),
  );

  it.effect("prunes superseded imported attachments while retaining referenced files", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const pipeline = yield* OrchestrationProjectionPipeline;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig;
      const staleAttachmentId = "thread-sync-pipeline-00000000-0000-4000-8000-000000000001";
      const keptAttachmentId = "thread-sync-pipeline-00000000-0000-4000-8000-000000000002";
      const otherThreadAttachmentId = "thread-other-00000000-0000-4000-8000-000000000003";
      const stalePath = path.join(config.attachmentsDir, `${staleAttachmentId}.png`);
      const keptPath = path.join(config.attachmentsDir, `${keptAttachmentId}.png`);
      const otherThreadPath = path.join(config.attachmentsDir, `${otherThreadAttachmentId}.png`);
      yield* Effect.all(
        [
          fileSystem.writeFile(stalePath, new Uint8Array([1])),
          fileSystem.writeFile(keptPath, new Uint8Array([2])),
          fileSystem.writeFile(otherThreadPath, new Uint8Array([3])),
        ],
        { concurrency: 1 },
      );

      yield* eventStore.append({
        eventId: EventId.make("event-attachment-project"),
        aggregateKind: "project",
        aggregateId: projectId,
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.make("command-attachment-project"),
        causationEventId: null,
        correlationId: CommandId.make("command-attachment-project"),
        metadata: {},
        payload: {
          projectId,
          title: "Sync project",
          workspaceRoot: "C:/work/sync",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      const attachment = (id: string, name: string) => ({
        type: "image" as const,
        id,
        name,
        mimeType: "image/png",
        sizeBytes: 1,
      });
      const firstThread: OrchestrationThread = {
        ...importedThread(threadId, "First import", null),
        messages: [
          {
            id: MessageId.make("message-first-import"),
            role: "user",
            text: "first",
            attachments: [
              attachment(staleAttachmentId, "stale.png"),
              attachment(keptAttachmentId, "kept.png"),
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        ],
      };
      const secondThread: OrchestrationThread = {
        ...importedThread(threadId, "Second import", null),
        messages: [
          {
            id: MessageId.make("message-second-import"),
            role: "user",
            text: "second",
            attachments: [attachment(keptAttachmentId, "kept.png")],
            turnId: null,
            streaming: false,
            createdAt: importedAt,
            updatedAt: importedAt,
          },
        ],
      };

      for (const [index, thread] of [firstThread, secondThread].entries()) {
        const revision = index + 1;
        yield* eventStore.append({
          eventId: EventId.make(`event-attachment-import-${String(revision)}`),
          aggregateKind: "thread",
          aggregateId: threadId,
          type: "thread.sync-imported",
          occurredAt: revision === 1 ? now : importedAt,
          commandId: CommandId.make(`command-attachment-import-${String(revision)}`),
          causationEventId: null,
          correlationId: CommandId.make(`command-attachment-import-${String(revision)}`),
          metadata: {},
          payload: {
            threadId,
            sourceRevision: `revision-${String(revision)}`,
            sourceHash: `hash-${String(revision)}`,
            importedAt: revision === 1 ? now : importedAt,
            thread,
            turns: [],
            bindingUpdates: [],
          },
        });
      }

      yield* pipeline.bootstrap;

      assert.isFalse(yield* fileSystem.exists(stalePath));
      assert.isTrue(yield* fileSystem.exists(keptPath));
      assert.isTrue(yield* fileSystem.exists(otherThreadPath));
    }),
  );

  it.effect("rolls back the imported thread when co-agent materialization fails", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const pipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      const parentThreadId = ThreadId.make("thread-rollback-parent");
      const childThreadId = ThreadId.make("thread-rollback-child");

      yield* sql`
        CREATE TRIGGER fail_imported_coagent
        BEFORE INSERT ON coagent_threads
        WHEN NEW.child_thread_id = 'thread-rollback-child'
        BEGIN
          SELECT RAISE(ABORT, 'forced-coagent-failure');
        END
      `;
      yield* eventStore.append({
        eventId: EventId.make("event-rollback-project"),
        aggregateKind: "project",
        aggregateId: projectId,
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.make("command-rollback-project"),
        causationEventId: null,
        correlationId: CommandId.make("command-rollback-project"),
        metadata: {},
        payload: {
          projectId,
          title: "Sync project",
          workspaceRoot: "C:/work/sync",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* eventStore.append({
        eventId: EventId.make("event-rollback-child"),
        aggregateKind: "thread",
        aggregateId: childThreadId,
        type: "thread.sync-imported",
        occurredAt: importedAt,
        commandId: CommandId.make("command-rollback-child"),
        causationEventId: null,
        correlationId: CommandId.make("command-rollback-child"),
        metadata: {},
        payload: {
          threadId: childThreadId,
          sourceRevision: "revision-rollback",
          sourceHash: "hash-rollback",
          importedAt,
          thread: importedThread(childThreadId, "Rollback child", {
            parentThreadId,
            creationMode: "blank",
            status: "ready",
          }),
          turns: [],
          bindingUpdates: [],
        },
      });

      const result = yield* Effect.result(pipeline.bootstrap);
      assert.equal(result._tag, "Failure");

      const threads = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM projection_threads
        WHERE thread_id = ${childThreadId}
      `;
      const links = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM coagent_threads
        WHERE child_thread_id = ${childThreadId}
      `;
      assert.deepEqual(threads, [{ count: 0 }]);
      assert.deepEqual(links, [{ count: 0 }]);
    }),
  );
});
