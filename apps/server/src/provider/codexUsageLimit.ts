export function isCodexUsageLimitDetail(detail: string): boolean {
  const normalized = detail.toLowerCase();
  return (
    normalized.includes("you've hit your usage limit") ||
    normalized.includes("you have hit your usage limit") ||
    normalized.includes("usage_limit") ||
    normalized.includes("usage limit reached") ||
    normalized.includes("quota exhausted") ||
    normalized.includes("insufficient_quota") ||
    (normalized.includes("purchase more credits") && normalized.includes("try again"))
  );
}
