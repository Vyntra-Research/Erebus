import { ResearchEventId, ResearchContractId, ResearchToolResult } from "@t3tools/contracts";
import { validateContractRegistration, validateFindingSubmission } from "../researchIntegrity.ts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { ResearchCampaignStore } from "../Services/ResearchCampaignStore.ts";
import {
  ResearchEngine,
  type ResearchCommand,
  type ResearchDispatchResult,
  type ResearchEngineError,
} from "../Services/ResearchEngine.ts";
import { emptyResearchProjection, replayResearchEvents } from "../researchState.ts";

interface CommandEnvelope {
  readonly kind: "command";
  readonly command: ResearchCommand;
  readonly result: Deferred.Deferred<ResearchDispatchResult, ResearchEngineError>;
}

interface DrainEnvelope {
  readonly kind: "drain";
  readonly result: Deferred.Deferred<void>;
}

type ResearchQueueEnvelope = CommandEnvelope | DrainEnvelope;

const accepted = (message: string): ResearchToolResult => ({
  accepted: true,
  status: "accepted",
  message,
  issues: [],
});

const rejected = (message: string, issues: ReadonlyArray<string>): ResearchToolResult => ({
  accepted: false,
  status: "rejected",
  message,
  issues,
});

function decideResearchCommand(
  command: ResearchCommand,
  projection: ReturnType<typeof emptyResearchProjection>,
  recordedAt: string,
  eventId: string,
) {
  const envelope = {
    eventId: ResearchEventId.make(eventId),
    campaignId: command.campaignId,
    sequence: projection.lastSequence + 1,
    recordedAt,
  } as const;

  switch (command.type) {
    case "campaign.create": {
      if (projection.campaign) {
        return {
          result: rejected("The campaign already exists.", ["campaignId is already registered"]),
        } as const;
      }
      return {
        event: {
          ...envelope,
          type: "campaign.created",
          campaign: {
            id: command.campaignId,
            projectId: command.projectId,
            principalThreadId: command.principalThreadId,
            observerThreadId: null,
            judgeThreadId: null,
            proteusCampaignId: command.proteusCampaignId,
            activeContractId: null,
            activeContractRevision: null,
            status: "draft",
            eligibleMessageCount: 0,
            lastObservedMessageCount: 0,
            createdAt: recordedAt,
            updatedAt: recordedAt,
          },
        },
        result: accepted("Campaign created and linked to Proteus."),
      } as const;
    }
    case "contract.register": {
      if (!projection.campaign) {
        return { result: rejected("Create the campaign first.", ["campaign not found"]) } as const;
      }
      if (command.contract.proteusCampaignId !== projection.campaign.proteusCampaignId) {
        return {
          result: rejected("The contract must use the linked Proteus campaign.", [
            "proteusCampaignId mismatch",
          ]),
        } as const;
      }
      const contractIssues = validateContractRegistration(command.contract, projection.contracts);
      if (contractIssues.length > 0) {
        return {
          result: rejected("The contract revision is invalid.", [...contractIssues]),
        } as const;
      }
      return {
        event: { ...envelope, type: "contract.registered", contract: command.contract },
        result: accepted("Contract revision registered."),
      } as const;
    }
    case "campaign.start": {
      const contract = projection.contracts.find(
        (candidate) =>
          candidate.id === command.contractId && candidate.revision === command.contractRevision,
      );
      const issues = [
        ...(!contract ? ["contract revision is not registered"] : []),
        ...(!command.proteusReady ? command.dependencyIssues : []),
      ];
      if (issues.length > 0) {
        return { result: rejected("Research monitoring did not start.", issues) } as const;
      }
      return {
        event: {
          ...envelope,
          type: "campaign.started",
          contractId: ResearchContractId.make(command.contractId),
          contractRevision: command.contractRevision,
        },
        result: accepted("Research monitoring started."),
      } as const;
    }
    case "campaign.control": {
      const campaign = projection.campaign;
      if (!campaign) {
        return {
          result: rejected("The campaign does not exist.", ["campaign not found"]),
        } as const;
      }
      const latestFindings = [...projection.findings]
        .toReversed()
        .filter(
          (finding, index, all) =>
            all.findIndex((candidate) => candidate.findingId === finding.findingId) === index,
        );
      const pendingJudgeCount = latestFindings.filter((finding) => {
        const evaluation = [...projection.judgeEvaluations]
          .toReversed()
          .find(
            (candidate) =>
              candidate.findingId === finding.findingId &&
              (candidate.findingRevision ?? 1) === (finding.revision ?? 1),
          );
        return !evaluation || evaluation.verdict === "reviewBlocked";
      }).length;
      const targetStatus =
        command.action === "pause"
          ? ("paused" as const)
          : command.action === "resume"
            ? ("active" as const)
            : command.action === "finish"
              ? ("completed" as const)
              : ("aborted" as const);
      const allowed =
        command.action === "pause"
          ? campaign.status === "active"
          : command.action === "resume"
            ? ["paused", "blockedDependency", "recovering"].includes(campaign.status)
            : command.action === "finish"
              ? ["active", "paused"].includes(campaign.status)
              : !["completed", "aborted"].includes(campaign.status);
      const issues = [
        ...(!allowed ? [`cannot ${command.action} a ${campaign.status} campaign`] : []),
        ...(command.action === "resume" && !command.proteusReady ? command.dependencyIssues : []),
        ...(command.action === "resume" && !campaign.activeContractId
          ? ["no active contract revision"]
          : []),
        ...(command.action === "finish" && pendingJudgeCount > 0
          ? [`${pendingJudgeCount} finding(s) still await judge review`]
          : []),
      ];
      if (issues.length > 0) {
        return { result: rejected(`Campaign ${command.action} was rejected.`, issues) } as const;
      }
      return {
        event: {
          ...envelope,
          type: "campaign.statusChanged",
          status: targetStatus,
          reason: command.reason,
        },
        result: accepted(`Campaign is now ${targetStatus}.`),
      } as const;
    }
    case "checkpoint.record":
      return {
        event: { ...envelope, type: "checkpoint.recorded", checkpoint: command.checkpoint },
        result: accepted("Checkpoint recorded."),
      } as const;
    case "finding.submit": {
      const campaign = projection.campaign;
      const contract = projection.contracts.find(
        (candidate) =>
          candidate.id === campaign?.activeContractId &&
          candidate.revision === campaign.activeContractRevision,
      );
      const issues = [
        ...(!campaign || campaign.status !== "active" ? ["campaign is not active"] : []),
        ...(!contract ? ["active contract was not found"] : []),
        ...(contract
          ? validateFindingSubmission(
              contract,
              command.finding,
              projection.findings,
              projection.judgeEvaluations,
            )
          : []),
      ];
      if (issues.length > 0) {
        return { result: rejected("The finding submission is invalid.", issues) } as const;
      }
      return {
        event: { ...envelope, type: "finding.submitted", finding: command.finding },
        result: accepted(
          "Finding submitted for independent Judge review. End this turn now; do not poll or wait. Erebus will start a separate follow-up turn when the durable verdict is ready.",
        ),
      } as const;
    }
    case "principal.message.complete":
      return {
        event: {
          ...envelope,
          type: "principal.messageCompleted",
          messageItemId: command.messageItemId,
          text: command.text,
          turnId: command.turnId,
        },
        result: accepted("Principal message recorded."),
      } as const;
    case "observer.evaluation.record":
      return {
        event: {
          ...envelope,
          type: "observer.evaluationRecorded",
          evaluation: command.evaluation,
          windowEndMessageCount: command.windowEndMessageCount,
        },
        result: accepted("Observer evaluation recorded."),
      } as const;
    case "judge.evaluation.record":
      return {
        event: {
          ...envelope,
          type: "judge.evaluationRecorded",
          evaluation: command.evaluation,
        },
        result: accepted("Judge evaluation recorded."),
      } as const;
    case "intervention.record":
      return {
        event: {
          ...envelope,
          type: "intervention.recorded",
          intervention: command.intervention,
        },
        result: accepted("Intervention recorded."),
      } as const;
  }
}

