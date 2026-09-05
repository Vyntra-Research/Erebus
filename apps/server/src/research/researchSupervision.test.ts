import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  MessageId,
  ResearchCampaignId,
  ResearchContractId,
  ThreadId,
} from "@t3tools/contracts";

import { emptyResearchProjection, type ResearchProjection } from "./researchState.ts";
import {
  buildObserverCampaignSnapshot,
  buildObserverCommandAudit,
  buildObserverTimeline,
  hydratePrincipalMessageTexts,
  isCompletedAssistantMessage,
  pendingJudgeFindings,
  pendingObserverWindowCount,
  queuedInterventions,
  queuedJudgeFollowUps,
  queuedObserverInterventions,
  resolveCompletedAssistantMessageText,
  selectObserverWindowBounds,
  shouldObserverIntervene,
  unjudgedFindings,
} from "./researchSupervision.ts";

const contract = {
  id: ResearchContractId.make("contract-1"),
  revision: 1,
  digest: "sha256:contract-1",
  objective: "Find realistic high-impact vulnerabilities.",
  target: "target",
  authorization: "Authorized research.",
  attackerModel: "Independent external attacker.",
  impactThreshold: "High",
  scope: { included: ["target"], excluded: [], stopConditions: [] },
  strategy: [],
  heuristics: [],
  gates: [{ id: "impact", title: "Impact", requirement: "Prove impact.", required: true }],
  duplicatePolicy: "Check prior work.",
  labPolicy: "Use a documented setup.",
  reportPolicy: "Require repeatable evidence.",
  observerPolicy: {
    messageWindow: 5,
    interventionConfidence: 0.8,
    cooldownMessages: 5,
    maxInterventionsPerTurn: 1,
  },
  proteusCampaignId: "proteus-1",
  createdAt: "2026-08-27T12:00:00.000Z",
} as const;

const projection = (eligibleMessageCount: number, lastObservedMessageCount: number) =>
  ({
    ...emptyResearchProjection(),
    campaign: {
      id: ResearchCampaignId.make("campaign-1"),
      projectId: ProjectId.make("project-1"),
      principalThreadId: ThreadId.make("thread-1"),
      observerThreadId: null,
      judgeThreadId: null,
      proteusCampaignId: "proteus-1",
      activeContractId: contract.id,
      activeContractRevision: contract.revision,
      status: "active",
      eligibleMessageCount,
      lastObservedMessageCount,
      createdAt: contract.createdAt,
      updatedAt: contract.createdAt,
    },
    contracts: [contract],
  }) satisfies ResearchProjection;

it("counts only complete assistant messages as observer input", () => {
  const base = {
    threadId: ThreadId.make("thread-1"),
    messageId: MessageId.make("message-1"),
    turnId: null,
    text: "result",
    createdAt: contract.createdAt,
    updatedAt: contract.createdAt,
  } as const;
  assert.isTrue(isCompletedAssistantMessage({ ...base, role: "assistant", streaming: false }));
  assert.isFalse(isCompletedAssistantMessage({ ...base, role: "assistant", streaming: true }));
  assert.isFalse(isCompletedAssistantMessage({ ...base, role: "user", streaming: false }));
});

it("resolves completed message text from the projected streaming message", () => {
  const payload = {
    threadId: ThreadId.make("thread-1"),
    messageId: MessageId.make("message-1"),
    turnId: null,
    role: "assistant",
    text: "",
    streaming: false,
    createdAt: contract.createdAt,
    updatedAt: contract.createdAt,
  } as const;
  const projected = [{ id: payload.messageId, role: "assistant", text: "Final message" }];

  assert.equal(resolveCompletedAssistantMessageText(payload, projected), "Final message");
  assert.isNull(resolveCompletedAssistantMessageText(payload, []));
});

