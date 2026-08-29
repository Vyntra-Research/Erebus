import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { JudgeAssessment, ObserverAssessment } from "./ResearchEvaluator.ts";

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
