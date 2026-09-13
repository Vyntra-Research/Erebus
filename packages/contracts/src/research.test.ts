import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ResearchFindingReviewEvaluation,
  ResearchFindingReviewSubmission,
  ResearchSubmitFindingForReviewInput,
} from "./research.ts";

const decodeFindingReviewSubmission = Schema.decodeUnknownSync(ResearchFindingReviewSubmission);
const decodeSubmitFindingForReviewInput = Schema.decodeUnknownSync(
  ResearchSubmitFindingForReviewInput,
);
const decodeFindingReviewEvaluation = Schema.decodeUnknownSync(ResearchFindingReviewEvaluation);

describe("independent finding review contracts", () => {
  it("decodes a campaign-free artifact handoff", () => {
    const decoded = decodeFindingReviewSubmission({
      findingId: "finding-1",
      revision: 1,
      supersedesEvaluationId: null,
      title: "Cross-tenant write",
      target: "Target 1.2.3 on a self-hosted Windows deployment",
      findingPath: "findings/finding-1.md",
      pocPath: "pocs/finding-1",
      submittedAt: "2026-09-12T12:00:00.000Z",
    });

    expect(decoded.findingId).toBe("finding-1");
    expect("campaignId" in decoded).toBe(false);
    expect("contractId" in decoded).toBe(false);
  });

  it("requires every public submission field and a positive revision", () => {
    expect(() =>
      decodeSubmitFindingForReviewInput({
        findingId: "finding-1",
        revision: 0,
        supersedesEvaluationId: null,
        title: "Finding",
        target: "Target",
        findingPath: "findings/finding-1.md",
        pocPath: null,
      }),
    ).toThrow();
    expect(() =>
      decodeSubmitFindingForReviewInput({
        findingId: "finding-1",
        revision: 1,
        supersedesEvaluationId: null,
        title: "Finding",
        target: "Target",
        findingPath: "findings/finding-1.md",
      }),
    ).toThrow();
  });

  it("keeps Judge verdict and CVSS classification separate", () => {
    const decoded = decodeFindingReviewEvaluation({
      evaluationId: "evaluation-1",
      findingId: "finding-1",
      findingRevision: 1,
      verdict: "accepted",
      confidence: 0.95,
      gates: [{ gateId: "J1", status: "pass", reason: "Passed", evidence: ["finding"] }],
      summary: "The submitted path is complete.",
      nextAction: null,
      cvssV31: {
        vector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N",
        score: 5.3,
        severity: "medium",
      },
      runtime: {
        policyVersion: 24,
        policyDigest: `sha256:${"a".repeat(64)}`,
        model: "judge-model",
        reasoningEffort: "xhigh",
      },
      evaluatedAt: "2026-09-12T12:01:00.000Z",
    });

    expect(decoded.verdict).toBe("accepted");
    expect(decoded.cvssV31?.severity).toBe("medium");
  });
});
