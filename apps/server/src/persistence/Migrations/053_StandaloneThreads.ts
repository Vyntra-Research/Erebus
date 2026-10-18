import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Allow a thread to exist without a machine-local project binding. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DROP TABLE IF EXISTS projection_threads_standalone_migration`;
  yield* sql`
    CREATE TABLE projection_threads_standalone_migration (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT,
      title TEXT NOT NULL,
      branch TEXT,
      worktree_path TEXT,
      latest_turn_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      runtime_mode TEXT NOT NULL DEFAULT 'full-access',
      interaction_mode TEXT NOT NULL DEFAULT 'default',
      model_selection_json TEXT,
      archived_at TEXT,
      latest_user_message_at TEXT,
      pending_approval_count INTEGER NOT NULL DEFAULT 0,
      pending_user_input_count INTEGER NOT NULL DEFAULT 0,
      has_actionable_proposed_plan INTEGER NOT NULL DEFAULT 0,
      settled_override TEXT,
      settled_at TEXT,
      snoozed_until TEXT,
      snoozed_at TEXT,
      title_regeneration_request_id TEXT,
      title_regeneration_started_at TEXT,
      pinned_at TEXT,
      pin_order_key TEXT,
      linked_pull_request_json TEXT,
      unsettled_at TEXT
    )
  `;

  yield* sql`
    INSERT INTO projection_threads_standalone_migration (
      thread_id, project_id, title, branch, worktree_path, latest_turn_id,
      created_at, updated_at, deleted_at, runtime_mode, interaction_mode,
      model_selection_json, archived_at, latest_user_message_at,
      pending_approval_count, pending_user_input_count, has_actionable_proposed_plan,
      settled_override, settled_at, snoozed_until, snoozed_at,
      title_regeneration_request_id, title_regeneration_started_at,
      pinned_at, pin_order_key, linked_pull_request_json, unsettled_at
    )
    SELECT
      thread_id, project_id, title, branch, worktree_path, latest_turn_id,
      created_at, updated_at, deleted_at, runtime_mode, interaction_mode,
      model_selection_json, archived_at, latest_user_message_at,
      pending_approval_count, pending_user_input_count, has_actionable_proposed_plan,
      settled_override, settled_at, snoozed_until, snoozed_at,
      title_regeneration_request_id, title_regeneration_started_at,
      pinned_at, pin_order_key, linked_pull_request_json, unsettled_at
    FROM projection_threads
  `;

  yield* sql`DROP TABLE projection_threads`;
  yield* sql`ALTER TABLE projection_threads_standalone_migration RENAME TO projection_threads`;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_project_id
    ON projection_threads(project_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_project_archived_at
    ON projection_threads(project_id, archived_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_project_deleted_created
    ON projection_threads(project_id, deleted_at, created_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_shell_active
    ON projection_threads(deleted_at, archived_at, project_id, created_at, thread_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_shell_archived
    ON projection_threads(deleted_at, archived_at, project_id, thread_id)
  `;
});
