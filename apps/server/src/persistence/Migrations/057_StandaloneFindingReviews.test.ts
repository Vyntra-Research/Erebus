import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("057_StandaloneFindingReviews", (it) => {
  it.effect("preserves linked reviews and accepts standalone submissions", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 56 });
      yield* sql`
        INSERT INTO research_finding_submissions (
          project_id, thread_id, finding_id, finding_revision, command_id,
          submission_json, created_at, updated_at
        ) VALUES (
          'project-1', 'linked-thread', 'linked-finding', 1, 'linked-command',
          '{"findingId":"linked-finding","revision":1,"supersedesEvaluationId":null,"title":"Linked","target":"Target","findingPath":"findings/linked.md","pocPath":null,"submittedAt":"2026-11-22T00:00:00.000Z"}',
          '2026-11-22T00:00:00.000Z', '2026-11-22T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO research_judge_reviews (
          evaluation_id, project_id, thread_id, finding_id, finding_revision,
          evaluation_json, delivery_status, created_at, delivered_at
        ) VALUES (
          'evaluation-1', 'project-1', 'linked-thread', 'linked-finding', 1,
          '{}', 'delivered', '2026-11-22T00:01:00.000Z', '2026-11-22T00:02:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 57 });

      const submissionColumns = yield* sql<{
        readonly name: string;
        readonly notnull: number;
      }>`PRAGMA table_info('research_finding_submissions')`;
      const reviewColumns = yield* sql<{
        readonly name: string;
        readonly notnull: number;
      }>`PRAGMA table_info('research_judge_reviews')`;
      assert.equal(submissionColumns.find((column) => column.name === "project_id")?.notnull, 0);
      assert.equal(reviewColumns.find((column) => column.name === "project_id")?.notnull, 0);

      const preserved = yield* sql<{ readonly projectId: string | null }>`
        SELECT project_id AS "projectId"
        FROM research_finding_submissions
        WHERE thread_id = 'linked-thread'
      `;
      assert.deepStrictEqual(preserved, [{ projectId: "project-1" }]);
      const preservedReview = yield* sql<{
        readonly projectId: string | null;
        readonly deliveryStatus: string;
      }>`
        SELECT project_id AS "projectId", delivery_status AS "deliveryStatus"
        FROM research_judge_reviews
        WHERE evaluation_id = 'evaluation-1'
      `;
      assert.deepStrictEqual(preservedReview, [
        { projectId: "project-1", deliveryStatus: "delivered" },
      ]);

      yield* sql`
        INSERT INTO research_finding_submissions (
          project_id, thread_id, finding_id, finding_revision, command_id,
          submission_json, created_at, updated_at
        ) VALUES (
          NULL, 'standalone-thread', 'standalone-finding', 1, 'standalone-command',
          '{"findingId":"standalone-finding","revision":1,"supersedesEvaluationId":null,"title":"Standalone","target":"Target","findingPath":"findings/standalone.md","pocPath":null,"submittedAt":"2026-11-22T00:00:00.000Z"}',
          '2026-11-22T00:00:00.000Z', '2026-11-22T00:00:00.000Z'
        )
      `;
      const standalone = yield* sql<{ readonly projectId: string | null }>`
        SELECT project_id AS "projectId"
        FROM research_finding_submissions
        WHERE thread_id = 'standalone-thread'
      `;
      assert.deepStrictEqual(standalone, [{ projectId: null }]);
    }),
  );
});
