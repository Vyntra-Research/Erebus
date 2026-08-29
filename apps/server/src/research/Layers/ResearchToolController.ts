import {
  CommandId,
  ResearchCampaignRefInput,
  ResearchCampaignCloseInput,
  ResearchCheckpointInput,
  ResearchCreateCampaignInput,
  ResearchRegisterContractInput,
  ResearchStartInput,
  ResearchSubmitFindingInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ServerSettingsService } from "../../serverSettings.ts";
import { ResearchEngine } from "../Services/ResearchEngine.ts";
import { ResearchToolController } from "../Services/ResearchToolController.ts";
import { ProteusBridge } from "../Services/ProteusBridge.ts";
import { buildPrincipalResearchInstructions } from "../researchPrincipalInstructions.ts";
import { canonicalContractDigest, canonicalizeFindingCvss } from "../researchIntegrity.ts";
import { researchObserverPolicyFromSettings } from "../researchPolicy.ts";
import { isErebusResearchToolCall, toDynamicToolResponse } from "../researchTools.ts";

const decoders = {
  create_campaign: Schema.decodeUnknownEffect(ResearchCreateCampaignInput),
  get_status: Schema.decodeUnknownEffect(ResearchCampaignRefInput),
  register_contract: Schema.decodeUnknownEffect(ResearchRegisterContractInput),
  start: Schema.decodeUnknownEffect(ResearchStartInput),
  checkpoint: Schema.decodeUnknownEffect(ResearchCheckpointInput),
  pause: Schema.decodeUnknownEffect(ResearchCampaignRefInput),
  resume: Schema.decodeUnknownEffect(ResearchCampaignRefInput),
  finish: Schema.decodeUnknownEffect(ResearchCampaignCloseInput),
  abort: Schema.decodeUnknownEffect(ResearchCampaignCloseInput),
  submit_finding: Schema.decodeUnknownEffect(ResearchSubmitFindingInput),
  revise_finding: Schema.decodeUnknownEffect(ResearchSubmitFindingInput),
} as const;

const failure = (message: string, issues: ReadonlyArray<string> = []) =>
  toDynamicToolResponse({ accepted: false, status: "rejected", message, issues });

type FindingToolName = "submit_finding" | "revise_finding";

const findingSubmissionFailure = (
  tool: FindingToolName,
  message: string,
  issues: ReadonlyArray<string> = [],
) => {
  const qualifiedTool = `research.${tool}` as const;
  return toDynamicToolResponse({
    accepted: false,
    status: "rejected",
    message: `SUBMISSION NOT RECORDED — NO JUDGE JOB CREATED. ${message} Correct every listed issue and retry ${qualifiedTool} with the same findingId and revision. Do not claim the finding is submitted or pending.`,
    issues,
    retry: {
      required: true,
      tool: qualifiedTool,
      mode: "sameFindingRevision",
      instruction: `Correct every listed issue, then call ${qualifiedTool} again with the same findingId and revision.`,
    },
  });
};

