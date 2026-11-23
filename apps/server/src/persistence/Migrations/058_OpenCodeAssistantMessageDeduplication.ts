import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    WITH ranked AS (
      SELECT
        message_id,
        FIRST_VALUE(message_id) OVER (
          PARTITION BY
            thread_id,
            turn_id,
            text,
            substr(message_id, 1, instr(message_id, ':text:') + 5)
          ORDER BY created_at ASC, message_id ASC
        ) AS keeper_id,
        ROW_NUMBER() OVER (
          PARTITION BY
            thread_id,
            turn_id,
            text,
            substr(message_id, 1, instr(message_id, ':text:') + 5)
          ORDER BY created_at ASC, message_id ASC
        ) AS duplicate_rank
      FROM projection_thread_messages
      WHERE role = 'assistant'
        AND is_streaming = 0
        AND message_id GLOB 'assistant:msg_*:text:*'
    )
    UPDATE projection_turns
    SET assistant_message_id = (
      SELECT keeper_id
      FROM ranked
      WHERE ranked.message_id = projection_turns.assistant_message_id
        AND ranked.duplicate_rank > 1
    )
    WHERE assistant_message_id IN (
      SELECT message_id FROM ranked WHERE duplicate_rank > 1
    )
  `;

  yield* sql`
    WITH ranked AS (
      SELECT
        message_id,
        ROW_NUMBER() OVER (
          PARTITION BY
            thread_id,
            turn_id,
            text,
            substr(message_id, 1, instr(message_id, ':text:') + 5)
          ORDER BY created_at ASC, message_id ASC
        ) AS duplicate_rank
      FROM projection_thread_messages
      WHERE role = 'assistant'
        AND is_streaming = 0
        AND message_id GLOB 'assistant:msg_*:text:*'
    )
    DELETE FROM projection_thread_messages
    WHERE message_id IN (
      SELECT message_id FROM ranked WHERE duplicate_rank > 1
    )
  `;
});
