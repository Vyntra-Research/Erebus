import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  EventId,
  MessageId,
  OrchestrationProposedPlanId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  ThreadSyncImportStageId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationThread,
  type ThreadSyncImportV2Descriptor,
  type ThreadSyncImportV2Record,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import {
  findThreadSyncImportStageProgress,
  prepareThreadSyncImportStage,
  threadSyncImportRecordsHash,
  threadSyncImportDescriptorHash,
  validateThreadSyncImportStage,
} from "../ThreadSyncImportProjection.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";

const TestLayer = OrchestrationProjectionPipelineLive.pipe(
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-sync-import-v2-test-" })),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

const now = "2026-10-17T12:00:00.000Z";
const importedAt = "2026-10-17T12:05:00.000Z";
const projectId = ProjectId.make("project-sync-v2");
const threadId = ThreadId.make("thread-sync-v2");
const turnId = TurnId.make("turn-sync-v2");
const portableTurnId = TurnId.make("portable-turn-sync-v2");
const stageId = ThreadSyncImportStageId.make("stage-sync-v2");
const sourceRevision = "a".repeat(64);
const sourceHash = "b".repeat(64);

type ThreadSyncImportedEvent = Extract<
  OrchestrationEvent,
  { readonly type: "thread.sync-imported" }
>;

function sha256(text: string): string {
  return NodeCrypto.createHash("sha256").update(text, "utf8").digest("hex");
}

const importedText = "the complete imported answer crosses fragment boundaries";
const firstText = importedText.slice(0, 29);
const secondText = importedText.slice(29);
const messageId = MessageId.make("message-sync-v2");
const portableMessageId = MessageId.make("portable-message-sync-v2");

const records: ReadonlyArray<ThreadSyncImportV2Record> = [
  {
    ordinal: 0,
    kind: "turn",
    portableId: portableTurnId,
    value: {
      turnId,
      pendingMessageId: null,
      sourceProposedPlanThreadId: null,
      sourceProposedPlanId: null,
      assistantMessageId: messageId,
      state: "completed",
      requestedAt: now,
      startedAt: now,
      completedAt: importedAt,
    },
  },
  {
    ordinal: 1,
    kind: "message",
    portableId: portableMessageId,
    value: {
      id: messageId,
      role: "assistant",
      text: {
        sha256: sha256(importedText),
        sizeBytes: Buffer.byteLength(importedText, "utf8"),
        fragmentCount: 2,
      },
      attachments: [],
      turnId,
      streaming: false,
      createdAt: now,
      updatedAt: importedAt,
    },
  },
  {
    ordinal: 2,
    kind: "message-text",
    messageId,
    fragmentIndex: 0,
    text: firstText,
  },
  {
    ordinal: 3,
    kind: "message-text",
    messageId,
    fragmentIndex: 1,
    text: secondText,
  },
];

const descriptor: ThreadSyncImportV2Descriptor = {
  stageId,
  mode: "replace",
  threadId,
  projectId,
  expectedLocalUpdatedAt: now,
  header: {
    title: "Imported v2 thread",
    coagent: null,
    latestTurnId: turnId,
    lifecycle: {
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      deletedAt: null,
    },
    createdAt: now,
    updatedAt: importedAt,
  },
  sourceRevision,
  sourceHash,
  recordCount: records.length,
  bindingUpdates: [
    {
      syncThreadId: ThreadId.make("portable-thread-sync-v2"),
      localThreadId: threadId,
      syncProjectId: "portable-project-sync-v2",
      localProjectId: projectId,
      baseRevision: sourceRevision,
    },
  ],
};

function importedThread(): OrchestrationThread {
  return {
    id: threadId,
    projectId,
    title: descriptor.header.title,
    coagent: null,
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex-local"),
      model: "gpt-local",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "local-branch",
    worktreePath: "C:/work/sync-v2",
    linkedPullRequest: null,
    latestTurn: {
      turnId,
      state: "completed",
      requestedAt: now,
      startedAt: now,
      completedAt: importedAt,
      assistantMessageId: messageId,
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
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  };
}

function projectEventBase(
  type: "project.created" | "thread.created" | "thread.message-sent",
  id: string,
): Pick<
  Omit<OrchestrationEvent, "sequence">,
  | "eventId"
  | "aggregateKind"
  | "aggregateId"
  | "type"
  | "occurredAt"
  | "commandId"
  | "causationEventId"
  | "correlationId"
  | "metadata"
> {
  const commandId = CommandId.make(`command-${id}`);
  return {
    eventId: EventId.make(`event-${id}`),
    aggregateKind: type === "project.created" ? "project" : "thread",
    aggregateId: type === "project.created" ? projectId : threadId,
    type,
    occurredAt: now,
    commandId,
    causationEventId: null,
    correlationId: commandId,
    metadata: {},
  };
}

const appendOldState = Effect.fn("appendOldThreadSyncV2State")(function* () {
  const eventStore = yield* OrchestrationEventStore;
  yield* eventStore.append({
    ...projectEventBase("project.created", "sync-v2-project"),
    type: "project.created",
    payload: {
      projectId,
      title: "Sync v2 project",
      workspaceRoot: "C:/work/sync-v2",
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  });
  yield* eventStore.append({
    ...projectEventBase("thread.created", "sync-v2-thread"),
    type: "thread.created",
    payload: {
      threadId,
      projectId,
      title: "Old thread",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex-local"),
        model: "gpt-local",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "local-branch",
      worktreePath: "C:/work/sync-v2",
      createdAt: now,
      updatedAt: now,
    },
  });
  yield* eventStore.append({
    ...projectEventBase("thread.message-sent", "sync-v2-old-message"),
    type: "thread.message-sent",
    payload: {
      threadId,
      messageId: MessageId.make("message-sync-v2-old"),
      role: "user",
      text: "old history remains until commit",
      turnId: null,
      streaming: false,
      createdAt: now,
      updatedAt: now,
    },
  });
});

function startEvent(
  stageDescriptor: ThreadSyncImportV2Descriptor = descriptor,
  startedAt: string = now,
): Omit<OrchestrationEvent, "sequence"> {
  const commandId = CommandId.make(`command-sync-v2-start-${stageDescriptor.stageId}`);
  return {
    eventId: EventId.make(`event-sync-v2-start-${stageDescriptor.stageId}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.sync-import-v2.started",
    occurredAt: startedAt,
    commandId,
    causationEventId: null,
    correlationId: commandId,
    metadata: {},
    payload: { descriptor: stageDescriptor, startedAt },
  };
}

function chunkEvent(
  chunkIndex: number,
  chunkRecords: ReadonlyArray<ThreadSyncImportV2Record>,
  selectedStageId: ThreadSyncImportStageId = stageId,
): Omit<OrchestrationEvent, "sequence"> {
  const commandId = CommandId.make(`command-sync-v2-chunk-${selectedStageId}-${chunkIndex}`);
  return {
    eventId: EventId.make(`event-sync-v2-chunk-${selectedStageId}-${chunkIndex}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.sync-import-v2.chunk-appended",
    occurredAt: now,
    commandId,
    causationEventId: null,
    correlationId: commandId,
    metadata: {},
    payload: {
      stageId: selectedStageId,
      threadId,
      chunkIndex,
      chunkHash: threadSyncImportRecordsHash(chunkRecords),
      records: chunkRecords,
      appendedAt: now,
    },
  };
}

function commitEvent(stagedHash: string): Omit<ThreadSyncImportedEvent, "sequence"> {
  const commandId = CommandId.make("command-sync-v2-commit");
  return {
    eventId: EventId.make("event-sync-v2-commit"),
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.sync-imported",
    occurredAt: importedAt,
    commandId,
    causationEventId: null,
    correlationId: commandId,
    metadata: {},
    payload: {
      threadId,
      sourceRevision,
      sourceHash,
      importedAt,
      thread: importedThread(),
      turns: [],
      bindingUpdates: descriptor.bindingUpdates,
      stagedImport: {
        stageId,
        recordCount: records.length,
        stagedHash,
      },
    },
  };
}

function validatedEvent(
  stagedHash: string,
): Omit<
  Extract<OrchestrationEvent, { readonly type: "thread.sync-import-v2.validated" }>,
  "sequence"
> {
  const commandId = CommandId.make("command-sync-v2-validated");
  return {
    eventId: EventId.make("event-sync-v2-validated"),
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.sync-import-v2.validated",
    occurredAt: importedAt,
    commandId,
    causationEventId: null,
    correlationId: commandId,
    metadata: {},
    payload: {
      stageId,
      threadId,
      recordCount: records.length,
      descriptorHash: threadSyncImportDescriptorHash({ ...descriptor, stagedHash }),
      stagedHash,
      validatedAt: importedAt,
    },
  };
}

it.layer(TestLayer)("thread sync v2 staged projection", (it) => {
  it.effect("replays chunks in event order and exposes the full history only after commit", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const pipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;

      yield* appendOldState();
      yield* eventStore.append(startEvent());
      yield* eventStore.append(chunkEvent(0, records.slice(0, 2)));
      yield* eventStore.append(chunkEvent(1, records.slice(2)));
      const stagedHash = threadSyncImportRecordsHash(records);
      yield* eventStore.append(validatedEvent(stagedHash));
      yield* eventStore.append(commitEvent(stagedHash));
      yield* eventStore.append({
        ...projectEventBase("thread.message-sent", "sync-v2-after-import"),
        type: "thread.message-sent",
        occurredAt: "2026-10-17T12:06:00.000Z",
        payload: {
          threadId,
          messageId: MessageId.make("message-sync-v2-after"),
          role: "assistant",
          text: "continued after import",
          turnId: null,
          streaming: false,
          createdAt: "2026-10-17T12:06:00.000Z",
          updatedAt: "2026-10-17T12:06:00.000Z",
        },
      });

      yield* pipeline.bootstrap;

      const messages = yield* sql<{
        readonly messageId: string;
        readonly portableId: string | null;
        readonly text: string;
      }>`
        SELECT message_id AS "messageId", sync_portable_id AS "portableId", text
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, message_id ASC
      `;
      assert.deepEqual(messages, [
        { messageId, portableId: portableMessageId, text: importedText },
        {
          messageId: "message-sync-v2-after",
          portableId: null,
          text: "continued after import",
        },
      ]);
      const turns = yield* sql<{
        readonly turnId: string;
        readonly portableId: string | null;
        readonly state: string;
      }>`
        SELECT turn_id AS "turnId", sync_portable_id AS "portableId", state
        FROM projection_turns
        WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(turns, [{ turnId, portableId: portableTurnId, state: "completed" }]);
      const staging = yield* sql<{ readonly count: number }>`
        SELECT
          (SELECT COUNT(*) FROM thread_sync_import_stages) +
          (SELECT COUNT(*) FROM thread_sync_import_chunks) +
          (SELECT COUNT(*) FROM thread_sync_import_records) AS count
      `;
      assert.deepEqual(staging, [{ count: 0 }]);
    }),
  );
});

it.layer(TestLayer)("thread sync v2 failed precommit", (it) => {
  it.effect("keeps old projections, appends no final event, and accepts an exact chunk retry", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const pipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;

      yield* appendOldState();
      yield* pipeline.bootstrap;
      const started = yield* eventStore.append(startEvent());
      yield* pipeline.projectEvent(started);
      const firstChunk = yield* eventStore.append(chunkEvent(0, records.slice(0, 2)));
      yield* pipeline.projectEvent(firstChunk);
      yield* pipeline.projectEvent(firstChunk);

      const secondChunk = yield* eventStore.append(chunkEvent(1, records.slice(2)));
      yield* pipeline.projectEvent(secondChunk);
      const badHash = "f".repeat(64);
      const failure = yield* Effect.flip(
        validateThreadSyncImportStage({
          descriptor: { ...descriptor, stagedHash: badHash },
          stagedHash: badHash,
        }),
      );
      assert.match(String(failure), /failed its final hash validation/);

      const finalEvents = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM orchestration_events
        WHERE event_type = 'thread.sync-imported'
      `;
      assert.equal(finalEvents[0]?.count, 0);

      const messages = yield* sql<{ readonly messageId: string; readonly text: string }>`
        SELECT message_id AS "messageId", text
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(messages, [
        { messageId: "message-sync-v2-old", text: "old history remains until commit" },
      ]);
      const stagedRecords = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM thread_sync_import_records
        WHERE stage_id = ${stageId}
      `;
      assert.deepEqual(stagedRecords, [{ count: records.length }]);

      const stagedHash = threadSyncImportRecordsHash(records);
      yield* validateThreadSyncImportStage({
        descriptor: { ...descriptor, stagedHash },
        stagedHash,
      });
      yield* pipeline.projectEvent(yield* eventStore.append(validatedEvent(stagedHash)));
      yield* pipeline.projectEvent(yield* eventStore.append(commitEvent(stagedHash)));
      const imported = yield* sql<{ readonly text: string }>`
        SELECT text
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(imported, [{ text: importedText }]);
    }),
  );
});

it.layer(TestLayer)("thread sync v2 interleaved stages", (it) => {
  it.effect("keeps interleaved deterministic stages recoverable across A/B/A retries", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const pipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      yield* appendOldState();
      yield* pipeline.bootstrap;

      const otherStageId = ThreadSyncImportStageId.make("stage-sync-v2-other");
      const otherDescriptor: ThreadSyncImportV2Descriptor = {
        ...descriptor,
        stageId: otherStageId,
        sourceRevision: "c".repeat(64),
        sourceHash: "d".repeat(64),
      };
      const firstStart = yield* eventStore.append(startEvent());
      const otherStart = yield* eventStore.append(startEvent(otherDescriptor));
      yield* pipeline.projectEvent(firstStart);
      yield* pipeline.projectEvent(otherStart);
      yield* pipeline.projectEvent(firstStart);

      const firstChunk = yield* eventStore.append(chunkEvent(0, records.slice(0, 2)));
      yield* pipeline.projectEvent(firstChunk);

      const stages = yield* sql<{
        readonly stageId: string;
        readonly recordCount: number;
        readonly nextChunkIndex: number;
        readonly nextOrdinal: number;
      }>`
        SELECT
          stage.stage_id AS "stageId",
          COUNT(record.ordinal) AS "recordCount",
          stage.next_chunk_index AS "nextChunkIndex",
          stage.next_ordinal AS "nextOrdinal"
        FROM thread_sync_import_stages AS stage
        LEFT JOIN thread_sync_import_records AS record ON record.stage_id = stage.stage_id
        WHERE stage.thread_id = ${threadId}
        GROUP BY stage.stage_id
        ORDER BY stage.stage_id
      `;
      assert.deepEqual(stages, [
        { stageId, recordCount: 2, nextChunkIndex: 1, nextOrdinal: 2 },
        { stageId: otherStageId, recordCount: 0, nextChunkIndex: 0, nextOrdinal: 0 },
      ]);
      const resumed = yield* findThreadSyncImportStageProgress({
        descriptor: {
          ...descriptor,
          stageId: ThreadSyncImportStageId.make("new-attempt-identity-is-ignored"),
        },
        now: importedAt,
      });
      assert.deepEqual(resumed, { stageId, nextChunkIndex: 1, nextOrdinal: 2 });
    }),
  );
});

it.layer(TestLayer)("thread sync v2 relational validation", (it) => {
  it.effect(
    "rejects staged history with v1-invalid turn relations before swapping projections",
    () =>
      Effect.gen(function* () {
        const eventStore = yield* OrchestrationEventStore;
        const pipeline = yield* OrchestrationProjectionPipeline;
        const sql = yield* SqlClient.SqlClient;
        const invalidRecords = records.map((record) =>
          record.kind === "message"
            ? {
                ...record,
                value: { ...record.value, turnId: TurnId.make("missing-imported-turn") },
              }
            : record,
        );

        yield* appendOldState();
        yield* pipeline.bootstrap;
        yield* pipeline.projectEvent(yield* eventStore.append(startEvent()));
        yield* pipeline.projectEvent(yield* eventStore.append(chunkEvent(0, invalidRecords)));
        const invalidHash = threadSyncImportRecordsHash(invalidRecords);
        const failure = yield* Effect.flip(
          validateThreadSyncImportStage({
            descriptor: { ...descriptor, stagedHash: invalidHash },
            stagedHash: invalidHash,
          }),
        );
        assert.match(String(failure), /references a missing turn/);

        const finalEvents = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count
          FROM orchestration_events
          WHERE event_type = 'thread.sync-imported'
        `;
        assert.equal(finalEvents[0]?.count, 0);
        yield* pipeline.bootstrap;

        const messages = yield* sql<{ readonly messageId: string }>`
        SELECT message_id AS "messageId"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
      `;
        assert.deepEqual(messages, [{ messageId: "message-sync-v2-old" }]);
      }),
  );
});

it.layer(TestLayer)("thread sync v2 reconstructed text validation", (it) => {
  it.effect("rejects blank reconstructed plan text before swapping projections", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const pipeline = yield* OrchestrationProjectionPipeline;
      const localPlanId = OrchestrationProposedPlanId.make("plan-sync-v2-blank");
      const portablePlanId = OrchestrationProposedPlanId.make("portable-plan-sync-v2-blank");
      const blank = " \n\t ";
      const blankRecords: ReadonlyArray<ThreadSyncImportV2Record> = [
        {
          ordinal: 0,
          kind: "plan",
          portableId: portablePlanId,
          value: {
            id: localPlanId,
            turnId: null,
            planMarkdown: {
              sha256: sha256(blank),
              sizeBytes: Buffer.byteLength(blank, "utf8"),
              fragmentCount: 1,
            },
            implementedAt: null,
            implementationThreadId: null,
            createdAt: now,
            updatedAt: importedAt,
          },
        },
        {
          ordinal: 1,
          kind: "plan-markdown",
          planId: localPlanId,
          fragmentIndex: 0,
          text: blank,
        },
      ];
      const blankDescriptor: ThreadSyncImportV2Descriptor = {
        ...descriptor,
        header: { ...descriptor.header, latestTurnId: null },
        recordCount: blankRecords.length,
      };
      yield* appendOldState();
      yield* pipeline.bootstrap;
      yield* pipeline.projectEvent(yield* eventStore.append(startEvent(blankDescriptor)));
      yield* pipeline.projectEvent(yield* eventStore.append(chunkEvent(0, blankRecords)));
      const blankHash = threadSyncImportRecordsHash(blankRecords);
      const failure = yield* Effect.flip(
        validateThreadSyncImportStage({
          descriptor: { ...blankDescriptor, stagedHash: blankHash },
          stagedHash: blankHash,
        }),
      );
      assert.match(String(failure), /reconstructed blank plan or activity text/);
      yield* pipeline.bootstrap;
    }),
  );
});

