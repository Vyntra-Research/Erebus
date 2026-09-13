import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { CodexAccountRouter } from "../../provider/Services/CodexAccountRouter.ts";
import * as ProviderInstanceRegistry from "../../provider/Services/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import {
  describeResearchEvaluatorFailure,
  isResearchEvaluatorQuotaFailure,
  JudgeAssessment,
  ResearchEvaluator,
  ResearchEvaluatorError,
} from "../Services/ResearchEvaluator.ts";
import { RESEARCH_INTERNAL_POLICY } from "../researchPolicy.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const makeResearchEvaluator = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const providerRegistry = yield* ProviderRegistry;
  const accountRouter = yield* CodexAccountRouter;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const buildArtifactManifest = Effect.fn("ResearchEvaluator.artifactManifest")(function* (
    cwd: string,
    finding: import("@t3tools/contracts").ResearchFindingReviewSubmission,
  ) {
    return yield* Effect.forEach(
      [finding.findingPath, finding.pocPath].filter((value): value is string => value !== null),
      (relativePath) => {
        const resolvedPath = path.resolve(cwd, relativePath);
        return fileSystem.stat(resolvedPath).pipe(
          Effect.map((info) => ({
            relativePath,
            resolvedPath,
            exists: true,
            kind: info.type.toLowerCase(),
            size: info.type === "File" ? Number(info.size) : null,
          })),
          Effect.orElseSucceed(() => ({
            relativePath,
            resolvedPath,
            exists: false,
            kind: null,
            size: null,
          })),
        );
      },
      { concurrency: 2 },
    );
  });

  const generate = Effect.fn("ResearchEvaluator.generate")(function* <
    S extends import("effect/Schema").Top,
  >(input: {
    readonly cwd: string;
    readonly modelSelection: import("@t3tools/contracts").ModelSelection;
    readonly prompt: string;
    readonly schema: S;
  }) {
    const generateWithSelection = (modelSelection: import("@t3tools/contracts").ModelSelection) =>
      Effect.gen(function* () {
        const instance = yield* registry.getInstance(modelSelection.instanceId);
        const generateStructured = instance?.textGeneration.generateStructured;
        if (!generateStructured) {
          return yield* new ResearchEvaluatorError({
            operation: "judge",
            detail: "The selected provider does not support isolated structured evaluation.",
          });
        }
        return yield* generateStructured({
          cwd: input.cwd,
          prompt: input.prompt,
          outputSchema: input.schema,
          modelSelection,
          timeoutMs: RESEARCH_INTERNAL_POLICY.judgeReviewBudgetSeconds * 1_000,
        }).pipe(
          Effect.mapError(
            (cause) =>
              new ResearchEvaluatorError({
                operation: "judge",
                detail: describeResearchEvaluatorFailure(cause.message),
              }),
          ),
        );
      });

    const routedSelection = yield* accountRouter.resolveModelSelection(input.modelSelection);
    const firstAttempt = yield* Effect.result(generateWithSelection(routedSelection));
    if (firstAttempt._tag === "Success") return firstAttempt.success;
    if (!isResearchEvaluatorQuotaFailure(firstAttempt.failure.detail)) {
      return yield* firstAttempt.failure;
    }

    yield* providerRegistry.refreshInstance(routedSelection.instanceId);
    const retrySelection = yield* accountRouter.resolveModelSelection(input.modelSelection);
    if (retrySelection.instanceId === routedSelection.instanceId) {
      return yield* firstAttempt.failure;
    }
    yield* Effect.logInfo("Research evaluator rerouted after Codex quota exhaustion", {
      previousInstanceId: routedSelection.instanceId,
      activeInstanceId: retrySelection.instanceId,
    });
    return yield* generateWithSelection(retrySelection);
  });

  return ResearchEvaluator.of({
    evaluateJudge: (input) =>
      Effect.gen(function* () {
        const artifactManifest = yield* buildArtifactManifest(input.cwd, input.finding);
        const environmentJson = encodeJson({
          workspaceRoot: input.cwd,
          filesystemMode: "read-only",
          reviewMode: "bounded-artifact-audit",
          wallClockBudgetSeconds: RESEARCH_INTERNAL_POLICY.judgeReviewBudgetSeconds,
          outputReserveSeconds: RESEARCH_INTERNAL_POLICY.judgeOutputReserveSeconds,
          practicalRevalidationAllowed: false,
          artifactManifest,
          proteusReadPolicy:
            "Legacy Proteus access is optional and read-only. Use only exposed query or record-reading tools for one directly cited fact. Never mutate state and never load Proteus skills.",
          argosPolicy:
            "Do not require Argos access and do not mutate Argos. The delivered finding and PoC must stand on their own.",
        });
        return yield* generate({
          cwd: input.cwd,
          modelSelection: input.modelSelection,
          schema: JudgeAssessment,
          prompt: `${RESEARCH_INTERNAL_POLICY.judgeInstructions}\n\nJUDGE ENVIRONMENT:\n${environmentJson}\n\nFIXED EREBUS GATES:\n${encodeJson(RESEARCH_INTERNAL_POLICY.judgeGates)}\n\nThe manifest is a path-discovery aid, not evidence. Read the finding document and inspect only the bounded PoC material needed to check its claims. Do not ask for a ZIP, hash, report bundle, or alternate path. If the delivery lacks a material fact, decide the matching gate from that absence instead of searching for substitute evidence.\n\nPRIOR REVIEW AUDIT:\n${encodeJson(input.priorEvaluations)}\n\nPrior evaluations are audit context, not authoritative verdicts. A reviewBlocked entry records evaluator failure and must not count against the immutable submission.\n\nFINDING HANDOFF:\n${encodeJson(input.finding)}`,
        });
      }),
  });
});

export const ResearchEvaluatorLive = Layer.effect(ResearchEvaluator, makeResearchEvaluator);
