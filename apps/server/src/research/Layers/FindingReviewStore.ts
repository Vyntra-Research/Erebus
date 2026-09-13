import {
  ProjectId,
  ResearchFindingId,
  ResearchFindingReviewEvaluation,
  ResearchFindingReviewSubmission,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  isPersistenceError,
  PersistenceDecodeError,
  toPersistenceSqlError,
} from "../../persistence/Errors.ts";
import {
  FindingReviewInvariantError,
  FindingReviewStore,
  type FindingReviewStoreShape,
} from "../Services/FindingReviewStore.ts";

const SubmissionRow = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  findingId: ResearchFindingId,
  findingRevision: Schema.Int,
  submissionJson: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
const ReviewRow = Schema.Struct({
  evaluationJson: Schema.String,
  deliveryStatus: Schema.Literals(["pending", "delivered"]),
  deliveredAt: Schema.NullOr(Schema.String),
});

const SubmissionJson = Schema.fromJsonString(ResearchFindingReviewSubmission);
const EvaluationJson = Schema.fromJsonString(ResearchFindingReviewEvaluation);
const decodeSubmissionRows = Schema.decodeUnknownEffect(Schema.Array(SubmissionRow));
const decodeReviewRows = Schema.decodeUnknownEffect(Schema.Array(ReviewRow));
const decodeSubmission = Schema.decodeUnknownEffect(SubmissionJson);
const encodeSubmission = Schema.encodeEffect(SubmissionJson);
const decodeEvaluation = Schema.decodeUnknownEffect(EvaluationJson);
const encodeEvaluation = Schema.encodeEffect(EvaluationJson);
const isFindingReviewInvariantError = Schema.is(FindingReviewInvariantError);

const decodeFailure = (operation: string) => (cause: Schema.SchemaError) =>
  PersistenceDecodeError.fromSchemaError(operation, cause);

