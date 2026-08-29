import { assert, it } from "@effect/vitest";
import type { ResearchEvent } from "@t3tools/contracts";

import { replayResearchEvents } from "./researchState.ts";

const at = "2026-08-27T12:00:00.000Z";

function foundationEvents(): ReadonlyArray<ResearchEvent> {
  const campaign = {
    id: "campaign-1",
    projectId: "project-1",
    principalThreadId: "thread-main",
    observerThreadId: null,
    judgeThreadId: null,
    proteusCampaignId: "proteus-1",
    activeContractId: null,
    activeContractRevision: null,
    status: "draft",
    eligibleMessageCount: 0,
    lastObservedMessageCount: 0,
    createdAt: at,
    updatedAt: at,
  };
  const contract = {
    id: "contract-1",
    revision: 1,
    digest: "sha256:contract-1",
    objective: "Find realistic high-impact vulnerabilities.",
    target: "target",
    authorization: "Authorized local and bug bounty research.",
    attackerModel: "Independent external attacker.",
    impactThreshold: "High",
    scope: { included: ["target"], excluded: [], stopConditions: ["out of scope"] },
    strategy: ["Map trust boundaries."],
    heuristics: ["Reject lab-assisted impact."],
    gates: [{ id: "impact", title: "Impact", requirement: "Prove High impact.", required: true }],
    duplicatePolicy: "Check Proteus and local reports.",
    labPolicy: "Use documented configuration only.",
    reportPolicy: "Require repeatable evidence.",
    observerPolicy: {
      messageWindow: 5,
      interventionConfidence: 0.8,
      cooldownMessages: 5,
      maxInterventionsPerTurn: 1,
    },
    proteusCampaignId: "proteus-1",
    createdAt: at,
  };

  return [
    {
      eventId: "event-1",
      campaignId: "campaign-1",
      sequence: 1,
      recordedAt: at,
      type: "campaign.created",
      campaign,
    },
    {
      eventId: "event-2",
      campaignId: "campaign-1",
      sequence: 2,
      recordedAt: at,
      type: "contract.registered",
      contract,
    },
    {
      eventId: "event-3",
      campaignId: "campaign-1",
      sequence: 3,
      recordedAt: at,
      type: "contract.activated",
      contractId: "contract-1",
      contractRevision: 1,
    },
  ] as unknown as ReadonlyArray<ResearchEvent>;
}

it("rebuilds campaign state across a simulated process restart", () => {
  const foundation = replayResearchEvents(foundationEvents());
  assert.isTrue(foundation.ok);
  if (!foundation.ok) return;

  const laterEvents = Array.from({ length: 5 }, (_, index) => ({
    eventId: `event-${index + 4}`,
    campaignId: "campaign-1",
    sequence: index + 4,
    recordedAt: at,
    type: "principal.messageCompleted",
    messageItemId: `message-${index + 1}`,
  })) as unknown as ReadonlyArray<ResearchEvent>;
  const recovered = replayResearchEvents(laterEvents, foundation.state);

  assert.isTrue(recovered.ok);
  if (!recovered.ok) return;
  assert.equal(recovered.state.campaign?.eligibleMessageCount, 5);
  assert.equal(recovered.state.lastSequence, 8);
});

it("treats a repeated event id as an idempotent delivery", () => {
  const events = foundationEvents();
  const replayed = replayResearchEvents([...events, events[2]!]);

  assert.isTrue(replayed.ok);
  if (!replayed.ok) return;
  assert.equal(replayed.state.contracts.length, 1);
  assert.equal(replayed.state.lastSequence, 3);
});

it("rejects findings tied to a stale contract revision", () => {
  const staleFinding = {
    eventId: "event-4",
    campaignId: "campaign-1",
    sequence: 4,
    recordedAt: at,
    type: "finding.submitted",
    finding: {
      findingId: "finding-1",
      contractId: "contract-1",
      contractRevision: 2,
    },
  } as unknown as ResearchEvent;
  const replayed = replayResearchEvents([...foundationEvents(), staleFinding]);

  assert.isFalse(replayed.ok);
  if (replayed.ok) return;
  assert.match(replayed.reason, /stale or inactive contract revision/);
});

it("preserves a bad Judge verdict while allowing a later harness-block marker and retry", () => {
  const finding = {
    eventId: "event-4",
    campaignId: "campaign-1",
    sequence: 4,
    recordedAt: at,
    type: "finding.submitted",
    finding: {
      findingId: "finding-1",
      revision: 1,
      contractId: "contract-1",
      contractRevision: 1,
    },
  } as unknown as ResearchEvent;
  const rejected = {
    eventId: "event-5",
    campaignId: "campaign-1",
    sequence: 5,
    recordedAt: at,
    type: "judge.evaluationRecorded",
    evaluation: {
      evaluationId: "evaluation-bad",
      findingId: "finding-1",
      findingRevision: 1,
      contractId: "contract-1",
      contractRevision: 1,
      verdict: "rejected",
    },
  } as unknown as ResearchEvent;
  const blocked = {
    eventId: "event-6",
    campaignId: "campaign-1",
    sequence: 6,
    recordedAt: at,
    type: "judge.evaluationRecorded",
    evaluation: {
      evaluationId: "evaluation-invalidation",
      findingId: "finding-1",
      findingRevision: 1,
      contractId: "contract-1",
      contractRevision: 1,
      verdict: "reviewBlocked",
    },
  } as unknown as ResearchEvent;
  const retried = {
    eventId: "event-7",
    campaignId: "campaign-1",
    sequence: 7,
    recordedAt: at,
    type: "judge.evaluationRecorded",
    evaluation: {
      evaluationId: "evaluation-retry",
      findingId: "finding-1",
      findingRevision: 1,
      contractId: "contract-1",
      contractRevision: 1,
      verdict: "accepted",
    },
  } as unknown as ResearchEvent;

  const replayed = replayResearchEvents([
    ...foundationEvents(),
    finding,
    rejected,
    blocked,
    retried,
  ]);
  assert.isTrue(replayed.ok);
  if (!replayed.ok) return;
  assert.deepStrictEqual(
    replayed.state.judgeEvaluations.map((evaluation) => evaluation.verdict),
    ["rejected", "reviewBlocked", "accepted"],
  );
});