it.layer(TestLayer)("thread sync v2 bounded preparation", (it) => {
  it.effect("materializes only a bounded latest tail and skips one oversized visible item", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const pipeline = yield* OrchestrationProjectionPipeline;
      const largeRecords: ThreadSyncImportV2Record[] = [];
      let ordinal = 0;
      for (let index = 0; index < 130; index += 1) {
        const localMessageId = MessageId.make(`message-sync-v2-tail-${index}`);
        const portableId = MessageId.make(`portable-message-sync-v2-tail-${index}`);
        const messageText = `message ${index}`;
        largeRecords.push(
          {
            ordinal: ordinal++,
            kind: "message",
            portableId,
            value: {
              id: localMessageId,
              role: "assistant",
              text: {
                sha256: sha256(messageText),
                sizeBytes: Buffer.byteLength(messageText, "utf8"),
                fragmentCount: 1,
              },
              attachments: [],
              turnId: null,
              streaming: false,
              createdAt: now,
              updatedAt: importedAt,
            },
          },
          {
            ordinal: ordinal++,
            kind: "message-text",
            messageId: localMessageId,
            fragmentIndex: 0,
            text: messageText,
          },
        );
      }
      const oversizedText = "x".repeat(300 * 1024);
      const oversizedMessageId = MessageId.make("message-sync-v2-tail-oversized");
      largeRecords.push(
        {
          ordinal: ordinal++,
          kind: "message",
          portableId: MessageId.make("portable-message-sync-v2-tail-oversized"),
          value: {
            id: oversizedMessageId,
            role: "assistant",
            text: {
              sha256: sha256(oversizedText),
              sizeBytes: Buffer.byteLength(oversizedText, "utf8"),
              fragmentCount: 2,
            },
            attachments: [],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: importedAt,
          },
        },
        {
          ordinal: ordinal++,
          kind: "message-text",
          messageId: oversizedMessageId,
          fragmentIndex: 0,
          text: oversizedText.slice(0, 150 * 1024),
        },
        {
          ordinal: ordinal++,
          kind: "message-text",
          messageId: oversizedMessageId,
          fragmentIndex: 1,
          text: oversizedText.slice(150 * 1024),
        },
      );
      const largeDescriptor: ThreadSyncImportV2Descriptor = {
        ...descriptor,
        header: { ...descriptor.header, latestTurnId: null },
        recordCount: largeRecords.length,
      };

      yield* appendOldState();
      yield* pipeline.bootstrap;
      yield* pipeline.projectEvent(yield* eventStore.append(startEvent(largeDescriptor)));
      for (let index = 0; index < largeRecords.length; index += 64) {
        yield* pipeline.projectEvent(
          yield* eventStore.append(chunkEvent(index / 64, largeRecords.slice(index, index + 64))),
        );
      }

      const prepared = yield* prepareThreadSyncImportStage({ descriptor: largeDescriptor });
      assert.equal(prepared.stagedHash, threadSyncImportRecordsHash(largeRecords));
      assert.equal(prepared.visibleHistory.messages.length, 127);
      assert.equal(prepared.visibleHistory.messages[0]?.text, "message 3");
      assert.equal(prepared.visibleHistory.messages.at(-1)?.text, "message 129");
      assert.isFalse(
        prepared.visibleHistory.messages.some((message) => message.id === oversizedMessageId),
      );
    }),
  );
});