const makeResearchEngine = Effect.gen(function* () {
  const store = yield* ResearchCampaignStore;
  const crypto = yield* Crypto.Crypto;
  const queue = yield* Queue.unbounded<ResearchQueueEnvelope>();
  const events = yield* PubSub.unbounded<import("@t3tools/contracts").ResearchEvent>();

  const processEnvelope = (envelope: CommandEnvelope) =>
    Effect.gen(function* () {
      const existing = yield* store.findReceipt(envelope.command.commandId);
      if (existing) {
        return yield* Deferred.succeed(envelope.result, existing);
      }
      const current =
        (yield* store.findProjection(envelope.command.campaignId)) ?? emptyResearchProjection();
      const now = DateTime.formatIso(yield* DateTime.now);
      const eventId = yield* crypto.randomUUIDv4;
      const decision = decideResearchCommand(envelope.command, current, now, eventId);
      if (!("event" in decision)) {
        return yield* Deferred.succeed(envelope.result, {
          replayed: false,
          event: null,
          projection: current,
          result: decision.result,
        });
      }

      const event = decision.event;
      const replayed = replayResearchEvents([event], current);
      if (!replayed.ok) {
        return yield* Deferred.succeed(envelope.result, {
          replayed: false,
          event,
          projection: current,
          result: rejected("The command violated campaign state.", [replayed.reason]),
        });
      }
      const stored = yield* store.commit({
        commandId: envelope.command.commandId,
        event,
        projection: replayed.state,
        result: decision.result,
      });
      if (!stored.replayed) yield* PubSub.publish(events, event);
      return yield* Deferred.succeed(envelope.result, stored);
    }).pipe(Effect.catch((error) => Deferred.fail(envelope.result, error)));

  const processQueueEnvelope = (envelope: ResearchQueueEnvelope) =>
    envelope.kind === "drain"
      ? Deferred.succeed(envelope.result, undefined).pipe(Effect.asVoid)
      : processEnvelope(envelope);

  yield* Effect.forkScoped(
    Effect.forever(Queue.take(queue).pipe(Effect.flatMap(processQueueEnvelope))),
  );

  const dispatch = (command: ResearchCommand) =>
    Effect.gen(function* () {
      const result = yield* Deferred.make<ResearchDispatchResult, ResearchEngineError>();
      yield* Queue.offer(queue, { kind: "command", command, result });
      return yield* Deferred.await(result);
    });

  const drain = Effect.gen(function* () {
    const result = yield* Deferred.make<void>();
    yield* Queue.offer(queue, { kind: "drain", result });
    yield* Deferred.await(result);
  });

  return ResearchEngine.of({
    dispatch,
    findProjection: store.findProjection,
    findProjectionByThread: (threadId) => store.findProjectionByThread(threadId),
    listProjections: store.listProjections,
    events: Stream.fromPubSub(events),
    drain,
  });
});

export const ResearchEngineLive = Layer.effect(ResearchEngine, makeResearchEngine);
