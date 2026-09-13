import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

const makeResearchId = <Brand extends string>(brand: Brand) =>
  TrimmedNonEmptyString.pipe(Schema.brand(brand));

export const ResearchFindingId = makeResearchId("ResearchFindingId");
export type ResearchFindingId = typeof ResearchFindingId.Type;

export const ResearchEvaluationId = makeResearchId("ResearchEvaluationId");
export type ResearchEvaluationId = typeof ResearchEvaluationId.Type;

export const ResearchDependencyState = Schema.Literals([
  "unknown",
  "ready",
  "missing",
  "incompatible",
  "failed",
]);
export type ResearchDependencyState = typeof ResearchDependencyState.Type;

export const ResearchKnowledgeRuntimeHealth = Schema.Struct({
  runtime: ResearchDependencyState,
  plugin: ResearchDependencyState,
  skills: ResearchDependencyState,
  mcp: ResearchDependencyState,
  version: Schema.NullOr(TrimmedNonEmptyString),
  message: Schema.NullOr(TrimmedNonEmptyString),
  checkedAt: IsoDateTime,
});
export type ResearchKnowledgeRuntimeHealth = typeof ResearchKnowledgeRuntimeHealth.Type;

export const ResearchArgosHealth = ResearchKnowledgeRuntimeHealth;
export type ResearchArgosHealth = typeof ResearchArgosHealth.Type;

export const ResearchProteusHealth = ResearchKnowledgeRuntimeHealth;
export type ResearchProteusHealth = typeof ResearchProteusHealth.Type;

export const ResearchGateStatus = Schema.Literals(["pending", "pass", "fail", "unknown"]);
export type ResearchGateStatus = typeof ResearchGateStatus.Type;

export const ResearchCvssSeverity = Schema.Literals(["none", "low", "medium", "high", "critical"]);
export type ResearchCvssSeverity = typeof ResearchCvssSeverity.Type;

export const ResearchCvssV31 = Schema.Struct({
  vector: TrimmedNonEmptyString,
  score: Schema.Number.check(Schema.isFinite()),
  severity: ResearchCvssSeverity,
});
export type ResearchCvssV31 = typeof ResearchCvssV31.Type;

export const ResearchJudgeVerdict = Schema.Literals([
  "accepted",
  "revisionRequired",
  "rejected",
  "invalidSubmission",
  "reviewBlocked",
]);
export type ResearchJudgeVerdict = typeof ResearchJudgeVerdict.Type;

export const ResearchGateDecision = Schema.Struct({
  gateId: TrimmedNonEmptyString,
  status: ResearchGateStatus,
  reason: TrimmedNonEmptyString,
  evidence: Schema.Array(TrimmedNonEmptyString),
});
export type ResearchGateDecision = typeof ResearchGateDecision.Type;

/** Minimal, campaign-free handoff to Erebus's independent Judge. */
export const ResearchFindingReviewSubmission = Schema.Struct({
  findingId: ResearchFindingId,
  revision: PositiveInt,
  supersedesEvaluationId: Schema.NullOr(ResearchEvaluationId),
  title: TrimmedNonEmptyString,
  target: TrimmedNonEmptyString,
  findingPath: TrimmedNonEmptyString,
  pocPath: Schema.NullOr(TrimmedNonEmptyString),
  submittedAt: IsoDateTime,
});
export type ResearchFindingReviewSubmission = typeof ResearchFindingReviewSubmission.Type;

export const ResearchFindingReviewEvaluation = Schema.Struct({
  evaluationId: ResearchEvaluationId,
  findingId: ResearchFindingId,
  findingRevision: PositiveInt,
  verdict: ResearchJudgeVerdict,
  confidence: Schema.Number.check(
    Schema.isFinite(),
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(1),
  ),
  gates: Schema.Array(ResearchGateDecision).check(Schema.isMinLength(1)),
  summary: TrimmedNonEmptyString,
  nextAction: Schema.NullOr(TrimmedNonEmptyString),
  cvssV31: Schema.NullOr(ResearchCvssV31),
  runtime: Schema.Struct({
    policyVersion: PositiveInt,
    policyDigest: TrimmedNonEmptyString,
    model: TrimmedNonEmptyString,
    reasoningEffort: TrimmedNonEmptyString,
  }),
  evaluatedAt: IsoDateTime,
});
export type ResearchFindingReviewEvaluation = typeof ResearchFindingReviewEvaluation.Type;

export const ResearchFindingReviewDeliveryStatus = Schema.Literals(["pending", "delivered"]);
export type ResearchFindingReviewDeliveryStatus = typeof ResearchFindingReviewDeliveryStatus.Type;

export const ResearchFindingReviewRecord = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  submission: ResearchFindingReviewSubmission,
  evaluations: Schema.Array(ResearchFindingReviewEvaluation),
  deliveryStatus: ResearchFindingReviewDeliveryStatus,
  deliveredEvaluationId: Schema.NullOr(ResearchEvaluationId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ResearchFindingReviewRecord = typeof ResearchFindingReviewRecord.Type;

export const ResearchSubmitFindingForReviewInput = Schema.Struct({
  findingId: ResearchFindingId,
  revision: PositiveInt,
  supersedesEvaluationId: Schema.NullOr(ResearchEvaluationId),
  title: TrimmedNonEmptyString,
  target: TrimmedNonEmptyString,
  findingPath: TrimmedNonEmptyString,
  pocPath: Schema.NullOr(TrimmedNonEmptyString),
});
export type ResearchSubmitFindingForReviewInput = typeof ResearchSubmitFindingForReviewInput.Type;

export const ResearchToolResult = Schema.Struct({
  accepted: Schema.Boolean,
  status: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
  issues: Schema.Array(TrimmedNonEmptyString),
  retry: Schema.optional(
    Schema.Struct({
      required: Schema.Boolean,
      tool: Schema.Literals(["research.submit_finding", "research.revise_finding"]),
      mode: Schema.Literal("sameFindingRevision"),
      instruction: TrimmedNonEmptyString,
    }),
  ),
});
export type ResearchToolResult = typeof ResearchToolResult.Type;
