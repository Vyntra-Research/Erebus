import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("058_OpenCodeAssistantMessageDeduplication", (it) => {
  it.effect("keeps one reconciled OpenCode reply and preserves distinct messages", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 57 });

      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
        ) VALUES
          (
            'assistant:msg_same:text:0', 'thread-1', 'turn-1', 'assistant', 'Same reply', 0,
            '2026-11-23T00:00:00.000Z', '2026-11-23T00:00:00.000Z'
          ),
          (
            'assistant:msg_same:text:1', 'thread-1', 'turn-1', 'assistant', 'Same reply', 0,
            '2026-11-23T00:00:00.002Z', '2026-11-23T00:00:00.002Z'
          ),
          (
            'assistant:msg_other:text:0', 'thread-1', 'turn-1', 'assistant', 'Same reply', 0,
            '2026-11-23T00:00:01.000Z', '2026-11-23T00:00:01.000Z'
          )
      `;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, assistant_message_id, state, requested_at,
          completed_at, checkpoint_files_json
        ) VALUES (
          'thread-1', 'turn-1', 'assistant:msg_same:text:1', 'completed',
          '2026-11-23T00:00:00.000Z', '2026-11-23T00:00:01.000Z', '[]'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 58 });

      const messages = yield* sql<{ readonly messageId: string }>`
        SELECT message_id AS "messageId"
        FROM projection_thread_messages
        ORDER BY message_id ASC
      `;
      assert.deepStrictEqual(messages, [
        { messageId: "assistant:msg_other:text:0" },
        { messageId: "assistant:msg_same:text:0" },
      ]);
      const turns = yield* sql<{ readonly assistantMessageId: string | null }>`
        SELECT assistant_message_id AS "assistantMessageId"
        FROM projection_turns
        WHERE thread_id = 'thread-1' AND turn_id = 'turn-1'
      `;
      assert.deepStrictEqual(turns, [{ assistantMessageId: "assistant:msg_same:text:0" }]);
    }),
  );
});
