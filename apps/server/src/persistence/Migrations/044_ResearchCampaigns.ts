import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS research_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      campaign_id TEXT NOT NULL,
      campaign_version INTEGER NOT NULL,
      command_id TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      event_json TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_research_events_campaign_version
    ON research_events(campaign_id, campaign_version)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_research_events_campaign_sequence
    ON research_events(campaign_id, sequence)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS research_campaign_projections (
      campaign_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      principal_thread_id TEXT NOT NULL UNIQUE,
      last_sequence INTEGER NOT NULL,
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS research_command_receipts (
      command_id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      status TEXT NOT NULL,
      event_sequence INTEGER,
      result_json TEXT NOT NULL,
      accepted_at TEXT NOT NULL
    )
  `;
});
