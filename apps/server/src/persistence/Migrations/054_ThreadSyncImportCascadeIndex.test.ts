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

layer("054_ThreadSyncImportCascadeIndex", (it) => {
  it.effect("indexes and clears staged import records through the chunk cascade", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 53 });
      yield* sql`
        INSERT INTO thread_sync_import_stages (
          stage_id, thread_id, resume_key, source_revision, source_hash,
          expected_record_count, started_at, last_activity_at
        ) VALUES (
          'stage-large', 'thread-large', 'resume-large', 'revision-large', 'hash-large',
          2, '2026-10-18T00:00:00.000Z', '2026-10-18T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO thread_sync_import_chunks (
          stage_id, chunk_index, chunk_hash, first_ordinal, last_ordinal, record_count
        ) VALUES
          ('stage-large', 0, 'chunk-0', 0, 0, 1),
          ('stage-large', 1, 'chunk-1', 1, 1, 1)
      `;
      yield* sql`
        INSERT INTO thread_sync_import_records (
          stage_id, ordinal, chunk_index, kind, value_json
        ) VALUES
          ('stage-large', 0, 0, 'turn', '{}'),
          ('stage-large', 1, 1, 'turn', '{}')
      `;

      yield* runMigrations({ toMigrationInclusive: 54 });

      const indexColumns = yield* sql<{
        readonly name: string | null;
      }>`PRAGMA index_info('idx_thread_sync_import_records_chunk')`;
      assert.deepStrictEqual(
        indexColumns.map((column) => column.name),
        ["stage_id", "chunk_index"],
      );

      const deletePlan = yield* sql<QueryPlanRow>`
        EXPLAIN QUERY PLAN
        DELETE FROM thread_sync_import_chunks
        WHERE stage_id = 'stage-large'
      `;
      assert.equal(
        deletePlan.some((row) => row.detail.includes("idx_thread_sync_import_records_chunk")),
        true,
      );

      yield* sql`DELETE FROM thread_sync_import_stages WHERE stage_id = 'stage-large'`;
      const remaining = yield* sql<{
        readonly chunks: number;
        readonly records: number;
      }>`
        SELECT
          (SELECT COUNT(*) FROM thread_sync_import_chunks) AS chunks,
          (SELECT COUNT(*) FROM thread_sync_import_records) AS records
      `;
      assert.deepStrictEqual(remaining, [{ chunks: 0, records: 0 }]);
    }),
  );
});
