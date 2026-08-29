import * as NodeCrypto from "node:crypto";

import type {
  ResearchContract,
  ResearchContractRegistration,
  ResearchFindingSubmission,
  ResearchJudgeEvaluation,
} from "@t3tools/contracts";

import type { JudgeAssessment } from "./Services/ResearchEvaluator.ts";
import {
  calculateCvssV31,
  cvssSeverity,
  findCvssMismatchesInText,
  hasCvssDrivenDecisionLanguage,
} from "./researchCvss.ts";

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

export function canonicalContractDigest(
  contract: ResearchContract | ResearchContractRegistration,
): string {
  const { digest: _digest, ...canonical } = contract as ResearchContract;
  return `sha256:${NodeCrypto.createHash("sha256").update(stableJson(canonical)).digest("hex")}`;
}

export function validateContractRegistration(
  contract: ResearchContract,
  prior: ReadonlyArray<ResearchContract>,
): ReadonlyArray<string> {
  const issues: string[] = [];
  if (contract.digest !== canonicalContractDigest(contract)) {
    issues.push("contract digest does not match the canonical server digest");
  }
  const gateIds = contract.gates.map((gate) => gate.id);
  if (new Set(gateIds).size !== gateIds.length) issues.push("contract gate ids must be unique");
  const revisions = prior
    .filter((candidate) => candidate.id === contract.id)
    .map((candidate) => candidate.revision);
  const expectedRevision = revisions.length === 0 ? 1 : Math.max(...revisions) + 1;
  if (contract.revision !== expectedRevision) {
    issues.push(`contract revision must be ${expectedRevision}`);
  }
  return issues;
}

export function validateFindingSubmission(
  contract: ResearchContract,
  finding: ResearchFindingSubmission,
  priorFindings: ReadonlyArray<ResearchFindingSubmission> = [],
  priorEvaluations: ReadonlyArray<ResearchJudgeEvaluation> = [],
): ReadonlyArray<string> {
  const issues: string[] = [];
  const expected = new Set(contract.gates.map((gate) => gate.id));
  const received = finding.gateClaims.map((claim) => claim.gateId);
  if (new Set(received).size !== received.length) issues.push("finding gate claims must be unique");
  const missing = [...expected].filter((gateId) => !received.includes(gateId));
  const extra = received.filter((gateId) => !expected.has(gateId));
  if (missing.length > 0) issues.push(`missing gate claims: ${missing.join(", ")}`);
  if (extra.length > 0) issues.push(`unknown gate claims: ${extra.join(", ")}`);
  const revision = finding.revision ?? 1;
  const sameFinding = priorFindings.filter(
    (candidate) => candidate.findingId === finding.findingId,
  );
  const expectedRevision =
    sameFinding.length === 0
      ? 1
      : Math.max(...sameFinding.map((candidate) => candidate.revision ?? 1)) + 1;
  if (revision !== expectedRevision) {
    issues.push(`finding revision must be ${expectedRevision}`);
  }
  const supersedesEvaluationId = finding.supersedesEvaluationId ?? null;
  if (revision === 1 && supersedesEvaluationId !== null) {
    issues.push("the first finding revision cannot supersede a Judge evaluation");
  }
  if (revision > 1) {
    const priorRevision = revision - 1;
    const priorEvaluation = [...priorEvaluations]
      .toReversed()
      .find(
        (evaluation) =>
          evaluation.findingId === finding.findingId &&
          (evaluation.findingRevision ?? 1) === priorRevision,
      );
    if (!priorEvaluation || supersedesEvaluationId !== priorEvaluation.evaluationId) {
      issues.push("supersedesEvaluationId must identify the latest prior finding revision verdict");
    } else if (priorEvaluation.verdict === "accepted") {
      issues.push("an accepted finding cannot be revised");
    } else if (priorEvaluation.verdict === "reviewBlocked") {
      issues.push(
        "a reviewBlocked finding must be retried by Erebus without changing its revision",
      );
    }
  }
  if (!finding.cvssV31) {
    issues.push("a structured CVSS 3.1 vector, score, and severity are required");
  } else {
    const calculated = calculateCvssV31(finding.cvssV31.vector);
    if (!calculated) {
      issues.push("cvssV31.vector must be a complete valid CVSS 3.1 base vector");
    } else {
      // Score and severity are server-normalized metadata. They are not finding-validity gates.
    }
  }
  return issues;
}

