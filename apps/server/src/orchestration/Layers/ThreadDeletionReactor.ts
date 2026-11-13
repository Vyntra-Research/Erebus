// @effect-diagnostics nodeBuiltinImport:off - standalone workspaces are app-owned local state.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { ThreadId, type OrchestrationEvent } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { CoagentRegistry } from "../../coagents/Services/CoagentRegistry.ts";
import { ServerConfig } from "../../config.ts";
import * as StorageMaintenance from "../../diagnostics/StorageMaintenance.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ThreadDeletionReactor,
  type ThreadDeletionReactorShape,
} from "../Services/ThreadDeletionReactor.ts";
import { forkParked } from "../../serverActivation.ts";

type ThreadDeletedEvent = Extract<OrchestrationEvent, { type: "thread.deleted" }>;

const DeletedThreadRetentionRow = Schema.Struct({
  threadId: ThreadId,
  projectId: Schema.NullOr(Schema.String),
  providerName: Schema.NullOr(Schema.String),
  resumeCursorJson: Schema.NullOr(Schema.String),
  providerHistoryDeletedAt: Schema.NullOr(Schema.String),
});

const CodexResumeCursor = Schema.Struct({
  threadId: Schema.String,
});
const decodeCodexResumeCursorValue = Schema.decodeUnknownOption(CodexResumeCursor);

function decodeCodexResumeCursor(value: string | null): typeof CodexResumeCursor.Type | undefined {
  if (value === null) return undefined;
  try {
    return Option.getOrUndefined(decodeCodexResumeCursorValue(JSON.parse(value)));
  } catch {
    return undefined;
  }
}

export const logCleanupCauseUnlessInterrupted = <R, E>({
  effect,
  message,
  threadId,
}: {
  readonly effect: Effect.Effect<void, E, R>;
  readonly message: string;
  readonly threadId: ThreadDeletedEvent["payload"]["threadId"];
}): Effect.Effect<void, E, R> =>
  effect.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.failCause(cause);
      }
      return Effect.logDebug(message, {
        threadId,
        cause: Cause.pretty(cause),
      });
    }),
  );

