import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE research_campaign_projections_v45 (
      campaign_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      principal_thread_id TEXT NOT NULL,
      last_sequence INTEGER NOT NULL,
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    INSERT INTO research_campaign_projections_v45 (
      campaign_id,
      project_id,
      principal_thread_id,
      last_sequence,
      state_json,
      updated_at
    )
    SELECT
      campaign_id,
      project_id,
      principal_thread_id,
      last_sequence,
      state_json,
      updated_at
    FROM research_campaign_projections
  `;

  yield* sql`DROP TABLE research_campaign_projections`;
  yield* sql`
    ALTER TABLE research_campaign_projections_v45
    RENAME TO research_campaign_projections
  `;

  yield* sql`
    CREATE INDEX idx_research_campaign_projections_thread_updated
    ON research_campaign_projections(principal_thread_id, updated_at DESC)
  `;

  yield* sql`
    CREATE UNIQUE INDEX idx_research_campaign_projections_live_thread
    ON research_campaign_projections(principal_thread_id)
    WHERE COALESCE(json_extract(state_json, '$.campaign.status'), '')
      NOT IN ('completed', 'aborted')
  `;
});
