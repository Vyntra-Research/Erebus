import { assert, it } from "@effect/vitest";
import { ResearchContractId } from "@t3tools/contracts";

import {
  canonicalContractDigest,
  normalizeJudgeAssessment,
  validateJudgeAssessmentConsistency,
  validateContractRegistration,
  validateFindingSubmission,
} from "./researchIntegrity.ts";

const registration = {
  id: ResearchContractId.make("contract-1"),
  revision: 1,
  objective: "Find realistic high-impact vulnerabilities.",
  target: "target",
  authorization: "Authorized research.",
  attackerModel: "Independent external attacker.",
  impactThreshold: "High",
  scope: { included: ["target"], excluded: [], stopConditions: [] },
  strategy: ["Map trust boundaries."],
  heuristics: ["Reject lab-assisted impact."],
  gates: [
    { id: "impact", title: "Impact", requirement: "Prove High impact.", required: true },
    { id: "quality", title: "Quality", requirement: "Explain the chain.", required: false },
  ],
  duplicatePolicy: "Check prior work.",
  labPolicy: "Use a documented setup.",
  reportPolicy: "Require repeatable evidence.",
  observerPolicy: {
    messageWindow: 5,
    interventionConfidence: 0.8,
    cooldownMessages: 5,
    maxInterventionsPerTurn: 1,
  },
  proteusCampaignId: "1",
  createdAt: "2026-08-28T12:00:00.000Z",
} as const;

const contract = { ...registration, digest: canonicalContractDigest(registration) };

it("computes a stable server-owned contract digest and enforces monotonic revisions", () => {
  assert.equal(canonicalContractDigest({ ...registration }), contract.digest);
  assert.deepStrictEqual(validateContractRegistration(contract, []), []);
  assert.deepStrictEqual(validateContractRegistration({ ...contract, revision: 2 }, []), [
    "contract digest does not match the canonical server digest",
    "contract revision must be 1",
  ]);
});

it("requires a finding claim for every contract gate and rejects unknown gates", () => {
  const finding = {
    findingId: "finding-1",
    revision: 1,
    supersedesEvaluationId: null,
    cvssV31: {
      vector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:L/A:L",
      score: 7.3,
      severity: "high",
    },
    gateClaims: [
      { gateId: "impact", status: "pass", evidence: ["proof"] },
      { gateId: "extra", status: "pass", evidence: [] },
    ],
  } as never;
  assert.deepStrictEqual(validateFindingSubmission(contract, finding), [
    "missing gate claims: quality",
    "unknown gate claims: extra",
  ]);
});

it("cannot accept a judge result while a required gate is incomplete", () => {
  const normalized = normalizeJudgeAssessment(contract, {
    verdict: "accepted",
    confidence: 0.9,
    gates: [
      { gateId: "impact", status: "unknown", reason: "No control", evidence: [] },
      { gateId: "invented", status: "pass", reason: "Not in contract", evidence: [] },
    ],
    summary: "Looks valid.",
    nextAction: null,
    evidenceAccess: {
      status: "sufficient",
      decisionBlocked: false,
      inaccessibleReferences: [],
      detail: null,
    },
    cvssV31: null,
  });
  assert.equal(normalized.verdict, "revisionRequired");
  assert.deepStrictEqual(
    normalized.gates.map((gate) => gate.gateId),
    ["impact", "quality"],
  );
  assert.equal(normalized.gates[1]?.status, "unknown");
});

it("does not allow a CVSS class to reject a technically passing finding", () => {
  const normalized = normalizeJudgeAssessment(contract, {
    verdict: "rejected",
    confidence: 0.95,
    gates: [
      { gateId: "impact", status: "pass", reason: "Practical impact proved", evidence: ["PoC"] },
      { gateId: "quality", status: "pass", reason: "Chain is complete", evidence: ["trace"] },
    ],
    summary: "Rejected because CVSS is Medium.",
    nextAction: null,
    evidenceAccess: {
      status: "sufficient",
      decisionBlocked: false,
      inaccessibleReferences: [],
      detail: null,
    },
    cvssV31: {
      vector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N",
      score: 5.3,
      severity: "medium",
    },
  });

  assert.equal(normalized.verdict, "accepted");
  assert.deepStrictEqual(validateJudgeAssessmentConsistency(normalized), []);
});

it("blocks a non-accepted verdict whose rationale uses CVSS as the validity gate", () => {
  const issues = validateJudgeAssessmentConsistency({
    verdict: "rejected",
    confidence: 0.95,
    gates: [
      {
        gateId: "impact",
        status: "fail",
        reason: "The score is Medium, below the High threshold.",
        evidence: [],
      },
    ],
    summary: "Rejected because CVSS is Medium.",
    nextAction: null,
    evidenceAccess: {
      status: "sufficient",
      decisionBlocked: false,
      inaccessibleReferences: [],
      detail: null,
    },
    cvssV31: {
      vector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N",
      score: 5.3,
      severity: "medium",
    },
  });

  assert.lengthOf(issues, 1);
  assert.match(issues[0] ?? "", /CVSS classification as a validity/);
});