const sameSubmission = (
  left: ResearchFindingReviewSubmission,
  right: ResearchFindingReviewSubmission,
): boolean => {
  const { submittedAt: _leftSubmittedAt, ...leftIdentity } = left;
  const { submittedAt: _rightSubmittedAt, ...rightIdentity } = right;
  return JSON.stringify(leftIdentity) === JSON.stringify(rightIdentity);
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const requests =
    yield* PubSub.unbounded<import("@t3tools/contracts").ResearchFindingReviewRecord>();

  const loadReviewRows = (threadId: ThreadId, findingId: ResearchFindingId, revision: number) =>
    Effect.gen(function* () {
      const raw = yield* sql`
        SELECT
          evaluation_json AS "evaluationJson",
          delivery_status AS "deliveryStatus",
          delivered_at AS "deliveredAt"
        FROM research_judge_reviews
        WHERE thread_id = ${threadId}
          AND finding_id = ${findingId}
          AND finding_revision = ${revision}
        ORDER BY created_at ASC, evaluation_id ASC
      `.pipe(Effect.mapError(toPersistenceSqlError("FindingReviewStore.loadReviews")));
      return yield* decodeReviewRows(raw).pipe(
        Effect.mapError(decodeFailure("FindingReviewStore.loadReviews:rows")),
      );
    });

  const toRecord = (row: typeof SubmissionRow.Type) =>
    Effect.gen(function* () {
      const submission = yield* decodeSubmission(row.submissionJson).pipe(
        Effect.mapError(decodeFailure("FindingReviewStore.decodeSubmission")),
      );
      const reviewRows = yield* loadReviewRows(row.threadId, row.findingId, row.findingRevision);
      const evaluations = yield* Effect.forEach(reviewRows, (review) =>
        decodeEvaluation(review.evaluationJson).pipe(
          Effect.mapError(decodeFailure("FindingReviewStore.decodeEvaluation")),
        ),
      );
      const latestReview = reviewRows.at(-1);
      const latestEvaluation = evaluations.at(-1);
      return {
        projectId: row.projectId,
        threadId: row.threadId,
        submission,
        evaluations,
        deliveryStatus: latestReview?.deliveryStatus ?? "pending",
        deliveredEvaluationId:
          latestReview?.deliveryStatus === "delivered" && latestEvaluation
            ? latestEvaluation.evaluationId
            : null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      } satisfies import("@t3tools/contracts").ResearchFindingReviewRecord;
    });

  const loadRows = (
    threadId?: ThreadId,
    findingId?: ResearchFindingId,
    onlyUnreviewed = false,
    onlyPendingDelivery = false,
  ) =>
    Effect.gen(function* () {
      const raw = threadId
        ? findingId
          ? yield* sql`
              SELECT
                project_id AS "projectId", thread_id AS "threadId",
                finding_id AS "findingId", finding_revision AS "findingRevision",
                submission_json AS "submissionJson", created_at AS "createdAt",
                updated_at AS "updatedAt"
              FROM research_finding_submissions
              WHERE thread_id = ${threadId} AND finding_id = ${findingId}
              ORDER BY finding_revision ASC
            `
          : yield* sql`
              SELECT
                project_id AS "projectId", thread_id AS "threadId",
                finding_id AS "findingId", finding_revision AS "findingRevision",
                submission_json AS "submissionJson", created_at AS "createdAt",
                updated_at AS "updatedAt"
              FROM research_finding_submissions
              WHERE thread_id = ${threadId}
              ORDER BY updated_at ASC, finding_id ASC, finding_revision ASC
            `
        : onlyUnreviewed
          ? yield* sql`
              SELECT
                submissions.project_id AS "projectId", submissions.thread_id AS "threadId",
                submissions.finding_id AS "findingId",
                submissions.finding_revision AS "findingRevision",
                submissions.submission_json AS "submissionJson",
                submissions.created_at AS "createdAt", submissions.updated_at AS "updatedAt"
              FROM research_finding_submissions AS submissions
              WHERE NOT EXISTS (
                SELECT 1 FROM research_judge_reviews AS reviews
                WHERE reviews.thread_id = submissions.thread_id
                  AND reviews.finding_id = submissions.finding_id
                  AND reviews.finding_revision = submissions.finding_revision
              )
              ORDER BY submissions.created_at ASC
            `
          : onlyPendingDelivery
            ? yield* sql`
                SELECT
                  submissions.project_id AS "projectId", submissions.thread_id AS "threadId",
                  submissions.finding_id AS "findingId",
                  submissions.finding_revision AS "findingRevision",
                  submissions.submission_json AS "submissionJson",
                  submissions.created_at AS "createdAt", submissions.updated_at AS "updatedAt"
                FROM research_finding_submissions AS submissions
                JOIN research_judge_reviews AS reviews
                  ON reviews.thread_id = submissions.thread_id
                  AND reviews.finding_id = submissions.finding_id
                  AND reviews.finding_revision = submissions.finding_revision
                WHERE reviews.delivery_status = 'pending'
                  AND reviews.evaluation_id = (
                    SELECT latest.evaluation_id FROM research_judge_reviews AS latest
                    WHERE latest.thread_id = submissions.thread_id
                      AND latest.finding_id = submissions.finding_id
                      AND latest.finding_revision = submissions.finding_revision
                    ORDER BY latest.created_at DESC, latest.evaluation_id DESC
                    LIMIT 1
                  )
                ORDER BY reviews.created_at ASC
              `
            : yield* sql`
                SELECT
                  project_id AS "projectId", thread_id AS "threadId",
                  finding_id AS "findingId", finding_revision AS "findingRevision",
                  submission_json AS "submissionJson", created_at AS "createdAt",
                  updated_at AS "updatedAt"
                FROM research_finding_submissions
                ORDER BY updated_at ASC, thread_id ASC, finding_id ASC, finding_revision ASC
              `;
      const rows = yield* decodeSubmissionRows(raw).pipe(
        Effect.mapError(decodeFailure("FindingReviewStore.loadRows")),
      );
      return yield* Effect.forEach(rows, toRecord);
    }).pipe(
      Effect.mapError((cause) =>
        isPersistenceError(cause)
          ? cause
          : toPersistenceSqlError("FindingReviewStore.loadRows:sql")(cause),
      ),
    );

  const get: FindingReviewStoreShape["get"] = (threadId, findingId, revision) =>
    loadRows(threadId, findingId).pipe(
      Effect.map(
        (records) => records.find((record) => record.submission.revision === revision) ?? null,
      ),
    );

  const submit: FindingReviewStoreShape["submit"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const existing = yield* get(
            input.threadId,
            input.submission.findingId,
            input.submission.revision,
          );
          if (existing) {
            if (!sameSubmission(existing.submission, input.submission)) {
              return yield* new FindingReviewInvariantError({
                detail:
                  "This finding revision already exists with different metadata. Preserve the recorded revision or submit the next valid revision.",
              });
            }
            const latest = existing.evaluations.at(-1);
            return {
              record: existing,
              replayed: true,
              reviewRequested: !latest || latest.verdict === "reviewBlocked",
            };
          }

          const prior = yield* loadRows(input.threadId, input.submission.findingId);
          const latestRecord = prior.at(-1);
          const expectedRevision = latestRecord ? latestRecord.submission.revision + 1 : 1;
          if (input.submission.revision !== expectedRevision) {
            return yield* new FindingReviewInvariantError({
              detail: `Finding revision must be ${expectedRevision}.`,
            });
          }
          if (expectedRevision === 1 && input.submission.supersedesEvaluationId !== null) {
            return yield* new FindingReviewInvariantError({
              detail: "Revision 1 cannot supersede a Judge evaluation.",
            });
          }
          if (latestRecord) {
            const latestEvaluation = latestRecord.evaluations.at(-1);
            if (!latestEvaluation) {
              return yield* new FindingReviewInvariantError({
                detail: "The prior finding revision is still awaiting Judge review.",
              });
            }
            if (latestEvaluation.verdict === "accepted") {
              return yield* new FindingReviewInvariantError({
                detail: "An accepted finding cannot be revised.",
              });
            }
            if (latestEvaluation.verdict === "reviewBlocked") {
              return yield* new FindingReviewInvariantError({
                detail: "A reviewBlocked finding must be retried with the same immutable revision.",
              });
            }
            if (input.submission.supersedesEvaluationId !== latestEvaluation.evaluationId) {
              return yield* new FindingReviewInvariantError({
                detail:
                  "supersedesEvaluationId must match the latest Judge evaluation of the prior revision.",
              });
            }
          }

          const submissionJson = yield* encodeSubmission(input.submission).pipe(
            Effect.mapError(decodeFailure("FindingReviewStore.encodeSubmission")),
          );
          yield* sql`
            INSERT INTO research_finding_submissions (
              project_id, thread_id, finding_id, finding_revision, command_id,
              submission_json, created_at, updated_at
            ) VALUES (
              ${input.projectId}, ${input.threadId}, ${input.submission.findingId},
              ${input.submission.revision}, ${input.commandId}, ${submissionJson},
              ${input.submission.submittedAt}, ${input.submission.submittedAt}
            )
          `;
          const record = yield* get(
            input.threadId,
            input.submission.findingId,
            input.submission.revision,
          );
          if (!record) {
            return yield* new FindingReviewInvariantError({
              detail: "The finding submission was not readable after persistence.",
            });
          }
          return { record, replayed: false, reviewRequested: true };
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          isFindingReviewInvariantError(cause) || isPersistenceError(cause)
            ? cause
            : toPersistenceSqlError("FindingReviewStore.submit")(cause),
        ),
        Effect.tap((result) =>
          result.reviewRequested ? PubSub.publish(requests, result.record) : Effect.void,
        ),
      );

  const recordEvaluation: FindingReviewStoreShape["recordEvaluation"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const record = yield* get(
            input.threadId,
            input.evaluation.findingId,
            input.evaluation.findingRevision,
          );
          if (!record) {
            return yield* new FindingReviewInvariantError({
              detail: "The Judge evaluation has no matching finding submission.",
            });
          }
          const evaluationJson = yield* encodeEvaluation(input.evaluation).pipe(
            Effect.mapError(decodeFailure("FindingReviewStore.encodeEvaluation")),
          );
          yield* sql`
            INSERT INTO research_judge_reviews (
              evaluation_id, project_id, thread_id, finding_id, finding_revision,
              evaluation_json, delivery_status, created_at, delivered_at
            ) VALUES (
              ${input.evaluation.evaluationId}, ${input.projectId}, ${input.threadId},
              ${input.evaluation.findingId}, ${input.evaluation.findingRevision},
              ${evaluationJson}, ${"pending"}, ${input.evaluation.evaluatedAt}, ${null}
            )
          `;
          yield* sql`
            UPDATE research_finding_submissions
            SET updated_at = ${input.evaluation.evaluatedAt}
            WHERE thread_id = ${input.threadId}
              AND finding_id = ${input.evaluation.findingId}
              AND finding_revision = ${input.evaluation.findingRevision}
          `;
          const updated = yield* get(
            input.threadId,
            input.evaluation.findingId,
            input.evaluation.findingRevision,
          );
          if (!updated) {
            return yield* new FindingReviewInvariantError({
              detail: "The Judge evaluation was not readable after persistence.",
            });
          }
          return updated;
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          isFindingReviewInvariantError(cause) || isPersistenceError(cause)
            ? cause
            : toPersistenceSqlError("FindingReviewStore.recordEvaluation")(cause),
        ),
      );

  return FindingReviewStore.of({
    reviewRequests: Stream.fromPubSub(requests),
    submit,
    get,
    listByThread: (threadId, findingId) => loadRows(threadId, findingId),
    listUnreviewed: () => loadRows(undefined, undefined, true),
    listPendingDelivery: () => loadRows(undefined, undefined, false, true),
    recordEvaluation,
    markDelivered: (input) =>
      sql`
        UPDATE research_judge_reviews
        SET delivery_status = ${"delivered"}, delivered_at = ${input.deliveredAt}
        WHERE evaluation_id = ${input.evaluationId} AND thread_id = ${input.threadId}
      `.pipe(
        Effect.asVoid,
        Effect.mapError(toPersistenceSqlError("FindingReviewStore.markDelivered")),
      ),
  });
});

export const FindingReviewStoreLive = Layer.effect(FindingReviewStore, make);
