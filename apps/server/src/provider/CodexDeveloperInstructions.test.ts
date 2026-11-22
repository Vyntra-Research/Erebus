import { assert, it } from "@effect/vitest";

import {
  buildCodexDeveloperInstructions,
  buildErebusDeveloperInstructions,
  EREBUS_COMMAND_SAFETY_INSTRUCTIONS,
} from "./CodexDeveloperInstructions.ts";

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

it("mentions web evidence tools only when the session received them", () => {
  const runtime = { model: "gpt-test", reasoningEffort: "medium" };
  const withoutWeb = buildCodexDeveloperInstructions("default", runtime, false, undefined, false);
  const withWeb = buildCodexDeveloperInstructions("default", runtime, false, undefined, true);

  assert.notInclude(withoutWeb, "## Erebus web testing");
  assert.include(withWeb, "## Erebus web testing");
  assert.include(withWeb, "session-bound extension pairing");
  assert.include(withWeb, "same runtime with their own scoped credential");
  assert.include(withWeb, "Subfinder discovers hosts");
  assert.include(withWeb, "Katana crawls URL space");
  assert.include(withWeb, "SecretHound scans chosen sources");
  assert.include(withWeb, "web_module_exec");
  assert.include(withWeb, "native arguments and stdin directly");
  assert.include(withWeb, "check the truncation fields");
  assert.include(withWeb, "Discovery output is a lead, not proof");
  assert.include(withWeb, "install or update it through Erebus module controls");
  assert.notInclude(withWeb, "must follow");
});

it("describes the active provider harness without changing shared Erebus rules", () => {
  const instructions = buildErebusDeveloperInstructions(
    "default",
    { harness: "OpenCode", model: "opencode/free", reasoningEffort: "high" },
    false,
    "persona:capri",
    false,
  );

  assert.include(instructions, "through the OpenCode harness");
  assert.include(instructions, "opencode/free");
  assert.include(instructions, "persona:capri");
  assert.include(instructions, "## Erebus command and workspace safety");
  assert.notInclude(instructions, "## Erebus collaborative browser");
});
