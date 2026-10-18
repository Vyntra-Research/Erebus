// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  ModelSelection,
  ThreadSyncImportStageId,
  ThreadSyncImportV2Record,
  ThreadLinkedPullRequest,
  type OrchestrationEvent,
  type ThreadSyncImportV2VisibleHistory,
  type ThreadSyncImportV2Descriptor,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceSqlError, toPersistenceSqlError } from "../persistence/Errors.ts";
import { canonicalThreadSyncJson } from "../threadSync/ThreadSyncDocuments.ts";

const HASH_PAGE_SIZE = 128;
const MAX_STAGES_PER_THREAD = 8;
const MAX_VISIBLE_ITEM_BYTES = 256 * 1024;
const MAX_VISIBLE_MESSAGE_BYTES = 2 * 1024 * 1024;
const MAX_VISIBLE_PLAN_BYTES = 1024 * 1024;
const MAX_VISIBLE_ACTIVITY_BYTES = 1024 * 1024;

export interface ThreadSyncImportStageProgress {
  readonly stageId: ThreadSyncImportStageId;
  readonly nextOrdinal: number;
  readonly nextChunkIndex: number;
}

export interface PreparedThreadSyncImportStage {
  readonly stagedHash: string;
  readonly visibleHistory: ThreadSyncImportV2VisibleHistory;
}

type StageRow = {
  readonly threadId: string;
  readonly resumeKey: string;
  readonly sourceRevision: string;
  readonly sourceHash: string;
  readonly expectedRecordCount: number;
  readonly nextChunkIndex: number;
  readonly nextOrdinal: number;
  readonly validatedDescriptorHash: string | null;
  readonly validatedHash: string | null;
  readonly validatedRecordCount: number | null;
  readonly validatedAt: string | null;
};

type ChunkRow = {
  readonly chunkHash: string;
  readonly firstOrdinal: number;
  readonly lastOrdinal: number;
  readonly recordCount: number;
};

type StagingRecordFields = {
  readonly ownerId: string | null;
  readonly fragmentIndex: number | null;
  readonly fragmentText: string | null;
  readonly portableId: string | null;
};

type StagedRecordRow = {
  readonly ordinal: number;
  readonly ownerId: string;
  readonly valueJson: string;
};

function stageIntegrityError(detail: string): PersistenceSqlError {
  return new PersistenceSqlError({
    operation: "ThreadSyncImportProjection",
    detail,
  });
}

function stageStaleCutoff(startedAt: string): string {
  return DateTime.makeUnsafe(startedAt).pipe(DateTime.subtract({ hours: 24 }), DateTime.formatIso);
}

export function canonicalThreadSyncImportRecord(record: ThreadSyncImportV2Record): string {
  return canonicalThreadSyncJson(record);
}

export function threadSyncImportRecordsHash(records: Iterable<ThreadSyncImportV2Record>): string {
  const hash = NodeCrypto.createHash("sha256");
  for (const record of records) hash.update(canonicalThreadSyncImportRecord(record), "utf8");
  return hash.digest("hex");
}

export function threadSyncImportDescriptorHash(descriptor: ThreadSyncImportV2Descriptor): string {
  return NodeCrypto.createHash("sha256")
    .update(canonicalThreadSyncJson(descriptor), "utf8")
    .digest("hex");
}

export function threadSyncImportResumeKey(descriptor: ThreadSyncImportV2Descriptor): string {
  return NodeCrypto.createHash("sha256")
    .update(
      canonicalThreadSyncJson({
        ...descriptor,
        stageId: null,
        stagedHash: null,
      }),
      "utf8",
    )
    .digest("hex");
}

const decodeStagedRecord = Schema.decodeUnknownSync(
  Schema.fromJsonString(ThreadSyncImportV2Record),
);

function parseStagedRecord(valueJson: string) {
  return Effect.try({
    try: () => decodeStagedRecord(valueJson),
    catch: () => stageIntegrityError("staged record JSON is invalid"),
  });
}

function stagingRecordFields(record: ThreadSyncImportV2Record): StagingRecordFields {
  switch (record.kind) {
    case "turn":
      return {
        ownerId: record.value.turnId,
        fragmentIndex: null,
        fragmentText: null,
        portableId: record.portableId,
      };
    case "message":
    case "plan":
    case "activity":
      return {
        ownerId: record.value.id,
        fragmentIndex: null,
        fragmentText: null,
        portableId: record.portableId,
      };
    case "message-text":
      return {
        ownerId: record.messageId,
        fragmentIndex: record.fragmentIndex,
        fragmentText: record.text,
        portableId: null,
      };
    case "plan-markdown":
      return {
        ownerId: record.planId,
        fragmentIndex: record.fragmentIndex,
        fragmentText: record.text,
        portableId: null,
      };
    case "activity-summary":
      return {
        ownerId: record.activityId,
        fragmentIndex: record.fragmentIndex,
        fragmentText: record.text,
        portableId: null,
      };
  }
}

/** Finds one live, resumable attempt with the exact same import intent. */
export const findThreadSyncImportStageProgress = Effect.fn("findThreadSyncImportStageProgress")(
  (input: { readonly descriptor: ThreadSyncImportV2Descriptor; readonly now: string }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        readonly stageId: string;
        readonly nextOrdinal: number;
        readonly nextChunkIndex: number;
      }>`
        SELECT
          stage_id AS "stageId",
          next_ordinal AS "nextOrdinal",
          next_chunk_index AS "nextChunkIndex"
        FROM thread_sync_import_stages
        WHERE thread_id = ${input.descriptor.threadId}
          AND resume_key = ${threadSyncImportResumeKey(input.descriptor)}
          AND last_activity_at >= ${stageStaleCutoff(input.now)}
        ORDER BY last_activity_at DESC, stage_id DESC
        LIMIT 1
      `;
      const row = rows[0];
      return row === undefined
        ? null
        : {
            stageId: ThreadSyncImportStageId.make(row.stageId),
            nextOrdinal: row.nextOrdinal,
            nextChunkIndex: row.nextChunkIndex,
          };
    }).pipe(
      Effect.catchTag(
        "SqlError",
        toPersistenceSqlError("ThreadSyncImportProjection.findProgress:query"),
      ),
    ),
);

/**
 * Reads the complete staged hash and a bounded UI tail without loading the
 * complete history or one oversized text value into Node memory.
 */
