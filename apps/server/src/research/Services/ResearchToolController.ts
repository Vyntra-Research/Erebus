import type { ProjectId, ResearchProteusHealth, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as CodexSchema from "effect-codex-app-server/schema";

export interface ResearchToolContext {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly proteus: ResearchProteusHealth;
}

export type ResearchInstructionContext = Omit<ResearchToolContext, "proteus">;

export interface ResearchToolControllerShape {
  readonly principalInstructions: (context: ResearchInstructionContext) => Effect.Effect<string>;
  readonly handle: (
    context: ResearchToolContext,
    params: CodexSchema.DynamicToolCallParams,
  ) => Effect.Effect<CodexSchema.DynamicToolCallResponse>;
}

export class ResearchToolController extends Context.Reference<
  ResearchToolControllerShape | undefined
>("erebus/research/Services/ResearchToolController", { defaultValue: () => undefined }) {}
