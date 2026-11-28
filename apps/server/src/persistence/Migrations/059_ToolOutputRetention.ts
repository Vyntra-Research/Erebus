import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS tool_output_retention_progress (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      target_sequence INTEGER NOT NULL,
      last_sequence INTEGER NOT NULL,
      completed INTEGER NOT NULL
    )
  `;

  yield* sql`
    INSERT OR IGNORE INTO tool_output_retention_progress (
      singleton,
      target_sequence,
      last_sequence,
      completed
    )
    SELECT
      1,
      COALESCE(MAX(sequence), 0),
      0,
      CASE WHEN COALESCE(MAX(sequence), 0) = 0 THEN 1 ELSE 0 END
    FROM orchestration_events
  `;
});
