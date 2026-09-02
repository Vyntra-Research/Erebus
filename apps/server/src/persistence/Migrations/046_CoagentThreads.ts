import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS coagent_threads (
      child_thread_id TEXT PRIMARY KEY,
      parent_thread_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      creation_mode TEXT NOT NULL CHECK (creation_mode IN ('blank', 'fork')),
      status TEXT NOT NULL CHECK (status IN ('preparing', 'ready', 'failed')),
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_coagent_threads_parent_created
    ON coagent_threads(parent_thread_id, created_at)
  `;
});
