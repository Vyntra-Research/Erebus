import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { compactLegacyToolOutputsBatch } from "./ToolOutputRetention.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

layer("legacy tool output retention", (it) => {
  it.effect("waits for idle and rewrites only the fixed legacy range", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const occurredAt = "2026-11-28T00:00:00.000Z";
      const rawOutput = `first useful line\n${"raw-output-sentinel".repeat(10_000)}`;
      const activity = {
        id: "activity-legacy-tool",
        createdAt: occurredAt,
        tone: "tool",
        kind: "tool.completed",
        summary: "Fetch issue",
        payload: {
          itemType: "mcp_tool_call",
          status: "completed",
          data: {
            item: {
              type: "mcpToolCall",
              id: "item-1",
              tool: "fetch_issue",
              server: "github",
              status: "completed",
              arguments: { issue: 42 },
              result: { content: [{ type: "text", text: rawOutput }] },
              _meta: { internal: true },
            },
          },
        },
        turnId: "turn-1",
      };

      yield* runMigrations({ toMigrationInclusive: 58 });
      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id, status, provider_name, provider_session_id,
          provider_thread_id, active_turn_id, last_error, updated_at
        ) VALUES (
          'thread-1', 'running', 'opencode', 'session-1',
          NULL, 'turn-1', NULL, ${occurredAt}
        )
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, command_id, causation_event_id, correlation_id,
          actor_kind, payload_json, metadata_json
        ) VALUES (
          'event-legacy-tool', 'thread', 'thread-1', 1, 'thread.activity-appended',
          ${occurredAt}, NULL, NULL, NULL,
          'provider', ${encodeJson({ threadId: "thread-1", activity })}, '{}'
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary,
          payload_json, sequence, created_at
        ) VALUES (
          ${activity.id}, 'thread-1', 'turn-1', 'tool', 'tool.completed',
          ${activity.summary}, ${encodeJson(activity.payload)}, 1, ${occurredAt}
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 59 });
      assert.deepStrictEqual(yield* compactLegacyToolOutputsBatch(sql), {
        status: "busy",
        scanned: 0,
        compacted: 0,
      });

      yield* sql`
        UPDATE projection_thread_sessions
        SET status = 'ready', active_turn_id = NULL
        WHERE thread_id = 'thread-1'
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, command_id, causation_event_id, correlation_id,
          actor_kind, payload_json, metadata_json
        ) VALUES (
          'event-after-target', 'thread', 'thread-1', 2, 'thread.activity-appended',
          ${occurredAt}, NULL, NULL, NULL,
          'provider', ${encodeJson({ threadId: "thread-1", activity: { ...activity, id: "activity-after-target" } })}, '{}'
        )
      `;

      assert.deepStrictEqual(yield* compactLegacyToolOutputsBatch(sql), {
        status: "complete",
        scanned: 1,
        compacted: 1,
      });

      const eventRows = yield* sql<{ readonly payloadJson: string }>`
        SELECT json_extract(payload_json, '$.activity.payload') AS "payloadJson"
        FROM orchestration_events
        WHERE event_id = 'event-legacy-tool'
      `;
      const projectionRows = yield* sql<{ readonly payloadJson: string }>`
        SELECT payload_json AS "payloadJson"
        FROM projection_thread_activities
        WHERE activity_id = ${activity.id}
      `;
      const untouchedRows = yield* sql<{ readonly payloadJson: string }>`
        SELECT payload_json AS "payloadJson"
        FROM orchestration_events
        WHERE event_id = 'event-after-target'
      `;
      const persisted = eventRows[0]!.payloadJson;

      assert.ok(persisted.length < 1_000);
      assert.ok(!persisted.includes("raw-output-sentinel"));
      assert.strictEqual(projectionRows[0]!.payloadJson, persisted);
      assert.ok(untouchedRows[0]!.payloadJson.includes("raw-output-sentinel"));
    }),
  );
});
