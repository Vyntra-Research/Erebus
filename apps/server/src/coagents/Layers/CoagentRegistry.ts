import { NonNegativeInt, ThreadId } from "@t3tools/contracts";
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
        observer_campaign_id,
        observer_message_count,
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
        ${row.observerCampaignId},
        ${row.observerMessageCount},
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
        observer_campaign_id = excluded.observer_campaign_id,
        observer_message_count = excluded.observer_message_count,
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
        observer_campaign_id,
        observer_message_count,
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
        ${link.observerCampaignId},
        ${link.observerMessageCount},
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
        observer_campaign_id AS "observerCampaignId",
        observer_message_count AS "observerMessageCount",
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
        observer_campaign_id AS "observerCampaignId",
        observer_message_count AS "observerMessageCount",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM coagent_threads
      WHERE parent_thread_id = ${parentThreadId}
      ORDER BY created_at ASC, child_thread_id ASC
    `,
  });

  const setObserverCursorRow = SqlSchema.void({
    Request: Schema.Struct({
      childThreadId: ThreadId,
      campaignId: Schema.String,
      messageCount: NonNegativeInt,
      updatedAt: Schema.String,
    }),
    execute: ({ childThreadId, campaignId, messageCount, updatedAt }) => sql`
      UPDATE coagent_threads
      SET observer_campaign_id = ${campaignId},
          observer_message_count = ${messageCount},
          updated_at = ${updatedAt}
      WHERE child_thread_id = ${childThreadId}
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
    setObserverCursor: (input) =>
      setObserverCursorRow(input).pipe(
        Effect.mapError(toPersistenceSqlError("CoagentRegistry.setObserverCursor")),
      ),
  });
});

export const CoagentRegistryLive = Layer.effect(CoagentRegistry, make);
