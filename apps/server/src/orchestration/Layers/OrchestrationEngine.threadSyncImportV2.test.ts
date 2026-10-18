import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  ThreadSyncImportStageId,
  type ThreadSyncImportV2Descriptor,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import {
  threadSyncImportDescriptorHash,
  threadSyncImportRecordsHash,
} from "../ThreadSyncImportProjection.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const now = "2026-10-17T12:00:00.000Z";
const importedAt = "2026-10-17T12:05:00.000Z";
const projectId = ProjectId.make("project-sync-v2-engine");
const threadId = ThreadId.make("thread-sync-v2-engine");
const portableThreadId = ThreadId.make("portable-thread-sync-v2-engine");
const emptyStagedHash = threadSyncImportRecordsHash([]);
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const TestLayer = Layer.mergeAll(
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
  ),
  OrchestrationProjectionSnapshotQueryLive,
  OrchestrationProjectionPipelineLive,
).pipe(
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-sync-import-v2-engine-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

function descriptor(stageId: ThreadSyncImportStageId): ThreadSyncImportV2Descriptor {
  return {
    stageId,
    mode: "replace",
    threadId,
    projectId,
    expectedLocalUpdatedAt: now,
    header: {
      title: "Imported v2 engine thread",
      coagent: null,
      latestTurnId: null,
      lifecycle: {
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        deletedAt: null,
      },
      createdAt: now,
      updatedAt: importedAt,
    },
    sourceRevision: `revision-${stageId}`,
    sourceHash: `source-${stageId}`,
    recordCount: 0,
    bindingUpdates: [
      {
        syncThreadId: portableThreadId,
        localThreadId: threadId,
        syncProjectId: "portable-project-sync-v2-engine",
        localProjectId: projectId,
        baseRevision: `revision-${stageId}`,
      },
    ],
  };
}

function descriptorWithRecordCount(
  stageId: ThreadSyncImportStageId,
  recordCount: number,
): ThreadSyncImportV2Descriptor {
  return { ...descriptor(stageId), recordCount };
}

it.layer(TestLayer)("thread sync v2 engine receipts", (it) => {
  it.effect(
    "rejects an unvalidated direct v2 commit without poisoning replay and keeps A/B/A receipts safe",
    () =>
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const pipeline = yield* OrchestrationProjectionPipeline;
        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("sync-v2-engine-project-create"),
          projectId,
          title: "Sync v2 engine project",
          workspaceRoot: "C:/work/sync-v2-engine",
          defaultModelSelection: null,
          createdAt: now,
        });
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("sync-v2-engine-thread-create"),
          threadId,
          projectId,
          title: "Old engine thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex-local"),
            model: "gpt-local",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now,
        });

        const stageA = ThreadSyncImportStageId.make("sync-v2-engine-stage-a");
        const stageB = ThreadSyncImportStageId.make("sync-v2-engine-stage-b");
        const descriptorA = descriptor(stageA);
        const descriptorB = descriptor(stageB);
        const startA = {
          type: "thread.sync.import-v2.start" as const,
          commandId: CommandId.make("sync-v2-engine-start-a"),
          descriptor: descriptorA,
          startedAt: now,
        };
        yield* engine.dispatch(startA);
        yield* engine.dispatch({
          type: "thread.sync.import-v2.start",
          commandId: CommandId.make("sync-v2-engine-start-b"),
          descriptor: descriptorB,
          startedAt: now,
        });
        yield* engine.dispatch(startA);

        const finalDescriptorA = { ...descriptorA, stagedHash: emptyStagedHash };
        const commitA = {
          type: "thread.sync.import-v2.commit" as const,
          commandId: CommandId.make("sync-v2-engine-commit-a"),
          descriptor: finalDescriptorA,
          visibleHistory: {
            latestTurn: null,
            messages: [],
            proposedPlans: [],
            activities: [],
          },
          importedAt,
        };
        const rejectedCommit = yield* Effect.flip(engine.dispatch(commitA));
        expect(String(rejectedCommit)).toContain("is not durably validated");
        yield* pipeline.bootstrap;

        const eventsAfterRejectedCommit = yield* Stream.runCollect(engine.readEvents(0)).pipe(
          Effect.map((events) => Array.from(events)),
        );
        expect(
          eventsAfterRejectedCommit.filter((event) => event.type === "thread.sync-imported"),
        ).toHaveLength(0);

        yield* engine.dispatch({
          type: "thread.sync.import-v2.validate",
          commandId: CommandId.make("sync-v2-engine-validate-a"),
          descriptor: finalDescriptorA,
          descriptorHash: threadSyncImportDescriptorHash(finalDescriptorA),
          stagedHash: emptyStagedHash,
          validatedAt: importedAt,
        });
        yield* engine.dispatch(commitA);
        yield* engine.dispatch(startA);

        const eventsAfterCommit = yield* Stream.runCollect(engine.readEvents(0)).pipe(
          Effect.map((events) => Array.from(events)),
        );
        expect(
          eventsAfterCommit.filter((event) => event.type === "thread.sync-imported"),
        ).toHaveLength(1);
        const stages = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{ readonly stageId: string }>`
          SELECT stage_id AS "stageId"
          FROM thread_sync_import_stages
          ORDER BY stage_id
        `;
        });
        expect(stages).toEqual([{ stageId: stageB }]);
        const importedThreads = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{ readonly unsettledAt: string | null }>`
            SELECT unsettled_at AS "unsettledAt"
            FROM projection_threads
            WHERE thread_id = ${threadId}
          `;
        });
        expect(importedThreads).toEqual([{ unsettledAt: importedAt }]);
      }),
  );

  it.effect("stores chunk contents once in crash-safe staging and only a reference in events", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;
      const payloadProjectId = ProjectId.make("project-sync-v2-engine-payload");
      const payloadThreadId = ThreadId.make("thread-sync-v2-engine-payload");
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("sync-v2-engine-project-create-payload"),
        projectId: payloadProjectId,
        title: "Sync v2 event payload project",
        workspaceRoot: "C:/work/sync-v2-event-payload",
        defaultModelSelection: null,
        createdAt: now,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("sync-v2-engine-thread-create-payload"),
        threadId: payloadThreadId,
        projectId: payloadProjectId,
        title: "Old payload thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex-local"),
          model: "gpt-local",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: now,
      });

      const stageId = ThreadSyncImportStageId.make("sync-v2-engine-stage-payload");
      const stagedDescriptor: ThreadSyncImportV2Descriptor = {
        ...descriptorWithRecordCount(stageId, 1),
        threadId: payloadThreadId,
        projectId: payloadProjectId,
        bindingUpdates: [
          {
            syncThreadId: ThreadId.make("portable-thread-sync-v2-engine-payload"),
            localThreadId: payloadThreadId,
            syncProjectId: "portable-project-sync-v2-engine-payload",
            localProjectId: payloadProjectId,
            baseRevision: `revision-${stageId}`,
          },
        ],
      };
      yield* engine.dispatch({
        type: "thread.sync.import-v2.start",
        commandId: CommandId.make("sync-v2-engine-start-payload"),
        descriptor: stagedDescriptor,
        startedAt: now,
      });

      const records = [
        {
          ordinal: 0,
          kind: "message-text" as const,
          messageId: MessageId.make("sync-v2-message-payload"),
          fragmentIndex: 0,
          text: "unique-transcript-payload-must-not-enter-event-store",
        },
      ];
      const chunkHash = threadSyncImportRecordsHash(records);
      const commandId = CommandId.make("sync-v2-engine-chunk-payload");
      const rejected = yield* engine
        .dispatch({
          type: "thread.sync.import-v2.chunk",
          commandId,
          stageId,
          threadId: payloadThreadId,
          chunkIndex: 0,
          chunkHash: "0".repeat(64),
          records,
          appendedAt: importedAt,
        })
        .pipe(Effect.flip);
      expect(String(rejected)).toContain("failed hash validation");
      expect(
        yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count
          FROM thread_sync_import_records
          WHERE stage_id = ${stageId}
        `,
      ).toEqual([{ count: 0 }]);

      // The failed transaction did not persist a receipt, so the exact command
      // identifier remains retryable after the source supplies the right hash.
      yield* engine.dispatch({
        type: "thread.sync.import-v2.chunk",
        commandId,
        stageId,
        threadId: payloadThreadId,
        chunkIndex: 0,
        chunkHash,
        records,
        appendedAt: importedAt,
      });

      const eventRows = yield* sql<{ readonly payloadJson: string }>`
        SELECT payload_json AS "payloadJson"
        FROM orchestration_events
        WHERE event_type = 'thread.sync-import-v2.chunk-appended'
      `;
      expect(eventRows).toHaveLength(1);
      expect(eventRows[0]!.payloadJson).not.toContain(records[0]!.text);
      expect(decodeJson(eventRows[0]!.payloadJson)).toMatchObject({
        stageId,
        threadId: payloadThreadId,
        chunkIndex: 0,
        chunkHash,
        firstOrdinal: 0,
        lastOrdinal: 0,
        recordCount: 1,
      });
      const stagedRows = yield* sql<{ readonly valueJson: string }>`
        SELECT value_json AS "valueJson"
        FROM thread_sync_import_records
        WHERE stage_id = ${stageId}
        ORDER BY ordinal ASC
      `;
      expect(stagedRows).toHaveLength(1);
      expect(stagedRows[0]!.valueJson).toContain(records[0]!.text);
    }),
  );
});