export const purgeDeletedThreadData = (sql: SqlClient.SqlClient, threadId: ThreadId) =>
  sql.withTransaction(
    Effect.gen(function* () {
      const ready = yield* sql`
        SELECT 1
        FROM projection_threads
        WHERE thread_id = ${threadId}
          AND deleted_at IS NOT NULL
          AND provider_history_deleted_at IS NOT NULL
      `;
      if (ready.length === 0) return;

      yield* sql`DELETE FROM checkpoint_diff_blobs WHERE thread_id = ${threadId}`;
      yield* sql`DELETE FROM thread_sync_import_stages WHERE thread_id = ${threadId}`;
      yield* sql`DELETE FROM projection_pending_approvals WHERE thread_id = ${threadId}`;
      yield* sql`DELETE FROM projection_pending_user_inputs WHERE thread_id = ${threadId}`;
      yield* sql`DELETE FROM projection_thread_activities WHERE thread_id = ${threadId}`;
      yield* sql`DELETE FROM projection_thread_messages WHERE thread_id = ${threadId}`;
      yield* sql`DELETE FROM projection_thread_proposed_plans WHERE thread_id = ${threadId}`;
      yield* sql`DELETE FROM projection_thread_sessions WHERE thread_id = ${threadId}`;
      yield* sql`DELETE FROM projection_turns WHERE thread_id = ${threadId}`;
      yield* sql`DELETE FROM provider_session_runtime WHERE thread_id = ${threadId}`;
      yield* sql`DELETE FROM research_judge_reviews WHERE thread_id = ${threadId}`;
      yield* sql`DELETE FROM research_finding_submissions WHERE thread_id = ${threadId}`;
      yield* sql`
        DELETE FROM orchestration_command_receipts
        WHERE aggregate_kind = 'thread' AND aggregate_id = ${threadId}
      `;
      yield* sql`
        DELETE FROM orchestration_events
        WHERE aggregate_kind = 'thread'
          AND stream_id = ${threadId}
      `;
      yield* sql`DELETE FROM projection_threads WHERE thread_id = ${threadId}`;
    }),
  );

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const coagents = yield* CoagentRegistry;
  const terminalManager = yield* TerminalManager.TerminalManager;
  const serverConfig = yield* ServerConfig;
  const sql = yield* SqlClient.SqlClient;

  const getDeletedThreadRetentionRow = SqlSchema.findOneOption({
    Request: ThreadId,
    Result: DeletedThreadRetentionRow,
    execute: (threadId) => sql`
      SELECT
        threads.thread_id AS "threadId",
        threads.project_id AS "projectId",
        runtime.provider_name AS "providerName",
        runtime.resume_cursor_json AS "resumeCursorJson",
        threads.provider_history_deleted_at AS "providerHistoryDeletedAt"
      FROM projection_threads AS threads
      LEFT JOIN provider_session_runtime AS runtime ON runtime.thread_id = threads.thread_id
      WHERE threads.thread_id = ${threadId}
        AND threads.deleted_at IS NOT NULL
      LIMIT 1
    `,
  });

  const listDeletedThreadsPendingCleanup = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({ threadId: ThreadId }),
    execute: () => sql`
      SELECT thread_id AS "threadId"
      FROM projection_threads
      WHERE deleted_at IS NOT NULL
      ORDER BY deleted_at ASC, thread_id ASC
    `,
  });

  const markProviderHistoryDeleted = (threadId: ThreadId, deletedAt: string) => sql`
    UPDATE projection_threads
    SET provider_history_deleted_at = COALESCE(provider_history_deleted_at, ${deletedAt})
    WHERE thread_id = ${threadId}
      AND deleted_at IS NOT NULL
  `;

  const deleteStandaloneWorkspace = Effect.fn("deleteStandaloneWorkspace")(function* (
    threadId: ThreadId,
    projectId: string | null,
  ) {
    if (projectId !== null) return;
    yield* Effect.try(() => {
      const root = NodePath.join(serverConfig.stateDir, "standalone-workspaces");
      const candidate = NodePath.join(root, threadId);
      if (!NodeFS.existsSync(candidate)) return;
      const rootStat = NodeFS.lstatSync(root);
      const candidateStat = NodeFS.lstatSync(candidate);
      if (rootStat.isSymbolicLink() || candidateStat.isSymbolicLink()) {
        throw new Error("Refusing to delete a linked standalone workspace.");
      }
      const canonicalRoot = NodeFS.realpathSync.native(root);
      const canonicalCandidate = NodeFS.realpathSync.native(candidate);
      const relative = NodePath.relative(canonicalRoot, canonicalCandidate);
      if (!relative || relative.startsWith("..") || NodePath.isAbsolute(relative)) {
        throw new Error("Refusing to delete a standalone workspace outside managed storage.");
      }
      NodeFS.rmSync(canonicalCandidate, { recursive: true, force: true });
    });
  });

  const closeThreadTerminals = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    logCleanupCauseUnlessInterrupted({
      effect: terminalManager.close({ threadId, deleteHistory: true }),
      message: "thread deletion cleanup skipped terminal close",
      threadId,
    });

  const processThreadDeleted = Effect.fn("processThreadDeleted")(function* (threadId: ThreadId) {
    const retentionRow = yield* getDeletedThreadRetentionRow(threadId);
    if (Option.isNone(retentionRow)) return;
    const row = retentionRow.value;
    const coagent = yield* coagents.getByChild(threadId);
    yield* Effect.gen(function* () {
      let providerHistoryDeleted = row.providerHistoryDeletedAt !== null;
      if (!providerHistoryDeleted) {
        yield* logCleanupCauseUnlessInterrupted({
          effect: providerService.stopSession({ threadId }),
          message: "thread deletion cleanup skipped provider session stop",
          threadId,
        });
        const adapterDeleted = yield* providerService
          .deletePersistedThreadHistory(threadId)
          .pipe(Effect.orElseSucceed(() => false));
        const cursor = decodeCodexResumeCursor(row.resumeCursorJson);
        const localCodexHistoryDeleted =
          !adapterDeleted && row.providerName === "codex" && cursor
            ? yield* StorageMaintenance.deleteCodexThreadHistories({
                stateDir: serverConfig.stateDir,
                providerThreadIds: [cursor.threadId],
              })
            : false;
        providerHistoryDeleted =
          (row.providerName === null && row.resumeCursorJson === null) ||
          adapterDeleted ||
          localCodexHistoryDeleted;
        if (!providerHistoryDeleted) {
          yield* Effect.logWarning("provider history could not be deleted for a removed thread", {
            threadId,
          });
          return;
        }
      }
      const deletedAt = DateTime.formatIso(yield* DateTime.now);
      yield* markProviderHistoryDeleted(threadId, deletedAt);
      if (Option.isSome(coagent)) {
        yield* coagents.markProviderHistoryDeleted(threadId, deletedAt);
      }
      yield* deleteStandaloneWorkspace(threadId, row.projectId);
      if (Option.isSome(coagent)) {
        yield* coagents.purgeDeleted(threadId);
      } else {
        yield* purgeDeletedThreadData(sql, threadId);
      }
      yield* sql`PRAGMA incremental_vacuum`;
    }).pipe(Effect.ensuring(Effect.ignore(closeThreadTerminals(threadId))));
  });

  const processThreadDeletedSafely = (threadId: ThreadId) =>
    processThreadDeleted(threadId).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("thread deletion reactor failed to process event", {
          threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processThreadDeletedSafely);

  const start: ThreadDeletionReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "thread.deleted") {
          return Effect.void;
        }
        return worker.enqueue(event.payload.threadId);
      }),
    );
    const pending = yield* listDeletedThreadsPendingCleanup().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("could not list deleted threads awaiting storage cleanup", {
          cause: Cause.pretty(cause),
        }).pipe(Effect.as([] as ReadonlyArray<{ readonly threadId: ThreadId }>)),
      ),
    );
    yield* Effect.forEach(pending, (row) => worker.enqueue(row.threadId), { discard: true });
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ThreadDeletionReactorShape;
});

export const ThreadDeletionReactorLive = Layer.effect(ThreadDeletionReactor, make);