export const prepareThreadSyncImportStage = Effect.fn("prepareThreadSyncImportStage")(
  (input: { readonly descriptor: ThreadSyncImportV2Descriptor }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { descriptor } = input;
      const stages = yield* sql<StageRow>`
        SELECT
          thread_id AS "threadId",
          resume_key AS "resumeKey",
          source_revision AS "sourceRevision",
          source_hash AS "sourceHash",
          expected_record_count AS "expectedRecordCount",
          next_chunk_index AS "nextChunkIndex",
          next_ordinal AS "nextOrdinal",
          validated_descriptor_hash AS "validatedDescriptorHash",
          validated_hash AS "validatedHash",
          validated_record_count AS "validatedRecordCount",
          validated_at AS "validatedAt"
        FROM thread_sync_import_stages
        WHERE stage_id = ${descriptor.stageId}
      `;
      const stage = stages[0];
      if (
        stage === undefined ||
        stage.threadId !== descriptor.threadId ||
        stage.resumeKey !== threadSyncImportResumeKey(descriptor) ||
        stage.sourceRevision !== descriptor.sourceRevision ||
        stage.sourceHash !== descriptor.sourceHash ||
        stage.expectedRecordCount !== descriptor.recordCount ||
        stage.nextOrdinal !== descriptor.recordCount
      ) {
        return yield* stageIntegrityError(
          `stage '${descriptor.stageId}' is incomplete or does not match its descriptor`,
        );
      }

      const hash = NodeCrypto.createHash("sha256");
      let nextOrdinal = 0;
      while (nextOrdinal < descriptor.recordCount) {
        const rows = yield* sql<{ readonly ordinal: number; readonly valueJson: string }>`
          SELECT ordinal, value_json AS "valueJson"
          FROM thread_sync_import_records
          WHERE stage_id = ${descriptor.stageId}
            AND ordinal >= ${nextOrdinal}
          ORDER BY ordinal ASC
          LIMIT ${HASH_PAGE_SIZE}
        `;
        if (rows.length === 0) {
          return yield* stageIntegrityError(
            `stage '${descriptor.stageId}' ended before its declared count`,
          );
        }
        for (const row of rows) {
          if (row.ordinal !== nextOrdinal) {
            return yield* stageIntegrityError(
              `stage '${descriptor.stageId}' has a skipped ordinal`,
            );
          }
          hash.update(row.valueJson, "utf8");
          nextOrdinal += 1;
        }
      }

      const readVisibleText = (input: {
        readonly fragmentKind: "message-text" | "plan-markdown" | "activity-summary";
        readonly ownerId: string;
        readonly descriptor: {
          readonly sha256: string;
          readonly sizeBytes: number;
          readonly fragmentCount: number;
        };
        readonly remainingBytes: number;
        readonly requireNonBlank: boolean;
      }) =>
        Effect.gen(function* () {
          if (
            input.descriptor.sizeBytes > MAX_VISIBLE_ITEM_BYTES ||
            input.descriptor.sizeBytes > input.remainingBytes
          ) {
            return null;
          }
          const fragments: string[] = [];
          const textHash = NodeCrypto.createHash("sha256");
          let nextFragmentIndex = 0;
          let sizeBytes = 0;
          let hasNonWhitespace = false;
          while (nextFragmentIndex < input.descriptor.fragmentCount) {
            const rows = yield* sql<{
              readonly fragmentIndex: number;
              readonly fragmentText: string;
            }>`
              SELECT
                fragment_index AS "fragmentIndex",
                fragment_text AS "fragmentText"
              FROM thread_sync_import_records
              WHERE stage_id = ${descriptor.stageId}
                AND kind = ${input.fragmentKind}
                AND owner_id = ${input.ownerId}
                AND fragment_index >= ${nextFragmentIndex}
              ORDER BY fragment_index ASC
              LIMIT ${HASH_PAGE_SIZE}
            `;
            if (rows.length === 0) break;
            for (const row of rows) {
              if (row.fragmentIndex !== nextFragmentIndex) {
                return yield* stageIntegrityError(
                  `stage '${descriptor.stageId}' has an invalid visible text fragment sequence`,
                );
              }
              const fragmentBytes = Buffer.byteLength(row.fragmentText, "utf8");
              sizeBytes += fragmentBytes;
              if (sizeBytes > MAX_VISIBLE_ITEM_BYTES) return null;
              textHash.update(row.fragmentText, "utf8");
              fragments.push(row.fragmentText);
              hasNonWhitespace ||= row.fragmentText.trim().length !== 0;
              nextFragmentIndex += 1;
            }
          }
          if (
            nextFragmentIndex !== input.descriptor.fragmentCount ||
            sizeBytes !== input.descriptor.sizeBytes ||
            textHash.digest("hex") !== input.descriptor.sha256 ||
            (input.requireNonBlank && !hasNonWhitespace)
          ) {
            return yield* stageIntegrityError(
              `stage '${descriptor.stageId}' has invalid visible reconstructed text`,
            );
          }
          return fragments.join("");
        });

      const latestTurn =
        descriptor.header.latestTurnId === null
          ? null
          : yield* Effect.gen(function* () {
              const rows = yield* sql<{ readonly valueJson: string }>`
                SELECT value_json AS "valueJson"
                FROM thread_sync_import_records
                WHERE stage_id = ${descriptor.stageId}
                  AND kind = 'turn'
                  AND owner_id = ${descriptor.header.latestTurnId}
                LIMIT 2
              `;
              if (rows.length !== 1) {
                return yield* stageIntegrityError(
                  `stage '${descriptor.stageId}' has an invalid latest turn`,
                );
              }
              const record = yield* parseStagedRecord(rows[0]!.valueJson);
              if (record.kind !== "turn") {
                return yield* stageIntegrityError(
                  `stage '${descriptor.stageId}' has an invalid latest turn record`,
                );
              }
              return record.value;
            });

      const messagesDescending: ThreadSyncImportV2VisibleHistory["messages"][number][] = [];
      let messageBytes = 0;
      let messageCursor = descriptor.recordCount;
      let inspectedMessages = 0;
      while (inspectedMessages < 128 && messageBytes < MAX_VISIBLE_MESSAGE_BYTES) {
        const rows = yield* sql<StagedRecordRow>`
          SELECT ordinal, owner_id AS "ownerId", value_json AS "valueJson"
          FROM thread_sync_import_records
          WHERE stage_id = ${descriptor.stageId}
            AND kind = 'message'
            AND ordinal < ${messageCursor}
          ORDER BY ordinal DESC
          LIMIT ${HASH_PAGE_SIZE}
        `;
        if (rows.length === 0) break;
        for (const row of rows) {
          messageCursor = row.ordinal;
          if (inspectedMessages >= 128) break;
          inspectedMessages += 1;
          const record = yield* parseStagedRecord(row.valueJson);
          if (record.kind !== "message") {
            return yield* stageIntegrityError(
              `stage '${descriptor.stageId}' has invalid visible message metadata`,
            );
          }
          const text = yield* readVisibleText({
            fragmentKind: "message-text",
            ownerId: row.ownerId,
            descriptor: record.value.text,
            remainingBytes: MAX_VISIBLE_MESSAGE_BYTES - messageBytes,
            requireNonBlank: false,
          });
          if (text === null) continue;
          messagesDescending.push({
            id: record.value.id,
            role: record.value.role,
            text,
            attachments: record.value.attachments,
            turnId: record.value.turnId,
            streaming: false,
            createdAt: record.value.createdAt,
            updatedAt: record.value.updatedAt,
          });
          messageBytes += record.value.text.sizeBytes;
        }
      }

      const plansDescending: ThreadSyncImportV2VisibleHistory["proposedPlans"][number][] = [];
      let planBytes = 0;
      let planCursor = descriptor.recordCount;
      let inspectedPlans = 0;
      while (inspectedPlans < 200 && planBytes < MAX_VISIBLE_PLAN_BYTES) {
        const rows = yield* sql<StagedRecordRow>`
          SELECT ordinal, owner_id AS "ownerId", value_json AS "valueJson"
          FROM thread_sync_import_records
          WHERE stage_id = ${descriptor.stageId}
            AND kind = 'plan'
            AND ordinal < ${planCursor}
          ORDER BY ordinal DESC
          LIMIT ${HASH_PAGE_SIZE}
        `;
        if (rows.length === 0) break;
        for (const row of rows) {
          planCursor = row.ordinal;
          if (inspectedPlans >= 200) break;
          inspectedPlans += 1;
          const record = yield* parseStagedRecord(row.valueJson);
          if (record.kind !== "plan") {
            return yield* stageIntegrityError(
              `stage '${descriptor.stageId}' has invalid visible plan metadata`,
            );
          }
          const planMarkdown = yield* readVisibleText({
            fragmentKind: "plan-markdown",
            ownerId: row.ownerId,
            descriptor: record.value.planMarkdown,
            remainingBytes: MAX_VISIBLE_PLAN_BYTES - planBytes,
            requireNonBlank: true,
          });
          if (planMarkdown === null) continue;
          plansDescending.push({
            id: record.value.id,
            turnId: record.value.turnId,
            planMarkdown,
            implementedAt: record.value.implementedAt,
            implementationThreadId: record.value.implementationThreadId,
            createdAt: record.value.createdAt,
            updatedAt: record.value.updatedAt,
          });
          planBytes += record.value.planMarkdown.sizeBytes;
        }
      }

      const activitiesDescending: ThreadSyncImportV2VisibleHistory["activities"][number][] = [];
      let activityBytes = 0;
      let activityCursor = descriptor.recordCount;
      let inspectedActivities = 0;
      while (inspectedActivities < 500 && activityBytes < MAX_VISIBLE_ACTIVITY_BYTES) {
        const rows = yield* sql<StagedRecordRow>`
          SELECT ordinal, owner_id AS "ownerId", value_json AS "valueJson"
          FROM thread_sync_import_records
          WHERE stage_id = ${descriptor.stageId}
            AND kind = 'activity'
            AND ordinal < ${activityCursor}
          ORDER BY ordinal DESC
          LIMIT ${HASH_PAGE_SIZE}
        `;
        if (rows.length === 0) break;
        for (const row of rows) {
          activityCursor = row.ordinal;
          if (inspectedActivities >= 500) break;
          inspectedActivities += 1;
          const record = yield* parseStagedRecord(row.valueJson);
          if (record.kind !== "activity") {
            return yield* stageIntegrityError(
              `stage '${descriptor.stageId}' has invalid visible activity metadata`,
            );
          }
          const summary = yield* readVisibleText({
            fragmentKind: "activity-summary",
            ownerId: row.ownerId,
            descriptor: record.value.summary,
            remainingBytes: MAX_VISIBLE_ACTIVITY_BYTES - activityBytes,
            requireNonBlank: true,
          });
          if (summary === null) continue;
          activitiesDescending.push({
            id: record.value.id,
            tone: record.value.tone,
            kind: record.value.kind,
            summary,
            turnId: record.value.turnId,
            ...(record.value.sequence === null ? {} : { sequence: record.value.sequence }),
            createdAt: record.value.createdAt,
          });
          activityBytes += record.value.summary.sizeBytes;
        }
      }

      return {
        stagedHash: hash.digest("hex"),
        visibleHistory: {
          latestTurn,
          messages: messagesDescending.toReversed(),
          proposedPlans: plansDescending.toReversed(),
          activities: activitiesDescending.toReversed(),
        },
      } satisfies PreparedThreadSyncImportStage;
    }).pipe(
      Effect.catchTag(
        "SqlError",
        toPersistenceSqlError("ThreadSyncImportProjection.prepareStage:query"),
      ),
    ),
);

