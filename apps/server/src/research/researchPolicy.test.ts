import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";

import { EREBUS_RESEARCH_BASE_CONTRACT } from "./researchBaseContract.ts";
import {
  buildResearchEvaluatorModelSelection,
  JUDGE_POLICY,
  OBSERVER_POLICY,
  RESEARCH_EVALUATOR_MODEL,
  RESEARCH_EVALUATOR_REASONING_EFFORT,
  RESEARCH_INTERNAL_POLICY,
  RESEARCH_OBSERVER_RUNTIME_POLICY,
  RESEARCH_SUPERVISOR_POLICY_VERSION,
} from "./researchPolicy.ts";
import {
  EREBUS_PRINCIPAL_INSTRUCTIONS,
  EREBUS_PRINCIPAL_POLICY_VERSION,
} from "./researchPrincipalInstructions.ts";

it("distributes the complete canonical contract to every research role", () => {
  assert.include(EREBUS_PRINCIPAL_INSTRUCTIONS, EREBUS_RESEARCH_BASE_CONTRACT);
  assert.include(OBSERVER_POLICY, EREBUS_RESEARCH_BASE_CONTRACT);
  assert.include(JUDGE_POLICY, EREBUS_RESEARCH_BASE_CONTRACT);
});

it("keeps strict role-specific behavior around the shared contract", () => {
  assert.match(OBSERVER_POLICY, /Silence is correct when no material deviation exists/);
  assert.match(OBSERVER_POLICY, /Tool calls do not count/);
  assert.match(OBSERVER_POLICY, /Never queue, replay, or reapply an Observer correction/);
  assert.match(OBSERVER_POLICY, /replay the exact last Observer block literally after compaction/);
  assert.match(JUDGE_POLICY, /Your job is not to help the finding pass/);
  assert.match(JUDGE_POLICY, /maximum impact currently proved/);
  assert.match(JUDGE_POLICY, /CVSS is an ancillary classification, never a validity gate/);
  assert.match(JUDGE_POLICY, /finding record under findings\/ and its working PoC under pocs\//);
  assert.match(EREBUS_PRINCIPAL_INSTRUCTIONS, /A finding stated in ordinary prose is not approved/);
  assert.match(
    EREBUS_PRINCIPAL_INSTRUCTIONS,
    /SUBMISSION NOT RECORDED|submission was not recorded/i,
  );
  assert.match(EREBUS_PRINCIPAL_INSTRUCTIONS, /finding record under `findings\/`/);
  assert.match(
    EREBUS_PRINCIPAL_INSTRUCTIONS,
    /Observer steering is valid only in the uninterrupted live turn/,
  );
  assert.match(EREBUS_PRINCIPAL_INSTRUCTIONS, /outside and after the compacted summary/);
  assert.match(EREBUS_PRINCIPAL_INSTRUCTIONS, /recent commits, diffs, patch archaeology/);
  assert.match(EREBUS_PRINCIPAL_INSTRUCTIONS, /never add lab glue/);
});

it("records a new policy revision and digest for persisted evaluations", () => {
  assert.equal(EREBUS_PRINCIPAL_POLICY_VERSION, 8);
  assert.equal(RESEARCH_SUPERVISOR_POLICY_VERSION, 8);
  assert.equal(RESEARCH_INTERNAL_POLICY.version, 8);
  assert.equal(RESEARCH_INTERNAL_POLICY.evaluatorModel, "gpt-daybreak-blue-latest");
  assert.equal(RESEARCH_INTERNAL_POLICY.evaluatorReasoningEffort, "xhigh");
  assert.match(RESEARCH_INTERNAL_POLICY.digest, /^sha256:[a-f0-9]{64}$/);
});

it("owns Observer cadence and intervention thresholds in the harness", () => {
  assert.deepStrictEqual(RESEARCH_OBSERVER_RUNTIME_POLICY, {
    messageWindow: 5,
    interventionConfidence: 0.8,
    cooldownMessages: 5,
    maxInterventionsPerTurn: null,
  });
});

it("runs Observer and Judge on pinned Daybreak Blue xhigh evaluations", () => {
  const selection = buildResearchEvaluatorModelSelection({
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.6-sol",
    options: [
      { id: "reasoningEffort", value: "low" },
      { id: "serviceTier", value: "priority" },
    ],
  });

  assert.equal(selection.instanceId, "codex");
  assert.equal(selection.model, RESEARCH_EVALUATOR_MODEL);
  assert.equal(RESEARCH_EVALUATOR_REASONING_EFFORT, "xhigh");
  assert.deepEqual(selection.options, [{ id: "reasoningEffort", value: "xhigh" }]);
});
