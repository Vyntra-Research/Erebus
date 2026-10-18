import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

interface QueryPlanRow {
  readonly detail: string;
}

function usesIndex(rows: ReadonlyArray<QueryPlanRow>, indexName: string): boolean {
  return rows.some((row) => row.detail.includes(indexName));
}

layer("052_ProjectionThreadTurnLookupIndexes", (it) => {
  it.effect("creates turn and actionable indexes used by bounded projection reads", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 51 });
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        ) VALUES
          (
            'input-open-1', 'thread-query-plan', NULL, 'approval', 'user-input.requested',
            'open one', '{"requestId":"input-1"}', NULL, '2026-10-17T00:00:01.000Z'
          ),
          (
            'input-closed-request', 'thread-query-plan', NULL, 'approval', 'user-input.requested',
            'closed', '{"requestId":"input-closed"}', NULL, '2026-10-17T00:00:02.000Z'
          ),
          (
            'input-closed-resolution', 'thread-query-plan', NULL, 'info', 'user-input.resolved',
            'closed', '{"requestId":"input-closed"}', NULL, '2026-10-17T00:00:03.000Z'
          )
      `;
      yield* runMigrations({ toMigrationInclusive: 52 });

      const expectedColumns = new Map<string, ReadonlyArray<string | null>>([
        [
          "idx_projection_thread_messages_thread_turn_created_id",
          ["thread_id", "turn_id", "created_at", "message_id"],
        ],
        [
          "idx_projection_thread_messages_streaming_head",
          ["thread_id", "updated_at", "message_id"],
        ],
        [
          "idx_projection_thread_activities_thread_turn_sequence_created_id",
          ["thread_id", "turn_id", "sequence", "created_at", "activity_id"],
        ],
        [
          "idx_projection_thread_plans_thread_turn_created_id",
          ["thread_id", "turn_id", "created_at", "plan_id"],
        ],
        [
          "idx_projection_thread_plans_thread_implemented_created_id",
          ["thread_id", "implemented_at", "created_at", "plan_id"],
        ],
        [
          "idx_projection_thread_plans_actionable",
          ["implemented_at", "thread_id", "created_at", "plan_id"],
        ],
      ]);

      for (const [indexName, columns] of expectedColumns) {
        const indexColumns = yield* sql.unsafe<{
          readonly seqno: number;
          readonly cid: number;
          readonly name: string | null;
        }>(`PRAGMA index_info('${indexName}')`);
        assert.deepStrictEqual(
          indexColumns.map((column) => column.name),
          columns,
        );
      }

      const expressionIndex = yield* sql<{ readonly sql: string }>`
        SELECT sql
        FROM sqlite_master
        WHERE type = 'index'
          AND name = 'idx_projection_thread_activities_thread_kind_request_created_id'
      `;
      assert.match(expressionIndex[0]?.sql ?? "", /json_extract\(payload_json, '\$\.requestId'\)/);

      const streamingIndex = yield* sql<{ readonly sql: string }>`
        SELECT sql
        FROM sqlite_master
        WHERE type = 'index'
          AND name = 'idx_projection_thread_messages_streaming_head'
      `;
      assert.match(streamingIndex[0]?.sql ?? "", /WHERE is_streaming = 1/);

      const pendingUserInputColumns = yield* sql<{
        readonly name: string;
      }>`PRAGMA table_info('projection_pending_user_inputs')`;
      assert.deepStrictEqual(
        pendingUserInputColumns.map((column) => column.name),
        ["thread_id", "request_id", "request_activity_id", "created_at"],
      );
      const backfilledUserInputs = yield* sql<{
        readonly requestId: string;
        readonly requestActivityId: string;
      }>`
        SELECT
          request_id AS "requestId",
          request_activity_id AS "requestActivityId"
        FROM projection_pending_user_inputs
        ORDER BY request_id
      `;
      assert.deepStrictEqual(backfilledUserInputs, [
        { requestId: "input-1", requestActivityId: "input-open-1" },
      ]);

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        ) VALUES
          (
            'input-open-2', 'thread-query-plan', NULL, 'approval', 'user-input.requested',
            'open two', '{"requestId":"input-2"}', NULL, '2026-10-17T00:00:04.000Z'
          ),
          (
            'input-open-1-resolution', 'thread-query-plan', NULL, 'info', 'user-input.resolved',
            'resolved one', '{"requestId":"input-1"}', NULL, '2026-10-17T00:00:05.000Z'
          )
      `;
      const triggeredUserInputs = yield* sql<{
        readonly requestId: string;
        readonly requestActivityId: string;
      }>`
        SELECT
          request_id AS "requestId",
          request_activity_id AS "requestActivityId"
        FROM projection_pending_user_inputs
        ORDER BY request_id
      `;
      assert.deepStrictEqual(triggeredUserInputs, [
        { requestId: "input-2", requestActivityId: "input-open-2" },
      ]);

      const messagePlan = yield* sql<QueryPlanRow>`
        EXPLAIN QUERY PLAN
        SELECT message_id
        FROM projection_thread_messages
        WHERE thread_id = 'thread-query-plan'
          AND turn_id = 'turn-query-plan'
        ORDER BY created_at DESC, message_id DESC
        LIMIT 201
      `;
      assert.equal(
        usesIndex(messagePlan, "idx_projection_thread_messages_thread_turn_created_id"),
        true,
      );

      const streamingHeadPlan = yield* sql<QueryPlanRow>`
        EXPLAIN QUERY PLAN
        SELECT message_id
        FROM projection_thread_messages
        WHERE thread_id = 'thread-query-plan'
          AND is_streaming = 1
        ORDER BY updated_at DESC, message_id DESC
        LIMIT 1
      `;
      assert.equal(
        usesIndex(streamingHeadPlan, "idx_projection_thread_messages_streaming_head"),
        true,
      );

      const activityPlan = yield* sql<QueryPlanRow>`
        EXPLAIN QUERY PLAN
        SELECT activity_id
        FROM projection_thread_activities
        WHERE thread_id = 'thread-query-plan'
          AND turn_id = 'turn-query-plan'
        ORDER BY sequence DESC, created_at DESC, activity_id DESC
        LIMIT 501
      `;
      assert.equal(
        usesIndex(activityPlan, "idx_projection_thread_activities_thread_turn_sequence_created_id"),
        true,
      );

      const planWindowPlan = yield* sql<QueryPlanRow>`
        EXPLAIN QUERY PLAN
        SELECT plan_id
        FROM projection_thread_proposed_plans
        WHERE thread_id = 'thread-query-plan'
          AND turn_id = 'turn-query-plan'
        ORDER BY created_at DESC, plan_id DESC
        LIMIT 201
      `;
      assert.equal(
        usesIndex(planWindowPlan, "idx_projection_thread_plans_thread_turn_created_id"),
        true,
      );

      const actionablePlan = yield* sql<QueryPlanRow>`
        EXPLAIN QUERY PLAN
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
        SELECT plans.plan_id
        FROM ranked_plan_keys AS ranked
        INNER JOIN projection_thread_proposed_plans AS plans
          ON plans.plan_id = ranked.plan_id
          AND plans.thread_id = ranked.thread_id
        WHERE ranked.plan_rank <= 200
      `;
      assert.equal(
        usesIndex(actionablePlan, "idx_projection_thread_plans_thread_implemented_created_id") ||
          usesIndex(actionablePlan, "idx_projection_thread_plans_actionable"),
        true,
      );
    }),
  );
});
