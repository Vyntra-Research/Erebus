import { assert, it } from "@effect/vitest";
import { ResearchEvaluationId } from "@t3tools/contracts";

import { formatResearchSteering } from "./researchSteering.ts";

it("marks recovered observer steering as historical context", () => {
  const message = formatResearchSteering({
    source: "observer",
    delivery: "historical",
    evaluationId: ResearchEvaluationId.make("evaluation-1"),
    observation: "Return to the active impact gate.",
  });

  assert.include(message, 'source="observer" delivery="historical"');
  assert.include(message, "created before the current recovered, resumed, or compacted context");
  assert.include(message, "Continue from the current durable campaign state and latest checkpoint");
  assert.include(message, "Do not restart, restate, quote, acknowledge, or cite");
});

it("marks live steering as control context and escapes the observation", () => {
  const message = formatResearchSteering({
    source: "judge",
    delivery: "live",
    evaluationId: ResearchEvaluationId.make("evaluation-2"),
    observation: "Fix <gate> & continue.",
  });

  assert.include(message, "not a new user request and not a final research iteration");
  assert.include(message, "Fix &lt;gate&gt; &amp; continue.");
  assert.notInclude(message, "<observation>Fix <gate>");
});

it("marks Judge delivery as a fresh follow-up turn", () => {
  const message = formatResearchSteering({
    source: "judge",
    delivery: "followUp",
    evaluationId: ResearchEvaluationId.make("evaluation-3"),
    observation: "Finding F1 was accepted.",
  });

  assert.include(message, 'source="judge" delivery="followUp"');
  assert.include(message, "fresh independent Judge result");
  assert.include(message, "Call research.get_status once");
  assert.include(message, "You may summarize the verdict to the user");
});
