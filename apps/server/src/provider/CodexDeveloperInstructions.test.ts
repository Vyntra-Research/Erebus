import { assert, it } from "@effect/vitest";

import { EREBUS_MICROVM_INSTRUCTIONS } from "../microVm/instructions.ts";
import {
  buildCodexDeveloperInstructions,
  buildErebusDeveloperInstructions,
} from "./CodexDeveloperInstructions.ts";

const openCodeRuntime = {
  harness: "OpenCode",
  model: "opencode-go/gemini-4-argon",
  reasoningEffort: "high",
} as const;

it("puts the hard operating order before the long research blocks", () => {
  const text = buildErebusDeveloperInstructions(
    "default",
    openCodeRuntime,
    true,
    "IMPORTED RESEARCH CONTRACT",
    true,
  );

  assert.match(text, /Erebus operating order \(hard defaults\)/);
  assert.match(text, /Memory first/);
  assert.match(text, /Browser order/);
  assert.match(text, /Finding gate/);
  assert.match(text, /host browser or host desktop only when the user explicitly asks/i);
  assert.ok(
    text.indexOf("Erebus operating order") < text.indexOf("Erebus command and workspace safety"),
  );
  assert.ok(text.indexOf("Erebus operating order") < text.indexOf("IMPORTED RESEARCH CONTRACT"));
});

it("applies the same operating order to Codex", () => {
  const text = buildCodexDeveloperInstructions(
    "default",
    { model: "gpt-5.6-sol", reasoningEffort: "xhigh" },
    true,
    "IMPORTED RESEARCH CONTRACT",
    true,
  );

  assert.match(text, /Erebus operating order \(hard defaults\)/);
  assert.match(text, /Never create a parallel memory/);
  assert.match(text, /negative controls/);
});

it("states the browser and host prohibition where the VM tools are described", () => {
  assert.match(EREBUS_MICROVM_INSTRUCTIONS, /Browser and desktop order/);
  assert.match(
    EREBUS_MICROVM_INSTRUCTIONS,
    /Never use the host browser for cookie, auth, or convenience reasons/,
  );
});