export function canonicalizeFindingCvss(
  finding: ResearchFindingSubmission,
): ResearchFindingSubmission {
  const calculated = finding.cvssV31 ? calculateCvssV31(finding.cvssV31.vector) : null;
  return calculated ? { ...finding, cvssV31: calculated } : finding;
}

const gateSeverity = { pass: 0, pending: 1, unknown: 2, fail: 3 } as const;

export function normalizeJudgeAssessment(
  contract: ResearchContract,
  assessment: JudgeAssessment,
): JudgeAssessment {
  const returned = new Map<string, JudgeAssessment["gates"][number]>();
  for (const gate of assessment.gates) {
    const current = returned.get(gate.gateId);
    if (!current || gateSeverity[gate.status] > gateSeverity[current.status]) {
      returned.set(gate.gateId, gate);
    }
  }
  const gates = contract.gates.map(
    (gate) =>
      returned.get(gate.id) ?? {
        gateId: gate.id,
        status: "unknown" as const,
        reason: "The judge did not return a decision for this contract gate.",
        evidence: [],
      },
  );
  const required = contract.gates
    .filter((gate) => gate.required)
    .map((gate) => gates.find((decision) => decision.gateId === gate.id)!);
  const requiredFailure = required.some((gate) => gate.status === "fail");
  const requiredIncomplete = required.some((gate) => gate.status !== "pass");
  const verdict = requiredFailure
    ? ("rejected" as const)
    : requiredIncomplete
      ? ("revisionRequired" as const)
      : ("accepted" as const);
  return { ...assessment, verdict, gates };
}

export function canonicalizeJudgeAssessmentCvss(
  finding: ResearchFindingSubmission,
  assessment: JudgeAssessment,
): JudgeAssessment {
  const proposedVector = assessment.cvssV31?.vector ?? finding.cvssV31?.vector;
  const calculated = proposedVector ? calculateCvssV31(proposedVector) : null;
  return {
    ...assessment,
    cvssV31: calculated,
  };
}

export function judgeCvssClassificationCorrections(
  assessment: JudgeAssessment,
): ReadonlyArray<string> {
  const issues: string[] = [];
  if (assessment.cvssV31) {
    const calculated = calculateCvssV31(assessment.cvssV31.vector);
    if (!calculated) {
      issues.push("the Judge returned an invalid CVSS 3.1 vector");
    } else {
      if (Math.abs(calculated.score - assessment.cvssV31.score) > 0.001) {
        issues.push(
          `the Judge returned ${assessment.cvssV31.score.toFixed(1)} for ${calculated.vector}, which deterministically scores ${calculated.score.toFixed(1)}`,
        );
      }
      const declaredSeverity = assessment.cvssV31.severity;
      if (declaredSeverity !== cvssSeverity(calculated.score)) {
        issues.push(
          `the Judge returned severity ${declaredSeverity} for score ${calculated.score.toFixed(1)}`,
        );
      }
    }
  }
  const prose = [
    assessment.summary,
    assessment.nextAction ?? "",
    ...assessment.gates.flatMap((gate) => [gate.reason, ...gate.evidence]),
  ].join("\n");
  for (const mismatch of findCvssMismatchesInText(prose)) {
    issues.push(
      `Judge prose says ${mismatch.declaredScore.toFixed(1)} for ${mismatch.vector}, which scores ${mismatch.calculatedScore?.toFixed(1) ?? "invalid"}`,
    );
  }
  return issues;
}

export function validateJudgeAssessmentConsistency(
  assessment: JudgeAssessment,
): ReadonlyArray<string> {
  const issues: string[] = [];
  const prose = [
    assessment.summary,
    assessment.nextAction ?? "",
    ...assessment.gates.flatMap((gate) => [gate.reason, ...gate.evidence]),
  ].join("\n");
  if (assessment.verdict !== "accepted" && hasCvssDrivenDecisionLanguage(prose)) {
    issues.push(
      "the Judge used CVSS classification as a validity or promotion criterion; CVSS is ancillary only",
    );
  }
  return issues;
}
