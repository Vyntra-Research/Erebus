import { CommandId, EventId, ProjectId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceDecodeError } from "../Errors.ts";
import { OrchestrationEventStore } from "../Services/OrchestrationEventStore.ts";
import { OrchestrationEventStoreLive } from "./OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
const isPersistenceDecodeError = Schema.is(PersistenceDecodeError);

const layer = it.layer(
  OrchestrationEventStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("OrchestrationEventStore", (it) => {
  it.effect("stores json columns as strings and replays decoded events", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";

      const appended = yield* eventStore.append({
        type: "project.created",
        eventId: EventId.make("evt-store-roundtrip"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-roundtrip"),
        occurredAt: now,
        commandId: CommandId.make("cmd-store-roundtrip"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-store-roundtrip"),
        metadata: {
          adapterKey: "codex",
        },
        payload: {
          projectId: ProjectId.make("project-roundtrip"),
          title: "Roundtrip Project",
          workspaceRoot: "/tmp/project-roundtrip",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      const storedRows = yield* sql<{
        readonly payloadJson: string;
        readonly metadataJson: string;
      }>`
        SELECT
          payload_json AS "payloadJson",
          metadata_json AS "metadataJson"
        FROM orchestration_events
        WHERE event_id = ${appended.eventId}
      `;
      assert.equal(storedRows.length, 1);
      assert.equal(typeof storedRows[0]?.payloadJson, "string");
      assert.equal(typeof storedRows[0]?.metadataJson, "string");

      const replayed = yield* Stream.runCollect(eventStore.readFromSequence(0, 10)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      assert.equal(replayed.length, 1);
      assert.equal(replayed[0]?.type, "project.created");
      assert.equal(replayed[0]?.metadata.adapterKey, "codex");
    }),
  );

  it.effect("fails with PersistenceDecodeError when stored json is invalid", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";

      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES (
          ${EventId.make("evt-store-invalid-json")},
          ${"project"},
          ${ProjectId.make("project-invalid-json")},
          ${0},
          ${"project.created"},
          ${now},
          ${CommandId.make("cmd-store-invalid-json")},
          ${null},
          ${null},
          ${"server"},
          ${"{"},
          ${"{}"}
        )
      `;

      const replayResult = yield* Effect.result(
        Stream.runCollect(eventStore.readFromSequence(0, 10)),
      );
      assert.equal(replayResult._tag, "Failure");
      if (replayResult._tag === "Failure") {
        assert.ok(isPersistenceDecodeError(replayResult.failure));
        assert.ok(
          replayResult.failure.operation.includes(
            "OrchestrationEventStore.readFromSequence:decodeRows",
          ),
        );
      }
    }),
  );

  it.effect("bounds latest-type lookups to one aggregate stream", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const targetThreadId = ThreadId.make("thread-target-boundary");
      const now = "2026-01-01T00:00:00.000Z";

      yield* sql`
        WITH RECURSIVE sequence(value) AS (
          SELECT 0
          UNION ALL
          SELECT value + 1 FROM sequence WHERE value < 499
        )
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        SELECT
          'evt-unrelated-' || value,
          'thread',
          'thread-unrelated',
          value,
          'thread.message-sent',
          ${now},
          NULL,
          NULL,
          NULL,
          'server',
          '{}',
          '{}'
        FROM sequence
      `;

      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES
          (
            'evt-target-import', 'thread', ${targetThreadId}, 0, 'thread.sync-imported',
            ${now}, NULL, NULL, NULL, 'server', '{}', '{}'
          ),
          (
            'evt-target-message', 'thread', ${targetThreadId}, 1, 'thread.message-sent',
            ${now}, NULL, NULL, NULL, 'server', '{}', '{}'
          ),
          (
            'evt-target-consumed', 'thread', ${targetThreadId}, 2, 'thread.import-context-consumed',
            ${now}, NULL, NULL, NULL, 'server', '{}', '{}'
          )
      `;

      const latestType = yield* eventStore.readLatestAggregateEventType({
        aggregateKind: "thread",
        aggregateId: targetThreadId,
        eventTypes: ["thread.sync-imported", "thread.import-context-consumed"],
      });
      assert.equal(latestType, "thread.import-context-consumed");

      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT event_type
        FROM orchestration_events
        WHERE aggregate_kind = 'thread'
          AND stream_id = ${targetThreadId}
          AND event_type IN ('thread.sync-imported', 'thread.import-context-consumed')
        ORDER BY stream_version DESC
        LIMIT 1
      `;
      assert.ok(
        plan.some(
          ({ detail }) =>
            detail.includes("idx_orch_events_stream_version") &&
            detail.includes("aggregate_kind") &&
            detail.includes("stream_id"),
        ),
      );
    }),
  );
});
