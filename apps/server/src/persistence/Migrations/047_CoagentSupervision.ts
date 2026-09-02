import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE coagent_threads RENAME TO coagent_threads_v46`;

  yield* sql`
    CREATE TABLE coagent_threads (
      child_thread_id TEXT PRIMARY KEY,
      parent_thread_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      assignment TEXT NOT NULL,
      creation_mode TEXT NOT NULL CHECK (creation_mode IN ('blank', 'fork')),
      status TEXT NOT NULL CHECK (status IN ('preparing', 'ready', 'failed', 'released')),
      error TEXT,
      observer_campaign_id TEXT,
      observer_message_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    INSERT INTO coagent_threads (
      child_thread_id,
      parent_thread_id,
      project_id,
      assignment,
      creation_mode,
      status,
      error,
      observer_campaign_id,
      observer_message_count,
      created_at,
      updated_at
    )
    SELECT
      child_thread_id,
      parent_thread_id,
      project_id,
      '',
      creation_mode,
      status,
      error,
      NULL,
      0,
      created_at,
      updated_at
    FROM coagent_threads_v46
  `;

  yield* sql`DROP TABLE coagent_threads_v46`;

  yield* sql`
    CREATE INDEX idx_coagent_threads_parent_created
    ON coagent_threads(parent_thread_id, created_at)
  `;
});
