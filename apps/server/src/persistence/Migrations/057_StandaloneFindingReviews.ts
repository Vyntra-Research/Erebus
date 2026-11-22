import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE research_judge_reviews RENAME TO research_judge_reviews_v56`;
  yield* sql`
    ALTER TABLE research_finding_submissions
    RENAME TO research_finding_submissions_v56
  `;

  yield* sql`
    CREATE TABLE research_finding_submissions (
      project_id TEXT,
      thread_id TEXT NOT NULL,
      finding_id TEXT NOT NULL,
      finding_revision INTEGER NOT NULL,
      command_id TEXT NOT NULL UNIQUE,
      submission_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, finding_id, finding_revision)
    )
  `;
  yield* sql`
    INSERT INTO research_finding_submissions (
      project_id, thread_id, finding_id, finding_revision, command_id,
      submission_json, created_at, updated_at
    )
    SELECT
      project_id, thread_id, finding_id, finding_revision, command_id,
      submission_json, created_at, updated_at
    FROM research_finding_submissions_v56
  `;

  yield* sql`
    CREATE TABLE research_judge_reviews (
      evaluation_id TEXT PRIMARY KEY,
      project_id TEXT,
      thread_id TEXT NOT NULL,
      finding_id TEXT NOT NULL,
      finding_revision INTEGER NOT NULL,
      evaluation_json TEXT NOT NULL,
      delivery_status TEXT NOT NULL CHECK (delivery_status IN ('pending', 'delivered')),
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      FOREIGN KEY (thread_id, finding_id, finding_revision)
        REFERENCES research_finding_submissions(thread_id, finding_id, finding_revision)
    )
  `;
  yield* sql`
    INSERT INTO research_judge_reviews (
      evaluation_id, project_id, thread_id, finding_id, finding_revision,
      evaluation_json, delivery_status, created_at, delivered_at
    )
    SELECT
      evaluation_id, project_id, thread_id, finding_id, finding_revision,
      evaluation_json, delivery_status, created_at, delivered_at
    FROM research_judge_reviews_v56
  `;

  yield* sql`DROP TABLE research_judge_reviews_v56`;
  yield* sql`DROP TABLE research_finding_submissions_v56`;

  yield* sql`
    CREATE INDEX idx_research_finding_submissions_thread_updated
    ON research_finding_submissions(thread_id, updated_at DESC)
  `;
  yield* sql`
    CREATE INDEX idx_research_judge_reviews_submission
    ON research_judge_reviews(thread_id, finding_id, finding_revision, created_at)
  `;
  yield* sql`
    CREATE INDEX idx_research_judge_reviews_pending_delivery
    ON research_judge_reviews(delivery_status, created_at)
  `;
});
