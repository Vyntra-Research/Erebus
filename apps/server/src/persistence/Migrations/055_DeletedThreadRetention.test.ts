import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("055_DeletedThreadRetention", (it) => {
  it.effect("preserves deleted threads and adds their cleanup marker", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, created_at, updated_at, deleted_at
        ) VALUES (
          'deleted-thread', NULL, 'Deleted',
          '2026-11-13T00:00:00.000Z', '2026-11-13T00:00:00.000Z',
          '2026-11-13T01:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 55 });

      const rows = yield* sql<{
        readonly threadId: string;
        readonly providerHistoryDeletedAt: string | null;
      }>`
        SELECT
          thread_id AS "threadId",
          provider_history_deleted_at AS "providerHistoryDeletedAt"
        FROM projection_threads
        WHERE thread_id = 'deleted-thread'
      `;
      assert.deepStrictEqual(rows, [
        { threadId: "deleted-thread", providerHistoryDeletedAt: null },
      ]);

      const indexColumns = yield* sql<{ readonly name: string | null }>`
        PRAGMA index_info('idx_projection_threads_deleted_retention')
      `;
      assert.deepStrictEqual(
        indexColumns.map((column) => column.name),
        ["deleted_at", "provider_history_deleted_at"],
      );
    }),
  );
});
