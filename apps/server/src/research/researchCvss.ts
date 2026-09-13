import { fromVector } from "ae-cvss-calculator";

export type CvssSeverity = "none" | "low" | "medium" | "high" | "critical";

export type SupportedCvssVersion = "3.0" | "3.1" | "4.0";

interface CvssCalculator {
  calculateScores(): Record<string, unknown>;
  isBaseFullyDefined(): boolean;
}

export interface CvssScoreResult {
  readonly version: SupportedCvssVersion;
  readonly requestedVector: string;
  readonly vector: string;
  readonly score: number;
  readonly severity: CvssSeverity;
  readonly scores: Readonly<Record<string, number | boolean | string>>;
  readonly metrics: Readonly<Record<string, string>>;
  readonly selectionGuidance: {
    readonly privilegesRequired: string;
    readonly attackConditions: string;
    readonly impact: string;
  };
  readonly attribution: string;
}

export interface CvssV31Score {
  readonly vector: string;
  readonly score: number;
  readonly severity: CvssSeverity;
}

const REQUIRED_BASE_METRICS: Record<SupportedCvssVersion, ReadonlyArray<string>> = {
  "3.0": ["AV", "AC", "PR", "UI", "S", "C", "I", "A"],
  "3.1": ["AV", "AC", "PR", "UI", "S", "C", "I", "A"],
  "4.0": ["AV", "AC", "AT", "PR", "UI", "VC", "VI", "VA", "SC", "SI", "SA"],
};

const ALLOWED_METRICS: Record<SupportedCvssVersion, ReadonlySet<string>> = {
  "3.0": new Set([
    "AV",
    "AC",
    "PR",
    "UI",
    "S",
    "C",
    "I",
    "A",
    "E",
    "RL",
    "RC",
    "CR",
    "IR",
    "AR",
    "MAV",
    "MAC",
    "MPR",
    "MUI",
    "MS",
    "MC",
    "MI",
    "MA",
  ]),
  "3.1": new Set([
    "AV",
    "AC",
    "PR",
    "UI",
    "S",
    "C",
    "I",
    "A",
    "E",
    "RL",
    "RC",
    "CR",
    "IR",
    "AR",
    "MAV",
    "MAC",
    "MPR",
    "MUI",
    "MS",
    "MC",
    "MI",
    "MA",
  ]),
  "4.0": new Set([
    "AV",
    "AC",
    "AT",
    "PR",
    "UI",
    "VC",
    "VI",
    "VA",
    "SC",
    "SI",
    "SA",
    "E",
    "CR",
    "IR",
    "AR",
    "MAV",
    "MAC",
    "MAT",
    "MPR",
    "MUI",
    "MVC",
    "MVI",
    "MVA",
    "MSC",
    "MSI",
    "MSA",
    "S",
    "AU",
    "R",
    "V",
    "RE",
    "U",
  ]),
};

export const cvssSeverity = (score: number): CvssSeverity => {
  if (score === 0) return "none";
  if (score < 4) return "low";
  if (score < 7) return "medium";
  if (score < 9) return "high";
  return "critical";
};

export function calculateCvss(vectorInput: string): CvssScoreResult {
  const requestedVector = vectorInput.trim();
  if (!requestedVector) throw new Error("CVSS vector must not be empty.");

  const { version, metrics } = validateVectorShape(requestedVector);
  const calculator = fromVector(requestedVector) as CvssCalculator | undefined;
  if (!calculator || typeof calculator.calculateScores !== "function") {
    throw new Error(`Invalid CVSS ${version} vector or metric value.`);
  }
  if (typeof calculator.isBaseFullyDefined !== "function" || !calculator.isBaseFullyDefined()) {
    const missing = REQUIRED_BASE_METRICS[version].filter(
      (metric) => metrics[metric] === undefined,
    );
    throw new Error(
      `CVSS ${version} vector is missing required base metrics: ${missing.join(", ")}.`,
    );
  }

  const rawScores = calculator.calculateScores();
  const score = rawScores.overall;
  if (typeof score !== "number" || !Number.isFinite(score)) {
    throw new Error(`CVSS ${version} calculator did not produce a finite score.`);
  }
  const scores = Object.fromEntries(
    Object.entries(rawScores).filter(
      (entry): entry is [string, number | boolean | string] =>
        typeof entry[1] === "number" ||
        typeof entry[1] === "boolean" ||
        typeof entry[1] === "string",
    ),
  );

  return {
    version,
    requestedVector,
    vector: typeof rawScores.vector === "string" ? rawScores.vector : requestedVector,
    score,
    severity: cvssSeverity(score),
    scores,
    metrics,
    selectionGuidance: {
      privilegesRequired:
        "PR:L means a normal low-privilege account. PR:H means a local owner or similarly privileged role, not a global platform administrator. Record a global-admin prerequisite as an out-of-scope or realism concern.",
      attackConditions:
        version === "4.0"
          ? "Use AC:H for security-specific exploit complexity. Use AT:P when success needs a prerequisite deployment state, uncommon or non-default configuration, timing, a race, or another condition outside the attacker's control. Otherwise use AC:L and AT:N."
          : "Use AC:H when success needs an uncommon or non-default configuration, timing, a race, or another condition outside the attacker's control. Otherwise use AC:L.",
      impact:
        "Use Low for limited or contained loss, including occasional cross-user data exposure. Use High only for broad or total loss, or restricted assets with direct serious value, such as RCE or unauthorized private source-code access. Judge both the value and breadth of what is affected, not only full control of one chosen target.",
    },
    attribution: "CVSS is owned by FIRST.Org, Inc. and used by permission.",
  };
}