const proteusNumericId = (value: string): number | null => {
  const match = value.trim().match(/^[A-Za-z]?([1-9]\d*)$/);
  if (!match?.[1]) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

const isTerminalCampaignStatus = (status: string): boolean =>
  status === "completed" || status === "aborted";

const makeResearchToolController = Effect.gen(function* () {
  const engine = yield* ResearchEngine;
  const proteusBridge = yield* ProteusBridge;
  const serverSettings = yield* ServerSettingsService;

  const resolveProteusCampaign = Effect.fn("ResearchToolController.resolveProteusCampaign")(
    function* (
      context: import("../Services/ResearchToolController.ts").ResearchToolContext,
      id: string,
    ) {
      if (!proteusBridge) return null;
      return yield* Effect.result(proteusBridge.resolveCampaign(context.cwd, id));
    },
  );

  const campaignProteusRoot = Effect.fn("ResearchToolController.campaignProteusRoot")(function* (
    context: import("../Services/ResearchToolController.ts").ResearchToolContext,
    campaign: import("@t3tools/contracts").ResearchCampaign,
  ) {
    if (campaign.proteusRoot) return { root: campaign.proteusRoot, issues: [] } as const;
    const result = yield* resolveProteusCampaign(context, campaign.proteusCampaignId);
    return !result
      ? ({ root: null, issues: ["Proteus validation bridge is unavailable"] } as const)
      : result._tag === "Success"
        ? ({ root: result.success.root, issues: [] } as const)
        : ({ root: null, issues: [result.failure.detail] } as const);
  });

  const validateProteusBranch = Effect.fn("ResearchToolController.validateProteusBranch")(
    function* (root: string, id: string, campaignId: string) {
      if (!proteusBridge) return ["Proteus validation bridge is unavailable"];
      const result = yield* Effect.result(proteusBridge.readBranch(root, id));
      if (result._tag === "Failure") return [result.failure.detail];
      const expectedCampaignId = proteusNumericId(campaignId);
      return result.success.campaignId === expectedCampaignId
        ? []
        : [`Proteus branch ${id} is not linked to campaign ${campaignId}.`];
    },
  );

  const validateProteusCheckpoint = Effect.fn("ResearchToolController.validateProteusCheckpoint")(
    function* (root: string, id: string, campaignId: string) {
      if (!proteusBridge) return ["Proteus validation bridge is unavailable"];
      const result = yield* Effect.result(proteusBridge.readCheckpoint(root, id));
      if (result._tag === "Failure") return [result.failure.detail];
      const expectedCampaignId = proteusNumericId(campaignId);
      return result.success.campaignId === expectedCampaignId
        ? []
        : [`Proteus checkpoint ${id} is not linked to campaign ${campaignId}.`];
    },
  );

  const campaignBelongsToContext = Effect.fn("ResearchToolController.campaignBelongsToContext")(
    function* (
      campaignId: import("@t3tools/contracts").ResearchCampaignId,
      context: import("../Services/ResearchToolController.ts").ResearchToolContext,
    ) {
      const projection = yield* engine.findProjection(campaignId);
      const campaign = projection?.campaign;
      return (
        campaign !== null &&
        campaign !== undefined &&
        campaign.projectId === context.projectId &&
        campaign.principalThreadId === context.threadId
      );
    },
  );

  return {
    principalInstructions: (context) =>
      engine.findProjectionByThread(context.threadId).pipe(
        Effect.map((projection) => buildPrincipalResearchInstructions(projection)),
        Effect.catch((cause) =>
          Effect.logWarning("Failed to read Erebus campaign context.", {
            threadId: context.threadId,
            cause,
          }).pipe(Effect.as(buildPrincipalResearchInstructions(null))),
        ),
      ),
    handle: (context, params) =>
      Effect.gen(function* () {
        if (!isErebusResearchToolCall(params)) {
          return failure("Unknown Erebus research tool.", [params.tool]);
        }

        const commandId = CommandId.make(`dynamic:${context.threadId}:${params.callId}`);
        switch (params.tool) {
          case "create_campaign": {
            const input = yield* decoders.create_campaign(params.arguments);
            const existingThreadCampaign = yield* engine.findProjectionByThread(context.threadId);
            if (
              existingThreadCampaign?.campaign?.id === input.campaignId &&
              existingThreadCampaign.campaign.proteusCampaignId === input.proteusCampaignId
            ) {
              const replayed = yield* engine.dispatch({
                type: "campaign.create",
                commandId,
                campaignId: input.campaignId,
                projectId: context.projectId,
                principalThreadId: context.threadId,
                proteusCampaignId: input.proteusCampaignId,
                proteusRoot: existingThreadCampaign.campaign.proteusRoot ?? context.cwd,
              });
              return toDynamicToolResponse(replayed.result);
            }
            if (
              existingThreadCampaign?.campaign &&
              existingThreadCampaign.campaign.id !== input.campaignId &&
              !isTerminalCampaignStatus(existingThreadCampaign.campaign.status)
            ) {
              return failure("This thread already owns a Erebus campaign.", [
                existingThreadCampaign.campaign.id,
              ]);
            }
            const existingProteusCampaign = (yield* engine.listProjections()).find(
              (projection) =>
                projection.campaign?.proteusCampaignId === input.proteusCampaignId &&
                projection.campaign.status !== "completed" &&
                projection.campaign.status !== "aborted",
            )?.campaign;
            if (existingProteusCampaign && existingProteusCampaign.id !== input.campaignId) {
              return failure("The Proteus campaign is already linked to an active Erebus run.", [
                existingProteusCampaign.id,
              ]);
            }
            const proteusResult = yield* resolveProteusCampaign(context, input.proteusCampaignId);
            if (!proteusResult) {
              return failure("The Proteus campaign link could not be verified.", [
                "Proteus validation bridge is unavailable",
              ]);
            }
            if (proteusResult._tag === "Failure") {
              return failure("The Proteus campaign link could not be verified.", [
                proteusResult.failure.detail,
              ]);
            }
            const dispatched = yield* engine.dispatch({
              type: "campaign.create",
              commandId,
              campaignId: input.campaignId,
              projectId: context.projectId,
              principalThreadId: context.threadId,
              proteusCampaignId: input.proteusCampaignId,
              proteusRoot: proteusResult.success.root,
            });
            return toDynamicToolResponse(dispatched.result);
          }
          case "get_status": {
            const input = yield* decoders.get_status(params.arguments);
            const projection = yield* engine.findProjection(input.campaignId);
            const campaign = projection?.campaign;
            if (!projection || !campaign) {
              return failure("The campaign does not exist.", ["campaign not found"]);
            }
            if (
              campaign.projectId !== context.projectId ||
              campaign.principalThreadId !== context.threadId
            ) {
              return failure("The campaign is not owned by this project thread.", [
                "campaign context mismatch",
              ]);
            }
            const queuedInterventions = projection.interventions.filter(
              (intervention) =>
                intervention.status === "queued" || intervention.status === "queuedWhilePaused",
            ).length;
            const activeContract = projection.contracts.find(
              (contract) =>
                contract.id === campaign.activeContractId &&
                contract.revision === campaign.activeContractRevision,
            );
            const judgeDecisions = projection.judgeEvaluations
              .map(
                (evaluation) =>
                  `${evaluation.findingId}@${evaluation.findingRevision ?? 1}:${evaluation.verdict}[${evaluation.evaluationId}]`,
              )
              .join(", ");
            return toDynamicToolResponse({
              accepted: true,
              status: campaign.status,
              message: [
                `Campaign ${campaign.id} is ${campaign.status}.`,
                activeContract
                  ? `Active contract: ${activeContract.id} revision ${activeContract.revision}, digest ${activeContract.digest}.`
                  : "No contract is active.",
                `Observer messages: ${campaign.lastObservedMessageCount}/${campaign.eligibleMessageCount}.`,
                `Findings: ${projection.findings.length}; judge reviews: ${projection.judgeEvaluations.length}.`,
                `Judge decisions: ${judgeDecisions || "none"}.`,
                `Queued steering: ${queuedInterventions}.`,
              ].join(" "),
              issues: [],
            });
          }
          case "register_contract": {
            const input = yield* decoders.register_contract(params.arguments);
            if (!(yield* campaignBelongsToContext(input.campaignId, context))) {
              return failure("The campaign is not owned by this project thread.", [
                "campaign context mismatch",
              ]);
            }
            const observerPolicy = researchObserverPolicyFromSettings(
              (yield* serverSettings.getSettings).researchSupervision,
            );
            const contractWithoutDigest = {
              ...input.contract,
              observerPolicy,
            };
            const contract = {
              ...contractWithoutDigest,
              digest: canonicalContractDigest(contractWithoutDigest),
            };
            const dispatched = yield* engine.dispatch({
              type: "contract.register",
              commandId,
              campaignId: input.campaignId,
              contract,
            });
            return toDynamicToolResponse(
              dispatched.result.accepted
                ? {
                    ...dispatched.result,
                    message: `${dispatched.result.message} Canonical digest: ${contract.digest}.`,
                  }
                : dispatched.result,
            );
          }
          case "start": {
            const input = yield* decoders.start(params.arguments);
            if (!(yield* campaignBelongsToContext(input.campaignId, context))) {
              return failure("The campaign is not owned by this project thread.", [
                "campaign context mismatch",
              ]);
            }
            const dependencyEntries = Object.entries(context.proteus).filter(([key]) =>
              ["runtime", "plugin", "skills", "mcp"].includes(key),
            );
            const dependencyIssues = dependencyEntries
              .filter(([, value]) => value !== "ready")
              .map(([key, value]) => `Proteus ${key} is ${String(value)}`);
            const projection = yield* engine.findProjection(input.campaignId);
            if (projection?.campaign) {
              const linked = yield* campaignProteusRoot(context, projection.campaign);
              dependencyIssues.push(...linked.issues);
              if (linked.root && proteusBridge) {
                const validated = yield* Effect.result(
                  proteusBridge.readCampaign(linked.root, projection.campaign.proteusCampaignId),
                );
                if (validated._tag === "Failure") dependencyIssues.push(validated.failure.detail);
              }
            }
            const dispatched = yield* engine.dispatch({
              type: "campaign.start",
              commandId,
              campaignId: input.campaignId,
              contractId: input.contractId,
              contractRevision: input.contractRevision,
              proteusReady: dependencyIssues.length === 0,
              dependencyIssues,
            });
            return toDynamicToolResponse(dispatched.result);
          }
          case "checkpoint": {
            const input = yield* decoders.checkpoint(params.arguments);
            if (!(yield* campaignBelongsToContext(input.campaignId, context))) {
              return failure("The campaign is not owned by this project thread.", [
                "campaign context mismatch",
              ]);
            }
            const projection = yield* engine.findProjection(input.campaignId);
            const campaign = projection?.campaign;
            if (!campaign) {
              return failure("The campaign does not have a Proteus campaign link.");
            }
            const linked = yield* campaignProteusRoot(context, campaign);
            if (!linked.root) {
              return failure("The Proteus campaign root could not be resolved.", linked.issues);
            }
            const proteusIssues = yield* validateProteusCheckpoint(
              linked.root,
              input.proteusCheckpointId,
              campaign.proteusCampaignId,
            );
            if (proteusIssues.length > 0) {
              return failure("The Proteus checkpoint link could not be verified.", proteusIssues);
            }
            const dispatched = yield* engine.dispatch({
              type: "checkpoint.record",
              commandId,
              campaignId: input.campaignId,
              checkpoint: input,
            });
            return toDynamicToolResponse(dispatched.result);
          }
          case "pause":
          case "resume":
          case "finish":
          case "abort": {
            const input = yield* decoders[params.tool](params.arguments);
            if (!(yield* campaignBelongsToContext(input.campaignId, context))) {
              return failure("The campaign is not owned by this project thread.", [
                "campaign context mismatch",
              ]);
            }
            const dependencyEntries = Object.entries(context.proteus).filter(([key]) =>
              ["runtime", "plugin", "skills", "mcp"].includes(key),
            );
            const dependencyIssues = dependencyEntries
              .filter(([, value]) => value !== "ready")
              .map(([key, value]) => `Proteus ${key} is ${String(value)}`);
            const projection = yield* engine.findProjection(input.campaignId);
            const campaign = projection?.campaign;
            const reason =
              "reason" in input && typeof input.reason === "string"
                ? input.reason
                : params.tool === "pause"
                  ? "Paused by the principal research agent."
                  : "Resumed by the principal research agent.";
            if (params.tool === "finish" && campaign?.status === "completed") {
              const replayed = yield* engine.dispatch({
                type: "campaign.control",
                commandId,
                campaignId: input.campaignId,
                action: params.tool,
                reason,
                proteusReady: dependencyIssues.length === 0,
                dependencyIssues,
              });
              return toDynamicToolResponse(replayed.result);
            }
            if (params.tool === "finish") {
              if (!campaign) return failure("The campaign does not exist.", ["campaign not found"]);
              if (!["active", "paused"].includes(campaign.status)) {
                return failure("Campaign finish was rejected.", [
                  `cannot finish a ${campaign.status} campaign`,
                ]);
              }
              const latestFindings = [...projection.findings]
                .toReversed()
                .filter(
                  (finding, index, all) =>
                    all.findIndex((candidate) => candidate.findingId === finding.findingId) ===
                    index,
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
              if (pendingJudgeCount > 0) {
                return failure("Campaign finish was rejected.", [
                  `${pendingJudgeCount} finding(s) still await judge review`,
                ]);
              }
              const linked = yield* campaignProteusRoot(context, campaign);
              if (!linked.root || !proteusBridge) {
                return failure(
                  "Proteus could not be completed; the Erebus campaign remains open.",
                  linked.issues.length > 0
                    ? linked.issues
                    : ["Proteus validation bridge is unavailable"],
                );
              }
              const completed = yield* Effect.result(
                proteusBridge.completeCampaign(linked.root, campaign.proteusCampaignId, reason),
              );
              if (completed._tag === "Failure") {
                return failure(
                  "Proteus could not be completed; the Erebus campaign remains open.",
                  [completed.failure.detail],
                );
              }
            }
            const dispatched = yield* engine.dispatch({
              type: "campaign.control",
              commandId,
              campaignId: input.campaignId,
              action: params.tool,
              reason,
              proteusReady: dependencyIssues.length === 0,
              dependencyIssues,
            });
            return toDynamicToolResponse(dispatched.result);
          }
          case "submit_finding":
          case "revise_finding": {
            const input = yield* decoders[params.tool](params.arguments);
            if (!(yield* campaignBelongsToContext(input.campaignId, context))) {
              return findingSubmissionFailure(
                params.tool,
                "The campaign is not owned by this project thread.",
                ["campaign context mismatch"],
              );
            }
            const projection = yield* engine.findProjection(input.campaignId);
            const campaign = projection?.campaign;
            if (!campaign) {
              return findingSubmissionFailure(
                params.tool,
                "The campaign does not have a Proteus campaign link.",
              );
            }
            const linked = yield* campaignProteusRoot(context, campaign);
            if (!linked.root) {
              return findingSubmissionFailure(
                params.tool,
                "The Proteus campaign root could not be resolved.",
                linked.issues,
              );
            }
            const proteusIssues = yield* validateProteusBranch(
              linked.root,
              input.proteusBranchId,
              campaign.proteusCampaignId,
            );
            if (proteusIssues.length > 0) {
              return findingSubmissionFailure(
                params.tool,
                "The Proteus branch link could not be verified.",
                proteusIssues,
              );
            }
            const dispatched = yield* engine.dispatch({
              type: "finding.submit",
              commandId,
              campaignId: input.campaignId,
              finding: canonicalizeFindingCvss(input),
            });
            return dispatched.result.accepted
              ? toDynamicToolResponse(dispatched.result)
              : findingSubmissionFailure(
                  params.tool,
                  dispatched.result.message,
                  dispatched.result.issues,
                );
          }
        }
        return failure("Unknown Erebus research tool.", [params.tool]);
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Erebus research tool call failed", {
            tool: params.tool,
            threadId: params.threadId,
            cause,
          }).pipe(
            Effect.as(
              params.tool === "submit_finding" || params.tool === "revise_finding"
                ? findingSubmissionFailure(params.tool, "The finding payload failed validation.", [
                    cause instanceof Error ? cause.message : String(cause),
                  ])
                : failure("The research command could not be accepted.", [
                    cause instanceof Error ? cause.message : String(cause),
                  ]),
            ),
          ),
        ),
      ),
  } satisfies import("../Services/ResearchToolController.ts").ResearchToolControllerShape;
});

export const ResearchToolControllerLive = Layer.effect(
  ResearchToolController,
  makeResearchToolController,
);
