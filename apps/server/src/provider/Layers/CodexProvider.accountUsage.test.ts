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
});
