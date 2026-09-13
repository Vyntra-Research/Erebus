import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("048_049_IndependentReviews", (it) => {
  it.effect("adds independent reviews and removes only retired co-agent supervision state", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 47 });
      yield* sql`
        INSERT INTO coagent_threads (
          child_thread_id, parent_thread_id, project_id, assignment,
          creation_mode, status, observer_campaign_id, observer_message_count,
          created_at, updated_at
        ) VALUES (
          'child-1', 'parent-1', 'project-1', 'Inspect parser sinks',
          'blank', 'ready', 'legacy-campaign', 7,
          '2026-09-12T20:00:00.000Z', '2026-09-12T20:01:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 49 });

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('research_finding_submissions', 'research_judge_reviews')
        ORDER BY name
      `;
      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(coagent_threads)`;
      const rows = yield* sql<{
        readonly assignment: string;
        readonly childThreadId: string;
        readonly status: string;
      }>`
        SELECT
          child_thread_id AS "childThreadId",
          assignment,
          status
        FROM coagent_threads
      `;

      assert.deepEqual(
        tables.map((row) => row.name),
        ["research_finding_submissions", "research_judge_reviews"],
      );
      assert.notInclude(
        columns.map((column) => column.name),
        "observer_campaign_id",
      );
      assert.notInclude(
        columns.map((column) => column.name),
        "observer_message_count",
      );
      assert.deepEqual(
        [...rows],
        [
          {
            childThreadId: "child-1",
            assignment: "Inspect parser sinks",
            status: "ready",
          },
        ],
      );
    }),
  );
});
