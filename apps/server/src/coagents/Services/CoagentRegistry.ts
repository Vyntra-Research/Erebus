import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ResearchCampaignId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export const CoagentThreadLink = Schema.Struct({
  childThreadId: ThreadId,
  parentThreadId: ThreadId,
  projectId: ProjectId,
  assignment: Schema.String,
  creationMode: Schema.Literals(["blank", "fork"]),
  status: Schema.Literals(["preparing", "ready", "failed", "released"]),
  error: Schema.NullOr(Schema.String),
  observerCampaignId: Schema.NullOr(ResearchCampaignId),
  observerMessageCount: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CoagentThreadLink = typeof CoagentThreadLink.Type;

export interface CoagentRegistryShape {
  readonly reserve: (
    link: CoagentThreadLink,
    maxActiveChildren: number,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly upsert: (link: CoagentThreadLink) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getByChild: (
    childThreadId: ThreadId,
  ) => Effect.Effect<Option.Option<CoagentThreadLink>, ProjectionRepositoryError>;
  readonly listByParent: (
    parentThreadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<CoagentThreadLink>, ProjectionRepositoryError>;
  readonly setObserverCursor: (input: {
    readonly childThreadId: ThreadId;
    readonly campaignId: ResearchCampaignId;
    readonly messageCount: number;
    readonly updatedAt: IsoDateTime;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class CoagentRegistry extends Context.Service<CoagentRegistry, CoagentRegistryShape>()(
  "erebus/coagents/Services/CoagentRegistry",
) {}
