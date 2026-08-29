import {
  NonNegativeInt,
  ResearchCampaign,
  ResearchCampaignId,
  ResearchCheckpointInput,
  ResearchContract,
  ResearchEvent,
  ResearchFindingSubmission,
  ResearchIntervention,
  ResearchJudgeEvaluation,
  ResearchObserverEvaluation,
  ResearchPrincipalMessage,
  ResearchToolResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceDecodeError, toPersistenceSqlError } from "../../persistence/Errors.ts";
import {
  ResearchCampaignStore,
  type ResearchCampaignCommitResult,
  type ResearchCampaignStoreShape,
} from "../Services/ResearchCampaignStore.ts";
import type { ResearchProjection } from "../researchState.ts";

const PersistedResearchProjection = Schema.Struct({
  campaign: Schema.NullOr(ResearchCampaign),
  contracts: Schema.Array(ResearchContract),
  principalMessageItemIds: Schema.Array(Schema.String),
  principalMessages: Schema.Array(ResearchPrincipalMessage),
  observerEvaluations: Schema.Array(ResearchObserverEvaluation),
  findings: Schema.Array(ResearchFindingSubmission),
  judgeEvaluations: Schema.Array(ResearchJudgeEvaluation),
  interventions: Schema.Array(ResearchIntervention),
  checkpoints: Schema.Array(ResearchCheckpointInput),
  processedEventIds: Schema.Array(Schema.String),
  lastSequence: NonNegativeInt,
});

const PersistedProjectionJson = Schema.fromJsonString(PersistedResearchProjection);
const ResearchEventJson = Schema.fromJsonString(ResearchEvent);
const ResearchToolResultJson = Schema.fromJsonString(ResearchToolResult);

const ProjectionRow = Schema.Struct({ stateJson: Schema.String });
const ReceiptRow = Schema.Struct({
  eventJson: Schema.String,
  stateJson: Schema.String,
  resultJson: Schema.String,
});

const encodeProjection = Schema.encodeEffect(PersistedProjectionJson);
const decodeProjection = Schema.decodeUnknownEffect(PersistedProjectionJson);
const encodeEvent = Schema.encodeEffect(ResearchEventJson);
const decodeEvent = Schema.decodeUnknownEffect(ResearchEventJson);
const encodeResult = Schema.encodeEffect(ResearchToolResultJson);
const decodeResult = Schema.decodeUnknownEffect(ResearchToolResultJson);
const decodeProjectionRows = Schema.decodeUnknownEffect(Schema.Array(ProjectionRow));
const decodeReceiptRows = Schema.decodeUnknownEffect(Schema.Array(ReceiptRow));

const toPersistedProjection = (projection: ResearchProjection) => ({
  ...projection,
  principalMessageItemIds: projection.principalMessageItemIds.map(String),
  processedEventIds: Array.from(projection.processedEventIds),
});

const fromPersistedProjection = (
  projection: typeof PersistedResearchProjection.Type,
): ResearchProjection => ({
  ...projection,
  principalMessageItemIds:
    projection.principalMessageItemIds as ResearchProjection["principalMessageItemIds"],
  processedEventIds: new Set(projection.processedEventIds),
});

const decodeFailure = (operation: string) => (cause: Schema.SchemaError) =>
  PersistenceDecodeError.fromSchemaError(operation, cause);

const makeResearchCampaignStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const decodeProjectionJson = (json: string) =>
    decodeProjection(json).pipe(
      Effect.map(fromPersistedProjection),
      Effect.mapError(decodeFailure("ResearchCampaignStore.decodeProjection")),
    );

  const findProjectionWhere = (column: "campaign_id" | "principal_thread_id", value: string) =>
    Effect.gen(function* () {
      const rows = yield* (
        column === "campaign_id"
          ? sql`
              SELECT state_json AS "stateJson"
              FROM research_campaign_projections
              WHERE campaign_id = ${value}
              LIMIT 1
            `
          : sql`
              SELECT state_json AS "stateJson"
              FROM research_campaign_projections
              WHERE principal_thread_id = ${value}
              ORDER BY
                CASE
                  WHEN json_extract(state_json, '$.campaign.status') IN ('completed', 'aborted')
                    THEN 1
                  ELSE 0
                END ASC,
                updated_at DESC,
                campaign_id DESC
              LIMIT 1
            `
      ).pipe(Effect.mapError(toPersistenceSqlError("ResearchCampaignStore.findProjection")));
      const decodedRows = yield* decodeProjectionRows(rows).pipe(
        Effect.mapError(decodeFailure("ResearchCampaignStore.findProjection:rows")),
      );
      return decodedRows[0] ? yield* decodeProjectionJson(decodedRows[0].stateJson) : null;
    });

  const findReceipt: ResearchCampaignStoreShape["findReceipt"] = (commandId) =>
    Effect.gen(function* () {
      const rowsRaw = yield* sql`
        SELECT
          events.event_json AS "eventJson",
          projections.state_json AS "stateJson",
          receipts.result_json AS "resultJson"
        FROM research_command_receipts AS receipts
        JOIN research_events AS events
          ON events.command_id = receipts.command_id
        JOIN research_campaign_projections AS projections
          ON projections.campaign_id = receipts.campaign_id
        WHERE receipts.command_id = ${commandId}
        LIMIT 1
      `.pipe(Effect.mapError(toPersistenceSqlError("ResearchCampaignStore.findReceipt")));
      const rows = yield* decodeReceiptRows(rowsRaw).pipe(
        Effect.mapError(decodeFailure("ResearchCampaignStore.findReceipt:rows")),
      );
      const row = rows[0];
      if (!row) return null;
      const [event, projection, result] = yield* Effect.all([
        decodeEvent(row.eventJson).pipe(
          Effect.mapError(decodeFailure("ResearchCampaignStore.findReceipt:event")),
        ),
        decodeProjectionJson(row.stateJson),
        decodeResult(row.resultJson).pipe(
          Effect.mapError(decodeFailure("ResearchCampaignStore.findReceipt:result")),
        ),
      ]);
      return { replayed: true, event, projection, result } satisfies ResearchCampaignCommitResult;
    });

  const commit: ResearchCampaignStoreShape["commit"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const existingRowsRaw = yield* sql`
          SELECT
            events.event_json AS "eventJson",
            projections.state_json AS "stateJson",
            receipts.result_json AS "resultJson"
          FROM research_command_receipts AS receipts
          JOIN research_events AS events
            ON events.command_id = receipts.command_id
          JOIN research_campaign_projections AS projections
            ON projections.campaign_id = receipts.campaign_id
          WHERE receipts.command_id = ${input.commandId}
          LIMIT 1
        `;
          const existingRows = yield* decodeReceiptRows(existingRowsRaw).pipe(
            Effect.mapError(decodeFailure("ResearchCampaignStore.commit:receiptRows")),
          );
          const existing = existingRows[0];
          if (existing) {
            const [event, projection, result] = yield* Effect.all([
              decodeEvent(existing.eventJson).pipe(
                Effect.mapError(decodeFailure("ResearchCampaignStore.commit:receiptEvent")),
              ),
              decodeProjectionJson(existing.stateJson),
              decodeResult(existing.resultJson).pipe(
                Effect.mapError(decodeFailure("ResearchCampaignStore.commit:receiptResult")),
              ),
            ]);
            return {
              replayed: true,
              event,
              projection,
              result,
            } satisfies ResearchCampaignCommitResult;
          }

          const [eventJson, stateJson, resultJson] = yield* Effect.all([
            encodeEvent(input.event).pipe(
              Effect.mapError(decodeFailure("ResearchCampaignStore.commit:encodeEvent")),
            ),
            encodeProjection(toPersistedProjection(input.projection)).pipe(
              Effect.mapError(decodeFailure("ResearchCampaignStore.commit:encodeProjection")),
            ),
            encodeResult(input.result).pipe(
              Effect.mapError(decodeFailure("ResearchCampaignStore.commit:encodeResult")),
            ),
          ]);

          yield* sql`
          INSERT INTO research_events (
            event_id,
            campaign_id,
            campaign_version,
            command_id,
            event_type,
            recorded_at,
            event_json
          ) VALUES (
            ${input.event.eventId},
            ${input.event.campaignId},
            ${input.event.sequence},
            ${input.commandId},
            ${input.event.type},
            ${input.event.recordedAt},
            ${eventJson}
          )
        `;

          const campaign = input.projection.campaign!;
          yield* sql`
          INSERT INTO research_campaign_projections (
            campaign_id,
            project_id,
            principal_thread_id,
            last_sequence,
            state_json,
            updated_at
          ) VALUES (
            ${campaign.id},
            ${campaign.projectId},
            ${campaign.principalThreadId},
            ${input.projection.lastSequence},
            ${stateJson},
            ${campaign.updatedAt}
          )
          ON CONFLICT(campaign_id) DO UPDATE SET
            project_id = excluded.project_id,
            principal_thread_id = excluded.principal_thread_id,
            last_sequence = excluded.last_sequence,
            state_json = excluded.state_json,
            updated_at = excluded.updated_at
          WHERE research_campaign_projections.last_sequence = excluded.last_sequence - 1
        `;

          yield* sql`
          INSERT INTO research_command_receipts (
            command_id,
            campaign_id,
            status,
            event_sequence,
            result_json,
            accepted_at
          ) VALUES (
            ${input.commandId},
            ${input.event.campaignId},
            ${"accepted"},
            ${input.event.sequence},
            ${resultJson},
            ${input.event.recordedAt}
          )
        `;

          return {
            replayed: false,
            event: input.event,
            projection: input.projection,
            result: input.result,
          } satisfies ResearchCampaignCommitResult;
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("ResearchCampaignStore.commit")));

  return ResearchCampaignStore.of({
    findReceipt,
    findProjection: (campaignId: ResearchCampaignId) =>
      findProjectionWhere("campaign_id", campaignId),
    findProjectionByThread: (threadId: string) =>
      findProjectionWhere("principal_thread_id", threadId),
    listProjections: () =>
      Effect.gen(function* () {
        const rows = yield* sql`
          SELECT state_json AS "stateJson"
          FROM research_campaign_projections
          ORDER BY updated_at ASC, campaign_id ASC
        `.pipe(Effect.mapError(toPersistenceSqlError("ResearchCampaignStore.listProjections")));
        const decodedRows = yield* decodeProjectionRows(rows).pipe(
          Effect.mapError(decodeFailure("ResearchCampaignStore.listProjections:rows")),
        );
        return yield* Effect.forEach(decodedRows, (row) => decodeProjectionJson(row.stateJson));
      }),
    commit,
  });
});

export const ResearchCampaignStoreLive = Layer.effect(
  ResearchCampaignStore,
  makeResearchCampaignStore,
);
