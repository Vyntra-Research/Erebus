import type {
  ModelSelection,
  ResearchFindingReviewEvaluation,
  ResearchFindingReviewSubmission,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const Confidence = Schema.Number.check(Schema.isFinite()).pipe(
  Schema.decodeTo(
    Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1)),
  ),
);

export const JudgeAssessment = Schema.Struct({
  verdict: Schema.Literals(["accepted", "revisionRequired", "rejected", "invalidSubmission"]),
  confidence: Confidence,
  gates: Schema.Array(
    Schema.Struct({
      gateId: Schema.String,
      status: Schema.Literals(["pending", "pass", "fail", "unknown"]),
      reason: Schema.String,
      evidence: Schema.Array(Schema.String),
    }),
  ),
  summary: Schema.String,
  nextAction: Schema.NullOr(Schema.String),
  evidenceAccess: Schema.Struct({
    status: Schema.Literals(["sufficient", "blocked"]),
    decisionBlocked: Schema.Boolean,
    inaccessibleReferences: Schema.Array(Schema.String),
    detail: Schema.NullOr(Schema.String),
  }),
  cvssV31: Schema.NullOr(
    Schema.Struct({
      vector: Schema.String,
      score: Schema.Number.check(Schema.isFinite()),
      severity: Schema.Literals(["none", "low", "medium", "high", "critical"]),
    }),
  ),
});
export type JudgeAssessment = typeof JudgeAssessment.Type;

export class ResearchEvaluatorError extends Schema.TaggedErrorClass<ResearchEvaluatorError>()(
  "ResearchEvaluatorError",
  {
    operation: Schema.Literal("judge"),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `judge evaluation failed: ${this.detail}`;
  }
}

export const isResearchEvaluatorQuotaFailure = (detail: string): boolean =>
  /(?:you(?:'|’)ve hit your usage limit|usage limit (?:has been )?reached|insufficient_quota|quota (?:is )?exhausted|quota exceeded|exhausted.{0,32}usage quota)/iu.test(
    detail,
  );

export const describeResearchEvaluatorFailure = (detail: string): string => {
  if (isResearchEvaluatorQuotaFailure(detail)) {
    return "The selected Codex evaluator account has exhausted its current usage quota.";
  }
  if (/prompt_cache_retention.+not supported/iu.test(detail)) {
    return "The evaluator model rejected an unsupported prompt-cache option.";
  }
  if (/(?:timed out|timeout)/iu.test(detail)) {
    return "The evaluator timed out before it produced a valid result.";
  }
  return "The evaluator provider failed before it produced a valid result. See the local server log for the provider error.";
};

export interface ResearchEvaluatorShape {
  readonly evaluateJudge: (input: {
    readonly cwd: string;
    readonly modelSelection: ModelSelection;
    readonly finding: ResearchFindingReviewSubmission;
    readonly priorEvaluations: ReadonlyArray<ResearchFindingReviewEvaluation>;
  }) => Effect.Effect<JudgeAssessment, ResearchEvaluatorError>;
}

export class ResearchEvaluator extends Context.Service<ResearchEvaluator, ResearchEvaluatorShape>()(
  "erebus/research/Services/ResearchEvaluator",
) {}
