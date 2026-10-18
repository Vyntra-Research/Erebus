import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("053_StandaloneThreads", (it) => {
  it.effect("preserves existing rows and permits a null project", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 52 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, created_at, updated_at,
          runtime_mode, interaction_mode, model_selection_json,
          pinned_at, pin_order_key, linked_pull_request_json, unsettled_at
        ) VALUES (
          'linked-thread', 'project-1', 'Linked',
          '2026-10-18T00:00:00.000Z', '2026-10-18T01:00:00.000Z',
          'full-access', 'default', '{"instanceId":"codex","model":"gpt-6.1-sol"}',
          '2026-10-18T00:30:00.000Z', 'm', '{"number":1}',
          '2026-10-18T00:45:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 53 });

      const projectColumn = yield* sql<{
        readonly name: string;
        readonly notnull: number;
      }>`PRAGMA table_info('projection_threads')`;
      assert.equal(projectColumn.find((column) => column.name === "project_id")?.notnull, 0);

      const preserved = yield* sql<{
        readonly projectId: string | null;
        readonly title: string;
        readonly pinnedAt: string | null;
        readonly pinOrderKey: string | null;
        readonly linkedPullRequestJson: string | null;
        readonly unsettledAt: string | null;
      }>`
        SELECT
          project_id AS "projectId",
          title,
          pinned_at AS "pinnedAt",
          pin_order_key AS "pinOrderKey",
          linked_pull_request_json AS "linkedPullRequestJson",
          unsettled_at AS "unsettledAt"
        FROM projection_threads
        WHERE thread_id = 'linked-thread'
      `;
      assert.deepStrictEqual(preserved, [
        {
          projectId: "project-1",
          title: "Linked",
          pinnedAt: "2026-10-18T00:30:00.000Z",
          pinOrderKey: "m",
          linkedPullRequestJson: '{"number":1}',
          unsettledAt: "2026-10-18T00:45:00.000Z",
        },
      ]);

      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, created_at, updated_at
        ) VALUES (
          'standalone-thread', NULL, 'Standalone',
          '2026-10-18T02:00:00.000Z', '2026-10-18T02:00:00.000Z'
        )
      `;
      const standalone = yield* sql<{ readonly projectId: string | null }>`
        SELECT project_id AS "projectId"
        FROM projection_threads
        WHERE thread_id = 'standalone-thread'
      `;
      assert.deepStrictEqual(standalone, [{ projectId: null }]);
    }),
  );
});
