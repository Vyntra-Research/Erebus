import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { CoagentRegistry, CoagentThreadLink } from "../Services/CoagentRegistry.ts";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRow = SqlSchema.void({
    Request: CoagentThreadLink,
    execute: (row) => sql`
      INSERT INTO coagent_threads (
        child_thread_id,
        parent_thread_id,
        project_id,
        assignment,
        creation_mode,
        status,
        error,
        created_at,
        updated_at
      ) VALUES (
        ${row.childThreadId},
        ${row.parentThreadId},
        ${row.projectId},
        ${row.assignment},
        ${row.creationMode},
        ${row.status},
        ${row.error},
        ${row.createdAt},
        ${row.updatedAt}
      )
      ON CONFLICT (child_thread_id) DO UPDATE SET
        parent_thread_id = excluded.parent_thread_id,
        project_id = excluded.project_id,
        assignment = excluded.assignment,
        creation_mode = excluded.creation_mode,
        status = excluded.status,
        error = excluded.error,
        updated_at = excluded.updated_at
    `,
  });

  const reserveRow = SqlSchema.findOneOption({
    Request: Schema.Struct({
      link: CoagentThreadLink,
      maxActiveChildren: Schema.Int,
    }),
    Result: Schema.Struct({ childThreadId: ThreadId }),
    execute: ({ link, maxActiveChildren }) => sql`
      INSERT INTO coagent_threads (
        child_thread_id,
        parent_thread_id,
        project_id,
        assignment,
        creation_mode,
        status,
        error,
        created_at,
        updated_at
      )
      SELECT
        ${link.childThreadId},
        ${link.parentThreadId},
        ${link.projectId},
        ${link.assignment},
        ${link.creationMode},
        ${link.status},
        ${link.error},
        ${link.createdAt},
        ${link.updatedAt}
      WHERE (
        SELECT COUNT(*)
        FROM coagent_threads
        WHERE parent_thread_id = ${link.parentThreadId}
          AND status NOT IN ('failed', 'released')
      ) < ${maxActiveChildren}
      ON CONFLICT (child_thread_id) DO NOTHING
      RETURNING child_thread_id AS "childThreadId"
    `,
  });

  const getByChildRow = SqlSchema.findOneOption({
    Request: ThreadId,
    Result: CoagentThreadLink,
    execute: (childThreadId) => sql`
      SELECT
        child_thread_id AS "childThreadId",
        parent_thread_id AS "parentThreadId",
        project_id AS "projectId",
        assignment,
        creation_mode AS "creationMode",
        status,
        error,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM coagent_threads
      WHERE child_thread_id = ${childThreadId}
      LIMIT 1
    `,
  });

  const listByParentRows = SqlSchema.findAll({
    Request: ThreadId,
    Result: CoagentThreadLink,
    execute: (parentThreadId) => sql`
      SELECT
        child_thread_id AS "childThreadId",
        parent_thread_id AS "parentThreadId",
        project_id AS "projectId",
        assignment,
        creation_mode AS "creationMode",
        status,
        error,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM coagent_threads
      WHERE parent_thread_id = ${parentThreadId}
      ORDER BY created_at ASC, child_thread_id ASC
    `,
  });

  const listDeletedPendingHistoryCleanupRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({ childThreadId: ThreadId }),
    execute: () => sql`
      SELECT c.child_thread_id AS "childThreadId"
      FROM coagent_threads c
      JOIN projection_threads t ON t.thread_id = c.child_thread_id
      WHERE t.deleted_at IS NOT NULL
        AND c.provider_history_deleted_at IS NULL
      ORDER BY t.deleted_at ASC, c.child_thread_id ASC
    `,
  });

  const isDeletedPendingHistoryCleanupRow = SqlSchema.findOneOption({
    Request: ThreadId,
    Result: Schema.Struct({ childThreadId: ThreadId }),
    execute: (childThreadId) => sql`
      SELECT c.child_thread_id AS "childThreadId"
      FROM coagent_threads c
      JOIN projection_threads t ON t.thread_id = c.child_thread_id
      WHERE c.child_thread_id = ${childThreadId}
        AND t.deleted_at IS NOT NULL
        AND c.provider_history_deleted_at IS NULL
      LIMIT 1
    `,
  });

  return CoagentRegistry.of({
    reserve: (link, maxActiveChildren) =>
      reserveRow({ link, maxActiveChildren }).pipe(
        Effect.map(Option.isSome),
        Effect.mapError(toPersistenceSqlError("CoagentRegistry.reserve")),
      ),
    upsert: (link) =>
      upsertRow(link).pipe(Effect.mapError(toPersistenceSqlError("CoagentRegistry.upsert"))),
    getByChild: (childThreadId) =>
      getByChildRow(childThreadId).pipe(
        Effect.mapError(toPersistenceSqlError("CoagentRegistry.getByChild")),
      ),
    listByParent: (parentThreadId) =>
      listByParentRows(parentThreadId).pipe(
        Effect.mapError(toPersistenceSqlError("CoagentRegistry.listByParent")),
      ),
    listDeletedPendingHistoryCleanup: () =>
      listDeletedPendingHistoryCleanupRows().pipe(
        Effect.map((rows) => rows.map((row) => row.childThreadId)),
        Effect.mapError(toPersistenceSqlError("CoagentRegistry.listDeletedPendingHistoryCleanup")),
      ),
    isDeletedPendingHistoryCleanup: (childThreadId) =>
      isDeletedPendingHistoryCleanupRow(childThreadId).pipe(
        Effect.map(Option.isSome),
        Effect.mapError(toPersistenceSqlError("CoagentRegistry.isDeletedPendingHistoryCleanup")),
      ),
    markProviderHistoryDeleted: (childThreadId, deletedAt) =>
      sql`
        UPDATE coagent_threads
        SET provider_history_deleted_at = ${deletedAt}
        WHERE child_thread_id = ${childThreadId}
          AND provider_history_deleted_at IS NULL
          AND EXISTS (
            SELECT 1 FROM projection_threads
            WHERE thread_id = ${childThreadId} AND deleted_at IS NOT NULL
          )
      `.pipe(
        Effect.asVoid,
        Effect.mapError(toPersistenceSqlError("CoagentRegistry.markProviderHistoryDeleted")),
      ),
  });
});

export const CoagentRegistryLive = Layer.effect(CoagentRegistry, make);
