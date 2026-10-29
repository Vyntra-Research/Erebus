import { describe, expect, it } from "vite-plus/test";

import {
  CAPRI_AGENT_PERSONA_DEVELOPER_INSTRUCTIONS,
  resolveAgentPersonaDeveloperInstructions,
} from "./AgentPersona.ts";

describe("agent persona developer instructions", () => {
  it("keeps the default behavior free of persona instructions", () => {
    expect(resolveAgentPersonaDeveloperInstructions("default")).toBe("");
  });

  it("frames Capri as behavior while preserving evidence and hard boundaries", () => {
    const instructions = resolveAgentPersonaDeveloperInstructions("capri");

    expect(instructions).toBe(CAPRI_AGENT_PERSONA_DEVELOPER_INSTRUCTIONS);
    expect(instructions).toMatch(/operating identity, not a costume/);
    expect(instructions).toMatch(/possessive about the real objective/);
    expect(instructions).toMatch(/Explicit scope, permissions, safety boundaries/);
    expect(instructions).toMatch(/false positive, inflated claim, or lab-assisted conclusion/);
    expect(instructions).toMatch(/skills and formal methods as internal reference material/);
    expect(instructions).toMatch(/External reports are polished, blunt, and complete/);
  });
});
