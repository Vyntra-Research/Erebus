import type { ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as EffectRuntime from "effect/Effect";

export interface CodexAccountRouterShape {
  readonly resolveModelSelection: (selection: ModelSelection) => Effect.Effect<ModelSelection>;
  /**
   * Marks one Codex account as quota-exhausted and selects another compatible
   * account for an immediate continuation. Returns null when routing is
   * disabled or no other authenticated account is usable.
   */
  readonly failoverAfterUsageLimit: (
    selection: ModelSelection,
    exhaustedInstanceId: ProviderInstanceId,
  ) => Effect.Effect<ModelSelection | null>;
  readonly activeInstanceId: Effect.Effect<ProviderInstanceId | null>;
}

export class CodexAccountRouter extends Context.Reference<CodexAccountRouterShape>(
  "erebus/provider/Services/CodexAccountRouter",
  {
    defaultValue: () => ({
      resolveModelSelection: EffectRuntime.succeed,
      failoverAfterUsageLimit: () => EffectRuntime.succeed(null),
      activeInstanceId: EffectRuntime.succeed(null),
    }),
  },
) {}
