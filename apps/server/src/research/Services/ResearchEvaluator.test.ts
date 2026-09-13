import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  describeResearchEvaluatorFailure,
  isResearchEvaluatorQuotaFailure,
  JudgeAssessment,
} from "./ResearchEvaluator.ts";

const decodeJudgeAssessment = Schema.decodeUnknownSync(JudgeAssessment);

it("keeps the independent Judge response provider-compatible and range checked", () => {
  const jsonSchema = Schema.toJsonSchemaDocument(JudgeAssessment).schema;
  const properties = jsonSchema.properties as Record<string, unknown>;
  assert.deepStrictEqual(properties.confidence, { type: "number" });
  assert.notInclude(JSON.stringify(jsonSchema), '"allOf"');

  const assessment = {
    verdict: "accepted",
    confidence: 0.5,
    gates: [{ gateId: "J1", status: "pass", reason: "Passed", evidence: ["evidence"] }],
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

  assert.equal(decodeJudgeAssessment(assessment).confidence, 0.5);
  assert.throws(() => decodeJudgeAssessment({ ...assessment, confidence: 2 }));
});

it("classifies Codex quota exhaustion without persisting raw provider output", () => {
  const raw =
    "Codex CLI command failed. ERROR: You've hit your usage limit. Visit the account page to continue.";

  assert.isTrue(isResearchEvaluatorQuotaFailure(raw));
  assert.equal(
    describeResearchEvaluatorFailure(raw),
    "The selected Codex evaluator account has exhausted its current usage quota.",
  );
  assert.notInclude(describeResearchEvaluatorFailure(raw), "account page");
});

it("keeps unknown evaluator failures out of durable review text", () => {
  const raw = "provider failed while processing SECRET_PROMPT_CONTENT at C:\\private\\evidence";
  const described = describeResearchEvaluatorFailure(raw);

  assert.equal(
    described,
    "The evaluator provider failed before it produced a valid result. See the local server log for the provider error.",
  );
  assert.notInclude(described, "SECRET_PROMPT_CONTENT");
});
