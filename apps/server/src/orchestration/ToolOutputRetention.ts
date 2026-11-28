import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { forkParked } from "../serverActivation.ts";
import { projectActivityPayload } from "./ActivityPayloadProjection.ts";

const LEGACY_SEQUENCE_WINDOW = 4_096;
const UnknownJson = Schema.fromJsonString(Schema.Unknown);
const decodeJson = Schema.decodeUnknownSync(UnknownJson);
const encodeJson = Schema.encodeSync(UnknownJson);

interface RetentionProgressRow {
  readonly targetSequence: number;
  readonly lastSequence: number;
  readonly completed: number;
}

interface LegacyEventRow {
  readonly sequence: number;
  readonly payloadJson: string | null;
}

export interface ToolOutputRetentionBatchResult {
  readonly status: "busy" | "progress" | "complete";
  readonly scanned: number;
  readonly compacted: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function compactLegacyEventPayload(payloadJson: string): {
  readonly eventPayloadJson: string;
  readonly activity: OrchestrationThreadActivity;
} | null {
  try {
    const eventPayload = asRecord(decodeJson(payloadJson));
    const activity = asRecord(eventPayload?.activity);
    if (!eventPayload || !activity || activity.kind !== "tool.completed") {
      return null;
    }
    const projected = projectActivityPayload(activity as unknown as OrchestrationThreadActivity);
    return {
      eventPayloadJson: encodeJson({ ...eventPayload, activity: projected }),
      activity: projected,
    };
  } catch {
    return null;
  }
}

/**
 * Rewrites one bounded legacy slice. The event sequence is the durable cursor,
 * so interruption either commits the payload reductions and cursor together or
 * leaves both untouched. New events are already reduced before append and sit
 * beyond the migration's fixed target sequence.
 */
export const compactLegacyToolOutputsBatch = Effect.fn("compactLegacyToolOutputsBatch")(function* (
  sql: SqlClient.SqlClient,
): Effect.fn.Return<ToolOutputRetentionBatchResult, SqlError> {
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const activeRows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS "count"
        FROM projection_thread_sessions
        WHERE status IN ('starting', 'running') OR active_turn_id IS NOT NULL
      `;
      if ((activeRows[0]?.count ?? 0) > 0) {
        return { status: "busy", scanned: 0, compacted: 0 } as const;
      }

      const progressRows = yield* sql<RetentionProgressRow>`
        SELECT
          target_sequence AS "targetSequence",
          last_sequence AS "lastSequence",
          completed
        FROM tool_output_retention_progress
        WHERE singleton = 1
      `;
      const progress = progressRows[0];
      if (!progress || progress.completed === 1) {
        return { status: "complete", scanned: 0, compacted: 0 } as const;
      }

      const upperSequence = Math.min(
        progress.lastSequence + LEGACY_SEQUENCE_WINDOW,
        progress.targetSequence,
      );
      const rows = yield* sql<LegacyEventRow>`
        SELECT sequence, payload_json AS "payloadJson"
        FROM orchestration_events
        WHERE sequence > ${progress.lastSequence}
          AND sequence <= ${upperSequence}
          AND event_type = 'thread.activity-appended'
          AND json_extract(payload_json, '$.activity.kind') = 'tool.completed'
        ORDER BY sequence ASC
        LIMIT 1
      `;

      const row = rows[0];
      let compacted = 0;
      if (row?.payloadJson !== null && row?.payloadJson !== undefined) {
        const result = compactLegacyEventPayload(row.payloadJson);
        if (result) {
          yield* sql`
            UPDATE orchestration_events
            SET payload_json = ${result.eventPayloadJson}
            WHERE sequence = ${row.sequence}
          `;
          yield* sql`
            UPDATE projection_thread_activities
            SET
              summary = ${result.activity.summary},
              payload_json = ${encodeJson(result.activity.payload)}
            WHERE activity_id = ${result.activity.id}
          `;
          compacted = 1;
        }
      }

      // Stop at the first matching activity so one transaction can never
      // rewrite several large legacy payloads. Empty windows advance without
      // materializing unrelated event JSON in JavaScript.
      const lastSequence = row?.sequence ?? upperSequence;
      const completed = lastSequence >= progress.targetSequence;
      yield* sql`
        UPDATE tool_output_retention_progress
        SET
          last_sequence = ${lastSequence},
          completed = ${completed ? 1 : 0}
        WHERE singleton = 1
      `;
      return {
        status: completed ? "complete" : "progress",
        scanned: lastSequence - progress.lastSequence,
        compacted,
      } as const;
    }),
  );
});

/** Runs only until the one-time legacy range is exhausted. */
export const runLegacyToolOutputRetention = Effect.fn("runLegacyToolOutputRetention")(function* (
  sql: SqlClient.SqlClient,
) {
  yield* Effect.sleep("30 seconds");
  let totalCompacted = 0;
  while (true) {
    const result = yield* compactLegacyToolOutputsBatch(sql).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterrupts(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("legacy tool output retention paused after a failed batch", {
          cause: Cause.pretty(cause),
        }).pipe(
          Effect.andThen(Effect.sleep("30 seconds")),
          Effect.as({ status: "busy", scanned: 0, compacted: 0 } as const),
        );
      }),
    );
    totalCompacted += result.compacted;
    if (result.status === "complete") {
      if (totalCompacted > 0) {
        yield* Effect.log("Legacy tool outputs reduced", { compacted: totalCompacted });
      }
      return;
    }
    yield* Effect.sleep(result.status === "busy" ? "15 seconds" : "2 seconds");
  }
});

export const ToolOutputRetentionLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* forkParked(runLegacyToolOutputRetention(sql));
  }),
);
