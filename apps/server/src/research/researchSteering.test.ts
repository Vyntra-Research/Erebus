import { assert, it } from "@effect/vitest";
import { ResearchEvaluationId } from "@t3tools/contracts";

import { formatJudgeFollowUp } from "./researchSteering.ts";

it("marks the independent Judge result as a separate follow-up and escapes content", () => {
  const message = formatJudgeFollowUp({
    evaluationId: ResearchEvaluationId.make("evaluation-1"),
    observation: "Finding <F1> was accepted & preserved.",
  });

  assert.include(message, 'source="judge" delivery="followUp"');
  assert.include(message, "fresh independent Judge result");
  assert.include(message, "Call research.get_status once");
  assert.include(message, "Judge does not own the native goal");
  assert.include(message, "Finding &lt;F1&gt; was accepted &amp; preserved.");
  assert.notInclude(message, "Observer");
  assert.notInclude(message, "campaign state");
});
