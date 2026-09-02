import type { ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as EffectRuntime from "effect/Effect";

export interface CodexAccountRouterShape {
  readonly resolveModelSelection: (selection: ModelSelection) => Effect.Effect<ModelSelection>;
  readonly activeInstanceId: Effect.Effect<ProviderInstanceId | null>;
}

export class CodexAccountRouter extends Context.Reference<CodexAccountRouterShape>(
  "erebus/provider/Services/CodexAccountRouter",
  {
    defaultValue: () => ({
      resolveModelSelection: EffectRuntime.succeed,
      activeInstanceId: EffectRuntime.succeed(null),
    }),
  },
) {}
