import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_messages_thread_turn_created_id
    ON projection_thread_messages(thread_id, turn_id, created_at, message_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_messages_streaming_head
    ON projection_thread_messages(thread_id, updated_at DESC, message_id DESC)
    WHERE is_streaming = 1
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_thread_turn_sequence_created_id
    ON projection_thread_activities(thread_id, turn_id, sequence, created_at, activity_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_plans_thread_turn_created_id
    ON projection_thread_proposed_plans(thread_id, turn_id, created_at, plan_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_plans_thread_implemented_created_id
    ON projection_thread_proposed_plans(thread_id, implemented_at, created_at, plan_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_plans_actionable
    ON projection_thread_proposed_plans(implemented_at, thread_id, created_at, plan_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_thread_kind_request_created_id
    ON projection_thread_activities(
      thread_id,
      kind,
      json_extract(payload_json, '$.requestId'),
      created_at,
      activity_id
    )
  `;

  // User-input requests did not previously have the compact lifecycle table
  // that approvals already use. Keep one exact activity reference per open
  // request so command startup never has to group a thread's full activity
  // history merely to protect an in-flight request.
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_pending_user_inputs (
      thread_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      request_activity_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, request_id)
    )
  `;

  yield* sql`
    WITH lifecycle AS (
      SELECT
        activity_id,
        thread_id,
        kind,
        created_at,
        json_extract(payload_json, '$.requestId') AS request_id
      FROM projection_thread_activities
      WHERE kind IN ('user-input.requested', 'user-input.resolved')
        OR (
          kind = 'provider.user-input.respond.failed'
          AND (
            lower(COALESCE(json_extract(payload_json, '$.detail'), ''))
              LIKE '%stale pending user-input request%'
            OR lower(COALESCE(json_extract(payload_json, '$.detail'), ''))
              LIKE '%unknown pending user-input request%'
            OR lower(COALESCE(json_extract(payload_json, '$.detail'), ''))
              LIKE '%unknown pending user input request%'
            OR lower(COALESCE(json_extract(payload_json, '$.detail'), ''))
              LIKE '%unknown pending codex user input request%'
          )
        )
    ), ranked AS (
      SELECT
        activity_id,
        thread_id,
        kind,
        created_at,
        request_id,
        ROW_NUMBER() OVER (
          PARTITION BY thread_id, request_id
          ORDER BY created_at DESC, activity_id DESC
        ) AS lifecycle_order
      FROM lifecycle
      WHERE request_id IS NOT NULL
    )
    INSERT INTO projection_pending_user_inputs (
      thread_id, request_id, request_activity_id, created_at
    )
    SELECT thread_id, request_id, activity_id, created_at
    FROM ranked
    WHERE lifecycle_order = 1
      AND kind = 'user-input.requested'
    ON CONFLICT(thread_id, request_id) DO UPDATE SET
      request_activity_id = excluded.request_activity_id,
      created_at = excluded.created_at
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS projection_pending_user_inputs_request_insert
    AFTER INSERT ON projection_thread_activities
    WHEN NEW.kind = 'user-input.requested'
      AND json_extract(NEW.payload_json, '$.requestId') IS NOT NULL
    BEGIN
      INSERT INTO projection_pending_user_inputs (
        thread_id, request_id, request_activity_id, created_at
      ) VALUES (
        NEW.thread_id,
        json_extract(NEW.payload_json, '$.requestId'),
        NEW.activity_id,
        NEW.created_at
      )
      ON CONFLICT(thread_id, request_id) DO UPDATE SET
        request_activity_id = excluded.request_activity_id,
        created_at = excluded.created_at
      WHERE excluded.created_at > projection_pending_user_inputs.created_at
        OR (
          excluded.created_at = projection_pending_user_inputs.created_at
          AND excluded.request_activity_id > projection_pending_user_inputs.request_activity_id
        );
    END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS projection_pending_user_inputs_request_update
    AFTER UPDATE ON projection_thread_activities
    WHEN NEW.kind = 'user-input.requested'
      AND json_extract(NEW.payload_json, '$.requestId') IS NOT NULL
    BEGIN
      INSERT INTO projection_pending_user_inputs (
        thread_id, request_id, request_activity_id, created_at
      ) VALUES (
        NEW.thread_id,
        json_extract(NEW.payload_json, '$.requestId'),
        NEW.activity_id,
        NEW.created_at
      )
      ON CONFLICT(thread_id, request_id) DO UPDATE SET
        request_activity_id = excluded.request_activity_id,
        created_at = excluded.created_at
      WHERE excluded.created_at > projection_pending_user_inputs.created_at
        OR (
          excluded.created_at = projection_pending_user_inputs.created_at
          AND excluded.request_activity_id > projection_pending_user_inputs.request_activity_id
        );
    END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS projection_pending_user_inputs_resolution_insert
    AFTER INSERT ON projection_thread_activities
    WHEN json_extract(NEW.payload_json, '$.requestId') IS NOT NULL
      AND (
        NEW.kind = 'user-input.resolved'
        OR (
          NEW.kind = 'provider.user-input.respond.failed'
          AND (
            lower(COALESCE(json_extract(NEW.payload_json, '$.detail'), ''))
              LIKE '%stale pending user-input request%'
            OR lower(COALESCE(json_extract(NEW.payload_json, '$.detail'), ''))
              LIKE '%unknown pending user-input request%'
            OR lower(COALESCE(json_extract(NEW.payload_json, '$.detail'), ''))
              LIKE '%unknown pending user input request%'
            OR lower(COALESCE(json_extract(NEW.payload_json, '$.detail'), ''))
              LIKE '%unknown pending codex user input request%'
          )
        )
      )
    BEGIN
      DELETE FROM projection_pending_user_inputs
      WHERE thread_id = NEW.thread_id
        AND request_id = json_extract(NEW.payload_json, '$.requestId')
        AND (
          NEW.created_at > created_at
          OR (NEW.created_at = created_at AND NEW.activity_id > request_activity_id)
        );
    END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS projection_pending_user_inputs_resolution_update
    AFTER UPDATE ON projection_thread_activities
    WHEN json_extract(NEW.payload_json, '$.requestId') IS NOT NULL
      AND (
        NEW.kind = 'user-input.resolved'
        OR (
          NEW.kind = 'provider.user-input.respond.failed'
          AND (
            lower(COALESCE(json_extract(NEW.payload_json, '$.detail'), ''))
              LIKE '%stale pending user-input request%'
            OR lower(COALESCE(json_extract(NEW.payload_json, '$.detail'), ''))
              LIKE '%unknown pending user-input request%'
            OR lower(COALESCE(json_extract(NEW.payload_json, '$.detail'), ''))
              LIKE '%unknown pending user input request%'
            OR lower(COALESCE(json_extract(NEW.payload_json, '$.detail'), ''))
              LIKE '%unknown pending codex user input request%'
          )
        )
      )
    BEGIN
      DELETE FROM projection_pending_user_inputs
      WHERE thread_id = NEW.thread_id
        AND request_id = json_extract(NEW.payload_json, '$.requestId')
        AND (
          NEW.created_at > created_at
          OR (NEW.created_at = created_at AND NEW.activity_id > request_activity_id)
        );
    END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS projection_pending_user_inputs_request_delete
    AFTER DELETE ON projection_thread_activities
    WHEN OLD.kind = 'user-input.requested'
      AND json_extract(OLD.payload_json, '$.requestId') IS NOT NULL
    BEGIN
      DELETE FROM projection_pending_user_inputs
      WHERE thread_id = OLD.thread_id
        AND request_id = json_extract(OLD.payload_json, '$.requestId')
        AND request_activity_id = OLD.activity_id;
    END
  `;
});
