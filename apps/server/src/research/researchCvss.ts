export type CvssSeverity = "none" | "low" | "medium" | "high" | "critical";

export interface CvssV31Score {
  readonly vector: string;
  readonly score: number;
  readonly severity: CvssSeverity;
}

const metricValues = {
  AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
  AC: { L: 0.77, H: 0.44 },
  UI: { N: 0.85, R: 0.62 },
  C: { H: 0.56, L: 0.22, N: 0 },
  I: { H: 0.56, L: 0.22, N: 0 },
  A: { H: 0.56, L: 0.22, N: 0 },
} as const;

const roundUp = (value: number): number => Math.ceil((value - Number.EPSILON) * 10) / 10;

export const cvssSeverity = (score: number): CvssSeverity => {
  if (score === 0) return "none";
  if (score < 4) return "low";
  if (score < 7) return "medium";
  if (score < 9) return "high";
  return "critical";
};

export function calculateCvssV31(vector: string): CvssV31Score | null {
  const normalized = vector.trim().toUpperCase();
  if (!normalized.startsWith("CVSS:3.1/")) return null;
  const metrics = new Map<string, string>();
  for (const component of normalized.slice("CVSS:3.1/".length).split("/")) {
    const [key, value, extra] = component.split(":");
    if (!key || !value || extra || metrics.has(key)) return null;
    metrics.set(key, value);
  }
  const av = metricValues.AV[metrics.get("AV") as keyof typeof metricValues.AV];
  const ac = metricValues.AC[metrics.get("AC") as keyof typeof metricValues.AC];
  const ui = metricValues.UI[metrics.get("UI") as keyof typeof metricValues.UI];
  const confidentiality = metricValues.C[metrics.get("C") as keyof typeof metricValues.C];
  const integrity = metricValues.I[metrics.get("I") as keyof typeof metricValues.I];
  const availability = metricValues.A[metrics.get("A") as keyof typeof metricValues.A];
  const scope = metrics.get("S");
  const privileges = metrics.get("PR");
  const pr =
    scope === "U"
      ? ({ N: 0.85, L: 0.62, H: 0.27 } as const)[privileges as "N" | "L" | "H"]
      : scope === "C"
        ? ({ N: 0.85, L: 0.68, H: 0.5 } as const)[privileges as "N" | "L" | "H"]
        : undefined;
  if (
    av === undefined ||
    ac === undefined ||
    pr === undefined ||
    ui === undefined ||
    confidentiality === undefined ||
    integrity === undefined ||
    availability === undefined ||
    metrics.size !== 8
  ) {
    return null;
  }

  const impactBase = 1 - (1 - confidentiality) * (1 - integrity) * (1 - availability);
  const impact =
    scope === "U"
      ? 6.42 * impactBase
      : 7.52 * (impactBase - 0.029) - 3.25 * (impactBase - 0.02) ** 15;
  const exploitability = 8.22 * av * ac * pr * ui;
  const score =
    impact <= 0
      ? 0
      : roundUp(
          scope === "U"
            ? Math.min(impact + exploitability, 10)
            : Math.min(1.08 * (impact + exploitability), 10),
        );
  return { vector: normalized, score, severity: cvssSeverity(score) };
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
