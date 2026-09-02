import type {
  MessageId,
  ResearchCampaign,
  ResearchCheckpointInput,
  ResearchContract,
  ResearchEvent,
  ResearchFindingSubmission,
  ResearchIntervention,
  ResearchJudgeEvaluation,
  ResearchObserverEvaluation,
  ResearchPrincipalMessage,
} from "@t3tools/contracts";

export interface ResearchProjection {
  readonly campaign: ResearchCampaign | null;
  readonly contracts: ReadonlyArray<ResearchContract>;
  readonly principalMessageItemIds: ReadonlyArray<MessageId>;
  readonly principalMessages: ReadonlyArray<ResearchPrincipalMessage>;
  readonly observerEvaluations: ReadonlyArray<ResearchObserverEvaluation>;
  readonly findings: ReadonlyArray<ResearchFindingSubmission>;
  readonly judgeEvaluations: ReadonlyArray<ResearchJudgeEvaluation>;
  readonly interventions: ReadonlyArray<ResearchIntervention>;
  readonly checkpoints: ReadonlyArray<ResearchCheckpointInput>;
  readonly processedEventIds: ReadonlySet<string>;
  readonly lastSequence: number;
}

export interface ResearchReplayFailure {
  readonly ok: false;
  readonly eventIndex: number;
  readonly eventId: string;
  readonly reason: string;
}

export interface ResearchReplaySuccess {
  readonly ok: true;
  readonly state: ResearchProjection;
}

export type ResearchReplayResult = ResearchReplayFailure | ResearchReplaySuccess;

export const emptyResearchProjection = (): ResearchProjection => ({
  campaign: null,
  contracts: [],
  principalMessageItemIds: [],
  principalMessages: [],
  observerEvaluations: [],
  findings: [],
  judgeEvaluations: [],
  interventions: [],
  checkpoints: [],
  processedEventIds: new Set(),
  lastSequence: 0,
});

const contractKey = (contract: { readonly id: string; readonly revision: number }): string =>
  `${contract.id}:${contract.revision}`;

const findingRevision = (finding: ResearchFindingSubmission): number => finding.revision ?? 1;
const evaluationRevision = (evaluation: ResearchJudgeEvaluation): number =>
  evaluation.findingRevision ?? 1;

