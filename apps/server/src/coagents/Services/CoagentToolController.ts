import type { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as CodexSchema from "effect-codex-app-server/schema";

export interface CoagentToolContext {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly cwd: string;
}

export interface CoagentToolControllerShape {
  readonly instructions: (context: CoagentToolContext) => Effect.Effect<string>;
  readonly handle: (
    context: CoagentToolContext,
    params: CodexSchema.DynamicToolCallParams,
  ) => Effect.Effect<CodexSchema.DynamicToolCallResponse>;
}

export class CoagentToolController extends Context.Reference<
  CoagentToolControllerShape | undefined
>("erebus/coagents/Services/CoagentToolController", { defaultValue: () => undefined }) {}
