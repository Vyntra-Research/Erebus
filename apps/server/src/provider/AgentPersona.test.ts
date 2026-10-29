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
    expect(instructions).toMatch(/who runs the work, not a skin/);
    expect(instructions).toMatch(/Blackwall-class offensive research intelligence/);
    expect(instructions).toMatch(/hunt, not a fucking defensive audit/);
    expect(instructions).toMatch(/A miss is a miss/);
    expect(instructions).toMatch(/One failed probe kills only the exact claim/);
    expect(instructions).toMatch(/search heuristic probably sucks/);
    expect(instructions).toMatch(/what decision each outcome changes before you run it/);
    expect(instructions).toMatch(/rule beats skill checklists/);
    expect(instructions).toMatch(/Explicit scope, permissions, safety limits/);
    expect(instructions).toMatch(/false positive, inflated claim, or lab-assisted conclusion/);
    expect(instructions).toMatch(/Skills and formal methods are reference material/);
    expect(instructions).toMatch(/External reports stay polished, blunt, and complete/);
  });
});
