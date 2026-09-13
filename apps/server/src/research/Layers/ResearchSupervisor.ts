import {
  CommandId,
  EventId,
  MessageId,
  ResearchEvaluationId,
  ThreadSessionSetPayload,
  type ThreadId,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { FindingReviewStore } from "../Services/FindingReviewStore.ts";
import { ResearchEvaluator } from "../Services/ResearchEvaluator.ts";
import {
  canonicalizeIndependentJudgeAssessmentCvss,
  judgeCvssClassificationCorrections,
  normalizeIndependentJudgeAssessment,
  validateJudgeAssessmentConsistency,
} from "../researchIntegrity.ts";
import {
  buildResearchEvaluatorModelSelection,
  RESEARCH_INTERNAL_POLICY,
} from "../researchPolicy.ts";
import { formatJudgeFollowUp } from "../researchSteering.ts";

const decodeSession = Schema.decodeUnknownEffect(ThreadSessionSetPayload);

const judgeObservation = (
  evaluation: import("@t3tools/contracts").ResearchFindingReviewEvaluation,
): string => {
  const gates = evaluation.gates
    .map((gate) => `${gate.gateId}=${gate.status}: ${gate.reason}`)
    .join(" | ");
  return [
    `Independent Judge evaluation ${evaluation.evaluationId} for finding ${evaluation.findingId} revision ${evaluation.findingRevision}: ${evaluation.verdict} (confidence ${evaluation.confidence.toFixed(2)}).`,
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
  const reviews = yield* FindingReviewStore;
  const evaluator = yield* ResearchEvaluator;
  const serverSettings = yield* ServerSettingsService;
  const crypto = yield* Crypto.Crypto;
  const inFlight = new Set<string>();
  const deliveriesInFlight = new Set<ResearchEvaluationId>();

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const uuid = crypto.randomUUIDv4;
  const reviewKey = (record: import("@t3tools/contracts").ResearchFindingReviewRecord) =>
    `${record.threadId}:${record.submission.findingId}:${record.submission.revision}`;

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
    return { thread, cwd: thread.worktreePath ?? project.workspaceRoot };
  });

  const appendJudgeActivity = Effect.fn("ResearchSupervisor.appendJudgeActivity")(function* (
    record: import("@t3tools/contracts").ResearchFindingReviewRecord,
    evaluation: import("@t3tools/contracts").ResearchFindingReviewEvaluation,
  ) {
    const detail = judgeObservation(evaluation);
    yield* orchestration
      .dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(`judge:activity:${evaluation.evaluationId}`),
        threadId: record.threadId,
        activity: {
          id: EventId.make(`erebus:judge:${evaluation.evaluationId}`),
          tone: evaluation.verdict === "reviewBlocked" ? "error" : "info",
          kind: "research.judge.evaluation",
          summary: `Judge verdict: ${evaluation.verdict}`,
          payload: {
            findingId: evaluation.findingId,
            findingRevision: evaluation.findingRevision,
            evaluationId: evaluation.evaluationId,
            verdict: evaluation.verdict,
            detail,
          },
          turnId: null,
          createdAt: evaluation.evaluatedAt,
        },
        createdAt: evaluation.evaluatedAt,
      })
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Erebus Judge activity could not be displayed", {
            evaluationId: evaluation.evaluationId,
            cause,
          }),
        ),
      );
  });

  const flushThread = Effect.fn("ResearchSupervisor.flushThread")(function* (threadId: ThreadId) {
    const pending = (yield* reviews.listPendingDelivery()).find(
      (record) => record.threadId === threadId,
    );
    const evaluation = pending?.evaluations.at(-1);
    if (!pending || !evaluation) return;
    if (deliveriesInFlight.has(evaluation.evaluationId)) return;
    deliveriesInFlight.add(evaluation.evaluationId);
    yield* Effect.gen(function* () {
      const context = yield* threadContext(threadId);
      if (!context) return;
      if (context.thread.session?.activeTurnId || context.thread.latestTurn?.state === "running") {
        return;
      }

      const message = formatJudgeFollowUp({
        evaluationId: evaluation.evaluationId,
        observation: judgeObservation(evaluation),
      });
      const started = yield* Effect.result(
        orchestration.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`judge:follow-up:${evaluation.evaluationId}`),
          threadId,
          message: {
            messageId: MessageId.make(`erebus:judge:${evaluation.evaluationId}`),
            role: "user",
            text: message,
            attachments: [],
          },
          runtimeMode: context.thread.runtimeMode,
          interactionMode: "default",
          createdAt: yield* nowIso,
        }),
      );
      if (started._tag === "Failure") {
        yield* Effect.logWarning("Erebus Judge follow-up turn could not start", {
          threadId,
          evaluationId: evaluation.evaluationId,
          cause: started.failure,
        });
        return;
      }
      yield* reviews.markDelivered({
        threadId,
        evaluationId: evaluation.evaluationId,
        deliveredAt: yield* nowIso,
      });
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          deliveriesInFlight.delete(evaluation.evaluationId);
        }),
      ),
    );
  });

  const evaluateFinding = Effect.fn("ResearchSupervisor.evaluateFinding")(function* (
    initial: import("@t3tools/contracts").ResearchFindingReviewRecord,
  ) {
    const key = reviewKey(initial);
    if (inFlight.has(key)) return;
    inFlight.add(key);
    yield* Effect.gen(function* () {
      const current = yield* reviews.get(
        initial.threadId,
        initial.submission.findingId,
        initial.submission.revision,
      );
      if (!current) return;
      const latest = current.evaluations.at(-1);
      if (latest && latest.verdict !== "reviewBlocked") return;
      const context = yield* threadContext(current.threadId);
      if (!context) return;
      const evaluatorModelSelection = buildResearchEvaluatorModelSelection(
        context.thread.modelSelection,
        (yield* serverSettings.getSettings).researchSupervision,
      );
      const assessmentResult = yield* Effect.result(
        evaluator.evaluateJudge({
          cwd: context.cwd,
          modelSelection: evaluatorModelSelection,
          finding: current.submission,
          priorEvaluations: current.evaluations,
        }),
      );
      const evaluatedAt = yield* nowIso;
      const runtime = {
        policyVersion: RESEARCH_INTERNAL_POLICY.version,
        policyDigest: RESEARCH_INTERNAL_POLICY.digest,
        model: evaluatorModelSelection.model,
        reasoningEffort:
          getModelSelectionStringOptionValue(evaluatorModelSelection, "reasoningEffort") ??
          "default",
      } as const;

      const evaluation = yield* Effect.gen(function* () {
        const evaluationId = ResearchEvaluationId.make(yield* uuid);
        if (assessmentResult._tag === "Failure") {
          const detail = assessmentResult.failure.detail;
          return {
            evaluationId,
            findingId: current.submission.findingId,
            findingRevision: current.submission.revision,
            verdict: "reviewBlocked" as const,
            confidence: 1,
            gates: RESEARCH_INTERNAL_POLICY.judgeGates.map((gate) => ({
              gateId: gate.id,
              status: "unknown" as const,
              reason: `The independent Judge did not complete its bounded review. ${detail}`,
              evidence: [],
            })),
            summary: `Review blocked by a harness or evaluator failure. ${detail} No technical verdict exists and the finding remains preserved.`,
            nextAction:
              "Repair the evaluator and retry this same immutable finding revision. Do not change the research conclusion merely to retry the review.",
            cvssV31: null,
            runtime,
            evaluatedAt,
          };
        }

        const rawAssessment = assessmentResult.success;
        const classificationCorrections = judgeCvssClassificationCorrections(rawAssessment);
        const normalized = normalizeIndependentJudgeAssessment(
          RESEARCH_INTERNAL_POLICY.judgeGates,
          canonicalizeIndependentJudgeAssessmentCvss(rawAssessment),
        );
        const consistencyIssues = validateJudgeAssessmentConsistency(normalized);
        const reviewBlocked =
          consistencyIssues.length > 0 ||
          (normalized.evidenceAccess.status === "blocked" &&
            normalized.evidenceAccess.decisionBlocked);
        const gates = reviewBlocked
          ? normalized.gates.map((gate) => ({
              ...gate,
              status: "unknown" as const,
              reason:
                consistencyIssues.length > 0
                  ? `Judge output failed deterministic integrity checks: ${consistencyIssues.join("; ")}`
                  : `Judge evidence access was blocked: ${normalized.evidenceAccess.detail ?? "required evidence was not readable"}`,
            }))
          : normalized.gates;
        const summary = reviewBlocked
          ? consistencyIssues.length > 0
            ? `Review blocked because the Judge output was internally inconsistent: ${consistencyIssues.join("; ")}`
            : "Review blocked because an artifact required for the decision was not readable from the Judge environment."
          : classificationCorrections.length > 0
            ? `${normalized.summary} Ancillary CVSS output was corrected by Erebus: ${classificationCorrections.join("; ")}. This did not affect the technical verdict.`
            : normalized.summary;
        return {
          evaluationId,
          findingId: current.submission.findingId,
          findingRevision: current.submission.revision,
          verdict: reviewBlocked ? ("reviewBlocked" as const) : normalized.verdict,
          confidence: normalized.confidence,
          gates: gates.map((gate) => ({
            gateId: gate.gateId.trim() || "unknown-gate",
            status: gate.status,
            reason: gate.reason.trim() || "No gate rationale was returned.",
            evidence: gate.evidence.map((item) => item.trim()).filter(Boolean),
          })),
          summary: summary.trim() || "The Judge returned no summary.",
          nextAction: reviewBlocked
            ? "Repair evidence access or Judge consistency and retry this same immutable revision."
            : normalized.nextAction?.trim() || null,
          cvssV31: normalized.cvssV31,
          runtime,
          evaluatedAt,
        };
      });

      const recorded = yield* reviews.recordEvaluation({
        projectId: current.projectId,
        threadId: current.threadId,
        evaluation,
      });
      const durableEvaluation = recorded.evaluations.at(-1) ?? evaluation;
      yield* appendJudgeActivity(recorded, durableEvaluation);
      yield* flushThread(recorded.threadId);
    }).pipe(
      Effect.ensuring(Effect.sync(() => inFlight.delete(key))),
      Effect.catch((cause) =>
        Effect.logWarning("Erebus Judge evaluation failed", {
          threadId: initial.threadId,
          findingId: initial.submission.findingId,
          revision: initial.submission.revision,
          cause,
        }),
      ),
    );
  });

  const onOrchestrationEvent = (event: import("@t3tools/contracts").OrchestrationEvent) =>
    Effect.gen(function* () {
      if (event.type !== "thread.session-set") return;
      const payload = yield* decodeSession(event.payload);
      if (!payload.session.activeTurnId) yield* flushThread(payload.threadId);
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Erebus Judge delivery event failed", { eventId: event.eventId, cause }),
      ),
    );

  yield* Effect.forkScoped(
    Stream.runForEach(reviews.reviewRequests, (record) =>
      Effect.forkScoped(evaluateFinding(record)).pipe(Effect.asVoid),
    ),
  );
  yield* Effect.forkScoped(
    Stream.runForEach(orchestration.streamDomainEvents, onOrchestrationEvent),
  );
  yield* Effect.forkScoped(
    Effect.gen(function* () {
      yield* Effect.forEach(yield* reviews.listUnreviewed(), evaluateFinding, {
        concurrency: 2,
        discard: true,
      });
      const pendingThreads = new Set(
        (yield* reviews.listPendingDelivery()).map((record) => record.threadId),
      );
      yield* Effect.forEach(pendingThreads, flushThread, { concurrency: 4, discard: true });
    }).pipe(Effect.catch((cause) => Effect.logWarning("Erebus Judge recovery failed", { cause }))),
  );
});

export const ResearchSupervisorLive = Layer.effectDiscard(makeResearchSupervisor);