const encodeModelSelection = Schema.encodeSync(Schema.fromJsonString(ModelSelection));
const encodeLinkedPullRequest = Schema.encodeSync(Schema.fromJsonString(ThreadLinkedPullRequest));

/**
 * Verifies the complete staged stream before the durable validation and final
 * import events are dispatched. It never mutates the public projections.
 */
export const validateThreadSyncImportStage = Effect.fn("validateThreadSyncImportStage")(
  (input: { readonly descriptor: ThreadSyncImportV2Descriptor; readonly stagedHash: string }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { descriptor, stagedHash } = input;
      if (descriptor.stagedHash !== stagedHash) {
        return yield* stageIntegrityError(
          `stage '${descriptor.stageId}' descriptor does not carry its final hash`,
        );
      }
      const stages = yield* sql<StageRow>`
        SELECT
          thread_id AS "threadId",
          resume_key AS "resumeKey",
          source_revision AS "sourceRevision",
          source_hash AS "sourceHash",
          expected_record_count AS "expectedRecordCount",
          next_chunk_index AS "nextChunkIndex",
          next_ordinal AS "nextOrdinal",
          validated_descriptor_hash AS "validatedDescriptorHash",
          validated_hash AS "validatedHash",
          validated_record_count AS "validatedRecordCount",
          validated_at AS "validatedAt"
        FROM thread_sync_import_stages
        WHERE stage_id = ${descriptor.stageId}
      `;
      const stage = stages[0];
      if (
        stage === undefined ||
        stage.threadId !== descriptor.threadId ||
        stage.resumeKey !== threadSyncImportResumeKey(descriptor) ||
        stage.sourceRevision !== descriptor.sourceRevision ||
        stage.sourceHash !== descriptor.sourceHash ||
        stage.expectedRecordCount !== descriptor.recordCount ||
        stage.nextOrdinal !== descriptor.recordCount
      ) {
        return yield* stageIntegrityError(
          `stage '${descriptor.stageId}' is incomplete or does not match its descriptor`,
        );
      }

      const hash = NodeCrypto.createHash("sha256");
      let nextOrdinal = 0;
      while (nextOrdinal < descriptor.recordCount) {
        const rows = yield* sql<{ readonly ordinal: number; readonly valueJson: string }>`
          SELECT ordinal, value_json AS "valueJson"
          FROM thread_sync_import_records
          WHERE stage_id = ${descriptor.stageId}
            AND ordinal >= ${nextOrdinal}
          ORDER BY ordinal ASC
          LIMIT ${HASH_PAGE_SIZE}
        `;
        if (rows.length === 0) {
          return yield* stageIntegrityError(
            `stage '${descriptor.stageId}' ended before its declared count`,
          );
        }
        for (const row of rows) {
          if (row.ordinal !== nextOrdinal) {
            return yield* stageIntegrityError(
              `stage '${descriptor.stageId}' has a skipped ordinal`,
            );
          }
          hash.update(row.valueJson, "utf8");
          nextOrdinal += 1;
        }
      }
      if (hash.digest("hex") !== stagedHash) {
        return yield* stageIntegrityError(
          `stage '${descriptor.stageId}' failed its final hash validation`,
        );
      }

      const duplicateOwners = yield* sql<{ readonly kind: string; readonly ownerId: string }>`
        SELECT kind, owner_id AS "ownerId"
        FROM thread_sync_import_records
        WHERE stage_id = ${descriptor.stageId}
          AND kind IN ('turn', 'message', 'plan', 'activity')
        GROUP BY kind, owner_id
        HAVING COUNT(*) <> 1
        LIMIT 1
      `;
      if (duplicateOwners.length !== 0) {
        return yield* stageIntegrityError(
          `stage '${descriptor.stageId}' has duplicate ${duplicateOwners[0]!.kind} id '${duplicateOwners[0]!.ownerId}'`,
        );
      }

      const danglingText = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM thread_sync_import_records AS fragment
        LEFT JOIN thread_sync_import_records AS metadata
          ON metadata.stage_id = fragment.stage_id
          AND metadata.owner_id = fragment.owner_id
          AND metadata.kind = CASE fragment.kind
            WHEN 'message-text' THEN 'message'
            WHEN 'plan-markdown' THEN 'plan'
            WHEN 'activity-summary' THEN 'activity'
          END
        WHERE fragment.stage_id = ${descriptor.stageId}
          AND fragment.kind IN ('message-text', 'plan-markdown', 'activity-summary')
          AND metadata.owner_id IS NULL
      `;
      if ((danglingText[0]?.count ?? 0) !== 0) {
        return yield* stageIntegrityError(
          `stage '${descriptor.stageId}' has detached text fragments`,
        );
      }

      let metadataOrdinal = -1;
      while (true) {
        const metadataRows = yield* sql<{
          readonly ordinal: number;
          readonly kind: "message" | "plan" | "activity";
          readonly ownerId: string;
          readonly expectedHash: string;
          readonly expectedSizeBytes: number;
          readonly expectedFragmentCount: number;
        }>`
          SELECT
            ordinal,
            kind,
            owner_id AS "ownerId",
            CASE kind
              WHEN 'message' THEN json_extract(value_json, '$.value.text.sha256')
              WHEN 'plan' THEN json_extract(value_json, '$.value.planMarkdown.sha256')
              WHEN 'activity' THEN json_extract(value_json, '$.value.summary.sha256')
            END AS "expectedHash",
            CASE kind
              WHEN 'message' THEN json_extract(value_json, '$.value.text.sizeBytes')
              WHEN 'plan' THEN json_extract(value_json, '$.value.planMarkdown.sizeBytes')
              WHEN 'activity' THEN json_extract(value_json, '$.value.summary.sizeBytes')
            END AS "expectedSizeBytes",
            CASE kind
              WHEN 'message' THEN json_extract(value_json, '$.value.text.fragmentCount')
              WHEN 'plan' THEN json_extract(value_json, '$.value.planMarkdown.fragmentCount')
              WHEN 'activity' THEN json_extract(value_json, '$.value.summary.fragmentCount')
            END AS "expectedFragmentCount"
          FROM thread_sync_import_records
          WHERE stage_id = ${descriptor.stageId}
            AND kind IN ('message', 'plan', 'activity')
            AND ordinal > ${metadataOrdinal}
          ORDER BY ordinal ASC
          LIMIT ${HASH_PAGE_SIZE}
        `;
        if (metadataRows.length === 0) break;

        for (const metadata of metadataRows) {
          const fragmentKind =
            metadata.kind === "message"
              ? "message-text"
              : metadata.kind === "plan"
                ? "plan-markdown"
                : "activity-summary";
          const textHash = NodeCrypto.createHash("sha256");
          let fragmentIndex = 0;
          let sizeBytes = 0;
          let hasNonWhitespace = false;

          while (fragmentIndex < metadata.expectedFragmentCount) {
            const fragmentRows = yield* sql<{
              readonly fragmentIndex: number;
              readonly fragmentText: string;
            }>`
              SELECT
                fragment_index AS "fragmentIndex",
                fragment_text AS "fragmentText"
              FROM thread_sync_import_records
              WHERE stage_id = ${descriptor.stageId}
                AND kind = ${fragmentKind}
                AND owner_id = ${metadata.ownerId}
                AND fragment_index >= ${fragmentIndex}
              ORDER BY fragment_index ASC
              LIMIT ${HASH_PAGE_SIZE}
            `;
            if (fragmentRows.length === 0) break;
            for (const fragment of fragmentRows) {
              if (fragment.fragmentIndex !== fragmentIndex) {
                return yield* stageIntegrityError(
                  `stage '${descriptor.stageId}' has an invalid text fragment sequence`,
                );
              }
              textHash.update(fragment.fragmentText, "utf8");
              sizeBytes += Buffer.byteLength(fragment.fragmentText, "utf8");
              hasNonWhitespace ||= fragment.fragmentText.trim().length !== 0;
              fragmentIndex += 1;
            }
          }

          if (
            fragmentIndex !== metadata.expectedFragmentCount ||
            sizeBytes !== metadata.expectedSizeBytes ||
            textHash.digest("hex") !== metadata.expectedHash
          ) {
            return yield* stageIntegrityError(
              `stage '${descriptor.stageId}' reconstructed text does not match its descriptor`,
            );
          }
          if (metadata.kind !== "message" && !hasNonWhitespace) {
            return yield* stageIntegrityError(
              `stage '${descriptor.stageId}' reconstructed blank plan or activity text`,
            );
          }
          metadataOrdinal = metadata.ordinal;
        }
      }

      const missingTurnReferences = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM thread_sync_import_records AS child
        LEFT JOIN thread_sync_import_records AS turn_record
          ON turn_record.stage_id = child.stage_id
          AND turn_record.kind = 'turn'
          AND turn_record.owner_id = json_extract(child.value_json, '$.value.turnId')
        WHERE child.stage_id = ${descriptor.stageId}
          AND child.kind IN ('message', 'plan', 'activity')
          AND json_extract(child.value_json, '$.value.turnId') IS NOT NULL
          AND turn_record.owner_id IS NULL
      `;
      if ((missingTurnReferences[0]?.count ?? 0) !== 0) {
        return yield* stageIntegrityError(
          `stage '${descriptor.stageId}' references a missing turn`,
        );
      }

      const invalidTurnReferences = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM thread_sync_import_records AS turn_record
        LEFT JOIN thread_sync_import_records AS pending_message
          ON pending_message.stage_id = turn_record.stage_id
          AND pending_message.kind = 'message'
          AND pending_message.owner_id = json_extract(
            turn_record.value_json,
            '$.value.pendingMessageId'
          )
        LEFT JOIN thread_sync_import_records AS assistant_message
          ON assistant_message.stage_id = turn_record.stage_id
          AND assistant_message.kind = 'message'
          AND assistant_message.owner_id = json_extract(
            turn_record.value_json,
            '$.value.assistantMessageId'
          )
        LEFT JOIN thread_sync_import_records AS source_plan
          ON source_plan.stage_id = turn_record.stage_id
          AND source_plan.kind = 'plan'
          AND source_plan.owner_id = json_extract(
            turn_record.value_json,
            '$.value.sourceProposedPlanId'
          )
        WHERE turn_record.stage_id = ${descriptor.stageId}
          AND turn_record.kind = 'turn'
          AND (
            (json_extract(turn_record.value_json, '$.value.pendingMessageId') IS NOT NULL
              AND (
                pending_message.owner_id IS NULL
                OR json_extract(pending_message.value_json, '$.value.role') <> 'user'
              ))
            OR (json_extract(turn_record.value_json, '$.value.assistantMessageId') IS NOT NULL
              AND (
                assistant_message.owner_id IS NULL
                OR json_extract(assistant_message.value_json, '$.value.role') <> 'assistant'
              ))
            OR (
              (json_extract(turn_record.value_json, '$.value.sourceProposedPlanThreadId') IS NULL)
              <> (json_extract(turn_record.value_json, '$.value.sourceProposedPlanId') IS NULL)
            )
            OR (
              json_extract(turn_record.value_json, '$.value.sourceProposedPlanThreadId') = ${descriptor.threadId}
              AND source_plan.owner_id IS NULL
            )
          )
      `;
      if ((invalidTurnReferences[0]?.count ?? 0) !== 0) {
        return yield* stageIntegrityError(
          `stage '${descriptor.stageId}' contains an invalid turn reference`,
        );
      }

      const latestTurnCount = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM thread_sync_import_records
        WHERE stage_id = ${descriptor.stageId}
          AND kind = 'turn'
          AND owner_id = ${descriptor.header.latestTurnId}
      `;
      if (
        (descriptor.header.latestTurnId === null && (latestTurnCount[0]?.count ?? 0) !== 0) ||
        (descriptor.header.latestTurnId !== null && (latestTurnCount[0]?.count ?? 0) !== 1)
      ) {
        return yield* stageIntegrityError(
          `stage '${descriptor.stageId}' has an invalid latest turn`,
        );
      }
    }).pipe(
      Effect.catchTag(
        "SqlError",
        toPersistenceSqlError("ThreadSyncImportProjection.validateStage:query"),
      ),
    ),
);

