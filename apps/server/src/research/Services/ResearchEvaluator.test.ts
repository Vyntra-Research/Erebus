import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  describeResearchEvaluatorFailure,
  isResearchEvaluatorQuotaFailure,
  JudgeAssessment,
  ObserverAssessment,
} from "./ResearchEvaluator.ts";

const decodeObserverAssessment = Schema.decodeUnknownSync(ObserverAssessment);
const decodeJudgeAssessment = Schema.decodeUnknownSync(JudgeAssessment);

it("emits provider-compatible confidence schemas and preserves range validation", () => {
  const observerJsonSchema = Schema.toJsonSchemaDocument(ObserverAssessment).schema;
  const judgeJsonSchema = Schema.toJsonSchemaDocument(JudgeAssessment).schema;
  const observerProperties = observerJsonSchema.properties as Record<string, unknown>;
  const judgeProperties = judgeJsonSchema.properties as Record<string, unknown>;
  assert.deepStrictEqual(observerProperties.confidence, { type: "number" });
  assert.deepStrictEqual(judgeProperties.confidence, { type: "number" });
  assert.notInclude(JSON.stringify(judgeJsonSchema), '"allOf"');

  const observer = {
    verdict: "aligned",
    confidence: 0.5,
    interventionBasis: {
      actualViolationObserved: false,
      materialRiskObserved: false,
      repairStillNeeded: false,
    },
    contractClauses: [],
    evidence: [],
    risk: null,
    recommendedSteering: null,
  } as const;
  const judge = {
    verdict: "accepted",
    confidence: 0.5,
    gates: [{ gateId: "G1", status: "pass", reason: "Passed", evidence: ["evidence"] }],
    summary: "Accepted",
    nextAction: null,
    evidenceAccess: {
      status: "sufficient",
      decisionBlocked: false,
      inaccessibleReferences: [],
      detail: null,
    },
    cvssV31: null,
  } as const;

  assert.equal(decodeObserverAssessment(observer).confidence, 0.5);
  assert.equal(decodeJudgeAssessment(judge).confidence, 0.5);
  assert.throws(() => decodeObserverAssessment({ ...observer, confidence: -1 }));
  assert.throws(() => decodeJudgeAssessment({ ...judge, confidence: 2 }));
});

it("classifies Codex quota exhaustion without persisting raw provider output", () => {
  const raw =
    "Codex CLI command failed. ERROR: You've hit your usage limit. Visit the account page to continue.";

  assert.isTrue(isResearchEvaluatorQuotaFailure(raw));
  assert.equal(
    describeResearchEvaluatorFailure(raw),
    "The selected Codex evaluator account has exhausted its current usage quota.",
  );
  assert.isTrue(isResearchEvaluatorQuotaFailure(describeResearchEvaluatorFailure(raw)));
  assert.notInclude(describeResearchEvaluatorFailure(raw), "account page");
});

it("keeps unknown evaluator failures out of durable campaign text", () => {
  const raw = "provider failed while processing SECRET_PROMPT_CONTENT at C:\\private\\evidence";
  const described = describeResearchEvaluatorFailure(raw);

  assert.equal(
    described,
    "The evaluator provider failed before it produced a valid result. See the local server log for the provider error.",
  );
  assert.notInclude(described, "SECRET_PROMPT_CONTENT");
});
