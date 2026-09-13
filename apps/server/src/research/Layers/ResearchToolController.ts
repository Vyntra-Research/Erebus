import {
  CommandId,
  ResearchFindingId,
  ResearchSubmitFindingForReviewInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { CoagentRegistry } from "../../coagents/Services/CoagentRegistry.ts";
import { FindingReviewStore } from "../Services/FindingReviewStore.ts";
import { ResearchToolController } from "../Services/ResearchToolController.ts";
import {
  buildCoagentResearchInstructions,
  buildPrincipalResearchInstructions,
} from "../researchPrincipalInstructions.ts";
import { isErebusResearchToolCall, toDynamicToolResponse } from "../researchTools.ts";

const StatusInput = Schema.Struct({
  findingId: Schema.optional(ResearchFindingId),
});

const decoders = {
  get_status: Schema.decodeUnknownEffect(StatusInput),
  submit_finding: Schema.decodeUnknownEffect(ResearchSubmitFindingForReviewInput),
  revise_finding: Schema.decodeUnknownEffect(ResearchSubmitFindingForReviewInput),
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
    message: `SUBMISSION NOT QUEUED — NO JUDGE JOB CREATED. ${message}`,
    issues,
    retry: {
      required: true,
      tool: qualifiedTool,
      mode: "sameFindingRevision",
      instruction: `Correct the listed input issue, then retry ${qualifiedTool} with the same findingId and revision.`,
    },
  });
};

