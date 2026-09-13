import { assert, it } from "@effect/vitest";

import {
  canonicalizeIndependentJudgeAssessmentCvss,
  judgeCvssClassificationCorrections,
  normalizeIndependentJudgeAssessment,
  validateJudgeAssessmentConsistency,
} from "./researchIntegrity.ts";

const evidenceAccess = {
  status: "sufficient" as const,
  decisionBlocked: false,
  inaccessibleReferences: [],
  detail: null,
};

it("keeps a bounded missing proof revisionable instead of turning it into rejection", () => {
  const normalized = normalizeIndependentJudgeAssessment(
    [
      { id: "J1", required: true },
      { id: "J2", required: true },
    ],
    {
      verdict: "revisionRequired",
      confidence: 0.9,
      gates: [
        { gateId: "J1", status: "pass", reason: "Proved", evidence: ["finding"] },
        { gateId: "J2", status: "fail", reason: "One proof is missing", evidence: [] },
      ],
      summary: "The candidate needs one bounded proof.",
      nextAction: "Add the missing proof.",
      evidenceAccess,
      cvssV31: null,
    },
  );

  assert.equal(normalized.verdict, "revisionRequired");
});

it("requires every fixed gate before acceptance and ignores unknown returned gates", () => {
  const normalized = normalizeIndependentJudgeAssessment(
    [
      { id: "J1", required: true },
      { id: "J2", required: true },
    ],
    {
      verdict: "accepted",
      confidence: 0.9,
      gates: [
        { gateId: "J1", status: "pass", reason: "Proved", evidence: ["finding"] },
        { gateId: "invented", status: "pass", reason: "Unknown", evidence: [] },
      ],
      summary: "Accepted",
      nextAction: null,
      evidenceAccess,
      cvssV31: null,
    },
  );

  assert.equal(normalized.verdict, "revisionRequired");
  assert.deepEqual(
    normalized.gates.map((gate) => gate.gateId),
    ["J1", "J2"],
  );
});

it("accepts all passing gates even when the Judge labels a medium finding rejected", () => {
  const assessment = {
    verdict: "rejected" as const,
    confidence: 0.95,
    gates: [{ gateId: "J1", status: "pass" as const, reason: "Impact proved", evidence: ["PoC"] }],
    summary: "Rejected because CVSS is Medium.",
    nextAction: null,
    evidenceAccess,
    cvssV31: {
      vector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N",
      score: 5.3,
      severity: "medium" as const,
    },
  };
  const normalized = normalizeIndependentJudgeAssessment(
    [{ id: "J1", required: true }],
    canonicalizeIndependentJudgeAssessmentCvss(assessment),
  );

  assert.equal(normalized.verdict, "accepted");
  assert.deepEqual(validateJudgeAssessmentConsistency(normalized), []);
});

it("detects CVSS-driven non-accepted decisions and repairs classification metadata", () => {
  const assessment = {
    verdict: "rejected" as const,
    confidence: 0.95,
    gates: [
      {
        gateId: "J1",
        status: "fail" as const,
        reason: "The score is Medium, below the High threshold.",
        evidence: [],
      },
    ],
    summary: "Rejected because CVSS is Medium.",
    nextAction: null,
    evidenceAccess,
    cvssV31: {
      vector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N",
      score: 9.9,
      severity: "critical" as const,
    },
  };

  assert.lengthOf(validateJudgeAssessmentConsistency(assessment), 1);
  assert.isAbove(judgeCvssClassificationCorrections(assessment).length, 0);
  assert.equal(canonicalizeIndependentJudgeAssessmentCvss(assessment).cvssV31?.score, 5.3);
});
