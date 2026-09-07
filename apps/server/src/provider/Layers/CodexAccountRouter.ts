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
    provider.accountUsage?.reached !== true &&
    provider.status !== "error" &&
    provider.status !== "disabled"
  );
}

function remainingPercent(provider: ServerProvider | undefined): number | undefined {
  return provider?.accountUsage?.remainingPercent;
}

function hasRemainingQuota(provider: ServerProvider): boolean {
  const remaining = remainingPercent(provider);
  return provider.accountUsage?.reached !== true && (remaining === undefined || remaining > 0);
}

export function selectCodexAccount(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly policy: CodexAccountRoutingSettings;
  readonly activeInstanceId: ProviderInstanceId | null;
  readonly exhaustedInstanceIds?: ReadonlySet<ProviderInstanceId>;
}): ProviderInstanceId | null {
  const accounts = input.providers.filter(
    (provider) =>
      isUsableAccount(provider) && !input.exhaustedInstanceIds?.has(provider.instanceId),
  );
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

export function selectCodexFailoverAccount(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly policy: CodexAccountRoutingSettings;
  readonly exhaustedInstanceIds: ReadonlySet<ProviderInstanceId>;
}): ProviderInstanceId | null {
  if (!input.policy.enabled) return null;
  const accounts = input.providers.filter(
    (provider) =>
      isUsableAccount(provider) &&
      !input.exhaustedInstanceIds.has(provider.instanceId) &&
      hasRemainingQuota(provider),
  );
  if (accounts.length === 0) return null;

  const configuredPrimary = input.policy.primaryInstanceId;
  const primary =
    accounts.find((provider) => provider.instanceId === configuredPrimary) ??
    accounts.find((provider) => provider.instanceId === DEFAULT_CODEX_INSTANCE);
  if (primary) return primary.instanceId;

  return (
    accounts.find(
      (provider) =>
        remainingPercent(provider) === undefined ||
        (remainingPercent(provider) ?? 0) > input.policy.fallbackReserveRemainingPercent,
    )?.instanceId ?? accounts[0]!.instanceId
  );
}

const make = Effect.fn("makeCodexAccountRouter")(function* () {
  const providerRegistry = yield* ProviderRegistry;
  const settingsService = yield* ServerSettingsService;
  const activeInstanceRef = yield* Ref.make<ProviderInstanceId | null>(null);
  const exhaustedInstancesRef = yield* Ref.make(new Map<ProviderInstanceId, string | undefined>());
  const switchLock = yield* Semaphore.make(1);

  const reconcileRecoveredAccounts = (
    providers: ReadonlyArray<ServerProvider>,
    exhausted: ReadonlyMap<ProviderInstanceId, string | undefined>,
  ) => {
    const next = new Map(exhausted);
    for (const [instanceId, failedSnapshotAt] of exhausted) {
      const provider = providers.find((candidate) => candidate.instanceId === instanceId);
      const hasNewSnapshot =
        provider !== undefined &&
        provider.checkedAt !== failedSnapshotAt &&
        Date.parse(provider.checkedAt) > Date.parse(failedSnapshotAt ?? "");
      if (provider && hasNewSnapshot && hasRemainingQuota(provider)) {
        next.delete(instanceId);
      }
    }
    return next;
  };

  const resolveActive = switchLock.withPermits(1)(
    Effect.gen(function* () {
      const [providers, policy, current, recordedExhausted] = yield* Effect.all([
        providerRegistry.getProviders,
        settingsService.getSettings.pipe(
          Effect.map((settings) => settings.codexAccountRouting),
          Effect.orElseSucceed(() => DEFAULT_SERVER_SETTINGS.codexAccountRouting),
        ),
        Ref.get(activeInstanceRef),
        Ref.get(exhaustedInstancesRef),
      ]);
      const exhausted = reconcileRecoveredAccounts(providers, recordedExhausted);
      if (exhausted.size !== recordedExhausted.size) {
        yield* Ref.set(exhaustedInstancesRef, exhausted);
      }
      const next = selectCodexAccount({
        providers,
        policy,
        activeInstanceId: current,
        exhaustedInstanceIds: new Set(exhausted.keys()),
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

  const failoverAfterUsageLimit: CodexAccountRouterShape["failoverAfterUsageLimit"] = (
    selection,
    exhaustedInstanceId,
  ) =>
    switchLock.withPermits(1)(
      Effect.gen(function* () {
        const [providers, policy, recordedExhausted] = yield* Effect.all([
          providerRegistry.getProviders,
          settingsService.getSettings.pipe(
            Effect.map((settings) => settings.codexAccountRouting),
            Effect.orElseSucceed(() => DEFAULT_SERVER_SETTINGS.codexAccountRouting),
          ),
          Ref.get(exhaustedInstancesRef),
        ]);
        const exhaustedProvider = providers.find(
          (provider) => provider.instanceId === exhaustedInstanceId,
        );
        if (exhaustedProvider?.driver !== CODEX_DRIVER) return null;

        const exhausted = new Map(recordedExhausted);
        exhausted.set(exhaustedInstanceId, exhaustedProvider.checkedAt);
        yield* Ref.set(exhaustedInstancesRef, exhausted);

        const next = selectCodexFailoverAccount({
          providers,
          policy,
          exhaustedInstanceIds: new Set(exhausted.keys()),
        });
        if (next === null || next === exhaustedInstanceId) return null;
        yield* Ref.set(activeInstanceRef, next);
        yield* Effect.logWarning("Codex account router failed over after a usage limit", {
          exhaustedInstanceId,
          activeInstanceId: next,
        });
        return { ...selection, instanceId: next } satisfies ModelSelection;
      }),
    );

  yield* Effect.forkScoped(
    Stream.runForEach(providerRegistry.streamChanges, () => resolveActive.pipe(Effect.asVoid)),
  );
  yield* Effect.forkScoped(
    Stream.runForEach(settingsService.streamChanges, () => resolveActive.pipe(Effect.asVoid)),
  );
  yield* resolveActive;

  return CodexAccountRouter.of({
    resolveModelSelection,
    failoverAfterUsageLimit,
    activeInstanceId: resolveActive,
  });
});

export const CodexAccountRouterLive = Layer.effect(CodexAccountRouter, make());
