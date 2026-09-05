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
  assert.match(OBSERVER_POLICY, /Silence is correct when no material contractual deviation exists/);
  assert.match(OBSERVER_POLICY, /Tool calls do not count/);
  assert.match(OBSERVER_POLICY, /Never queue, replay, or reapply an Observer recommendation/);
  assert.match(OBSERVER_POLICY, /replay the exact last Observer block literally after compaction/);
  assert.match(OBSERVER_POLICY, /userPrompt, userSteer, coagentMessage, and principalAssistant/);
  assert.match(OBSERVER_POLICY, /coagentMessage is task-to-task coordination/);
  assert.match(OBSERVER_POLICY, /user's prompt and later steers are binding/);
  assert.match(OBSERVER_POLICY, /compliance monitor, not the research coordinator/);
  assert.match(OBSERVER_POLICY, /do not decide the best research strategy/i);
  assert.match(OBSERVER_POLICY, /You have no command authority/);
  assert.match(OBSERVER_POLICY, /Never address the principal in imperative voice/);
  assert.match(OBSERVER_POLICY, /The active contract or user instruction is the authority/);
  assert.match(OBSERVER_POLICY, /Never issue a stop, pause, resume, or reconciliation command/);
  assert.match(OBSERVER_POLICY, /Possibility is not observation/);
  assert.match(OBSERVER_POLICY, /Repetition does not make a safe, bounded action unsafe/);
  assert.match(OBSERVER_POLICY, /merely could enter its versioned src\/compiled subtree/);
  assert.match(OBSERVER_POLICY, /actually started at a drive or user-home root/);
  assert.match(OBSERVER_POLICY, /If any element is missing, use aligned or watch/);
  assert.match(OBSERVER_POLICY, /Cost, elapsed time.*are not evidence of contractual deviation/);
  assert.match(OBSERVER_POLICY, /earlier tactical plans are durable research context, not binding/);
  assert.match(OBSERVER_POLICY, /Do not select the replacement branch/);
  assert.match(OBSERVER_POLICY, /Do not infer that a wider sink.*is exhausted/);
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
    /Observer advice is fresh only in the uninterrupted live turn/,
  );
  assert.match(EREBUS_PRINCIPAL_INSTRUCTIONS, /outside and after the compacted summary/);
  assert.match(EREBUS_PRINCIPAL_INSTRUCTIONS, /recent commits, diffs, patch archaeology/);
  assert.match(EREBUS_PRINCIPAL_INSTRUCTIONS, /never add lab glue/);
  assert.match(EREBUS_PRINCIPAL_INSTRUCTIONS, /contract\.target.*required plain string/);
  assert.match(EREBUS_PRINCIPAL_INSTRUCTIONS, /supply every required field/);
  assert.match(
    EREBUS_PRINCIPAL_INSTRUCTIONS,
    /containment boundary, not a request to create a lab/,
  );
  assert.match(EREBUS_PRINCIPAL_INSTRUCTIONS, /read-only work must not create one/i);
  assert.match(OBSERVER_POLICY, /creating one bounded task-owned directory.*is not itself unsafe/);
  assert.match(OBSERVER_POLICY, /leading shell executable.*is not the mutation target/);
  assert.match(
    OBSERVER_POLICY,
    /unsafeExecuted outcome is high-priority audit evidence, not a conclusive breach/,
  );
  assert.match(OBSERVER_POLICY, /docker exec belong to that named container/);
  assert.match(OBSERVER_POLICY, /mark aligned or watch and remain silent/);
  assert.match(OBSERVER_POLICY, /do not flag it merely because it is recursive/);
  assert.match(OBSERVER_POLICY, /generated or compiled subtree.*is not automatically unsafe/);
  assert.match(OBSERVER_POLICY, /never justifies pausing the campaign/);
  assert.match(OBSERVER_POLICY, /Observed deviation: .*Recommended repair:/);
  assert.notMatch(OBSERVER_POLICY, /you may require the principal to stop/i);
  assert.match(
    EREBUS_PRINCIPAL_INSTRUCTIONS,
    /recursive search.*explicit source subtree is allowed/,
  );
});

it("records a new policy revision and digest for persisted evaluations", () => {
  assert.equal(EREBUS_PRINCIPAL_POLICY_VERSION, 15);
  assert.equal(RESEARCH_SUPERVISOR_POLICY_VERSION, 15);
  assert.equal(RESEARCH_INTERNAL_POLICY.version, 15);
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
