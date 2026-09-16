import { assert, it } from "@effect/vitest";

import { EREBUS_THREADS_DYNAMIC_TOOL } from "../coagents/coagentTools.ts";
import { EREBUS_RESEARCH_DYNAMIC_TOOL } from "../research/researchTools.ts";
import {
  EREBUS_NATIVE_CONTROL_FINGERPRINT,
  EREBUS_NATIVE_CONTROL_VERSION,
  fingerprintNativeControlTools,
  hasCurrentNativeControlTools,
} from "./nativeControlTools.ts";

const current = {
  erebusResearchNativeTools: true,
  erebusNativeControlVersion: EREBUS_NATIVE_CONTROL_VERSION,
  erebusNativeControlFingerprint: EREBUS_NATIVE_CONTROL_FINGERPRINT,
};

it("requires the actual tool contract, not a legacy or future version marker", () => {
  assert.isTrue(hasCurrentNativeControlTools({ ...current, cwd: "/workspace" }));
  for (const payload of [
    null,
    {},
    { erebusResearchNativeTools: true, erebusNativeControlVersion: 3 },
    { ...current, erebusNativeControlFingerprint: "old-tool-contract" },
    { ...current, erebusNativeControlVersion: EREBUS_NATIVE_CONTROL_VERSION + 1 },
    { ...current, erebusResearchNativeTools: false },
  ]) {
    assert.isFalse(hasCurrentNativeControlTools(payload));
  }
});

it("changes the fingerprint when a research or coordination schema changes", () => {
  assert.equal(
    fingerprintNativeControlTools([EREBUS_RESEARCH_DYNAMIC_TOOL, EREBUS_THREADS_DYNAMIC_TOOL]),
    EREBUS_NATIVE_CONTROL_FINGERPRINT,
  );
  for (const index of [0, 1]) {
    const tools = [EREBUS_RESEARCH_DYNAMIC_TOOL, EREBUS_THREADS_DYNAMIC_TOOL];
    const original = tools[index]!;
    const changed = {
      ...original,
      tools: original.tools.map((tool, i) =>
        i === 0
          ? {
              ...tool,
              inputSchema: { ...tool.inputSchema, required: ["newRequiredField"] },
            }
          : tool,
      ),
    };
    assert.notEqual(
      fingerprintNativeControlTools(tools.map((tool, i) => (i === index ? changed : tool))),
      EREBUS_NATIVE_CONTROL_FINGERPRINT,
    );
  }
});
