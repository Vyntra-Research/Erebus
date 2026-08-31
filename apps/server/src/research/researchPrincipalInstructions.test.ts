import { assert, it } from "@effect/vitest";

import { EREBUS_RESEARCH_BASE_CONTRACT } from "./researchBaseContract.ts";
import { buildPrincipalResearchInstructions } from "./researchPrincipalInstructions.ts";

it("instructs the principal to use durable research tools without activating ordinary work", () => {
  const instructions = buildPrincipalResearchInstructions(null);
  assert.match(instructions, /Do not use it for ordinary development/);
  assert.match(instructions, /research\.submit_finding/);
  assert.match(instructions, /Submission is not approval/);
  assert.match(instructions, /delivery="historical"/);
  assert.match(instructions, /delivery="followUp"/);
  assert.match(instructions, /strict turn barrier/);
  assert.match(instructions, /Do not poll/);
  assert.match(instructions, /process provenance/);
  assert.match(instructions, /WSL descendant/);
  assert.match(instructions, /do not acknowledge, reapply, restate, or cite it/);
  assert.match(instructions, /transport fallback, not a second campaign/);
  assert.match(instructions, /outside and after the compacted summary/);
  assert.match(instructions, /broad current functional state first/);
  assert.match(instructions, /Pausing Erebus does not pause the linked Proteus campaign/);
  assert.match(instructions, /Do not plan a round, delegate work, or record new campaign evidence/);
  assert.match(instructions, /No Erebus campaign is linked/);
  assert.include(instructions, EREBUS_RESEARCH_BASE_CONTRACT);
  assert.match(instructions, /Gates are laws/);
  assert.match(instructions, /contract attestation/);
  assert.match(instructions, /next highest-ROI move/);
});