/** Requires the exact, durably validated descriptor before a final event exists. */
export const assertThreadSyncImportStageReadyToCommit = Effect.fn(
  "assertThreadSyncImportStageReadyToCommit",
)((input: { readonly descriptor: ThreadSyncImportV2Descriptor; readonly stagedHash: string }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { descriptor, stagedHash } = input;
    const rows = yield* sql<StageRow>`
      SELECT
        thread_id AS "threadId",
        resume_key AS "resumeKey",
        source_revision AS "sourceRevision",
        source_hash AS "sourceHash",
        expected_record_count AS "expectedRecordCount",
        next_chunk_index AS "nextChunkIndex",
        next_ordinal AS "nextOrdinal",
        validated_descriptor_hash AS "validatedDescriptorHash",
        validated_hash AS "validatedHash",
        validated_record_count AS "validatedRecordCount",
        validated_at AS "validatedAt"
      FROM thread_sync_import_stages
      WHERE stage_id = ${descriptor.stageId}
    `;
    const stage = rows[0];
    if (
      descriptor.stagedHash !== stagedHash ||
      stage === undefined ||
      stage.threadId !== descriptor.threadId ||
      stage.resumeKey !== threadSyncImportResumeKey(descriptor) ||
      stage.sourceRevision !== descriptor.sourceRevision ||
      stage.sourceHash !== descriptor.sourceHash ||
      stage.expectedRecordCount !== descriptor.recordCount ||
      stage.nextOrdinal !== descriptor.recordCount ||
      stage.validatedDescriptorHash !== threadSyncImportDescriptorHash(descriptor) ||
      stage.validatedHash !== stagedHash ||
      stage.validatedRecordCount !== descriptor.recordCount ||
      stage.validatedAt === null
    ) {
      return yield* stageIntegrityError(
        `stage '${descriptor.stageId}' is not durably validated for this commit`,
      );
    }
  }).pipe(
    Effect.catchTag(
      "SqlError",
      toPersistenceSqlError("ThreadSyncImportProjection.assertReady:query"),
    ),
  ),
);

