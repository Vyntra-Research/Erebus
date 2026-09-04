import type {
  ResearchContract,
  ResearchFindingSubmission,
  ResearchIntervention,
  ThreadMessageSentPayload,
} from "@t3tools/contracts";

import type { ObserverAssessment } from "./Services/ResearchEvaluator.ts";
import type { ObserverCampaignSnapshot } from "./Services/ResearchEvaluator.ts";
import { isErebusCoagentMessage } from "../provider/codexUserSteering.ts";
import type { ResearchProjection } from "./researchState.ts";
import { RESEARCH_OBSERVER_RUNTIME_POLICY } from "./researchPolicy.ts";

export function activeResearchContract(projection: ResearchProjection): ResearchContract | null {
  const campaign = projection.campaign;
  if (!campaign || campaign.status !== "active") return null;
  return (
    projection.contracts.find(
      (contract) =>
        contract.id === campaign.activeContractId &&
        contract.revision === campaign.activeContractRevision,
    ) ?? null
  );
}

export function isCompletedAssistantMessage(
  payload: typeof ThreadMessageSentPayload.Type,
): boolean {
  return payload.role === "assistant" && !payload.streaming;
}

type ProjectedConversationMessage = {
  readonly id: string;
  readonly role: string;
  readonly text: string;
  readonly turnId?: string | null;
};

export type ObserverTimelineMessage = {
  readonly id: string;
  readonly source: "userPrompt" | "userSteer" | "coagentMessage" | "principalAssistant";
  readonly text: string;
  readonly turnId: string | null;
};

export function resolveCompletedAssistantMessageText(
  payload: typeof ThreadMessageSentPayload.Type,
  projectedMessages: ReadonlyArray<ProjectedConversationMessage>,
): string | null {
  if (payload.text.trim().length > 0) return payload.text;
  const projected = projectedMessages.find(
    (message) => message.id === payload.messageId && message.role === "assistant",
  );
  return projected && projected.text.trim().length > 0 ? projected.text : null;
}

export function hydratePrincipalMessageTexts<
  Message extends { readonly id: string; readonly text: string },
>(
  messages: ReadonlyArray<Message>,
  projectedMessages: ReadonlyArray<ProjectedConversationMessage>,
): ReadonlyArray<Message> {
  const projectedById = new Map(
    projectedMessages
      .filter((message) => message.role === "assistant" && message.text.trim().length > 0)
      .map((message) => [message.id, message.text] as const),
  );
  return messages.map((message) =>
    message.text.trim().length > 0
      ? message
      : { ...message, text: projectedById.get(message.id) ?? "" },
  );
}

function isErebusSupervisoryMessage(message: ProjectedConversationMessage): boolean {
  const text = message.text.trimStart();
  return (
    message.id.startsWith("erebus:") ||
    text.startsWith("<vigil_steering") ||
    text.startsWith("<erebus_steering")
  );
}

/**
 * Build chronological Observer context without changing its assistant-only cadence.
 */
export function buildObserverTimeline(
  assistantMessages: ReadonlyArray<{ readonly id: string; readonly text: string }>,
  projectedMessages: ReadonlyArray<ProjectedConversationMessage>,
): ReadonlyArray<ObserverTimelineMessage> {
  if (assistantMessages.length === 0) return [];
  const assistantById = new Map(assistantMessages.map((message) => [message.id, message] as const));
  const indexedAssistants = projectedMessages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => assistantById.has(message.id));
  if (indexedAssistants.length === 0) {
    return assistantMessages.map((message) => ({
      id: message.id,
      source: "principalAssistant" as const,
      text: message.text,
      turnId: null,
    }));
  }

  const firstWindowIndex = indexedAssistants[0]!.index;
  const lastWindowIndex = indexedAssistants.at(-1)!.index;
  const eligibleUsers = projectedMessages
    .map((message, index) => ({ message, index }))
    .filter(
      ({ message, index }) =>
        index <= lastWindowIndex &&
        message.role === "user" &&
        message.text.trim().length > 0 &&
        !isErebusSupervisoryMessage(message),
    );
  const userAuthored = eligibleUsers.filter(({ message }) => !isErebusCoagentMessage(message.text));
  const coagentMessages = eligibleUsers.filter(({ message }) =>
    isErebusCoagentMessage(message.text),
  );
  const latestPrompt = userAuthored.findLast(({ message }) => message.turnId == null);
  const steers = userAuthored.filter(({ message }) => message.turnId != null);
  const lastPriorSteer = steers.findLast(({ index }) => index < firstWindowIndex);
  const laterSteers = steers.filter(({ index }) => index >= firstWindowIndex);
  const lastPriorCoagentMessage = coagentMessages.findLast(({ index }) => index < firstWindowIndex);
  const laterCoagentMessages = coagentMessages.filter(({ index }) => index >= firstWindowIndex);
  const selectedUserIndexes = new Set(
    [latestPrompt, lastPriorSteer, lastPriorCoagentMessage, ...laterSteers, ...laterCoagentMessages]
      .filter((item) => item !== undefined)
      .map((item) => item.index),
  );

  return projectedMessages.flatMap<ObserverTimelineMessage>((message, index) => {
    const assistant = assistantById.get(message.id);
    if (assistant) {
      return [
        {
          id: message.id,
          source: "principalAssistant" as const,
          text: assistant.text,
          turnId: message.turnId ?? null,
        },
      ];
    }
    if (!selectedUserIndexes.has(index)) return [];
    return [
      {
        id: message.id,
        source: isErebusCoagentMessage(message.text)
          ? ("coagentMessage" as const)
          : message.turnId == null
            ? ("userPrompt" as const)
            : ("userSteer" as const),
        text: message.text,
        turnId: message.turnId ?? null,
      },
    ];
  });
}

