import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN provider_history_deleted_at TEXT`;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_deleted_retention
    ON projection_threads(deleted_at, provider_history_deleted_at)
  `;
});
