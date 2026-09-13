import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";

import { EREBUS_RESEARCH_BASE_CONTRACT } from "./researchBaseContract.ts";
import {
  buildResearchEvaluatorModelSelection,
  JUDGE_POLICY,
  RESEARCH_EVALUATOR_MODEL,
  RESEARCH_EVALUATOR_REASONING_EFFORT,
  RESEARCH_INTERNAL_POLICY,
  RESEARCH_JUDGE_GATES,
  RESEARCH_JUDGE_OUTPUT_RESERVE_SECONDS,
  RESEARCH_JUDGE_REVIEW_BUDGET_SECONDS,
  RESEARCH_SUPERVISOR_POLICY_VERSION,
} from "./researchPolicy.ts";
import {
  EREBUS_PRINCIPAL_INSTRUCTIONS,
  EREBUS_PRINCIPAL_POLICY_VERSION,
} from "./researchPrincipalInstructions.ts";

it("keeps the durable heuristics in principal and Judge roles", () => {
  assert.match(EREBUS_RESEARCH_BASE_CONTRACT, /Post-AI Blind-Spot Heuristics/);
  assert.match(EREBUS_RESEARCH_BASE_CONTRACT, /A limit on one producer/);
  assert.match(EREBUS_RESEARCH_BASE_CONTRACT, /Reopen a conclusion/);
  assert.match(EREBUS_RESEARCH_BASE_CONTRACT, /Connect complementary evidence/);
  assert.include(EREBUS_PRINCIPAL_INSTRUCTIONS, EREBUS_RESEARCH_BASE_CONTRACT);
  assert.include(JUDGE_POLICY, EREBUS_RESEARCH_BASE_CONTRACT);
});

it("keeps Judge independent, artifact-bounded, and campaign-free", () => {
  assert.match(JUDGE_POLICY, /not part of a campaign/);
  assert.match(JUDGE_POLICY, /do not manage the submitter's native goal/);
  assert.match(JUDGE_POLICY, /skeptical triager and an informed reviewer/);
  assert.match(JUDGE_POLICY, /Never fill a gap with new research/);
  assert.match(JUDGE_POLICY, /bounded desk review/);
  assert.match(JUDGE_POLICY, /hard wall-clock budget of 600 seconds/);
  assert.match(JUDGE_POLICY, /CVSS is ancillary classification only/);
  assert.match(JUDGE_POLICY, /finding[\s\S]*under findings\/[\s\S]*PoC under pocs\//);
  assert.match(JUDGE_POLICY, /never use Proteus skills/);
  assert.lengthOf(RESEARCH_JUDGE_GATES, 8);
});

it("records the campaign-free policy revision and pinned evaluator", () => {
  assert.equal(EREBUS_PRINCIPAL_POLICY_VERSION, 20);
  assert.equal(RESEARCH_SUPERVISOR_POLICY_VERSION, 24);
  assert.equal(RESEARCH_INTERNAL_POLICY.version, 24);
  assert.equal(RESEARCH_JUDGE_REVIEW_BUDGET_SECONDS, 600);
  assert.equal(RESEARCH_JUDGE_OUTPUT_RESERVE_SECONDS, 60);
  assert.match(RESEARCH_INTERNAL_POLICY.digest, /^sha256:[a-f0-9]{64}$/);

  const selection = buildResearchEvaluatorModelSelection({
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.6-sol",
    options: [{ id: "reasoningEffort", value: "low" }],
  });
  assert.equal(selection.model, RESEARCH_EVALUATOR_MODEL);
  assert.equal(RESEARCH_EVALUATOR_REASONING_EFFORT, "xhigh");
  assert.deepEqual(selection.options, [{ id: "reasoningEffort", value: "xhigh" }]);
});