/**
 * Writes one bounded import chunk into durable staging. The engine invokes
 * this inside the same SQLite transaction that appends the small reference
 * event and its command receipt, so a crash cannot leave either half visible.
 */
export const appendThreadSyncImportStageChunk = Effect.fn("appendThreadSyncImportStageChunk")(
  (input: {
    readonly stageId: ThreadSyncImportStageId;
    readonly threadId: string;
    readonly chunkIndex: number;
    readonly chunkHash: string;
    readonly records: ReadonlyArray<ThreadSyncImportV2Record>;
    readonly appendedAt: string;
  }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const stageRows = yield* sql<StageRow>`
        SELECT
          thread_id AS "threadId",
          resume_key AS "resumeKey",
          source_revision AS "sourceRevision",
          source_hash AS "sourceHash",
          expected_record_count AS "expectedRecordCount",
          next_chunk_index AS "nextChunkIndex",
          next_ordinal AS "nextOrdinal",
          validated_descriptor_hash AS "validatedDescriptorHash",
          validated_hash AS "validatedHash",
          validated_record_count AS "validatedRecordCount",
          validated_at AS "validatedAt"
        FROM thread_sync_import_stages
        WHERE stage_id = ${input.stageId}
      `;
      const stage = stageRows[0];
      if (stage === undefined || stage.threadId !== input.threadId) {
        return yield* stageIntegrityError(
          `stage '${input.stageId}' is missing or belongs to another thread`,
        );
      }

      const records = input.records;
      const firstOrdinal = records[0]!.ordinal;
      const lastOrdinal = records.at(-1)!.ordinal;
      if (
        records.some((record, index) => record.ordinal !== firstOrdinal + index) ||
        lastOrdinal >= stage.expectedRecordCount
      ) {
        return yield* stageIntegrityError(
          `chunk ${input.chunkIndex} for stage '${input.stageId}' is out of order`,
        );
      }
      const recordJson = records.map(canonicalThreadSyncImportRecord);
      const recordFields = records.map(stagingRecordFields);
      const computedChunkHash = NodeCrypto.createHash("sha256")
        .update(recordJson.join(""), "utf8")
        .digest("hex");
      if (computedChunkHash !== input.chunkHash) {
        return yield* stageIntegrityError(
          `chunk ${input.chunkIndex} for stage '${input.stageId}' failed hash validation`,
        );
      }

      const existingChunks = yield* sql<ChunkRow>`
        SELECT
          chunk_hash AS "chunkHash",
          first_ordinal AS "firstOrdinal",
          last_ordinal AS "lastOrdinal",
          record_count AS "recordCount"
        FROM thread_sync_import_chunks
        WHERE stage_id = ${input.stageId}
          AND chunk_index = ${input.chunkIndex}
      `;
      const existing = existingChunks[0];
      if (existing !== undefined) {
        if (
          existing.chunkHash !== input.chunkHash ||
          existing.firstOrdinal !== firstOrdinal ||
          existing.lastOrdinal !== lastOrdinal ||
          existing.recordCount !== records.length
        ) {
          return yield* stageIntegrityError(
            `chunk ${input.chunkIndex} for stage '${input.stageId}' conflicts with its persisted copy`,
          );
        }
        return;
      }

      if (
        stage.validatedAt !== null ||
        input.chunkIndex !== stage.nextChunkIndex ||
        firstOrdinal !== stage.nextOrdinal
      ) {
        return yield* stageIntegrityError(
          `chunk ${input.chunkIndex} for stage '${input.stageId}' does not continue the staged stream`,
        );
      }

      yield* sql`
        INSERT INTO thread_sync_import_chunks (
          stage_id, chunk_index, chunk_hash, first_ordinal,
          last_ordinal, record_count
        ) VALUES (
          ${input.stageId},
          ${input.chunkIndex},
          ${input.chunkHash},
          ${firstOrdinal},
          ${lastOrdinal},
          ${records.length}
        )
      `;
      yield* Effect.forEach(
        records,
        (record, index) =>
          sql`
            INSERT INTO thread_sync_import_records (
              stage_id, ordinal, chunk_index, kind, owner_id,
              fragment_index, fragment_text, portable_id, value_json
            ) VALUES (
              ${input.stageId},
              ${record.ordinal},
              ${input.chunkIndex},
              ${record.kind},
              ${recordFields[index]!.ownerId},
              ${recordFields[index]!.fragmentIndex},
              ${recordFields[index]!.fragmentText},
              ${recordFields[index]!.portableId},
              ${recordJson[index]!}
            )
          `,
        { concurrency: 1, discard: true },
      );
      yield* sql`
        UPDATE thread_sync_import_stages
        SET
          next_chunk_index = ${stage.nextChunkIndex + 1},
          next_ordinal = ${stage.nextOrdinal + records.length},
          last_activity_at = ${input.appendedAt}
        WHERE stage_id = ${input.stageId}
      `;
    }).pipe(
      Effect.catchTag(
        "SqlError",
        toPersistenceSqlError("ThreadSyncImportProjection.appendChunk:query"),
      ),
    ),
);

