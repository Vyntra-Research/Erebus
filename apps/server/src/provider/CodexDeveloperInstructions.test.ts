import { assert, it } from "@effect/vitest";

import { EREBUS_COMMAND_SAFETY_INSTRUCTIONS } from "./CodexDeveloperInstructions.ts";

it("requires the Codex-safe two-call flow for Windows recursive cleanup", () => {
  assert.match(
    EREBUS_COMMAND_SAFETY_INSTRUCTIONS,
    /recursive deletion is always a two-call sequence/,
  );
  assert.match(EREBUS_COMMAND_SAFETY_INSTRUCTIONS, /first run one read-only command/);
  assert.match(EREBUS_COMMAND_SAFETY_INSTRUCTIONS, /wait for that command to finish/);
  assert.match(EREBUS_COMMAND_SAFETY_INSTRUCTIONS, /separate deletion command/);
  assert.match(EREBUS_COMMAND_SAFETY_INSTRUCTIONS, /one already verified literal absolute target/);
  assert.match(EREBUS_COMMAND_SAFETY_INSTRUCTIONS, /must not contain variables, path computation/);
  assert.match(EREBUS_COMMAND_SAFETY_INSTRUCTIONS, /report the exact residual path/);
  assert.notInclude(EREBUS_COMMAND_SAFETY_INSTRUCTIONS, "workspace.cleanup_temp_directory");
});
