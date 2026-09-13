import { IsoDateTime, ProjectId, ThreadId } from "@t3tools/contracts";
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
}

export class CoagentRegistry extends Context.Service<CoagentRegistry, CoagentRegistryShape>()(
  "erebus/coagents/Services/CoagentRegistry",
) {}