const assertThreadSyncImportStageChunkReference = Effect.fn(
  "assertThreadSyncImportStageChunkReference",
)(
  (input: {
    readonly stageId: ThreadSyncImportStageId;
    readonly threadId: string;
    readonly chunkIndex: number;
    readonly chunkHash: string;
    readonly firstOrdinal: number;
    readonly lastOrdinal: number;
    readonly recordCount: number;
  }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const stages = yield* sql<{ readonly threadId: string }>`
        SELECT thread_id AS "threadId"
        FROM thread_sync_import_stages
        WHERE stage_id = ${input.stageId}
      `;
      const chunks = yield* sql<ChunkRow>`
        SELECT
          chunk_hash AS "chunkHash",
          first_ordinal AS "firstOrdinal",
          last_ordinal AS "lastOrdinal",
          record_count AS "recordCount"
        FROM thread_sync_import_chunks
        WHERE stage_id = ${input.stageId}
          AND chunk_index = ${input.chunkIndex}
      `;
      const chunk = chunks[0];
      if (
        stages[0]?.threadId !== input.threadId ||
        chunk === undefined ||
        chunk.chunkHash !== input.chunkHash ||
        chunk.firstOrdinal !== input.firstOrdinal ||
        chunk.lastOrdinal !== input.lastOrdinal ||
        chunk.recordCount !== input.recordCount
      ) {
        return yield* stageIntegrityError(
          `chunk ${input.chunkIndex} for stage '${input.stageId}' is not durably staged`,
        );
      }
    }),
);

/**
 * Stages bounded v2 events and swaps a verified history into the public
 * projections. ProjectionPipeline supplies one SQLite transaction per event.
 */
