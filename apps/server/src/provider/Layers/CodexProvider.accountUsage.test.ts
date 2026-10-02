import type * as CodexSchema from "effect-codex-app-server/schema";
import { describe, expect, it } from "vite-plus/test";

import { normalizeCodexAccountUsage } from "./CodexProvider.ts";

describe("normalizeCodexAccountUsage", () => {
  it("uses the most constrained Codex quota window", () => {
    const response = {
      rateLimits: {
        primary: { usedPercent: 96, resetsAt: 1_788_000_000, windowDurationMins: 300 },
        secondary: { usedPercent: 35, resetsAt: 1_788_500_000, windowDurationMins: 10_080 },
      },
    } satisfies CodexSchema.V2GetAccountRateLimitsResponse;

    expect(normalizeCodexAccountUsage(response)).toEqual({
      remainingPercent: 4,
      primary: {
        usedPercent: 96,
        remainingPercent: 4,
        resetsAt: 1_788_000_000,
        windowDurationMins: 300,
      },
      secondary: {
        usedPercent: 35,
        remainingPercent: 65,
        resetsAt: 1_788_500_000,
        windowDurationMins: 10_080,
      },
      reached: false,
    });
  });

  it("marks backend-enforced limits as reached", () => {
    const response = {
      rateLimits: {
        primary: { usedPercent: 99 },
        rateLimitReachedType: "rate_limit_reached",
      },
    } satisfies CodexSchema.V2GetAccountRateLimitsResponse;

    expect(normalizeCodexAccountUsage(response)?.reached).toBe(true);
  });

  it("keeps an account usable when included quota ends but usage credits remain", () => {
    const response = {
      rateLimits: {
        primary: { usedPercent: 100 },
        credits: { hasCredits: true, unlimited: false, balance: "12" },
        rateLimitReachedType: "rate_limit_reached",
      },
    } satisfies CodexSchema.V2GetAccountRateLimitsResponse;

    expect(normalizeCodexAccountUsage(response)).toMatchObject({
      remainingPercent: 0,
      reached: false,
    });
  });

  it("keeps spend controls and workspace blocks enforced despite credits", () => {
    for (const blockedLimit of [
      { spendControlReached: true },
      { individualLimit: { limit: "100", used: "100", remainingPercent: 0, resetsAt: 1 } },
      { rateLimitReachedType: "workspace_owner_usage_limit_reached" as const },
      { rateLimitReachedType: "workspace_owner_credits_depleted" as const },
    ]) {
      const response = {
        rateLimits: {
          primary: { usedPercent: 100 },
          credits: { hasCredits: true, unlimited: false },
          ...blockedLimit,
        },
      } satisfies CodexSchema.V2GetAccountRateLimitsResponse;

      expect(normalizeCodexAccountUsage(response)?.reached).toBe(true);
    }
  });
});
