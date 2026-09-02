import type {
  ModelSelection,
  ResearchContract,
  ResearchFindingSubmission,
  ResearchJudgeEvaluation,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ObserverTimelineMessage } from "../researchSupervision.ts";

const Confidence = Schema.Number.check(Schema.isFinite()).pipe(
  Schema.decodeTo(
    Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1)),
  ),
);

export const ObserverAssessment = Schema.Struct({
  verdict: Schema.Literals(["aligned", "watch", "deviation", "criticalDeviation"]),
  confidence: Confidence,
  contractClauses: Schema.Array(Schema.String),
  evidence: Schema.Array(Schema.String),
  risk: Schema.NullOr(Schema.String),
  recommendedSteering: Schema.NullOr(Schema.String),
});
export type ObserverAssessment = typeof ObserverAssessment.Type;

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

export interface ObserverCampaignSnapshot {
  readonly observedTask?: {
    readonly threadId: string;
    readonly role: "coagent";
    readonly parentThreadId: string;
    readonly assignment: string;
  };
  readonly campaign: {
    readonly id: string;
    readonly status: string;
    readonly proteusCampaignId: string;
    readonly eligibleMessageCount: number;
    readonly lastObservedMessageCount: number;
  };
  readonly runtimeObserverPolicy: {
    readonly messageWindow: number;
    readonly interventionConfidence: number;
    readonly cooldownMessages: number;
    readonly maxInterventionsPerTurn: number | null;
  };
  readonly latestCheckpoint: {
    readonly proteusCheckpointId: string;
    readonly summary: string;
    readonly evidence: ReadonlyArray<string>;
    readonly killedPaths: ReadonlyArray<string>;
    readonly openDeviations: ReadonlyArray<string>;
    readonly nextMove: string;
  } | null;
  readonly latestFindings: ReadonlyArray<{
    readonly findingId: string;
    readonly revision: number;
    readonly title: string;
    readonly proteusBranchId: string;
    readonly judge: {
      readonly evaluationId: string;
      readonly verdict: string;
      readonly summary: string;
      readonly nextAction: string | null;
    } | null;
  }>;
  readonly recentInterventions: ReadonlyArray<{
    readonly source: string;
    readonly delivery: string;
    readonly status: string;
    readonly evaluationId: string;
    readonly observation: string;
  }>;
}

export class ResearchEvaluatorError extends Schema.TaggedErrorClass<ResearchEvaluatorError>()(
  "ResearchEvaluatorError",
  {
    operation: Schema.Literals(["observer", "judge"]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `${this.operation} evaluation failed: ${this.detail}`;
  }
}

export interface ResearchEvaluatorShape {
  readonly evaluateObserver: (input: {
    readonly cwd: string;
    readonly modelSelection: ModelSelection;
    readonly contract: ResearchContract;
    readonly campaignSnapshot: ObserverCampaignSnapshot;
    readonly messages: ReadonlyArray<{ readonly id: string; readonly text: string }>;
    readonly timeline: ReadonlyArray<ObserverTimelineMessage>;
  }) => Effect.Effect<ObserverAssessment, ResearchEvaluatorError>;
  readonly evaluateJudge: (input: {
    readonly cwd: string;
    readonly modelSelection: ModelSelection;
    readonly contract: ResearchContract;
    readonly finding: ResearchFindingSubmission;
    readonly priorEvaluations: ReadonlyArray<ResearchJudgeEvaluation>;
  }) => Effect.Effect<JudgeAssessment, ResearchEvaluatorError>;
}

export class ResearchEvaluator extends Context.Service<ResearchEvaluator, ResearchEvaluatorShape>()(
  "erebus/research/Services/ResearchEvaluator",
) {}