export const applyThreadSyncImportProjection = Effect.fn("applyThreadSyncImportProjection")(
  (event: OrchestrationEvent) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      switch (event.type) {
        case "thread.sync-import-v2.started": {
          const descriptor = event.payload.descriptor;
          const existing = yield* sql<StageRow>`
          SELECT
            thread_id AS "threadId",
            resume_key AS "resumeKey",
            source_revision AS "sourceRevision",
            source_hash AS "sourceHash",
            expected_record_count AS "expectedRecordCount",
            next_chunk_index AS "nextChunkIndex",
            next_ordinal AS "nextOrdinal",
            validated_descriptor_hash AS "validatedDescriptorHash",
            validated_hash AS "validatedHash",
            validated_record_count AS "validatedRecordCount",
            validated_at AS "validatedAt"
          FROM thread_sync_import_stages
          WHERE stage_id = ${descriptor.stageId}
        `;
          const row = existing[0];
          if (
            row !== undefined &&
            (row.threadId !== descriptor.threadId ||
              row.resumeKey !== threadSyncImportResumeKey(descriptor) ||
              row.sourceRevision !== descriptor.sourceRevision ||
              row.sourceHash !== descriptor.sourceHash ||
              row.expectedRecordCount !== descriptor.recordCount)
          ) {
            return yield* stageIntegrityError(
              `stage '${descriptor.stageId}' was reused with different import metadata`,
            );
          }

          const staleBefore = stageStaleCutoff(event.payload.startedAt);
          yield* sql`
          DELETE FROM thread_sync_import_stages
          WHERE last_activity_at < ${staleBefore}
        `;

          yield* sql`
          INSERT OR IGNORE INTO thread_sync_import_stages (
            stage_id, thread_id, resume_key, source_revision, source_hash,
            expected_record_count, started_at, last_activity_at
          ) VALUES (
            ${descriptor.stageId},
            ${descriptor.threadId},
            ${threadSyncImportResumeKey(descriptor)},
            ${descriptor.sourceRevision},
            ${descriptor.sourceHash},
            ${descriptor.recordCount},
            ${event.payload.startedAt},
            ${event.payload.startedAt}
          )
        `;
          yield* sql`
          DELETE FROM thread_sync_import_stages
          WHERE thread_id = ${descriptor.threadId}
            AND stage_id <> ${descriptor.stageId}
            AND stage_id IN (
              SELECT stage_id
              FROM thread_sync_import_stages
              WHERE thread_id = ${descriptor.threadId}
                AND stage_id <> ${descriptor.stageId}
              ORDER BY last_activity_at DESC, stage_id DESC
              LIMIT -1 OFFSET ${MAX_STAGES_PER_THREAD - 1}
            )
        `;
          return;
        }

        case "thread.sync-import-v2.chunk-appended": {
          if ("records" in event.payload) {
            yield* appendThreadSyncImportStageChunk(event.payload);
            return;
          }
          yield* assertThreadSyncImportStageChunkReference(event.payload);
          return;
        }

        case "thread.sync-import-v2.validated":
          yield* sql`
          UPDATE thread_sync_import_stages
          SET
            validated_descriptor_hash = ${event.payload.descriptorHash},
            validated_hash = ${event.payload.stagedHash},
            validated_record_count = ${event.payload.recordCount},
            validated_at = ${event.payload.validatedAt},
            last_activity_at = ${event.payload.validatedAt}
          WHERE stage_id = ${event.payload.stageId}
            AND thread_id = ${event.payload.threadId}
        `;
          return;

        case "thread.sync-imported": {
          if (event.payload.stagedImport === undefined) return;
          const { stageId } = event.payload.stagedImport;

          const thread = event.payload.thread;

          // Nothing public changes before this point. The surrounding transaction
          // rolls every delete and insert back if any projection write fails.
          yield* sql`DELETE FROM projection_thread_messages WHERE thread_id = ${event.payload.threadId}`;
          yield* sql`DELETE FROM projection_thread_proposed_plans WHERE thread_id = ${event.payload.threadId}`;
          yield* sql`DELETE FROM projection_thread_activities WHERE thread_id = ${event.payload.threadId}`;
          yield* sql`DELETE FROM projection_turns WHERE thread_id = ${event.payload.threadId}`;
          yield* sql`DELETE FROM projection_thread_sessions WHERE thread_id = ${event.payload.threadId}`;
          yield* sql`DELETE FROM projection_pending_approvals WHERE thread_id = ${event.payload.threadId}`;

          let lastMessageOrdinal = -1;
          while (true) {
            const page = yield* sql<{ readonly ordinal: number; readonly ownerId: string }>`
              SELECT ordinal, owner_id AS "ownerId"
              FROM thread_sync_import_records
              WHERE stage_id = ${stageId}
                AND kind = 'message'
                AND ordinal > ${lastMessageOrdinal}
              ORDER BY ordinal ASC
              LIMIT ${HASH_PAGE_SIZE}
            `;
            if (page.length === 0) break;
            for (const metadataRow of page) {
              yield* sql`
                INSERT INTO projection_thread_messages (
                  message_id, sync_portable_id, thread_id, turn_id, role, text,
                  attachments_json, is_streaming, created_at, updated_at
                )
                SELECT
                  owner_id,
                  portable_id,
                  ${event.payload.threadId},
                  json_extract(value_json, '$.value.turnId'),
                  json_extract(value_json, '$.value.role'),
                  COALESCE((
                    SELECT GROUP_CONCAT(fragment_text, '')
                    FROM (
                      SELECT fragment_text
                      FROM thread_sync_import_records
                      WHERE stage_id = ${stageId}
                        AND kind = 'message-text'
                        AND owner_id = ${metadataRow.ownerId}
                      ORDER BY fragment_index ASC
                    )
                  ), ''),
                  json_extract(value_json, '$.value.attachments'),
                  0,
                  json_extract(value_json, '$.value.createdAt'),
                  json_extract(value_json, '$.value.updatedAt')
                FROM thread_sync_import_records
                WHERE stage_id = ${stageId}
                  AND kind = 'message'
                  AND ordinal = ${metadataRow.ordinal}
              `;
              lastMessageOrdinal = metadataRow.ordinal;
            }
          }

          let lastPlanOrdinal = -1;
          while (true) {
            const page = yield* sql<{ readonly ordinal: number; readonly ownerId: string }>`
              SELECT ordinal, owner_id AS "ownerId"
              FROM thread_sync_import_records
              WHERE stage_id = ${stageId}
                AND kind = 'plan'
                AND ordinal > ${lastPlanOrdinal}
              ORDER BY ordinal ASC
              LIMIT ${HASH_PAGE_SIZE}
            `;
            if (page.length === 0) break;
            for (const metadataRow of page) {
              yield* sql`
                INSERT INTO projection_thread_proposed_plans (
                  plan_id, sync_portable_id, thread_id, turn_id, plan_markdown,
                  implemented_at, implementation_thread_id, created_at, updated_at
                )
                SELECT
                  owner_id,
                  portable_id,
                  ${event.payload.threadId},
                  json_extract(value_json, '$.value.turnId'),
                  COALESCE((
                    SELECT GROUP_CONCAT(fragment_text, '')
                    FROM (
                      SELECT fragment_text
                      FROM thread_sync_import_records
                      WHERE stage_id = ${stageId}
                        AND kind = 'plan-markdown'
                        AND owner_id = ${metadataRow.ownerId}
                      ORDER BY fragment_index ASC
                    )
                  ), ''),
                  json_extract(value_json, '$.value.implementedAt'),
                  json_extract(value_json, '$.value.implementationThreadId'),
                  json_extract(value_json, '$.value.createdAt'),
                  json_extract(value_json, '$.value.updatedAt')
                FROM thread_sync_import_records
                WHERE stage_id = ${stageId}
                  AND kind = 'plan'
                  AND ordinal = ${metadataRow.ordinal}
              `;
              lastPlanOrdinal = metadataRow.ordinal;
            }
          }

          let lastActivityOrdinal = -1;
          while (true) {
            const page = yield* sql<{ readonly ordinal: number; readonly ownerId: string }>`
              SELECT ordinal, owner_id AS "ownerId"
              FROM thread_sync_import_records
              WHERE stage_id = ${stageId}
                AND kind = 'activity'
                AND ordinal > ${lastActivityOrdinal}
              ORDER BY ordinal ASC
              LIMIT ${HASH_PAGE_SIZE}
            `;
            if (page.length === 0) break;
            for (const metadataRow of page) {
              yield* sql`
                INSERT INTO projection_thread_activities (
                  activity_id, sync_portable_id, thread_id, turn_id, tone, kind,
                  summary, payload_json, sequence, created_at
                )
                SELECT
                  owner_id,
                  portable_id,
                  ${event.payload.threadId},
                  json_extract(value_json, '$.value.turnId'),
                  json_extract(value_json, '$.value.tone'),
                  json_extract(value_json, '$.value.kind'),
                  COALESCE((
                    SELECT GROUP_CONCAT(fragment_text, '')
                    FROM (
                      SELECT fragment_text
                      FROM thread_sync_import_records
                      WHERE stage_id = ${stageId}
                        AND kind = 'activity-summary'
                        AND owner_id = ${metadataRow.ownerId}
                      ORDER BY fragment_index ASC
                    )
                  ), ''),
                  'null',
                  json_extract(value_json, '$.value.sequence'),
                  json_extract(value_json, '$.value.createdAt')
                FROM thread_sync_import_records
                WHERE stage_id = ${stageId}
                  AND kind = 'activity'
                  AND ordinal = ${metadataRow.ordinal}
              `;
              lastActivityOrdinal = metadataRow.ordinal;
            }
          }

          yield* sql`
          INSERT INTO projection_turns (
            thread_id, turn_id, sync_portable_id, pending_message_id,
            source_proposed_plan_thread_id, source_proposed_plan_id,
            assistant_message_id, state, requested_at, started_at, completed_at,
            checkpoint_turn_count, checkpoint_ref, checkpoint_status,
            checkpoint_files_json
          )
          SELECT
            ${event.payload.threadId},
            owner_id,
            portable_id,
            json_extract(value_json, '$.value.pendingMessageId'),
            json_extract(value_json, '$.value.sourceProposedPlanThreadId'),
            json_extract(value_json, '$.value.sourceProposedPlanId'),
            json_extract(value_json, '$.value.assistantMessageId'),
            json_extract(value_json, '$.value.state'),
            json_extract(value_json, '$.value.requestedAt'),
            json_extract(value_json, '$.value.startedAt'),
            json_extract(value_json, '$.value.completedAt'),
            NULL, NULL, NULL, '[]'
          FROM thread_sync_import_records
          WHERE stage_id = ${stageId} AND kind = 'turn'
          ORDER BY ordinal ASC
        `;

          const summary = yield* sql<{
            readonly latestUserMessageAt: string | null;
            readonly hasActionableProposedPlan: number;
          }>`
          SELECT
            (
              SELECT MAX(created_at)
              FROM projection_thread_messages
              WHERE thread_id = ${event.payload.threadId} AND role = 'user'
            ) AS "latestUserMessageAt",
            CASE WHEN COALESCE(
              (
                SELECT implemented_at IS NULL
                FROM projection_thread_proposed_plans
                WHERE thread_id = ${event.payload.threadId}
                  AND turn_id = ${thread.latestTurn?.turnId ?? null}
                ORDER BY updated_at DESC, plan_id DESC
                LIMIT 1
              ),
              (
                SELECT implemented_at IS NULL
                FROM projection_thread_proposed_plans
                WHERE thread_id = ${event.payload.threadId}
                ORDER BY updated_at DESC, plan_id DESC
                LIMIT 1
              ),
              0
            ) THEN 1 ELSE 0 END AS "hasActionableProposedPlan"
        `;
          yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode,
            interaction_mode, branch, worktree_path, linked_pull_request_json,
            latest_turn_id, created_at, updated_at, archived_at, settled_override,
            settled_at, unsettled_at, snoozed_until, snoozed_at, pinned_at,
            pin_order_key, title_regeneration_request_id,
            title_regeneration_started_at, latest_user_message_at,
            pending_approval_count, pending_user_input_count,
            has_actionable_proposed_plan, deleted_at
          ) VALUES (
            ${event.payload.threadId},
            ${thread.projectId},
            ${thread.title},
            ${encodeModelSelection(thread.modelSelection)},
            ${thread.runtimeMode},
            ${thread.interactionMode},
            ${thread.branch},
            ${thread.worktreePath},
            ${thread.linkedPullRequest === undefined || thread.linkedPullRequest === null ? null : encodeLinkedPullRequest(thread.linkedPullRequest)},
            ${thread.latestTurn?.turnId ?? null},
            ${thread.createdAt},
            ${thread.updatedAt},
            ${thread.archivedAt},
            ${thread.settledOverride},
            ${thread.settledAt},
            ${thread.unsettledAt ?? null},
            ${thread.snoozedUntil ?? null},
            ${thread.snoozedAt ?? null},
            ${thread.pinnedAt ?? null},
            ${thread.pinOrderKey ?? null},
            NULL,
            NULL,
            ${summary[0]?.latestUserMessageAt ?? null},
            0,
            0,
            ${summary[0]?.hasActionableProposedPlan ?? 0},
            ${thread.deletedAt}
          )
          ON CONFLICT (thread_id) DO UPDATE SET
            project_id = excluded.project_id,
            title = excluded.title,
            model_selection_json = excluded.model_selection_json,
            runtime_mode = excluded.runtime_mode,
            interaction_mode = excluded.interaction_mode,
            branch = excluded.branch,
            worktree_path = excluded.worktree_path,
            linked_pull_request_json = excluded.linked_pull_request_json,
            latest_turn_id = excluded.latest_turn_id,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at,
            archived_at = excluded.archived_at,
            settled_override = excluded.settled_override,
            settled_at = excluded.settled_at,
            unsettled_at = excluded.unsettled_at,
            snoozed_until = excluded.snoozed_until,
            snoozed_at = excluded.snoozed_at,
            pinned_at = excluded.pinned_at,
            pin_order_key = excluded.pin_order_key,
            title_regeneration_request_id = excluded.title_regeneration_request_id,
            title_regeneration_started_at = excluded.title_regeneration_started_at,
            latest_user_message_at = excluded.latest_user_message_at,
            pending_approval_count = excluded.pending_approval_count,
            pending_user_input_count = excluded.pending_user_input_count,
            has_actionable_proposed_plan = excluded.has_actionable_proposed_plan,
            deleted_at = excluded.deleted_at
        `;

          yield* sql`DELETE FROM coagent_threads WHERE child_thread_id = ${event.payload.threadId}`;
          if (thread.coagent !== undefined && thread.coagent !== null) {
            yield* sql`
            INSERT INTO coagent_threads (
              child_thread_id, parent_thread_id, project_id, assignment,
              creation_mode, status, error, created_at, updated_at,
              provider_history_deleted_at
            ) VALUES (
              ${event.payload.threadId},
              ${thread.coagent.parentThreadId},
              ${thread.projectId},
              ${"Synchronized co-agent"},
              ${thread.coagent.creationMode},
              ${thread.coagent.status},
              NULL,
              ${thread.createdAt},
              ${event.payload.importedAt},
              NULL
            )
          `;
          }

          yield* sql`DELETE FROM thread_sync_import_stages WHERE stage_id = ${stageId}`;
          return;
        }

        default:
          return;
      }
    }).pipe(
      Effect.catchTag("SqlError", toPersistenceSqlError("ThreadSyncImportProjection.apply:query")),
    ),
);
