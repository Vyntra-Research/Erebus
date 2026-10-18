import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // SQLite checks the child table for every imported chunk removed by the
  // stage cascade. Without this exact foreign-key index, cleaning a large
  // staged import repeatedly scans every staged record.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_thread_sync_import_records_chunk
    ON thread_sync_import_records(stage_id, chunk_index)
  `;
});
