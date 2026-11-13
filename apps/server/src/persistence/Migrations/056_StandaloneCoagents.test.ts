import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("056_StandaloneCoagents", (it) => {
  it.effect("preserves linked rows and permits a null project", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 55 });
      yield* sql`
        INSERT INTO coagent_threads (
          child_thread_id, parent_thread_id, project_id, assignment,
          creation_mode, status, error, created_at, updated_at,
          provider_history_deleted_at
        ) VALUES (
          'linked-child', 'linked-parent', 'project-1', 'Inspect parser',
          'blank', 'released', NULL,
          '2026-11-13T00:00:00.000Z', '2026-11-13T01:00:00.000Z',
          '2026-11-13T02:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 56 });

      const projectColumn = yield* sql<{
        readonly name: string;
        readonly notnull: number;
      }>`PRAGMA table_info('coagent_threads')`;
      assert.equal(projectColumn.find((column) => column.name === "project_id")?.notnull, 0);

      const preserved = yield* sql<{
        readonly projectId: string | null;
        readonly providerHistoryDeletedAt: string | null;
      }>`
        SELECT
          project_id AS "projectId",
          provider_history_deleted_at AS "providerHistoryDeletedAt"
        FROM coagent_threads
        WHERE child_thread_id = 'linked-child'
      `;
      assert.deepStrictEqual(preserved, [
        {
          projectId: "project-1",
          providerHistoryDeletedAt: "2026-11-13T02:00:00.000Z",
        },
      ]);

      yield* sql`
        INSERT INTO coagent_threads (
          child_thread_id, parent_thread_id, project_id, assignment,
          creation_mode, status, error, created_at, updated_at
        ) VALUES (
          'standalone-child', 'standalone-parent', NULL, 'Inspect standalone task',
          'blank', 'ready', NULL,
          '2026-11-13T03:00:00.000Z', '2026-11-13T03:00:00.000Z'
        )
      `;
      const standalone = yield* sql<{ readonly projectId: string | null }>`
        SELECT project_id AS "projectId"
        FROM coagent_threads
        WHERE child_thread_id = 'standalone-child'
      `;
      assert.deepStrictEqual(standalone, [{ projectId: null }]);
    }),
  );
});