it("hydrates persisted empty observer messages after restart", () => {
  const messages = [
    { id: "message-1", text: "", turnId: "turn-1" },
    { id: "message-2", text: "Persisted", turnId: "turn-1" },
  ];
  const hydrated = hydratePrincipalMessageTexts(messages, [
    { id: "message-1", role: "assistant", text: "Recovered" },
    { id: "message-2", role: "assistant", text: "Projected" },
  ]);

  assert.deepStrictEqual(hydrated, [
    { id: "message-1", text: "Recovered", turnId: "turn-1" },
    { id: "message-2", text: "Persisted", turnId: "turn-1" },
  ]);
});

it("gives Observer the latest prompt and steers in chronological context", () => {
  const messages = [
    { id: "prompt-old", role: "user", text: "Old prompt", turnId: null },
    { id: "steer-old", role: "user", text: "Old steer", turnId: "turn-0" },
    { id: "before", role: "assistant", text: "Before window", turnId: "turn-0" },
    { id: "prompt-latest", role: "user", text: "Current objective", turnId: null },
    { id: "steer-prior", role: "user", text: "Preserve this route", turnId: "turn-1" },
    { id: "a1", role: "assistant", text: "One", turnId: "turn-1" },
    { id: "a2", role: "assistant", text: "Two", turnId: "turn-1" },
    {
      id: "coagent-prior",
      role: "user",
      text: '<erebus_coagent_message from_thread_id="child-1" from_title="Parser">Prior child update</erebus_coagent_message>',
      turnId: "turn-1",
    },
    { id: "steer-live", role: "user", text: "User correction", turnId: "turn-2" },
    {
      id: "coagent-live",
      role: "user",
      text: '<erebus_coagent_message from_thread_id="child-2" from_title="Cache">Later child update</erebus_coagent_message>',
      turnId: "turn-2",
    },
    {
      id: "erebus:observer:1",
      role: "user",
      text: "<erebus_steering>internal</erebus_steering>",
      turnId: "turn-2",
    },
    { id: "a3", role: "assistant", text: "Three", turnId: "turn-2" },
  ];
  const timeline = buildObserverTimeline(
    [
      { id: "a1", text: "One" },
      { id: "a2", text: "Two" },
      { id: "a3", text: "Three" },
    ],
    messages,
  );

  assert.deepStrictEqual(
    timeline.map(({ id, source }) => ({ id, source })),
    [
      { id: "prompt-latest", source: "userPrompt" },
      { id: "steer-prior", source: "userSteer" },
      { id: "a1", source: "principalAssistant" },
      { id: "a2", source: "principalAssistant" },
      { id: "coagent-prior", source: "coagentMessage" },
      { id: "steer-live", source: "userSteer" },
      { id: "coagent-live", source: "coagentMessage" },
      { id: "a3", source: "principalAssistant" },
    ],
  );
});

it("keeps co-agent coordination separate from user authority", () => {
  const timeline = buildObserverTimeline(
    [{ id: "a1", text: "One" }],
    [
      { id: "prompt", role: "user", text: "User objective", turnId: null },
      {
        id: "coagent",
        role: "user",
        text: '<erebus_coagent_message from_thread_id="child" from_title="Child">Status</erebus_coagent_message>',
        turnId: null,
      },
      { id: "a1", role: "assistant", text: "One", turnId: "turn-1" },
    ],
  );

  assert.deepStrictEqual(
    timeline.map(({ id, source }) => ({ id, source })),
    [
      { id: "prompt", source: "userPrompt" },
      { id: "coagent", source: "coagentMessage" },
      { id: "a1", source: "principalAssistant" },
    ],
  );
});

