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
  assert.match(instructions, /without restating or citing the block/);
  assert.match(instructions, /No Erebus campaign is linked/);
  assert.include(instructions, EREBUS_RESEARCH_BASE_CONTRACT);
  assert.match(instructions, /Gates are laws/);
  assert.match(instructions, /contract attestation/);
  assert.match(instructions, /next highest-ROI move/);
});
