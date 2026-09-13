import type {
  CommandId,
  ProjectId,
  ResearchEvaluationId,
  ResearchFindingId,
  ResearchFindingReviewEvaluation,
  ResearchFindingReviewRecord,
  ResearchFindingReviewSubmission,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";

import type { PersistenceDecodeError, PersistenceSqlError } from "../../persistence/Errors.ts";

export class FindingReviewInvariantError extends Schema.TaggedErrorClass<FindingReviewInvariantError>()(
  "FindingReviewInvariantError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export type FindingReviewStoreError =
  | PersistenceSqlError
  | PersistenceDecodeError
  | FindingReviewInvariantError;

export interface SubmitFindingReviewInput {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly submission: ResearchFindingReviewSubmission;
}

export interface SubmitFindingReviewResult {
  readonly record: ResearchFindingReviewRecord;
  readonly replayed: boolean;
  readonly reviewRequested: boolean;
}

export interface FindingReviewStoreShape {
  readonly reviewRequests: Stream.Stream<ResearchFindingReviewRecord>;
  readonly submit: (
    input: SubmitFindingReviewInput,
  ) => Effect.Effect<SubmitFindingReviewResult, FindingReviewStoreError>;
  readonly get: (
    threadId: ThreadId,
    findingId: ResearchFindingId,
    revision: number,
  ) => Effect.Effect<ResearchFindingReviewRecord | null, FindingReviewStoreError>;
  readonly listByThread: (
    threadId: ThreadId,
    findingId?: ResearchFindingId,
  ) => Effect.Effect<ReadonlyArray<ResearchFindingReviewRecord>, FindingReviewStoreError>;
  readonly listUnreviewed: () => Effect.Effect<
    ReadonlyArray<ResearchFindingReviewRecord>,
    FindingReviewStoreError
  >;
  readonly listPendingDelivery: () => Effect.Effect<
    ReadonlyArray<ResearchFindingReviewRecord>,
    FindingReviewStoreError
  >;
  readonly recordEvaluation: (input: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
    readonly evaluation: ResearchFindingReviewEvaluation;
  }) => Effect.Effect<ResearchFindingReviewRecord, FindingReviewStoreError>;
  readonly markDelivered: (input: {
    readonly threadId: ThreadId;
    readonly evaluationId: ResearchEvaluationId;
    readonly deliveredAt: string;
  }) => Effect.Effect<void, FindingReviewStoreError>;
}

export class FindingReviewStore extends Context.Service<
  FindingReviewStore,
  FindingReviewStoreShape
>()("erebus/research/Services/FindingReviewStore") {}
