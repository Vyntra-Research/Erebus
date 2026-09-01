import {
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  ServerProvider,
  type ServerProvider as ServerProviderType,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { selectCodexAccount } from "./CodexAccountRouter.ts";

const decodeProvider = Schema.decodeUnknownSync(ServerProvider);

function account(instanceId: string, remainingPercent: number): ServerProviderType {
  return decodeProvider({
    instanceId,
    driver: "codex",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-01T00:00:00.000Z",
    models: [],
    accountUsage: {
      remainingPercent,
      primary: {
        usedPercent: 100 - remainingPercent,
        remainingPercent,
        resetsAt: null,
        windowDurationMins: 300,
      },
      secondary: null,
      reached: remainingPercent === 0,
    },
  });
}

describe("selectCodexAccount", () => {
  const primary = ProviderInstanceId.make("codex");
  const fallback = ProviderInstanceId.make("codex_secondary");
  const policy = DEFAULT_SERVER_SETTINGS.codexAccountRouting;

  it("keeps the primary account while it remains above the switch threshold", () => {
    expect(
      selectCodexAccount({
        providers: [account(primary, 6), account(fallback, 100)],
        policy,
        activeInstanceId: primary,
      }),
    ).toBe(primary);
  });

  it("moves to the fallback when the primary reaches the threshold", () => {
    expect(
      selectCodexAccount({
        providers: [account(primary, 5), account(fallback, 100)],
        policy,
        activeInstanceId: primary,
      }),
    ).toBe(fallback);
  });

  it("routes away from an exhausted primary on the first decision after startup", () => {
    expect(
      selectCodexAccount({
        providers: [account(primary, 4), account(fallback, 100)],
        policy,
        activeInstanceId: null,
      }),
    ).toBe(fallback);
  });

  it("returns to a recovered primary account", () => {
    expect(
      selectCodexAccount({
        providers: [account(primary, 25), account(fallback, 80)],
        policy,
        activeInstanceId: fallback,
      }),
    ).toBe(primary);
  });

  it("uses the primary's final quota when the fallback reaches its reserve", () => {
    expect(
      selectCodexAccount({
        providers: [account(primary, 1), account(fallback, 1)],
        policy,
        activeInstanceId: fallback,
      }),
    ).toBe(primary);
  });

  it("keeps the fallback when both accounts reach their protected edge", () => {
    expect(
      selectCodexAccount({
        providers: [account(primary, 0), account(fallback, 1)],
        policy,
        activeInstanceId: fallback,
      }),
    ).toBe(fallback);
  });
});