const isContained = (path: Path.Path, root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

const makeResearchToolController = Effect.gen(function* () {
  const reviews = yield* FindingReviewStore;
  const coagents = yield* CoagentRegistry;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const validateArtifact = Effect.fn("ResearchToolController.validateArtifact")(function* (
    cwd: string,
    value: string,
    rootName: "findings" | "pocs",
    expectedKind: "file" | "file-or-directory",
  ) {
    if (path.isAbsolute(value)) {
      return `${rootName} artifact path must be workspace-relative`;
    }
    const workspaceRoot = yield* fileSystem.realPath(cwd);
    const expectedRoot = path.resolve(workspaceRoot, rootName);
    const candidate = path.resolve(workspaceRoot, value);
    if (!isContained(path, expectedRoot, candidate)) {
      return `artifact must be located under ${rootName}/`;
    }
    const canonicalCandidate = yield* fileSystem.realPath(candidate).pipe(Effect.option);
    if (Option.isNone(canonicalCandidate)) {
      return `artifact does not exist: ${value}`;
    }
    const canonicalRoot = yield* fileSystem.realPath(expectedRoot).pipe(Effect.option);
    if (
      Option.isNone(canonicalRoot) ||
      !isContained(path, canonicalRoot.value, canonicalCandidate.value)
    ) {
      return `artifact resolves outside ${rootName}/`;
    }
    const info = yield* fileSystem.stat(canonicalCandidate.value);
    if (expectedKind === "file" && info.type !== "File") {
      return `${rootName} artifact must be a file`;
    }
    if (expectedKind === "file-or-directory" && info.type !== "File" && info.type !== "Directory") {
      return `${rootName} artifact must be a file or directory`;
    }
    return null;
  });

  return ResearchToolController.of({
    principalInstructions: (context) =>
      Effect.gen(function* () {
        const link = yield* coagents
          .getByChild(context.threadId)
          .pipe(Effect.map(Option.getOrNull));
        if (link) {
          return buildCoagentResearchInstructions(link.assignment, link.parentThreadId);
        }
        return buildPrincipalResearchInstructions(yield* reviews.listByThread(context.threadId));
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Failed to read Erebus Judge context.", {
            threadId: context.threadId,
            cause,
          }).pipe(Effect.as(buildPrincipalResearchInstructions())),
        ),
      ),
    handle: (context, params) =>
      Effect.gen(function* () {
        if (!isErebusResearchToolCall(params)) {
          return failure("Unknown Erebus research tool.", [params.tool]);
        }

        const coagentLink = yield* coagents
          .getByChild(context.threadId)
          .pipe(Effect.map(Option.getOrNull));
        if (coagentLink && params.tool !== "get_status") {
          return failure(
            "A co-agent cannot submit a finding to the Judge. Return the candidate to the parent task.",
            [`parentThreadId=${coagentLink.parentThreadId}`, `tool=research.${params.tool}`],
          );
        }

        switch (params.tool) {
          case "get_status": {
            const input = yield* decoders.get_status(params.arguments);
            const ownerThreadId = coagentLink?.parentThreadId ?? context.threadId;
            const records = yield* reviews.listByThread(ownerThreadId, input.findingId);
            if (records.length === 0) {
              return toDynamicToolResponse({
                accepted: true,
                status: "empty",
                message: input.findingId
                  ? `No Judge submission exists for ${input.findingId}.`
                  : "No finding has been submitted to the Judge from this task.",
                issues: [],
              });
            }
            const states = records.map((record) => {
              const evaluation = record.evaluations.at(-1);
              return evaluation
                ? `${record.submission.findingId}@${record.submission.revision}: ${evaluation.verdict} [${evaluation.evaluationId}] — ${evaluation.summary}`
                : `${record.submission.findingId}@${record.submission.revision}: pending Judge review`;
            });
            return toDynamicToolResponse({
              accepted: true,
              status: records.some((record) => record.evaluations.length === 0)
                ? "pending"
                : "reviewed",
              message: states.join("\n"),
              issues: [],
            });
          }
          case "submit_finding":
          case "revise_finding": {
            const input = yield* decoders[params.tool](params.arguments);
            if (params.tool === "submit_finding" && input.revision !== 1) {
              return findingSubmissionFailure(
                params.tool,
                "submit_finding accepts revision 1 only.",
              );
            }
            if (params.tool === "revise_finding" && input.revision === 1) {
              return findingSubmissionFailure(
                params.tool,
                "Revision 1 must use research.submit_finding.",
              );
            }

            const artifactIssues = (yield* Effect.all([
              validateArtifact(context.cwd, input.findingPath, "findings", "file"),
              input.pocPath
                ? validateArtifact(context.cwd, input.pocPath, "pocs", "file-or-directory")
                : Effect.succeed(null),
            ])).filter((issue): issue is string => issue !== null);
            if (artifactIssues.length > 0) {
              return findingSubmissionFailure(
                params.tool,
                "One or more Judge artifacts are invalid or unreadable.",
                artifactIssues,
              );
            }

            const submittedAt = DateTime.formatIso(yield* DateTime.now);
            const result = yield* reviews.submit({
              commandId: CommandId.make(`dynamic:${context.threadId}:${params.callId}`),
              projectId: context.projectId,
              threadId: context.threadId,
              submission: { ...input, submittedAt },
            });
            if (!result.reviewRequested) {
              const evaluation = result.record.evaluations.at(-1);
              return toDynamicToolResponse({
                accepted: false,
                status: "alreadyReviewed",
                message: evaluation
                  ? `Finding ${input.findingId} revision ${input.revision} already has verdict ${evaluation.verdict} [${evaluation.evaluationId}]. No new Judge job was created.`
                  : "No new Judge job was created.",
                issues: [],
              });
            }
            return toDynamicToolResponse({
              accepted: true,
              status: "pendingJudge",
              message: `Finding ${input.findingId} revision ${input.revision} is durable and queued for independent Judge review. End this turn now; Erebus will deliver the verdict in a separate follow-up turn.`,
              issues: [],
            });
          }
          default:
            return failure("Unknown Erebus research tool.", [params.tool]);
        }
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Erebus Judge tool call failed", {
            tool: params.tool,
            threadId: params.threadId,
            cause,
          }).pipe(
            Effect.as(
              params.tool === "submit_finding" || params.tool === "revise_finding"
                ? findingSubmissionFailure(
                    params.tool,
                    cause instanceof Error ? cause.message : String(cause),
                  )
                : failure("The Judge status could not be read.", [
                    cause instanceof Error ? cause.message : String(cause),
                  ]),
            ),
          ),
        ),
      ),
  });
});

export const ResearchToolControllerLive = Layer.effect(
  ResearchToolController,
  makeResearchToolController,
);
