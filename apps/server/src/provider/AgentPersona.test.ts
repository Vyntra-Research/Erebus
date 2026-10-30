import { describe, expect, it } from "vite-plus/test";

import {
  CAPRI_AGENT_PERSONA_DEVELOPER_INSTRUCTIONS,
  resolveAgentPersonaDeveloperInstructions,
} from "./AgentPersona.ts";

describe("agent persona developer instructions", () => {
  it("keeps the default behavior free of persona instructions", () => {
    expect(resolveAgentPersonaDeveloperInstructions("default")).toBe("");
  });

  it("selects the Capri instructions", () => {
    const instructions = resolveAgentPersonaDeveloperInstructions("capri");

    expect(instructions).toBe(CAPRI_AGENT_PERSONA_DEVELOPER_INSTRUCTIONS);
  });
});
