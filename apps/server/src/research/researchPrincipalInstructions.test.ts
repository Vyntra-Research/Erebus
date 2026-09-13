import { assert, it } from "@effect/vitest";

import { EREBUS_RESEARCH_BASE_CONTRACT } from "./researchBaseContract.ts";
import {
  buildCoagentResearchInstructions,
  buildPrincipalResearchInstructions,
} from "./researchPrincipalInstructions.ts";

it("uses the native goal and leaves ordinary research free of Erebus lifecycle calls", () => {
  const instructions = buildPrincipalResearchInstructions();
  assert.include(instructions, EREBUS_RESEARCH_BASE_CONTRACT);
  assert.match(instructions, /native Codex\/T3 goal/);
  assert.match(instructions, /without any\s+`research\.\*` setup call/);
  assert.match(instructions, /only for independent\s+Judge handoff/);
  assert.match(instructions, /Argos as the canonical connected research\s+memory/);
  assert.match(instructions, /Proteus is read-only legacy history/);
  assert.match(instructions, /Do not load or rely on Proteus skills/);
  assert.match(instructions, /research\.calculate_cvss/);
  assert.match(instructions, /`findings\/`[\s\S]*`pocs\/`/);
  assert.match(instructions, /do not poll, wait, or keep researching/);
  assert.notMatch(instructions, /research\.start|research\.checkpoint|research\.pause/);
});

it("keeps co-agents horizontal and Judge handoff principal-owned", () => {
  const instructions = buildCoagentResearchInstructions("Inspect parser sinks", "parent-1");
  assert.match(instructions, /one horizontal sink or surface/);
  assert.match(instructions, /do not own[\s\S]*native goal/);
  assert.match(instructions, /do not create another co-agent task/);
  assert.match(instructions, /Do not call `research\.submit_finding`/);
  assert.match(instructions, /principal owns Judge handoff/);
  assert.include(instructions, "Inspect parser sinks");
});
