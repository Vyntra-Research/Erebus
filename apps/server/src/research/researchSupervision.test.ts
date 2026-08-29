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
  hydratePrincipalMessageTexts,
  isCompletedAssistantMessage,
  pendingJudgeFindings,
  pendingObserverWindowCount,
  queuedInterventions,
  queuedJudgeFollowUps,
  queuedObserverInterventions,
  resolveCompletedAssistantMessageText,
  shouldObserverIntervene,
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

it("schedules exact five-message observer windows, including after restart", () => {
  assert.equal(pendingObserverWindowCount(projection(4, 0)), 0);
  assert.equal(pendingObserverWindowCount(projection(5, 0)), 1);
  assert.equal(pendingObserverWindowCount(projection(16, 5)), 2);
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
  assert.deepStrictEqual(queuedJudgeFollowUps(state), [current]);
});
