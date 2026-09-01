import {
  DEFAULT_SERVER_SETTINGS,
  defaultInstanceIdForDriver,
  type CodexAccountRoutingSettings,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import {
  CodexAccountRouter,
  type CodexAccountRouterShape,
} from "../Services/CodexAccountRouter.ts";

const CODEX_DRIVER = ProviderDriverKind.make("codex");
const DEFAULT_CODEX_INSTANCE = defaultInstanceIdForDriver(CODEX_DRIVER);

function isUsableAccount(provider: ServerProvider): boolean {
  return (
    provider.driver === CODEX_DRIVER &&
    provider.enabled &&
    provider.availability !== "unavailable" &&
    provider.auth.status === "authenticated" &&
    provider.status !== "error" &&
    provider.status !== "disabled"
  );
}

function remainingPercent(provider: ServerProvider | undefined): number | undefined {
  return provider?.accountUsage?.remainingPercent;
}

export function selectCodexAccount(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly policy: CodexAccountRoutingSettings;
  readonly activeInstanceId: ProviderInstanceId | null;
}): ProviderInstanceId | null {
  const accounts = input.providers.filter(isUsableAccount);
  if (accounts.length === 0) return null;

  const configuredPrimary = input.policy.primaryInstanceId;
  const primary =
    accounts.find((provider) => provider.instanceId === configuredPrimary) ??
    accounts.find((provider) => provider.instanceId === DEFAULT_CODEX_INSTANCE) ??
    accounts[0]!;
  if (!input.policy.enabled || accounts.length === 1) return primary.instanceId;

  const active =
    accounts.find((provider) => provider.instanceId === input.activeInstanceId) ?? primary;

  const primaryRemaining = remainingPercent(primary);
  const activeRemaining = remainingPercent(active);
  if (active.instanceId === primary.instanceId) {
    if (
      primaryRemaining === undefined ||
      primaryRemaining > input.policy.primarySwitchRemainingPercent
    ) {
      return primary.instanceId;
    }
    return (
      accounts.find(
        (provider) =>
          provider.instanceId !== primary.instanceId &&
          (remainingPercent(provider) ?? -1) > input.policy.fallbackReserveRemainingPercent,
      )?.instanceId ?? primary.instanceId
    );
  }

  if (
    primaryRemaining !== undefined &&
    primaryRemaining > input.policy.primarySwitchRemainingPercent
  ) {
    return primary.instanceId;
  }
  if (
    activeRemaining === undefined ||
    activeRemaining > input.policy.fallbackReserveRemainingPercent
  ) {
    return active.instanceId;
  }
  if (primaryRemaining !== undefined && primaryRemaining > 0) {
    return primary.instanceId;
  }
  return (
    accounts.find(
      (provider) =>
        provider.instanceId !== active.instanceId &&
        provider.instanceId !== primary.instanceId &&
        (remainingPercent(provider) ?? -1) > input.policy.fallbackReserveRemainingPercent,
    )?.instanceId ?? active.instanceId
  );
}

const make = Effect.fn("makeCodexAccountRouter")(function* () {
  const providerRegistry = yield* ProviderRegistry;
  const settingsService = yield* ServerSettingsService;
  const activeInstanceRef = yield* Ref.make<ProviderInstanceId | null>(null);
  const switchLock = yield* Semaphore.make(1);

  const resolveActive = switchLock.withPermits(1)(
    Effect.gen(function* () {
      const [providers, policy, current] = yield* Effect.all([
        providerRegistry.getProviders,
        settingsService.getSettings.pipe(
          Effect.map((settings) => settings.codexAccountRouting),
          Effect.orElseSucceed(() => DEFAULT_SERVER_SETTINGS.codexAccountRouting),
        ),
        Ref.get(activeInstanceRef),
      ]);
      const next = selectCodexAccount({
        providers,
        policy,
        activeInstanceId: current,
      });
      if (next !== current) {
        yield* Ref.set(activeInstanceRef, next);
        yield* Effect.logInfo("Codex account router changed the active account", {
          previousInstanceId: current,
          activeInstanceId: next,
        });
      }
      return next;
    }),
  );

  const resolveModelSelection: CodexAccountRouterShape["resolveModelSelection"] = (selection) =>
    Effect.gen(function* () {
      const providers = yield* providerRegistry.getProviders;
      const requestedProvider = providers.find(
        (provider) => provider.instanceId === selection.instanceId,
      );
      if (requestedProvider?.driver !== CODEX_DRIVER) return selection;
      const activeInstanceId = yield* resolveActive;
      return activeInstanceId === null || activeInstanceId === selection.instanceId
        ? selection
        : ({ ...selection, instanceId: activeInstanceId } satisfies ModelSelection);
    });

  yield* Effect.forkScoped(
    Stream.runForEach(providerRegistry.streamChanges, () => resolveActive.pipe(Effect.asVoid)),
  );
  yield* Effect.forkScoped(
    Stream.runForEach(settingsService.streamChanges, () => resolveActive.pipe(Effect.asVoid)),
  );
  yield* resolveActive;

  return CodexAccountRouter.of({
    resolveModelSelection,
    activeInstanceId: resolveActive,
  });
});

export const CodexAccountRouterLive = Layer.effect(CodexAccountRouter, make());