export function pendingObserverWindowCount(
  projection: ResearchProjection,
  observerPolicy = RESEARCH_OBSERVER_RUNTIME_POLICY,
): number {
  const campaign = projection.campaign;
  const contract = activeResearchContract(projection);
  if (!campaign || !contract) return 0;
  return Math.max(
    0,
    Math.floor(
      (campaign.eligibleMessageCount - campaign.lastObservedMessageCount) /
        observerPolicy.messageWindow,
    ),
  );
}

export function shouldObserverIntervene(
  assessment: ObserverAssessment,
  observerPolicy = RESEARCH_OBSERVER_RUNTIME_POLICY,
): boolean {
  return (
    (assessment.verdict === "deviation" || assessment.verdict === "criticalDeviation") &&
    assessment.confidence >= observerPolicy.interventionConfidence &&
    assessment.contractClauses.some((clause) => clause.trim().length > 0) &&
    assessment.evidence.some((evidence) => evidence.trim().length > 0) &&
    Boolean(assessment.recommendedSteering?.trim())
  );
}

export function buildObserverCampaignSnapshot(
  projection: ResearchProjection,
  observerPolicy = RESEARCH_OBSERVER_RUNTIME_POLICY,
): ObserverCampaignSnapshot | null {
  const campaign = projection.campaign;
  if (!campaign) return null;
  const latestFindings = [...projection.findings]
    .toReversed()
    .filter(
      (finding, index, all) =>
        all.findIndex((candidate) => candidate.findingId === finding.findingId) === index,
    )
    .toReversed()
    .map((finding) => {
      const revision = finding.revision ?? 1;
      const judge = [...projection.judgeEvaluations]
        .toReversed()
        .find(
          (evaluation) =>
            evaluation.findingId === finding.findingId &&
            (evaluation.findingRevision ?? 1) === revision,
        );
      return {
        findingId: finding.findingId,
        revision,
        title: finding.title,
        proteusBranchId: finding.proteusBranchId,
        judge: judge
          ? {
              evaluationId: judge.evaluationId,
              verdict: judge.verdict,
              summary: judge.summary,
              nextAction: judge.nextAction,
            }
          : null,
      };
    });
  const checkpoint = projection.checkpoints.at(-1);
  return {
    campaign: {
      id: campaign.id,
      status: campaign.status,
      proteusCampaignId: campaign.proteusCampaignId,
      eligibleMessageCount: campaign.eligibleMessageCount,
      lastObservedMessageCount: campaign.lastObservedMessageCount,
    },
    runtimeObserverPolicy: observerPolicy,
    latestCheckpoint: checkpoint
      ? {
          proteusCheckpointId: checkpoint.proteusCheckpointId,
          summary: checkpoint.summary,
          evidence: checkpoint.evidence,
          killedPaths: checkpoint.killedPaths,
          openDeviations: checkpoint.openDeviations,
          nextMove: checkpoint.nextMove,
        }
      : null,
    latestFindings,
    recentInterventions: projection.interventions.slice(-5).map((intervention) => ({
      source: intervention.source,
      delivery: intervention.delivery,
      status: intervention.status,
      evaluationId: intervention.evaluationId,
      observation: intervention.observation,
    })),
  };
}

export function pendingJudgeFindings(
  projection: ResearchProjection,
): ReadonlyArray<ResearchFindingSubmission> {
  const latestFindings = [...projection.findings]
    .toReversed()
    .filter(
      (finding, index, all) =>
        all.findIndex((candidate) => candidate.findingId === finding.findingId) === index,
    );
  return latestFindings.filter((finding) => {
    const latest = [...projection.judgeEvaluations]
      .toReversed()
      .find(
        (evaluation) =>
          evaluation.findingId === finding.findingId &&
          (evaluation.findingRevision ?? 1) === (finding.revision ?? 1),
      );
    return !latest || latest.verdict === "reviewBlocked";
  });
}

export function queuedInterventions(
  projection: ResearchProjection,
): ReadonlyArray<ResearchIntervention> {
  return projection.interventions.filter(
    (intervention) =>
      intervention.status === "queued" || intervention.status === "queuedWhilePaused",
  );
}

export function queuedObserverInterventions(
  projection: ResearchProjection,
): ReadonlyArray<ResearchIntervention> {
  return queuedInterventions(projection).filter(
    (intervention) => intervention.source === "observer",
  );
}

export function queuedJudgeFollowUps(
  projection: ResearchProjection,
): ReadonlyArray<ResearchIntervention> {
  return queuedInterventions(projection).filter((intervention) => {
    if (intervention.source !== "judge" || intervention.delivery !== "followUp") return false;
    const evaluation = projection.judgeEvaluations.find(
      (candidate) => candidate.evaluationId === intervention.evaluationId,
    );
    if (!evaluation) return false;
    const latestFinding = [...projection.findings]
      .toReversed()
      .find((finding) => finding.findingId === evaluation.findingId);
    if (!latestFinding || (latestFinding.revision ?? 1) !== (evaluation.findingRevision ?? 1)) {
      return false;
    }
    const latestEvaluation = [...projection.judgeEvaluations]
      .toReversed()
      .find(
        (candidate) =>
          candidate.findingId === evaluation.findingId &&
          (candidate.findingRevision ?? 1) === (evaluation.findingRevision ?? 1),
      );
    return latestEvaluation?.evaluationId === evaluation.evaluationId;
  });
}
