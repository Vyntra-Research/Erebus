import { assert, it } from "@effect/vitest";

import { ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import {
  getCodexCyberAccessProgramOptionValue,
  getCodexServiceTierOptionValue,
} from "./codexModelOptions.ts";

it("returns the selected Codex service tier id", () => {
  const selection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.5", [
    { id: "serviceTier", value: "flex" },
  ]);

  assert.equal(getCodexServiceTierOptionValue(selection), "flex");
});

it("keeps legacy persisted fast mode selections working", () => {
  const selection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
    { id: "fastMode", value: true },
  ]);

  assert.equal(getCodexServiceTierOptionValue(selection), "fast");
});

it("keeps Daybreak selection separate from the model and ignores it on unsupported models", () => {
  const sol = createModelSelection(ProviderInstanceId.make("codex"), "gpt-6-sol", [
    { id: "cyberAccessProgram", value: "daybreakBlue" },
  ]);
  const astra = { ...sol, model: "gpt-6-astra" };

  assert.equal(getCodexCyberAccessProgramOptionValue(sol), "daybreakBlue");
  assert.equal(getCodexCyberAccessProgramOptionValue(astra), undefined);
});