function applyResearchEvent(
  state: ResearchProjection,
  event: ResearchEvent,
): ResearchProjection | string {
  if (state.processedEventIds.has(event.eventId)) {
    return state;
  }
  if (event.sequence !== state.lastSequence + 1) {
    return `Expected event sequence ${state.lastSequence + 1}, received ${event.sequence}.`;
  }
  if (state.campaign && event.campaignId !== state.campaign.id) {
    return `Event campaign ${event.campaignId} does not match ${state.campaign.id}.`;
  }
  if (!state.campaign && event.type !== "campaign.created") {
    return "The first campaign event must be campaign.created.";
  }

  let next: ResearchProjection;
  switch (event.type) {
    case "campaign.created": {
      if (state.campaign) return "The campaign was already created.";
      if (event.campaign.id !== event.campaignId) {
        return "The campaign.created payload does not match its envelope.";
      }
      next = { ...state, campaign: event.campaign };
      break;
    }
    case "contract.registered": {
      if (event.contract.proteusCampaignId !== state.campaign?.proteusCampaignId) {
        return "The contract points to a different Proteus campaign.";
      }
      const key = contractKey(event.contract);
      const existing = state.contracts.find((contract) => contractKey(contract) === key);
      if (existing && existing.digest !== event.contract.digest) {
        return "A contract revision cannot be replaced with a different digest.";
      }
      next = existing ? state : { ...state, contracts: [...state.contracts, event.contract] };
      break;
    }
    case "contract.activated": {
      const contract = state.contracts.find(
        (candidate) =>
          candidate.id === event.contractId && candidate.revision === event.contractRevision,
      );
      if (!contract) return "Only a registered contract revision can be activated.";
      next = {
        ...state,
        campaign: {
          ...state.campaign!,
          activeContractId: contract.id,
          activeContractRevision: contract.revision,
          updatedAt: event.recordedAt,
        },
      };
      break;
    }
    case "campaign.started": {
      const contract = state.contracts.find(
        (candidate) =>
          candidate.id === event.contractId && candidate.revision === event.contractRevision,
      );
      if (!contract) return "Only a registered contract revision can start the campaign.";
      next = {
        ...state,
        campaign: {
          ...state.campaign!,
          activeContractId: contract.id,
          activeContractRevision: contract.revision,
          status: "active",
          updatedAt: event.recordedAt,
        },
      };
      break;
    }
    case "campaign.statusChanged":
      next = {
        ...state,
        campaign: {
          ...state.campaign!,
          status: event.status,
          updatedAt: event.recordedAt,
        },
      };
      break;
    case "principal.messageCompleted":
      if (state.principalMessageItemIds.includes(event.messageItemId)) {
        next = state;
        break;
      }
      next = {
        ...state,
        campaign: {
          ...state.campaign!,
          eligibleMessageCount: state.campaign!.eligibleMessageCount + 1,
          updatedAt: event.recordedAt,
        },
        principalMessageItemIds: [...state.principalMessageItemIds, event.messageItemId],
        principalMessages: [
          ...state.principalMessages,
          { id: event.messageItemId, text: event.text, turnId: event.turnId },
        ],
      };
      break;
    case "observer.evaluationRecorded": {
      const campaign = state.campaign!;
      if (
        event.evaluation.contractId !== campaign.activeContractId ||
        event.evaluation.contractRevision !== campaign.activeContractRevision
      ) {
        return "The observer evaluated a stale or inactive contract revision.";
      }
      const observesPrincipal =
        event.evaluation.observedThreadId === undefined ||
        event.evaluation.observedThreadId === campaign.principalThreadId;
      if (
        observesPrincipal &&
        (event.windowEndMessageCount > campaign.eligibleMessageCount ||
          event.windowEndMessageCount <= campaign.lastObservedMessageCount)
      ) {
        return "The observer window is outside the unreconciled principal message range.";
      }
      next = {
        ...state,
        campaign: {
          ...campaign,
          lastObservedMessageCount: observesPrincipal
            ? event.windowEndMessageCount
            : campaign.lastObservedMessageCount,
          updatedAt: event.recordedAt,
        },
        observerEvaluations: [...state.observerEvaluations, event.evaluation],
      };
      break;
    }
    case "finding.submitted": {
      const campaign = state.campaign!;
      if (
        event.finding.contractId !== campaign.activeContractId ||
        event.finding.contractRevision !== campaign.activeContractRevision
      ) {
        return "The finding was submitted against a stale or inactive contract revision.";
      }
      const sameFinding = state.findings.filter(
        (finding) => finding.findingId === event.finding.findingId,
      );
      const expectedRevision =
        sameFinding.length === 0 ? 1 : Math.max(...sameFinding.map(findingRevision)) + 1;
      if (findingRevision(event.finding) !== expectedRevision) {
        return `The next finding revision must be ${expectedRevision}.`;
      }
      next = { ...state, findings: [...state.findings, event.finding] };
      break;
    }
    case "judge.evaluationRecorded": {
      const finding = state.findings.find(
        (candidate) =>
          candidate.findingId === event.evaluation.findingId &&
          findingRevision(candidate) === evaluationRevision(event.evaluation),
      );
      if (!finding) return "The judge evaluation has no matching finding submission.";
      if (
        event.evaluation.contractId !== finding.contractId ||
        event.evaluation.contractRevision !== finding.contractRevision
      ) {
        return "The judge evaluation does not use the finding contract revision.";
      }
      const priorEvaluation = [...state.judgeEvaluations]
        .toReversed()
        .find(
          (evaluation) =>
            evaluation.findingId === event.evaluation.findingId &&
            evaluationRevision(evaluation) === evaluationRevision(event.evaluation),
        );
      if (
        priorEvaluation &&
        priorEvaluation.verdict !== "reviewBlocked" &&
        event.evaluation.verdict !== "reviewBlocked"
      ) {
        return "The finding revision already has a Judge evaluation.";
      }
      next = { ...state, judgeEvaluations: [...state.judgeEvaluations, event.evaluation] };
      break;
    }
    case "intervention.recorded": {
      const existingIndex = state.interventions.findIndex(
        (intervention) => intervention.id === event.intervention.id,
      );
      const interventions = [...state.interventions];
      if (existingIndex === -1) interventions.push(event.intervention);
      else interventions[existingIndex] = event.intervention;
      next = { ...state, interventions };
      break;
    }
    case "checkpoint.recorded":
      next = { ...state, checkpoints: [...state.checkpoints, event.checkpoint] };
      break;
  }

  return {
    ...next,
    processedEventIds: new Set([...next.processedEventIds, event.eventId]),
    lastSequence: event.sequence,
  };
}

export function replayResearchEvents(
  events: ReadonlyArray<ResearchEvent>,
  initialState: ResearchProjection = emptyResearchProjection(),
): ResearchReplayResult {
  let state = initialState;
  for (const [eventIndex, event] of events.entries()) {
    const next = applyResearchEvent(state, event);
    if (typeof next === "string") {
      return { ok: false, eventIndex, eventId: event.eventId, reason: next };
    }
    state = next;
  }
  return { ok: true, state };
}
