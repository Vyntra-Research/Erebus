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

it("reads Daybreak selection independently of the model slug", () => {
  for (const model of ["gpt-6-sol", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
    const selection = createModelSelection(ProviderInstanceId.make("codex"), model, [
      { id: "cyberAccessProgram", value: "daybreakBlue" },
    ]);
    assert.equal(getCodexCyberAccessProgramOptionValue(selection), "daybreakBlue");
  }
  const invalid = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.6-sol", [
    { id: "cyberAccessProgram", value: "invalid" },
  ]);
  assert.equal(getCodexCyberAccessProgramOptionValue(invalid), undefined);
});