it.layer(TestLayer)("thread sync v2 stage retention", (it) => {
  it.effect("collects stale attempts and caps live attempts per thread", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const pipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      yield* appendOldState();
      yield* pipeline.bootstrap;

      const staleStageId = ThreadSyncImportStageId.make("stage-sync-v2-stale");
      const staleDescriptor = { ...descriptor, stageId: staleStageId };
      yield* pipeline.projectEvent(
        yield* eventStore.append(startEvent(staleDescriptor, "2026-10-15T00:00:00.000Z")),
      );
      for (let index = 0; index < 9; index += 1) {
        const selectedStageId = ThreadSyncImportStageId.make(`stage-sync-v2-live-${index}`);
        const selectedDescriptor = {
          ...descriptor,
          stageId: selectedStageId,
          sourceRevision: `${index}`.repeat(64).slice(0, 64),
          sourceHash: `${9 - index}`.repeat(64).slice(0, 64),
        };
        yield* pipeline.projectEvent(
          yield* eventStore.append(startEvent(selectedDescriptor, importedAt)),
        );
      }

      const stages = yield* sql<{ readonly stageId: string }>`
        SELECT stage_id AS "stageId"
        FROM thread_sync_import_stages
        WHERE thread_id = ${threadId}
        ORDER BY stage_id ASC
      `;
      assert.equal(stages.length, 8);
      assert.isFalse(stages.some((stage) => stage.stageId === staleStageId));
      assert.isFalse(stages.some((stage) => stage.stageId === "stage-sync-v2-live-0"));
    }),
  );
});