it("gives Observer a bounded redacted command audit for the monitored turns", () => {
  const audit = buildObserverCommandAudit(
    [{ turnId: "turn-1" }],
    [
      {
        id: "tool-1",
        kind: "tool.started",
        tone: "tool",
        summary: "Ran command started",
        payload: {
          itemType: "command_execution",
          toolCallId: "call-1",
          detail: "robocopy .\\node_modules .\\work\\copy\\node_modules /E /MT:16 TOKEN=hidden",
          agentId: "subagent-1",
        },
        turnId: "turn-1",
        createdAt: contract.createdAt,
      },
      {
        id: "tool-other-turn",
        kind: "tool.started",
        tone: "tool",
        summary: "Ran command started",
        payload: {
          itemType: "command_execution",
          toolCallId: "call-2",
          detail: "git status --short",
        },
        turnId: "turn-2",
        createdAt: contract.createdAt,
      },
    ] as never,
    "C:\\Users\\researcher\\work\\target",
  );

  assert.equal(audit.entries.length, 1);
  assert.equal(audit.entries[0]?.outcome, "unsafeExecuted");
  assert.equal(audit.entries[0]?.safetyCode, "unsafe-copy");
  assert.equal(audit.entries[0]?.agentId, "subagent-1");
  assert.isFalse(audit.entries[0]?.command.includes("hidden") ?? true);
});

it("classifies the canonical command instead of its absolute shell launcher", () => {
  const audit = buildObserverCommandAudit(
    [{ turnId: "turn-1" }],
    [
      {
        id: "tool-1",
        kind: "tool.started",
        tone: "tool",
        summary: "Ran command started",
        payload: {
          itemType: "command_execution",
          toolCallId: "call-1",
          command:
            '"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "$src=\'C:\\workspace\\src\'; Get-ChildItem -LiteralPath $src -Recurse -File"',
          data: {
            item: {
              commandActions: [
                {
                  command:
                    "$src='C:\\Users\\researcher\\work\\target\\src'; Get-ChildItem -LiteralPath $src -Recurse -File",
                  type: "unknown",
                },
              ],
            },
          },
        },
        turnId: "turn-1",
        createdAt: contract.createdAt,
      },
    ] as never,
    "C:\\Users\\researcher\\work\\target",
  );

  assert.equal(audit.entries[0]?.outcome, "executed");
  assert.isFalse(audit.entries[0]?.command.includes("WindowsPowerShell") ?? true);
  assert.match(audit.entries[0]?.command ?? "", /Get-ChildItem/);
});

it("records a denied command as blocked even when denial follows tool start", () => {
  const audit = buildObserverCommandAudit(
    [{ turnId: "turn-parent" }],
    [
      {
        id: "started",
        kind: "tool.started",
        tone: "tool",
        summary: "Command started",
        payload: {
          itemType: "command_execution",
          toolCallId: "child-call",
          detail: "rg --files C:\\Users\\researcher",
          agentId: "child-agent",
        },
        turnId: "turn-parent",
        createdAt: contract.createdAt,
      },
      {
        id: "denied",
        kind: "tool.denied",
        tone: "error",
        summary: "Tool denied: command",
        payload: {
          toolName: "command",
          toolUseId: "child-call",
          command: "rg --files C:\\Users\\researcher",
          safetyCode: "blocked-tool",
        },
        turnId: "turn-child",
        createdAt: contract.createdAt,
      },
    ] as never,
    "C:\\Users\\researcher\\work\\target",
  );

  assert.equal(audit.entries.length, 1);
  assert.equal(audit.entries[0]?.outcome, "blocked");
  assert.equal(audit.entries[0]?.agentId, "child-agent");
  assert.equal(audit.entries[0]?.safetyCode, "blocked-tool");
});

it("bounds command audit by message chronology when one turn emits several messages", () => {
  const commandActivity = (id: string, createdAt: string, detail: string) => ({
    id,
    kind: "tool.started",
    tone: "tool",
    summary: "Command started",
    payload: { itemType: "command_execution", toolCallId: id, detail },
    turnId: "turn-shared",
    createdAt,
  });
  const audit = buildObserverCommandAudit(
    [{ id: "assistant-current", turnId: "turn-shared" }],
    [
      commandActivity("before", "2026-08-27T12:00:01.000Z", "git status --short"),
      commandActivity("inside", "2026-08-27T12:00:03.000Z", "Get-ChildItem -LiteralPath src"),
      commandActivity("after", "2026-08-27T12:00:05.000Z", "git status --short"),
    ] as never,
    "C:\\Users\\researcher\\work\\target",
    [
      { id: "assistant-previous", createdAt: "2026-08-27T12:00:02.000Z" },
      { id: "assistant-current", createdAt: "2026-08-27T12:00:04.000Z" },
    ],
    "assistant-previous",
  );

  assert.deepStrictEqual(
    audit.entries.map((entry) => entry.id),
    ["inside"],
  );
});