function validateVectorShape(vector: string): {
  version: SupportedCvssVersion;
  metrics: Record<string, string>;
} {
  const segments = vector.split("/");
  const prefix = segments.shift();
  const version = prefix?.startsWith("CVSS:") ? prefix.slice(5) : "";
  if (version !== "3.0" && version !== "3.1" && version !== "4.0") {
    throw new Error(
      "Unsupported CVSS version. Use a vector beginning with CVSS:3.0, CVSS:3.1, or CVSS:4.0.",
    );
  }

  const metrics: Record<string, string> = {};
  for (const segment of segments) {
    const separator = segment.indexOf(":");
    if (separator <= 0 || separator === segment.length - 1) {
      throw new Error(`Malformed CVSS metric segment: ${segment || "<empty>"}.`);
    }
    const key = segment.slice(0, separator);
    const value = segment.slice(separator + 1);
    if (!/^[A-Z]+$/.test(key) || !/^[A-Za-z0-9-]+$/.test(value)) {
      throw new Error(`Malformed CVSS metric segment: ${segment}.`);
    }
    if (!ALLOWED_METRICS[version].has(key)) {
      throw new Error(`Unsupported CVSS ${version} metric: ${key}.`);
    }
    if (metrics[key] !== undefined) {
      throw new Error(`Duplicate CVSS metric: ${key}.`);
    }
    metrics[key] = value;
  }

  const missing = REQUIRED_BASE_METRICS[version].filter((metric) => metrics[metric] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `CVSS ${version} vector is missing required base metrics: ${missing.join(", ")}.`,
    );
  }
  return { version, metrics };
}

export function calculateCvssV31(vector: string): CvssV31Score | null {
  const normalized = vector.trim().toUpperCase();
  if (!normalized.startsWith("CVSS:3.1/")) return null;
  try {
    const result = calculateCvss(normalized);
    if (result.version !== "3.1") return null;
    return { vector: result.vector, score: result.score, severity: result.severity };
  } catch {
    return null;
  }
}

const vectorAndScore =
  /(CVSS:3\.1\/[A-Z]+:[A-Z](?:\/[A-Z]+:[A-Z])+)(?:\s*(?:=|is|score(?:s|d)?(?:\s+of)?)\s*\*{0,2}(\d+(?:[.,]\d+)?))/giu;

export interface CvssMismatch {
  readonly vector: string;
  readonly declaredScore: number;
  readonly calculatedScore: number | null;
}

export function findCvssMismatchesInText(text: string): ReadonlyArray<CvssMismatch> {
  const mismatches: CvssMismatch[] = [];
  for (const match of text.matchAll(vectorAndScore)) {
    const vector = match[1];
    const declared = match[2];
    if (!vector || !declared) continue;
    const declaredScore = Number(declared.replace(",", "."));
    const calculated = calculateCvssV31(vector);
    if (!calculated || Math.abs(calculated.score - declaredScore) > 0.001) {
      mismatches.push({
        vector,
        declaredScore,
        calculatedScore: calculated?.score ?? null,
      });
    }
  }
  return mismatches;
}

const cvssDecisionLanguage =
  /(?:accept(?:ed|ance)?|promot(?:e|ed|ion)|reject(?:ed|ion)?|invalid|downgrad(?:e|ed)|fail(?:ed|ure)?|revision(?:required)?|kill(?:ed)?|pivot|not\s+(?:valid|accepted)|below\s+(?:the\s+)?threshold)[^.!?\n]{0,180}(?:cvss|medium|high|critical|score)|(?:cvss|medium|high|critical|score)[^.!?\n]{0,180}(?:accept(?:ed|ance)?|promot(?:e|ed|ion)|reject(?:ed|ion)?|invalid|downgrad(?:e|ed)|fail(?:ed|ure)?|revision(?:required)?|kill(?:ed)?|pivot|not\s+(?:valid|accepted)|below\s+(?:the\s+)?threshold)/iu;

export function hasCvssDrivenDecisionLanguage(text: string): boolean {
  return cvssDecisionLanguage.test(text);
}
