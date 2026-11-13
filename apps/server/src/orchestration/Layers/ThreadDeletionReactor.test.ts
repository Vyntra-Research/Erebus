import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../../persistence/Migrations.ts";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import {
  logCleanupCauseUnlessInterrupted,
  purgeDeletedThreadData,
} from "./ThreadDeletionReactor.ts";

describe("logCleanupCauseUnlessInterrupted", () => {
  const threadId = ThreadId.make("thread-deletion-reactor-test");

  it("swallows ordinary cleanup failures", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.fail("cleanup failed"),
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("preserves interrupt causes", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.interrupt,
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  });
});

describe("purgeDeletedThreadData", () => {
  it.effect("removes a fully deleted thread without touching a live thread", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, created_at, updated_at,
            deleted_at, provider_history_deleted_at
          ) VALUES
            (
              'deleted-thread', NULL, 'Deleted',
              '2026-11-13T00:00:00.000Z', '2026-11-13T00:00:00.000Z',
              '2026-11-13T01:00:00.000Z', '2026-11-13T01:01:00.000Z'
            ),
            (
              'live-thread', NULL, 'Live',
              '2026-11-13T00:00:00.000Z', '2026-11-13T00:00:00.000Z',
              NULL, NULL
            )
        `;
      yield* sql`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type,
            occurred_at, actor_kind, payload_json, metadata_json
          ) VALUES (
            'deleted-event', 'thread', 'deleted-thread', 1, 'thread.deleted',
            '2026-11-13T01:00:00.000Z', 'system', '{}', '{}'
          )
        `;

      yield* purgeDeletedThreadData(sql, ThreadId.make("deleted-thread"));
      yield* purgeDeletedThreadData(sql, ThreadId.make("live-thread"));

      const threads = yield* sql<{ readonly threadId: string }>`
          SELECT thread_id AS "threadId" FROM projection_threads ORDER BY thread_id
        `;
      const events = yield* sql<{ readonly eventId: string }>`
          SELECT event_id AS "eventId" FROM orchestration_events
        `;
      expect(threads).toEqual([{ threadId: "live-thread" }]);
      expect(events).toEqual([]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
