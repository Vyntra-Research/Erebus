import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ResearchContract,
  ResearchContractRegistration,
  ResearchFindingSubmission,
  ResearchJudgeEvaluation,
  ResearchObserverEvaluation,
} from "./research.ts";

const contract = {
  id: "contract-1",
  revision: 1,
  digest: "sha256:contract",
  objective: "Find a realistic cross-tenant security boundary violation",
  target: "example/repository at v1.2.3",
  authorization: "Local authorized repository and lab only",
  attackerModel: "Unauthenticated external attacker",
  impactThreshold: "Other-user confidentiality or integrity",
  scope: {
    included: ["request handling"],
    excluded: ["availability-only issues"],
    stopConditions: ["target version is not affected"],
  },
  strategy: ["Trace high-complexity trust boundaries"],
  heuristics: ["Kill self-only abuse early"],
  gates: [
    {
      id: "realistic-impact",
      title: "Realistic impact",
      requirement: "Prove impact without lab assistance",
      required: true,
    },
  ],
  duplicatePolicy: "Search Proteus and local findings before deep validation",
  labPolicy: "Use documented defaults and negative controls",
  reportPolicy: "Require reproducible evidence",
  observerPolicy: {
    messageWindow: 5,
    interventionConfidence: 0.8,
    cooldownMessages: 5,
    maxInterventionsPerTurn: 1,
  },
  proteusCampaignId: "proteus-campaign-1",
  createdAt: "2026-08-27T00:00:00.000Z",
} as const;

describe("research contracts", () => {
  it("decodes a complete campaign contract", () => {
    const decoded = Schema.decodeUnknownSync(ResearchContract)(contract);

    expect(decoded.objective).toBe(contract.objective);
    expect(decoded.observerPolicy.messageWindow).toBe(5);
  });

  it("keeps Observer runtime policy out of principal contract registration", () => {
    const { digest: _digest, observerPolicy: _observerPolicy, ...registration } = contract;
    const decoded = Schema.decodeUnknownSync(ResearchContractRegistration)(registration);

    expect(decoded.id).toBe(contract.id);
    expect("observerPolicy" in decoded).toBe(false);
  });

  it("requires at least one promotion gate", () => {
    expect(() =>
      Schema.decodeUnknownSync(ResearchContract)({
        ...contract,
        gates: [],
      }),
    ).toThrow();
  });

  it("rejects observer confidence outside the normalized range", () => {
    expect(() =>
      Schema.decodeUnknownSync(ResearchContract)({
        ...contract,
        observerPolicy: {
          ...contract.observerPolicy,
          interventionConfidence: 1.1,
        },
      }),
    ).toThrow();
  });

  it("decodes a finding submission bound to an exact contract revision", () => {
    const decoded = Schema.decodeUnknownSync(ResearchFindingSubmission)({
      findingId: "finding-1",
      campaignId: "campaign-1",
      contractId: contract.id,
      contractRevision: contract.revision,
      title: "Cross-tenant write",
      mechanism: "Confused deputy in the storage adapter",
      targetVersions: ["1.2.3"],
      attacker: contract.attackerModel,
      preconditions: ["Attacker controls a low-privilege tenant"],
      impact: "Write data owned by another tenant",
      exploitPath: ["request", "adapter", "storage write"],
      evidence: ["negative control fails after ownership check"],
      negativeControls: ["same request with patched ownership check is denied"],
      duplicateCheck: "No same-root finding in Proteus or local reports",
      gateClaims: [
        {
          gateId: contract.gates[0].id,
          status: "pass",
          evidence: ["reproduced under documented defaults"],
        },
      ],
      proteusBranchId: "branch-1",
      submittedAt: "2026-08-27T00:01:00.000Z",
    });

    expect(decoded.contractRevision).toBe(1);
    expect(decoded.gateClaims[0]?.status).toBe("pass");
  });

  it("keeps observer and judge verdicts separate", () => {
    const runtime = {
      policyVersion: 1,
      policyDigest: "sha256:policy-1",
      model: "gpt-5.6",
      reasoningEffort: "high",
    };
    const observer = Schema.decodeUnknownSync(ResearchObserverEvaluation)({
      evaluationId: "evaluation-observer-1",
      campaignId: "campaign-1",
      contractId: contract.id,
      contractRevision: 1,
      messageItemIds: ["provider-message-1"],
      verdict: "deviation",
      confidence: 0.9,
      contractClauses: ["impactThreshold"],
      evidence: ["The agent changed focus to availability-only behavior"],
      risk: "The branch cannot meet the campaign impact threshold",
      recommendedSteering: "Return to cross-tenant integrity paths.",
      runtime,
      evaluatedAt: "2026-08-27T00:02:00.000Z",
    });
    const judge = Schema.decodeUnknownSync(ResearchJudgeEvaluation)({
      evaluationId: "evaluation-judge-1",
      findingId: "finding-1",
      campaignId: "campaign-1",
      contractId: contract.id,
      contractRevision: 1,
      verdict: "revisionRequired",
      confidence: 0.95,
      gates: [
        {
          gateId: "realistic-impact",
          status: "unknown",
          reason: "The current evidence depends on a lab-only helper",
          evidence: ["helper bypasses the documented ownership path"],
        },
      ],
      summary: "The primitive is concrete but realistic impact remains unproven.",
      nextAction: "Repeat without the helper and include a negative control.",
      runtime,
      evaluatedAt: "2026-08-27T00:03:00.000Z",
    });

    expect(observer.verdict).toBe("deviation");
    expect(judge.verdict).toBe("revisionRequired");
  });
});
