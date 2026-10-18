import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE thread_sync_import_stages (
      stage_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      resume_key TEXT NOT NULL,
      source_revision TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      expected_record_count INTEGER NOT NULL CHECK (expected_record_count >= 0),
      next_chunk_index INTEGER NOT NULL DEFAULT 0 CHECK (next_chunk_index >= 0),
      next_ordinal INTEGER NOT NULL DEFAULT 0 CHECK (next_ordinal >= 0),
      started_at TEXT NOT NULL,
      last_activity_at TEXT NOT NULL,
      validated_descriptor_hash TEXT,
      validated_hash TEXT,
      validated_record_count INTEGER CHECK (
        validated_record_count IS NULL OR validated_record_count >= 0
      ),
      validated_at TEXT
    )
  `;
  yield* sql`
    CREATE TABLE thread_sync_import_chunks (
      stage_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
      chunk_hash TEXT NOT NULL,
      first_ordinal INTEGER NOT NULL CHECK (first_ordinal >= 0),
      last_ordinal INTEGER NOT NULL CHECK (last_ordinal >= first_ordinal),
      record_count INTEGER NOT NULL CHECK (record_count > 0),
      PRIMARY KEY (stage_id, chunk_index),
      FOREIGN KEY (stage_id) REFERENCES thread_sync_import_stages(stage_id) ON DELETE CASCADE
    )
  `;
  yield* sql`
    CREATE TABLE thread_sync_import_records (
      stage_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
      kind TEXT NOT NULL,
      owner_id TEXT,
      fragment_index INTEGER CHECK (fragment_index IS NULL OR fragment_index >= 0),
      fragment_text TEXT,
      portable_id TEXT,
      value_json TEXT NOT NULL,
      PRIMARY KEY (stage_id, ordinal),
      FOREIGN KEY (stage_id, chunk_index)
        REFERENCES thread_sync_import_chunks(stage_id, chunk_index) ON DELETE CASCADE
    )
  `;
  yield* sql`
    CREATE INDEX idx_thread_sync_import_stages_thread
    ON thread_sync_import_stages(thread_id, resume_key, last_activity_at DESC)
  `;
  yield* sql`
    CREATE INDEX idx_thread_sync_import_records_owner
    ON thread_sync_import_records(stage_id, kind, owner_id, fragment_index, ordinal)
  `;

  // Imported rows keep their local primary key and the stable repository id.
  // Native rows remain NULL and export their local id directly.
  yield* sql`ALTER TABLE projection_turns ADD COLUMN sync_portable_id TEXT`;
  yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN sync_portable_id TEXT`;
  yield* sql`ALTER TABLE projection_thread_proposed_plans ADD COLUMN sync_portable_id TEXT`;
  yield* sql`ALTER TABLE projection_thread_activities ADD COLUMN sync_portable_id TEXT`;

  // This projector is introduced by the same migration as the v2 import
  // events it handles, so every event already in the store predates it. Seed
  // its cursor at the current head: replaying a large existing event store
  // would only perform one no-op transaction per historical event. A fresh
  // database starts at sequence zero, and an existing cursor wins so a retry
  // can never move the projector backwards.
  yield* sql`
    INSERT INTO projection_state (
      projector,
      last_applied_sequence,
      updated_at
    ) VALUES (
      'projection.thread-sync-imports',
      COALESCE((SELECT MAX(sequence) FROM orchestration_events), 0),
      COALESCE(
        (
          SELECT occurred_at
          FROM orchestration_events
          ORDER BY sequence DESC
          LIMIT 1
        ),
        '1970-01-01T00:00:00.000Z'
      )
    )
    ON CONFLICT (projector) DO NOTHING
  `;
});
