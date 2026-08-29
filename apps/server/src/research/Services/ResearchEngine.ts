import type {
  CommandId,
  ProjectId,
  ResearchCampaign,
  ResearchCampaignId,
  ResearchCheckpointInput,
  ResearchContract,
  ResearchEvent,
  ResearchFindingSubmission,
  ResearchIntervention,
  ResearchJudgeEvaluation,
  ResearchObserverEvaluation,
  ResearchToolResult,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";
import type * as Stream from "effect/Stream";

import type { ResearchCampaignStoreError } from "./ResearchCampaignStore.ts";
import type { ResearchProjection } from "../researchState.ts";

export type ResearchCommand =
  | {
      readonly type: "campaign.create";
      readonly commandId: CommandId;
      readonly campaignId: ResearchCampaignId;
      readonly projectId: ProjectId;
      readonly principalThreadId: ThreadId;
      readonly proteusCampaignId: string;
    }
  | {
      readonly type: "contract.register";
      readonly commandId: CommandId;
      readonly campaignId: ResearchCampaignId;
      readonly contract: ResearchContract;
    }
  | {
      readonly type: "campaign.start";
      readonly commandId: CommandId;
      readonly campaignId: ResearchCampaignId;
      readonly contractId: string;
      readonly contractRevision: number;
      readonly proteusReady: boolean;
      readonly dependencyIssues: ReadonlyArray<string>;
    }
  | {
      readonly type: "campaign.control";
      readonly commandId: CommandId;
      readonly campaignId: ResearchCampaignId;
      readonly action: "pause" | "resume" | "finish" | "abort";
      readonly reason: string;
      readonly proteusReady: boolean;
      readonly dependencyIssues: ReadonlyArray<string>;
    }
  | {
      readonly type: "checkpoint.record";
      readonly commandId: CommandId;
      readonly campaignId: ResearchCampaignId;
      readonly checkpoint: ResearchCheckpointInput;
    }
  | {
      readonly type: "finding.submit";
      readonly commandId: CommandId;
      readonly campaignId: ResearchCampaignId;
      readonly finding: ResearchFindingSubmission;
    }
  | {
      readonly type: "principal.message.complete";
      readonly commandId: CommandId;
      readonly campaignId: ResearchCampaignId;
      readonly messageItemId: MessageId;
      readonly text: string;
      readonly turnId: import("@t3tools/contracts").TurnId | null;
    }
  | {
      readonly type: "observer.evaluation.record";
      readonly commandId: CommandId;
      readonly campaignId: ResearchCampaignId;
      readonly evaluation: ResearchObserverEvaluation;
      readonly windowEndMessageCount: number;
    }
  | {
      readonly type: "judge.evaluation.record";
      readonly commandId: CommandId;
      readonly campaignId: ResearchCampaignId;
      readonly evaluation: ResearchJudgeEvaluation;
    }
  | {
      readonly type: "intervention.record";
      readonly commandId: CommandId;
      readonly campaignId: ResearchCampaignId;
      readonly intervention: ResearchIntervention;
    };

export interface ResearchDispatchResult {
  readonly replayed: boolean;
  readonly event: ResearchEvent | null;
  readonly projection: ResearchProjection;
  readonly result: ResearchToolResult;
}

export type ResearchEngineError = ResearchCampaignStoreError | PlatformError.PlatformError;

export interface ResearchEngineShape {
  readonly dispatch: (
    command: ResearchCommand,
  ) => Effect.Effect<ResearchDispatchResult, ResearchEngineError>;
  readonly findProjection: (
    campaignId: ResearchCampaignId,
  ) => Effect.Effect<ResearchProjection | null, ResearchEngineError>;
  readonly findProjectionByThread: (
    threadId: ThreadId,
  ) => Effect.Effect<ResearchProjection | null, ResearchEngineError>;
  readonly listProjections: () => Effect.Effect<
    ReadonlyArray<ResearchProjection>,
    ResearchEngineError
  >;
  readonly events: Stream.Stream<ResearchEvent>;
  readonly drain: Effect.Effect<void>;
}

export class ResearchEngine extends Context.Service<ResearchEngine, ResearchEngineShape>()(
  "erebus/research/Services/ResearchEngine",
) {}

export type { ResearchCampaign };
