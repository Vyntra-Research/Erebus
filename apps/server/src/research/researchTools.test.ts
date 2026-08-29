import { assert, it } from "@effect/vitest";

import {
  isErebusResearchToolCall,
  toDynamicToolResponse,
  EREBUS_RESEARCH_DYNAMIC_TOOL,
} from "./researchTools.ts";

it("exposes only explicit campaign lifecycle tools", () => {
  assert.deepStrictEqual(
    EREBUS_RESEARCH_DYNAMIC_TOOL.tools.map((tool) => tool.name),
    [
      "create_campaign",
      "get_status",
      "register_contract",
      "start",
      "checkpoint",
      "pause",
      "resume",
      "finish",
      "abort",
      "submit_finding",
      "revise_finding",
    ],
  );
});

it("routes only calls from the research namespace", () => {
  const call = {
    arguments: {},
    callId: "call-1",
    namespace: "research",
    threadId: "thread-1",
    tool: "submit_finding",
    turnId: "turn-1",
  };

  assert.isTrue(isErebusResearchToolCall(call));
  assert.isFalse(isErebusResearchToolCall({ ...call, namespace: "proteus" }));
  assert.isFalse(isErebusResearchToolCall({ ...call, tool: "finish_without_judge" }));
});

it("returns a structured result as dynamic-tool content", () => {
  const response = toDynamicToolResponse({
    accepted: false,
    status: "revisionRequired",
    message: "The finding did not pass all required gates.",
    issues: ["Missing negative control."],
  });

  assert.isFalse(response.success);
  const content = response.contentItems[0];
  assert.equal(content?.type, "inputText");
  if (content?.type === "inputText") {
    assert.match(content.text, /revisionRequired/);
  }
});

it("publishes every required contract registration field", () => {
  const registerContract = EREBUS_RESEARCH_DYNAMIC_TOOL.tools.find(
    (tool) => tool.name === "register_contract",
  );
  assert.isDefined(registerContract);
  const serializedSchema = JSON.stringify(registerContract.inputSchema);

  for (const field of [
    "id",
    "revision",
    "objective",
    "target",
    "authorization",
    "attackerModel",
    "impactThreshold",
    "scope",
    "strategy",
    "heuristics",
    "gates",
    "duplicatePolicy",
    "labPolicy",
    "reportPolicy",
    "proteusCampaignId",
    "createdAt",
  ]) {
    assert.include(serializedSchema, `"${field}"`);
  }
  assert.notInclude(serializedSchema, '"observerPolicy"');
  assert.include(registerContract.description, "contract.id");
  assert.include(registerContract.description, "contractId");
});

it("publishes the complete finding gate-claim schema and turn barrier", () => {
  const submitFinding = EREBUS_RESEARCH_DYNAMIC_TOOL.tools.find(
    (tool) => tool.name === "submit_finding",
  );
  assert.isDefined(submitFinding);
  assert.include(submitFinding.description, "final tool call");
  assert.include(submitFinding.description, "separate follow-up turn");
  assert.include(submitFinding.description, "accepted=false");

  const serializedSchema = JSON.stringify(submitFinding.inputSchema);
  for (const field of ["gateId", "status", "evidence", "pending", "pass", "fail", "unknown"]) {
    assert.include(serializedSchema, `"${field}"`);
  }
});

it("publishes immutable finding revision metadata", () => {
  const reviseFinding = EREBUS_RESEARCH_DYNAMIC_TOOL.tools.find(
    (tool) => tool.name === "revise_finding",
  );
  assert.isDefined(reviseFinding);
  const serializedSchema = JSON.stringify(reviseFinding.inputSchema);
  for (const field of ["findingId", "revision", "supersedesEvaluationId", "cvssV31"]) {
    assert.include(serializedSchema, `"${field}"`);
  }
});
