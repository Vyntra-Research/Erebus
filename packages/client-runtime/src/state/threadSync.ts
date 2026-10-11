import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/**
 * Client state for the optional Git-backed thread mirror.
 *
 * Mutations share one serial lane per environment. This prevents a manual
 * pull, push, or relink from racing the periodic fetch performed by the
 * server, while keeping separate environments independent.
 */
export function createThreadSyncEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  };

  return {
    getStatus: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:thread-sync:get-status",
      tag: WS_METHODS.threadSyncGetStatus,
      staleTimeMs: 5_000,
      idleTtlMs: 5 * 60_000,
    }),
    status: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:thread-sync:status",
      tag: WS_METHODS.subscribeThreadSyncStatus,
      idleTtlMs: 5 * 60_000,
    }),
    configure: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:thread-sync:configure",
      tag: WS_METHODS.threadSyncConfigure,
      scheduler,
      concurrency,
    }),
    fetch: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:thread-sync:fetch",
      tag: WS_METHODS.threadSyncFetch,
      scheduler,
      concurrency,
    }),
    linkProject: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:thread-sync:link-project",
      tag: WS_METHODS.threadSyncLinkProject,
      scheduler,
      concurrency,
    }),
    disconnect: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:thread-sync:disconnect",
      tag: WS_METHODS.threadSyncDisconnect,
      scheduler,
      concurrency,
    }),
    pull: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:thread-sync:pull",
      tag: WS_METHODS.threadSyncPull,
      scheduler,
      concurrency,
    }),
    push: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:thread-sync:push",
      tag: WS_METHODS.threadSyncPush,
      scheduler,
      concurrency,
    }),
  };
}
