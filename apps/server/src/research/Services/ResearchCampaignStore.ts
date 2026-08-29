import type {
  CommandId,
  ResearchCampaignId,
  ResearchEvent,
  ResearchToolResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { PersistenceDecodeError, PersistenceSqlError } from "../../persistence/Errors.ts";
import type { ResearchProjection } from "../researchState.ts";

export type ResearchCampaignStoreError = PersistenceSqlError | PersistenceDecodeError;

export interface ResearchCampaignCommit {
  readonly commandId: CommandId;
  readonly event: ResearchEvent;
  readonly projection: ResearchProjection;
  readonly result: ResearchToolResult;
}

export interface ResearchCampaignCommitResult {
  readonly replayed: boolean;
  readonly event: ResearchEvent;
  readonly projection: ResearchProjection;
  readonly result: ResearchToolResult;
}

export interface ResearchCampaignStoreShape {
  readonly findReceipt: (
    commandId: CommandId,
  ) => Effect.Effect<ResearchCampaignCommitResult | null, ResearchCampaignStoreError>;
  readonly findProjection: (
    campaignId: ResearchCampaignId,
  ) => Effect.Effect<ResearchProjection | null, ResearchCampaignStoreError>;
  readonly findProjectionByThread: (
    threadId: string,
  ) => Effect.Effect<ResearchProjection | null, ResearchCampaignStoreError>;
  readonly listProjections: () => Effect.Effect<
    ReadonlyArray<ResearchProjection>,
    ResearchCampaignStoreError
  >;
  readonly commit: (
    input: ResearchCampaignCommit,
  ) => Effect.Effect<ResearchCampaignCommitResult, ResearchCampaignStoreError>;
}

export class ResearchCampaignStore extends Context.Service<
  ResearchCampaignStore,
  ResearchCampaignStoreShape
>()("erebus/research/Services/ResearchCampaignStore") {}