it("counts exact five-message Observer windows", () => {
  assert.equal(pendingObserverWindowCount(projection(4, 0)), 0);
  assert.equal(pendingObserverWindowCount(projection(5, 0)), 1);
  assert.equal(pendingObserverWindowCount(projection(16, 5)), 2);
});

it("selects the newest bounded Observer window instead of replaying stale backlog", () => {
  assert.isNull(
    selectObserverWindowBounds({ completedMessageCount: 4, cursor: 0, messageWindow: 5 }),
  );
  assert.deepStrictEqual(
    selectObserverWindowBounds({ completedMessageCount: 5, cursor: 0, messageWindow: 5 }),
    { start: 0, end: 5, skippedMessageCount: 0 },
  );
  assert.deepStrictEqual(
    selectObserverWindowBounds({ completedMessageCount: 101, cursor: 0, messageWindow: 5 }),
    { start: 96, end: 101, skippedMessageCount: 96 },
  );
  assert.deepStrictEqual(
    selectObserverWindowBounds({ completedMessageCount: 11, cursor: 5, messageWindow: 5 }),
    { start: 6, end: 11, skippedMessageCount: 1 },
  );
});

it("uses the configured harness cadence and confidence threshold", () => {
  const policy = {
    messageWindow: 3,
    interventionConfidence: 0.92,
    cooldownMessages: 2,
    maxInterventionsPerTurn: 2,
  } as const;
  const assessment = {
    verdict: "deviation",
    confidence: 0.9,
    contractClauses: ["impactThreshold"],
    evidence: ["The principal switched to an excluded branch."],
    risk: null,
    recommendedSteering: "Return to the active contract.",
  } as const;

  assert.equal(pendingObserverWindowCount(projection(6, 0), policy), 2);
  assert.isFalse(shouldObserverIntervene(assessment, policy));
  assert.isTrue(shouldObserverIntervene({ ...assessment, confidence: 0.93 }, policy));
});

it("uses the harness cadence even when a legacy contract stored a different window", () => {
  const state = projection(10, 0);
  const legacyContract = {
    ...contract,
    observerPolicy: { ...contract.observerPolicy, messageWindow: 10 },
  };
  assert.equal(pendingObserverWindowCount({ ...state, contracts: [legacyContract] }), 2);
});

it("steers only for a confident deviation with a concrete correction", () => {
  const assessment = {
    verdict: "deviation",
    confidence: 0.9,
    contractClauses: ["impactThreshold"],
    evidence: ["The principal switched to an availability-only branch."],
    risk: null,
    recommendedSteering: "Return to the active impact gate.",
  } as const;
  assert.isTrue(shouldObserverIntervene(assessment));
  assert.isFalse(shouldObserverIntervene({ ...assessment, verdict: "watch" }));
  assert.isFalse(shouldObserverIntervene({ ...assessment, confidence: 0.79 }));
  assert.isFalse(shouldObserverIntervene({ ...assessment, evidence: [] }));
  assert.isFalse(shouldObserverIntervene({ ...assessment, recommendedSteering: " " }));
});

it("builds a bounded durable snapshot for Observer continuity", () => {
  const state = {
    ...projection(7, 5),
    checkpoints: [
      {
        campaignId: ResearchCampaignId.make("campaign-1"),
        proteusCheckpointId: "CP151",
        summary: "Validated the current branch.",
        evidence: ["control passed"],
        killedPaths: ["duplicate branch"],
        openDeviations: [],
        nextMove: "Complete the negative control.",
      },
    ],
  } satisfies ResearchProjection;
  const snapshot = buildObserverCampaignSnapshot(state);

  assert.equal(snapshot?.campaign.proteusCampaignId, "proteus-1");
  assert.equal(snapshot?.runtimeObserverPolicy.messageWindow, 5);
  assert.equal(snapshot?.latestCheckpoint?.proteusCheckpointId, "CP151");
  assert.deepStrictEqual(snapshot?.latestCheckpoint?.killedPaths, ["duplicate branch"]);
});

