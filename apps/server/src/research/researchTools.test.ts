import { assert, it } from "@effect/vitest";

import {
  isErebusResearchToolCall,
  toDynamicToolContent,
  toDynamicToolResponse,
  EREBUS_RESEARCH_DYNAMIC_TOOL,
} from "./researchTools.ts";

it("exposes the local CVSS calculator and independent Judge handoff tools", () => {
  assert.deepStrictEqual(
    EREBUS_RESEARCH_DYNAMIC_TOOL.tools.map((tool) => tool.name),
    ["calculate_cvss", "get_status", "submit_finding", "revise_finding"],
  );
});

it("publishes an explicit CVSS vector schema", () => {
  const calculator = EREBUS_RESEARCH_DYNAMIC_TOOL.tools.find(
    (tool) => tool.name === "calculate_cvss",
  );
  assert.isDefined(calculator);
  assert.include(calculator.description, "never infers metrics");
  const serializedSchema = JSON.stringify(calculator.inputSchema);
  assert.include(serializedSchema, '"vector"');
  assert.include(serializedSchema, "CVSS:4.0");

  const response = toDynamicToolContent({ score: 7.3, severity: "high" });
  assert.isTrue(response.success);
  const content = response.contentItems[0];
  assert.equal(content?.type, "inputText");
  if (content?.type === "inputText") {
    assert.deepEqual(JSON.parse(content.text), { score: 7.3, severity: "high" });
  }
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

it("publishes the minimal artifact handoff schema and turn barrier", () => {
  const submitFinding = EREBUS_RESEARCH_DYNAMIC_TOOL.tools.find(
    (tool) => tool.name === "submit_finding",
  );
  assert.isDefined(submitFinding);
  assert.include(submitFinding.description, "final tool call");
  assert.include(submitFinding.description, "separate follow-up turn");
  assert.include(submitFinding.description, "accepted=false");

  const serializedSchema = JSON.stringify(submitFinding.inputSchema);
  for (const field of [
    "findingId",
    "revision",
    "supersedesEvaluationId",
    "title",
    "target",
    "findingPath",
    "pocPath",
  ]) {
    assert.include(serializedSchema, `"${field}"`);
  }
  assert.notInclude(serializedSchema, '"campaignId"');
  assert.notInclude(serializedSchema, '"contractId"');
  assert.notInclude(serializedSchema, '"gateClaims"');
  assert.include(serializedSchema, "findings/");
  assert.include(serializedSchema, "pocs/");
});

it("publishes immutable finding revision metadata", () => {
  const reviseFinding = EREBUS_RESEARCH_DYNAMIC_TOOL.tools.find(
    (tool) => tool.name === "revise_finding",
  );
  assert.isDefined(reviseFinding);
  const serializedSchema = JSON.stringify(reviseFinding.inputSchema);
  for (const field of ["findingId", "revision", "supersedesEvaluationId"]) {
    assert.include(serializedSchema, `"${field}"`);
  }
  assert.notInclude(serializedSchema, '"cvssV31"');
});
