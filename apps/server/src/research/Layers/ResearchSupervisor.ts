import {
  CommandId,
  EventId,
  IsoDateTime,
  MessageId,
  ResearchEventId,
  ResearchEvaluationId,
  type ResearchFindingId,
  type ResearchPrincipalMessage,
  ResearchInterventionId,
  type ResearchJudgeEvaluation,
  ThreadMessageSentPayload,
  ThreadSessionSetPayload,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { CoagentRegistry } from "../../coagents/Services/CoagentRegistry.ts";
import { ResearchEngine } from "../Services/ResearchEngine.ts";
import { ResearchEvaluator } from "../Services/ResearchEvaluator.ts";
import {
  activeResearchContract,
  buildObserverCampaignSnapshot,
  buildObserverCommandAudit,
  buildObserverTimeline,
  hydratePrincipalMessageTexts,
  isCompletedAssistantMessage,
  pendingJudgeFindings,
  queuedJudgeFollowUps,
  queuedObserverInterventions,
  resolveCompletedAssistantMessageText,
  selectObserverWindowBounds,
  shouldObserverIntervene,
  unjudgedFindings,
} from "../researchSupervision.ts";
import {
  canonicalizeJudgeAssessmentCvss,
  judgeCvssClassificationCorrections,
  normalizeJudgeAssessment,
  validateJudgeAssessmentConsistency,
} from "../researchIntegrity.ts";
import { findCvssMismatchesInText, hasCvssDrivenDecisionLanguage } from "../researchCvss.ts";
import {
  buildResearchEvaluatorModelSelection,
  RESEARCH_INTERNAL_POLICY,
  researchObserverPolicyFromSettings,
} from "../researchPolicy.ts";
import { formatResearchSteering } from "../researchSteering.ts";

const decodeMessage = Schema.decodeUnknownEffect(ThreadMessageSentPayload);
const decodeSession = Schema.decodeUnknownEffect(ThreadSessionSetPayload);

const judgeFollowUpId = (evaluationId: ResearchEvaluationId) =>
  ResearchInterventionId.make(`judge-follow-up:${evaluationId}`);

const judgeObservation = (evaluation: ResearchJudgeEvaluation): string => {
  const gates = evaluation.gates
    .map((gate) => `${gate.gateId}=${gate.status}: ${gate.reason}`)
    .join(" | ");
  return [
    `Independent Judge evaluation ${evaluation.evaluationId} for finding ${evaluation.findingId} revision ${evaluation.findingRevision ?? 1}: ${evaluation.verdict} (confidence ${evaluation.confidence.toFixed(2)}).`,
    `Summary: ${evaluation.summary}`,
    `Gate decisions: ${gates || "none returned"}.`,
    evaluation.nextAction
      ? `Next action: ${evaluation.nextAction}`
      : "No further Judge action was requested.",
  ].join(" ");
};

const makeResearchSupervisor = Effect.gen(function* () {
  const orchestration = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const providers = yield* ProviderService;
  const research = yield* ResearchEngine;
  const evaluator = yield* ResearchEvaluator;
  const serverSettings = yield* ServerSettingsService;
  const coagents = yield* CoagentRegistry;
  const crypto = yield* Crypto.Crypto;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const uuid = crypto.randomUUIDv4;

  const threadContext = Effect.fn("ResearchSupervisor.threadContext")(function* (
    threadId: ThreadId,
  ) {
    const thread = yield* snapshots
      .getThreadDetailById(threadId)
      .pipe(Effect.map(Option.getOrNull));
    if (!thread) return null;
    const project = yield* snapshots
      .getProjectShellById(thread.projectId)
      .pipe(Effect.map(Option.getOrNull));
    if (!project) return null;
    return {
      thread,
      cwd: thread.worktreePath ?? project.workspaceRoot,
    };
  });

  const appendSupervisorActivity = Effect.fn("ResearchSupervisor.appendActivity")(
    function* (input: {
      readonly activityId: string;
      readonly threadId: ThreadId;
      readonly turnId: TurnId | null;
      readonly kind: "research.observer.intervention" | "research.judge.evaluation";
      readonly summary: string;
      readonly detail: string;
      readonly tone: "info" | "error";
      readonly payload: Readonly<Record<string, unknown>>;
    }) {
      const createdAt = yield* nowIso;
      yield* orchestration
        .dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make(`supervisor:activity:${input.activityId}`),
          threadId: input.threadId,
          activity: {
            id: EventId.make(`erebus:${input.activityId}`),
            tone: input.tone,
            kind: input.kind,
            summary: input.summary,
            payload: { ...input.payload, detail: input.detail },
            turnId: input.turnId,
            createdAt,
          },
          createdAt,
        })
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Erebus supervisor activity could not be displayed", {
              activityId: input.activityId,
              cause,
            }),
          ),
        );
    },
  );

  const recordIntervention = Effect.fn("ResearchSupervisor.recordIntervention")(function* (input: {
    readonly campaignId: import("@t3tools/contracts").ResearchCampaignId;
    readonly evaluationId: import("@t3tools/contracts").ResearchEvaluationId;
    readonly source: import("@t3tools/contracts").ResearchInterventionSource;
    readonly observation: string;
    readonly expectedTurnId: TurnId | null;
    readonly targetThreadId: ThreadId;
  }) {
    // Observer steering is valid only against the exact live turn it evaluated.
    // The durable evaluation remains the audit record when that turn has ended.
    if (!input.expectedTurnId) return;

    const id = ResearchInterventionId.make(yield* uuid);
    const createdAt = yield* nowIso;
    const intervention = {
      id,
      campaignId: input.campaignId,
      evaluationId: input.evaluationId,
      targetThreadId: input.targetThreadId,
      source: input.source,
      delivery: "live" as const,
      status: "queued" as const,
      observation: input.observation,
      message: formatResearchSteering({
        source: input.source,
        delivery: "live",
        evaluationId: input.evaluationId,
        observation: input.observation,
      }),
      expectedTurnId: input.expectedTurnId,
      createdAt,
      deliveredAt: null,
    };
    yield* research.dispatch({
      type: "intervention.record",
      commandId: CommandId.make(`supervisor:intervention:${id}:queued`),
      campaignId: input.campaignId,
      intervention,
    });
    const delivered = yield* Effect.result(
      providers.steerTurn({
        threadId: input.targetThreadId,
        expectedTurnId: input.expectedTurnId,
        text: intervention.message,
      }),
    );
    const deliveredAt = yield* nowIso;
    yield* research.dispatch({
      type: "intervention.record",
      commandId: CommandId.make(`supervisor:intervention:${id}:settled`),
      campaignId: input.campaignId,
      intervention: {
        ...intervention,
        status: delivered._tag === "Success" ? "delivered" : "failed",
        deliveredAt: delivered._tag === "Success" ? deliveredAt : null,
      },
    });
    yield* appendSupervisorActivity({
      activityId: `observer:${id}:settled`,
      threadId: input.targetThreadId,
      turnId: input.expectedTurnId,
      kind: "research.observer.intervention",
      summary:
        delivered._tag === "Success"
          ? "Observer course correction delivered"
          : "Observer correction expired before delivery",
      detail: input.observation,
      tone: delivered._tag === "Success" ? "info" : "error",
      payload: {
        campaignId: input.campaignId,
        evaluationId: input.evaluationId,
        status: delivered._tag === "Success" ? "delivered" : "failed",
      },
    });
  });

  const expireQueuedObserverInterventions = Effect.fn(
    "ResearchSupervisor.expireQueuedObserverInterventions",
  )(function* (threadId: ThreadId) {
    const childLink = yield* coagents.getByChild(threadId).pipe(Effect.map(Option.getOrNull));
    const projection = yield* research.findProjectionByThread(
      childLink?.parentThreadId ?? threadId,
    );
    const campaign = projection?.campaign;
    if (!projection || !campaign) return;
    yield* Effect.forEach(
      queuedObserverInterventions(projection).filter(
        (intervention) => (intervention.targetThreadId ?? campaign.principalThreadId) === threadId,
      ),
      (intervention) =>
        research.dispatch({
          type: "intervention.record",
          commandId: CommandId.make(`supervisor:intervention:${intervention.id}:expired`),
          campaignId: campaign.id,
          intervention: {
            ...intervention,
            status: "superseded" as const,
            deliveredAt: null,
          },
        }),
      { discard: true },
    );
  });

  const recordJudgeFollowUp = Effect.fn("ResearchSupervisor.recordJudgeFollowUp")(
    function* (input: {
      readonly campaignId: import("@t3tools/contracts").ResearchCampaignId;
      readonly evaluationId: ResearchEvaluationId;
      readonly observation: string;
    }) {
      const projection = yield* research.findProjection(input.campaignId);
      const campaign = projection?.campaign;
      if (!projection || !campaign) return;
      const id = judgeFollowUpId(input.evaluationId);
      const createdAt = yield* nowIso;
      const intervention = {
        id,
        campaignId: input.campaignId,
        evaluationId: input.evaluationId,
        source: "judge" as const,
        delivery: "followUp" as const,
        status: campaign.status === "active" ? ("queued" as const) : ("queuedWhilePaused" as const),
        observation: input.observation,
        message: formatResearchSteering({
          source: "judge",
          delivery: "followUp",
          evaluationId: input.evaluationId,
          observation: input.observation,
        }),
        expectedTurnId: null,
        createdAt,
        deliveredAt: null,
      };
      yield* research.dispatch({
        type: "intervention.record",
        commandId: CommandId.make(`supervisor:intervention:${id}:queued`),
        campaignId: input.campaignId,
        intervention,
      });
      const evaluation = projection.judgeEvaluations.find(
        (candidate) => candidate.evaluationId === input.evaluationId,
      );
      yield* appendSupervisorActivity({
        activityId: `judge:${id}:ready`,
        threadId: campaign.principalThreadId,
        turnId: null,
        kind: "research.judge.evaluation",
        summary: evaluation ? `Judge verdict: ${evaluation.verdict}` : "Judge verdict ready",
        detail: input.observation,
        tone: evaluation?.verdict === "reviewBlocked" ? "error" : "info",
        payload: {
          campaignId: input.campaignId,
          evaluationId: input.evaluationId,
          verdict: evaluation?.verdict ?? null,
          status: intervention.status,
        },
      });
    },
  );

  const supersedePriorJudgeFollowUps = Effect.fn("ResearchSupervisor.supersedePriorJudgeFollowUps")(
    function* (input: {
      readonly campaignId: import("@t3tools/contracts").ResearchCampaignId;
      readonly findingId: ResearchFindingId;
      readonly findingRevision: number;
      readonly currentEvaluationId: ResearchEvaluationId;
    }) {
      const projection = yield* research.findProjection(input.campaignId);
      if (!projection) return;
      const priorEvaluationIds = new Set(
        projection.judgeEvaluations
          .filter(
            (evaluation) =>
              evaluation.findingId === input.findingId &&
              (evaluation.findingRevision ?? 1) === input.findingRevision &&
              evaluation.evaluationId !== input.currentEvaluationId,
          )
          .map((evaluation) => evaluation.evaluationId),
      );
      const stale = projection.interventions.filter(
        (intervention) =>
          intervention.source === "judge" &&
          intervention.delivery === "followUp" &&
          priorEvaluationIds.has(intervention.evaluationId) &&
          (intervention.status === "queued" || intervention.status === "queuedWhilePaused"),
      );
      yield* Effect.forEach(
        stale,
        (intervention) =>
          research.dispatch({
            type: "intervention.record",
            commandId: CommandId.make(
              `supervisor:intervention:${intervention.id}:superseded:${input.currentEvaluationId}`,
            ),
            campaignId: input.campaignId,
            intervention: { ...intervention, status: "superseded" as const },
          }),
        { discard: true },
      );
    },
  );

  const flushQueuedJudgeFollowUps = Effect.fn("ResearchSupervisor.flushQueuedJudgeFollowUps")(
    function* (threadId: ThreadId) {
      const projection = yield* research.findProjectionByThread(threadId);
      const campaign = projection?.campaign;
      if (!projection || !campaign || campaign.status !== "active") return;
      const intervention = queuedJudgeFollowUps(projection).at(0);
      if (!intervention) return;
      const context = yield* threadContext(threadId);
      if (!context) return;
      if (context.thread.session?.activeTurnId || context.thread.latestTurn?.state === "running") {
        return;
      }

      const started = yield* Effect.result(
        orchestration.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`supervisor:judge-follow-up:${intervention.id}`),
          threadId,
          message: {
            messageId: MessageId.make(`erebus:${intervention.id}`),
            role: "user",
            text: intervention.message,
            attachments: [],
          },
          runtimeMode: context.thread.runtimeMode,
          interactionMode: "default",
          createdAt: yield* nowIso,
        }),
      );
      if (started._tag === "Failure") {
        yield* Effect.logWarning("Erebus Judge follow-up turn could not start", {
          campaignId: campaign.id,
          interventionId: intervention.id,
          cause: started.failure,
        });
        return;
      }

      yield* research.dispatch({
        type: "intervention.record",
        commandId: CommandId.make(`supervisor:intervention:${intervention.id}:delivered`),
        campaignId: campaign.id,
        intervention: {
          ...intervention,
          status: "delivered",
          deliveredAt: yield* nowIso,
        },
      });
    },
  );

  const evaluateObserverWindow = Effect.fn("ResearchSupervisor.evaluateObserverWindow")(function* (
    campaignId: import("@t3tools/contracts").ResearchCampaignId,
    observedThreadId?: ThreadId,
  ) {
    const projection = yield* research.findProjection(campaignId);
    const campaign = projection?.campaign;
    if (!projection || !campaign || campaign.status !== "active") return;
    const contract = activeResearchContract(projection);
    if (!contract) return;
    const targetThreadId = observedThreadId ?? campaign.principalThreadId;
    const coagentLink = observedThreadId
      ? yield* coagents.getByChild(observedThreadId).pipe(Effect.map(Option.getOrNull))
      : null;
    if (
      observedThreadId &&
      (!coagentLink ||
        coagentLink.parentThreadId !== campaign.principalThreadId ||
        coagentLink.status === "failed" ||
        coagentLink.status === "released")
    ) {
      return;
    }
    const supervisionSettings = (yield* serverSettings.getSettings).researchSupervision;
    const observerPolicy = researchObserverPolicyFromSettings(supervisionSettings);
    const context = yield* threadContext(targetThreadId);
    if (!context) return;
    const completedMessages: ReadonlyArray<ResearchPrincipalMessage> = observedThreadId
      ? context.thread.messages
          .filter(
            (message) =>
              message.role === "assistant" && !message.streaming && message.text.trim().length > 0,
          )
          .map((message) => ({ id: message.id, text: message.text, turnId: message.turnId }))
      : projection.principalMessages;
    const observerCursor = observedThreadId
      ? coagentLink?.observerCampaignId === campaignId
        ? coagentLink.observerMessageCount
        : 0
      : campaign.lastObservedMessageCount;
    const windowBounds = selectObserverWindowBounds({
      completedMessageCount: completedMessages.length,
      cursor: observerCursor,
      messageWindow: observerPolicy.messageWindow,
    });
    if (!windowBounds) return;
    const { start, end, skippedMessageCount } = windowBounds;
    if (skippedMessageCount > 0) {
      yield* Effect.logInfo("Erebus Observer skipped stale message backlog", {
        campaignId,
        targetThreadId,
        skippedMessageCount,
      });
    }
    const persistedMessages = completedMessages.slice(start, end);
    if (persistedMessages.length !== observerPolicy.messageWindow) return;
    const baseCampaignSnapshot = buildObserverCampaignSnapshot(projection, observerPolicy);
    if (!baseCampaignSnapshot) return;
    const campaignSnapshot = coagentLink
      ? {
          ...baseCampaignSnapshot,
          observedTask: {
            threadId: coagentLink.childThreadId,
            role: "coagent" as const,
            parentThreadId: coagentLink.parentThreadId,
            assignment: coagentLink.assignment,
          },
        }
      : baseCampaignSnapshot;
    const messages = hydratePrincipalMessageTexts(persistedMessages, context.thread.messages);
    if (messages.some((message) => message.text.trim().length === 0)) {
      yield* Effect.logWarning("Erebus observer window contains unresolved empty messages", {
        campaignId,
        messageItemIds: messages
          .filter((message) => message.text.trim().length === 0)
          .map((message) => message.id),
      });
      return;
    }
    const timeline = buildObserverTimeline(messages, context.thread.messages);
    const commandAudit = buildObserverCommandAudit(
      messages,
      context.thread.activities,
      context.cwd,
      context.thread.messages,
      completedMessages[start - 1]?.id,
    );

    const evaluatorModelSelection = buildResearchEvaluatorModelSelection(
      context.thread.modelSelection,
      supervisionSettings,
    );
    const rawAssessment = yield* evaluator
      .evaluateObserver({
        cwd: context.cwd,
        modelSelection: evaluatorModelSelection,
        contract,
        campaignSnapshot,
        messages: messages.map((message) => ({ id: message.id, text: message.text })),
        timeline,
        commandAudit,
      })
      .pipe(Effect.retry({ times: 2 }));
    const cvssMismatches = messages.flatMap((message) =>
      hasCvssDrivenDecisionLanguage(message.text) ? findCvssMismatchesInText(message.text) : [],
    );
    const assessment =
      cvssMismatches.length === 0
        ? rawAssessment
        : {
            verdict: "deviation" as const,
            confidence: 1,
            contractClauses: [
              "G13: Evidence must support the exact impact without speculative or inconsistent claims.",
            ],
            evidence: cvssMismatches.map(
              (mismatch) =>
                `${mismatch.vector} was stated as ${mismatch.declaredScore.toFixed(1)} but deterministically scores ${mismatch.calculatedScore?.toFixed(1) ?? "invalid"}.`,
            ),
            risk: "A promotion, downgrade, kill decision, or pivot is being derived from inconsistent security scoring.",
            recommendedSteering:
              "Correct the ancillary CVSS classification deterministically. Do not change any validity, promotion, rejection, kill, or pivot decision from the CVSS class; decide those only from the campaign's practical-impact, exploitability, and evidence gates.",
          };
    const evaluationId = ResearchEvaluationId.make(yield* uuid);
    const evaluatedAt = yield* nowIso;
    const evaluationRuntime = {
      policyVersion: RESEARCH_INTERNAL_POLICY.version,
      policyDigest: RESEARCH_INTERNAL_POLICY.digest,
      model: evaluatorModelSelection.model,
      reasoningEffort:
        getModelSelectionStringOptionValue(evaluatorModelSelection, "reasoningEffort") ?? "default",
    } as const;
    const cleanStrings = (values: ReadonlyArray<string>) =>
      values.map((value) => value.trim()).filter((value) => value.length > 0);
    const evaluation = {
      evaluationId,
      campaignId,
      ...(observedThreadId ? { observedThreadId } : {}),
      contractId: contract.id,
      contractRevision: contract.revision,
      messageItemIds: messages.map((message) => message.id),
      verdict: assessment.verdict,
      confidence: assessment.confidence,
      contractClauses: cleanStrings(assessment.contractClauses),
      evidence: cleanStrings(assessment.evidence),
      risk: assessment.risk?.trim() || null,
      recommendedSteering: assessment.recommendedSteering?.trim() || null,
      runtime: evaluationRuntime,
      evaluatedAt,
    } as const;
    const recorded = yield* research.dispatch({
      type: "observer.evaluation.record",
      commandId: CommandId.make(`observer:evaluation:${campaignId}:${targetThreadId}:${end}`),
      campaignId,
      evaluation,
      windowEndMessageCount: end,
    });
    if (coagentLink) {
      yield* coagents.setObserverCursor({
        childThreadId: coagentLink.childThreadId,
        campaignId,
        messageCount: end,
        updatedAt: IsoDateTime.make(evaluatedAt),
      });
    }
    if (recorded.replayed) return;
    if (recorded.projection.campaign?.status !== "active") return;

    const shouldIntervene = shouldObserverIntervene(assessment, observerPolicy);
    if (!shouldIntervene) return;

    const expectedTurnId = messages.at(-1)?.turnId ?? null;
    const interventionsThisTurn = recorded.projection.interventions.filter(
      (intervention) =>
        intervention.expectedTurnId === expectedTurnId &&
        (intervention.targetThreadId ?? campaign.principalThreadId) === targetThreadId,
    ).length;
    if (
      observerPolicy.maxInterventionsPerTurn !== null &&
      interventionsThisTurn >= observerPolicy.maxInterventionsPerTurn
    ) {
      return;
    }

    const previousObserverIntervention = [...recorded.projection.interventions]
      .toReversed()
      .map((intervention) => ({
        intervention,
        evaluation: recorded.projection.observerEvaluations.find(
          (candidate) =>
            candidate.evaluationId === intervention.evaluationId &&
            (candidate.observedThreadId ?? campaign.principalThreadId) === targetThreadId,
        ),
      }))
      .find((entry) => entry.evaluation !== undefined);
    const previousWindowEnd = previousObserverIntervention?.evaluation?.messageItemIds.at(-1);
    if (previousWindowEnd) {
      const previousIndex = completedMessages.findIndex(
        (message) => message.id === previousWindowEnd,
      );
      const messagesSinceIntervention = previousIndex < 0 ? end : end - (previousIndex + 1);
      if (messagesSinceIntervention < observerPolicy.cooldownMessages) return;
    }
    yield* recordIntervention({
      campaignId,
      evaluationId,
      source: "observer",
      expectedTurnId,
      targetThreadId,
      observation: evaluation.recommendedSteering!,
    });
  });

  const onOrchestrationEvent = (event: import("@t3tools/contracts").OrchestrationEvent) =>
    Effect.gen(function* () {
      if (event.type === "thread.session-set") {
        const payload = yield* decodeSession(event.payload);
        yield* expireQueuedObserverInterventions(payload.threadId);
        if (!payload.session.activeTurnId) {
          yield* flushQueuedJudgeFollowUps(payload.threadId);
        }
        return;
      }
      if (event.type !== "thread.message-sent") return;
      const payload = yield* decodeMessage(event.payload);
      if (!isCompletedAssistantMessage(payload)) return;
      const projection = yield* research.findProjectionByThread(payload.threadId);
      const campaign = projection?.campaign;
      if (!campaign || campaign.status !== "active") {
        const childLink = yield* coagents
          .getByChild(payload.threadId)
          .pipe(Effect.map(Option.getOrNull));
        if (!childLink || childLink.status === "failed" || childLink.status === "released") return;
        const parentProjection = yield* research.findProjectionByThread(childLink.parentThreadId);
        const parentCampaign = parentProjection?.campaign;
        if (!parentCampaign || parentCampaign.status !== "active") return;
        yield* evaluateObserverWindow(parentCampaign.id, payload.threadId);
        return;
      }
      const context = yield* threadContext(payload.threadId);
      if (!context) return;
      const text = resolveCompletedAssistantMessageText(payload, context.thread.messages);
      if (!text) return;
      const recorded = yield* research.dispatch({
        type: "principal.message.complete",
        commandId: CommandId.make(`observer:message:${payload.threadId}:${payload.messageId}`),
        campaignId: campaign.id,
        messageItemId: MessageId.make(payload.messageId),
        text,
        turnId: payload.turnId,
      });
      if (!recorded.result.accepted) return;
      yield* evaluateObserverWindow(campaign.id);
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Erebus observer event failed", { eventId: event.eventId, cause }),
      ),
    );

  const onResearchEvent: (
    event: import("@t3tools/contracts").ResearchEvent,
  ) => Effect.Effect<void, never, never> = (event) =>
    Effect.gen(function* () {
      if (event.type === "campaign.statusChanged" && event.status === "active") {
        const projection = yield* research.findProjection(event.campaignId);
        const campaign = projection?.campaign;
        if (!projection || !campaign) return;
        yield* Effect.forEach(
          pendingJudgeFindings(projection),
          (finding) =>
            onResearchEvent({
              eventId: ResearchEventId.make(`resume:${campaign.id}:${finding.findingId}`),
              campaignId: campaign.id,
              sequence: projection.lastSequence,
              recordedAt: campaign.updatedAt,
              type: "finding.submitted",
              finding,
            }),
          { discard: true },
        );
        yield* flushQueuedJudgeFollowUps(campaign.principalThreadId);
        return;
      }
      if (event.type !== "finding.submitted") return;
      const projection = yield* research.findProjection(event.campaignId);
      const campaign = projection?.campaign;
      if (!projection || !campaign) return;
      const contract = projection.contracts.find(
        (candidate) =>
          candidate.id === event.finding.contractId &&
          candidate.revision === event.finding.contractRevision,
      );
      if (!contract) return;
      const context = yield* threadContext(campaign.principalThreadId);
      if (!context) return;
      const evaluatorModelSelection = buildResearchEvaluatorModelSelection(
        context.thread.modelSelection,
        (yield* serverSettings.getSettings).researchSupervision,
      );
      const assessmentResult = yield* Effect.result(
        evaluator
          .evaluateJudge({
            cwd: context.cwd,
            modelSelection: evaluatorModelSelection,
            contract,
            finding: event.finding,
            priorEvaluations: projection.judgeEvaluations.filter(
              (evaluation) =>
                evaluation.findingId === event.finding.findingId &&
                (evaluation.findingRevision ?? 1) === (event.finding.revision ?? 1),
            ),
          })
          .pipe(Effect.retry({ times: 2 })),
      );
      if (assessmentResult._tag === "Failure") {
        const failureDetail = assessmentResult.failure.detail;
        const failureEvaluationId = ResearchEvaluationId.make(yield* uuid);
        const evaluatorModelSelection = buildResearchEvaluatorModelSelection(
          context.thread.modelSelection,
          (yield* serverSettings.getSettings).researchSupervision,
        );
        const evaluation = {
          evaluationId: failureEvaluationId,
          findingId: event.finding.findingId,
          findingRevision: event.finding.revision ?? 1,
          campaignId: campaign.id,
          contractId: contract.id,
          contractRevision: contract.revision,
          verdict: "reviewBlocked" as const,
          confidence: 1,
          gates: contract.gates.map((gate) => ({
            gateId: gate.id,
            status: "unknown" as const,
            reason: `The independent Judge did not complete after bounded retries. ${failureDetail}`,
            evidence: [],
          })),
          summary: `Review blocked by a harness or evaluator failure. ${failureDetail} No technical verdict exists and the finding remains preserved.`,
          nextAction:
            "Repair the evaluator and retry this same finding revision; do not return the branch to research or claim acceptance, rejection, downgrade, or closure.",
          cvssV31: null,
          runtime: {
            policyVersion: RESEARCH_INTERNAL_POLICY.version,
            policyDigest: RESEARCH_INTERNAL_POLICY.digest,
            model: evaluatorModelSelection.model,
            reasoningEffort:
              getModelSelectionStringOptionValue(evaluatorModelSelection, "reasoningEffort") ??
              "default",
          },
          evaluatedAt: yield* nowIso,
        } as const;
        const attempt =
          projection.judgeEvaluations.filter(
            (candidate) =>
              candidate.findingId === event.finding.findingId &&
              (candidate.findingRevision ?? 1) === (event.finding.revision ?? 1),
          ).length + 1;
        yield* research.dispatch({
          type: "judge.evaluation.record",
          commandId: CommandId.make(
            `judge:evaluation:${event.finding.findingId}:${event.finding.revision ?? 1}:attempt-${attempt}`,
          ),
          campaignId: campaign.id,
          evaluation,
        });
        yield* supersedePriorJudgeFollowUps({
          campaignId: campaign.id,
          findingId: event.finding.findingId,
          findingRevision: event.finding.revision ?? 1,
          currentEvaluationId: failureEvaluationId,
        });
        yield* recordJudgeFollowUp({
          campaignId: campaign.id,
          evaluationId: failureEvaluationId,
          observation: judgeObservation(evaluation),
        });
        yield* flushQueuedJudgeFollowUps(campaign.principalThreadId);
        yield* Effect.logWarning("Erebus judge event failed", {
          eventId: event.eventId,
          findingId: event.finding.findingId,
          cause: assessmentResult.failure,
        });
        return;
      }
      const rawAssessment = assessmentResult.success;
      const classificationCorrections = judgeCvssClassificationCorrections(rawAssessment);
      const normalizedAssessment = normalizeJudgeAssessment(
        contract,
        canonicalizeJudgeAssessmentCvss(event.finding, rawAssessment),
      );
      const consistencyIssues = validateJudgeAssessmentConsistency(normalizedAssessment);
      const reviewBlocked =
        consistencyIssues.length > 0 ||
        (normalizedAssessment.evidenceAccess.status === "blocked" &&
          normalizedAssessment.evidenceAccess.decisionBlocked);
      const assessment = {
        ...normalizedAssessment,
        verdict: reviewBlocked ? ("reviewBlocked" as const) : normalizedAssessment.verdict,
        gates: reviewBlocked
          ? normalizedAssessment.gates.map((gate) => ({
              ...gate,
              status: "unknown" as const,
              reason:
                consistencyIssues.length > 0
                  ? `Judge output failed deterministic integrity checks: ${consistencyIssues.join("; ")}`
                  : `Judge evidence access was blocked: ${normalizedAssessment.evidenceAccess.detail ?? "required evidence was not readable"}`,
            }))
          : normalizedAssessment.gates,
        summary: reviewBlocked
          ? consistencyIssues.length > 0
            ? `Review blocked because the Judge output was internally inconsistent: ${consistencyIssues.join("; ")}`
            : "Review blocked because evidence required for the decision was not readable from the Judge environment."
          : classificationCorrections.length > 0
            ? `${normalizedAssessment.summary} Ancillary CVSS output was corrected by the harness: ${classificationCorrections.join("; ")}. This correction did not affect the gate verdict.`
            : normalizedAssessment.summary,
        nextAction: reviewBlocked
          ? "Repair evidence access or Judge consistency and retry this same finding revision. Do not return the branch to research or make a promotion, rejection, downgrade, kill, or pivot decision."
          : normalizedAssessment.nextAction,
      };
      const evaluationId = ResearchEvaluationId.make(yield* uuid);
      const evaluation = {
        evaluationId,
        findingId: event.finding.findingId,
        findingRevision: event.finding.revision ?? 1,
        campaignId: campaign.id,
        contractId: contract.id,
        contractRevision: contract.revision,
        verdict: assessment.verdict,
        confidence: assessment.confidence,
        gates: assessment.gates.map((gate) => ({
          ...gate,
          gateId: gate.gateId.trim() || "unknown-gate",
          reason: gate.reason.trim() || "No gate rationale was returned.",
          evidence: gate.evidence.map((value) => value.trim()).filter((value) => value.length > 0),
        })),
        summary: assessment.summary.trim() || "The finding did not pass the active research gates.",
        nextAction: assessment.nextAction?.trim() || null,
        cvssV31: assessment.cvssV31,
        runtime: {
          policyVersion: RESEARCH_INTERNAL_POLICY.version,
          policyDigest: RESEARCH_INTERNAL_POLICY.digest,
          model: evaluatorModelSelection.model,
          reasoningEffort:
            getModelSelectionStringOptionValue(evaluatorModelSelection, "reasoningEffort") ??
            "default",
        },
        evaluatedAt: yield* nowIso,
      } as const;
      const attempt =
        projection.judgeEvaluations.filter(
          (candidate) =>
            candidate.findingId === event.finding.findingId &&
            (candidate.findingRevision ?? 1) === (event.finding.revision ?? 1),
        ).length + 1;
      const recorded = yield* research.dispatch({
        type: "judge.evaluation.record",
        commandId: CommandId.make(
          `judge:evaluation:${event.finding.findingId}:${event.finding.revision ?? 1}:attempt-${attempt}`,
        ),
        campaignId: campaign.id,
        evaluation,
      });
      const durableEvaluation =
        recorded.event?.type === "judge.evaluationRecorded"
          ? recorded.event.evaluation
          : evaluation;
      yield* supersedePriorJudgeFollowUps({
        campaignId: campaign.id,
        findingId: event.finding.findingId,
        findingRevision: event.finding.revision ?? 1,
        currentEvaluationId: durableEvaluation.evaluationId,
      });
      yield* recordJudgeFollowUp({
        campaignId: campaign.id,
        evaluationId: durableEvaluation.evaluationId,
        observation: judgeObservation(durableEvaluation),
      });
      yield* flushQueuedJudgeFollowUps(campaign.principalThreadId);
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Erebus judge event failed", { eventId: event.eventId, cause }),
      ),
    );

  const recoverPendingWork = Effect.gen(function* () {
    const projections = yield* research.listProjections();
    yield* Effect.forEach(
      projections,
      (projection) =>
        Effect.gen(function* () {
          const campaign = projection.campaign;
          if (!campaign || campaign.status !== "active") return;
          const contract = activeResearchContract(projection);
          if (!contract) return;
          // Observer steering is useful only while the triggering research is
          // current. Never replay missed Observer windows during bootstrap.
          // The next completed assistant message selects one fresh bounded
          // window and advances past any stale backlog.
          // Bootstrap may recover a submission that never reached the Judge,
          // but it must not retry a durable reviewBlocked verdict merely
          // because the app restarted. An explicit campaign resume owns that
          // retry once the evaluator environment is ready again.
          yield* Effect.forEach(
            unjudgedFindings(projection),
            (finding) =>
              onResearchEvent({
                eventId: ResearchEventId.make(`recovery:${finding.findingId}`),
                campaignId: campaign.id,
                sequence: projection.lastSequence,
                recordedAt: campaign.updatedAt,
                type: "finding.submitted",
                finding,
              }),
            { discard: true },
          );
          const refreshedProjection = (yield* research.findProjection(campaign.id)) ?? projection;
          const latestFindings = [...refreshedProjection.findings]
            .toReversed()
            .filter(
              (finding, index, all) =>
                all.findIndex((candidate) => candidate.findingId === finding.findingId) === index,
            );
          const latestEvaluations = latestFindings
            .map((finding) =>
              [...refreshedProjection.judgeEvaluations]
                .toReversed()
                .find(
                  (evaluation) =>
                    evaluation.findingId === finding.findingId &&
                    (evaluation.findingRevision ?? 1) === (finding.revision ?? 1),
                ),
            )
            .filter((evaluation) => evaluation !== undefined);
          yield* Effect.forEach(
            latestEvaluations.filter(
              (evaluation) =>
                !refreshedProjection.interventions.some(
                  (intervention) =>
                    intervention.evaluationId === evaluation.evaluationId &&
                    intervention.source === "judge" &&
                    intervention.delivery === "followUp",
                ),
            ),
            (evaluation) =>
              recordJudgeFollowUp({
                campaignId: campaign.id,
                evaluationId: evaluation.evaluationId,
                observation: judgeObservation(evaluation),
              }),
            { discard: true },
          );
          yield* flushQueuedJudgeFollowUps(campaign.principalThreadId);
          yield* expireQueuedObserverInterventions(campaign.principalThreadId);
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Erebus campaign recovery failed", {
              campaignId: projection.campaign?.id,
              cause,
            }),
          ),
        ),
      { discard: true },
    );
  });

  yield* Effect.forkScoped(
    Stream.runForEach(orchestration.streamDomainEvents, onOrchestrationEvent),
  );
  yield* Effect.forkScoped(Stream.runForEach(research.events, onResearchEvent));
  // Judge and follow-up recovery can involve slow external model calls. It
  // must never delay HTTP readiness or prevent the desktop window from opening.
  yield* Effect.forkScoped(recoverPendingWork);
});

export const ResearchSupervisorLive = Layer.effectDiscard(makeResearchSupervisor);