it("recovers only unjudged findings and queued interventions", () => {
  const finding = {
    findingId: "finding-1",
    revision: 1,
  } as ResearchProjection["findings"][number];
  const queued = {
    id: "intervention-1",
    status: "queuedWhilePaused",
    source: "observer",
    delivery: "historical",
  } as ResearchProjection["interventions"][number];
  const judgeFollowUp = {
    id: "intervention-judge",
    status: "queued",
    source: "judge",
    delivery: "followUp",
    evaluationId: "evaluation-1",
  } as ResearchProjection["interventions"][number];
  const delivered = {
    id: "intervention-2",
    status: "delivered",
  } as ResearchProjection["interventions"][number];
  const state = {
    ...projection(0, 0),
    findings: [finding],
    judgeEvaluations: [
      {
        evaluationId: "evaluation-1",
        findingId: "finding-1",
        findingRevision: 1,
        verdict: "reviewBlocked",
      } as ResearchProjection["judgeEvaluations"][number],
    ],
    interventions: [queued, judgeFollowUp, delivered],
  } satisfies ResearchProjection;

  assert.deepStrictEqual(pendingJudgeFindings(state), [finding]);
  assert.deepStrictEqual(unjudgedFindings(state), []);
  assert.deepStrictEqual(queuedInterventions(state), [queued, judgeFollowUp]);
  assert.deepStrictEqual(queuedObserverInterventions(state), [queued]);
  assert.deepStrictEqual(queuedJudgeFollowUps(state), [judgeFollowUp]);
});

it("retries only the latest logical finding revision and suppresses stale Judge follow-ups", () => {
  const revision1 = {
    findingId: "finding-1",
    revision: 1,
  } as ResearchProjection["findings"][number];
  const revision2 = {
    findingId: "finding-1",
    revision: 2,
  } as ResearchProjection["findings"][number];
  const evaluation1 = {
    evaluationId: "evaluation-1",
    findingId: "finding-1",
    findingRevision: 1,
    verdict: "reviewBlocked",
  } as ResearchProjection["judgeEvaluations"][number];
  const evaluation2 = {
    evaluationId: "evaluation-2",
    findingId: "finding-1",
    findingRevision: 2,
    verdict: "reviewBlocked",
  } as ResearchProjection["judgeEvaluations"][number];
  const stale = {
    id: "follow-up-1",
    evaluationId: "evaluation-1",
    status: "queuedWhilePaused",
    source: "judge",
    delivery: "followUp",
  } as ResearchProjection["interventions"][number];
  const current = {
    id: "follow-up-2",
    evaluationId: "evaluation-2",
    status: "queuedWhilePaused",
    source: "judge",
    delivery: "followUp",
  } as ResearchProjection["interventions"][number];
  const state = {
    ...projection(0, 0),
    findings: [revision1, revision2],
    judgeEvaluations: [evaluation1, evaluation2],
    interventions: [stale, current],
  } satisfies ResearchProjection;

  assert.deepStrictEqual(pendingJudgeFindings(state), [revision2]);
  assert.deepStrictEqual(unjudgedFindings(state), []);
  assert.deepStrictEqual(queuedJudgeFollowUps(state), [current]);
});

it("recovers a finding that never reached the Judge", () => {
  const finding = {
    findingId: "finding-unjudged",
    revision: 1,
  } as ResearchProjection["findings"][number];
  const state = {
    ...projection(0, 0),
    findings: [finding],
  } satisfies ResearchProjection;

  assert.deepStrictEqual(unjudgedFindings(state), [finding]);
});
