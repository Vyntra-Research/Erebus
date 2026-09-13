import type { JudgeAssessment } from "./Services/ResearchEvaluator.ts";
import {
  calculateCvssV31,
  cvssSeverity,
  findCvssMismatchesInText,
  hasCvssDrivenDecisionLanguage,
} from "./researchCvss.ts";

const gateSeverity = { pass: 0, pending: 1, unknown: 2, fail: 3 } as const;

export function normalizeIndependentJudgeAssessment(
  gatesDefinition: ReadonlyArray<{ readonly id: string; readonly required: boolean }>,
  assessment: JudgeAssessment,
): JudgeAssessment {
  const returned = new Map<string, JudgeAssessment["gates"][number]>();
  for (const gate of assessment.gates) {
    const current = returned.get(gate.gateId);
    if (!current || gateSeverity[gate.status] > gateSeverity[current.status]) {
      returned.set(gate.gateId, gate);
    }
  }
  const gates = gatesDefinition.map(
    (gate) =>
      returned.get(gate.id) ?? {
        gateId: gate.id,
        status: "unknown" as const,
        reason: "The Judge did not return a decision for this fixed Erebus gate.",
        evidence: [],
      },
  );
  const required = gatesDefinition
    .filter((gate) => gate.required)
    .map((gate) => gates.find((decision) => decision.gateId === gate.id)!);
  const requiredFailure = required.some((gate) => gate.status === "fail");
  const requiredIncomplete = required.some((gate) => gate.status !== "pass");
  const verdict = requiredIncomplete
    ? assessment.verdict === "invalidSubmission"
      ? "invalidSubmission"
      : assessment.verdict === "rejected" && requiredFailure
        ? "rejected"
        : "revisionRequired"
    : "accepted";
  return { ...assessment, verdict, gates };
}

export function canonicalizeIndependentJudgeAssessmentCvss(
  assessment: JudgeAssessment,
): JudgeAssessment {
  const calculated = assessment.cvssV31 ? calculateCvssV31(assessment.cvssV31.vector) : null;
  return { ...assessment, cvssV31: calculated };
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
      if (assessment.cvssV31.severity !== cvssSeverity(calculated.score)) {
        issues.push(
          `the Judge returned severity ${assessment.cvssV31.severity} for score ${calculated.score.toFixed(1)}`,
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
  const prose = [
    assessment.summary,
    assessment.nextAction ?? "",
    ...assessment.gates.flatMap((gate) => [gate.reason, ...gate.evidence]),
  ].join("\n");
  return assessment.verdict !== "accepted" && hasCvssDrivenDecisionLanguage(prose)
    ? [
        "the Judge used CVSS classification as a validity or promotion criterion; CVSS is ancillary only",
      ]
    : [];
}
