import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

export function createWebRuntimeEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const sessionScheduler = createAtomCommandScheduler();
  const evidenceScheduler = createAtomCommandScheduler();
  const serialPerEnvironment = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  };
  const serialPerSession = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { readonly environmentId: string; input: object }) =>
      JSON.stringify([
        environmentId,
        "sessionId" in input ? input.sessionId : "id" in input ? input.id : null,
      ]),
  };

  return {
    status: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:web-runtime:status",
      tag: WS_METHODS.webRuntimeGetStatus,
      staleTimeMs: 2_000,
      refreshIntervalMs: 5_000,
    }),
    sessions: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:web-runtime:sessions",
      tag: WS_METHODS.webRuntimeListSessions,
      staleTimeMs: 2_000,
    }),
    extensionClients: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:web-runtime:extension-clients",
      tag: WS_METHODS.webRuntimeListExtensionClients,
      staleTimeMs: 500,
    }),
    scopes: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:web-runtime:scopes",
      tag: WS_METHODS.webRuntimeListScopes,
      staleTimeMs: 5_000,
    }),
    scope: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:web-runtime:scope",
      tag: WS_METHODS.webRuntimeGetScope,
      staleTimeMs: 5_000,
    }),
    traffic: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:web-runtime:traffic",
      tag: WS_METHODS.webRuntimeListTraffic,
      staleTimeMs: 1_000,
    }),
    exchange: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:web-runtime:exchange",
      tag: WS_METHODS.webRuntimeGetExchange,
      staleTimeMs: 30_000,
    }),
    body: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:web-runtime:body",
      tag: WS_METHODS.webRuntimeReadBody,
      staleTimeMs: 60_000,
    }),
    webSockets: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:web-runtime:websockets",
      tag: WS_METHODS.webRuntimeListWebSockets,
      staleTimeMs: 1_000,
    }),
    webSocketEvent: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:web-runtime:websocket-event",
      tag: WS_METHODS.webRuntimeGetWebSocket,
      staleTimeMs: 30_000,
    }),
    gaps: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:web-runtime:gaps",
      tag: WS_METHODS.webRuntimeListGaps,
      staleTimeMs: 5_000,
    }),
    map: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:web-runtime:map",
      tag: WS_METHODS.webRuntimeGetMap,
      staleTimeMs: 2_000,
    }),
    neighborhood: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:web-runtime:neighborhood",
      tag: WS_METHODS.webRuntimeGetNeighborhood,
      staleTimeMs: 2_000,
    }),
    annotations: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:web-runtime:annotations",
      tag: WS_METHODS.webRuntimeListAnnotations,
      staleTimeMs: 2_000,
    }),
    annotation: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:web-runtime:annotation",
      tag: WS_METHODS.webRuntimeGetAnnotation,
      staleTimeMs: 5_000,
    }),
    createSession: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:web-runtime:create-session",
      tag: WS_METHODS.webRuntimeCreateSession,
      scheduler: sessionScheduler,
      concurrency: serialPerEnvironment,
    }),
    createExtensionPairing: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:web-runtime:create-extension-pairing",
      tag: WS_METHODS.webRuntimeCreateExtensionPairing,
      scheduler: sessionScheduler,
      concurrency: serialPerSession,
    }),
    invokeExtension: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:web-runtime:invoke-extension",
      tag: WS_METHODS.webRuntimeInvokeExtension,
      scheduler: sessionScheduler,
      concurrency: {
        mode: "serial" as const,
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.producerId, input.tabId ?? null]),
      },
    }),
    endSession: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:web-runtime:end-session",
      tag: WS_METHODS.webRuntimeEndSession,
      scheduler: sessionScheduler,
      concurrency: serialPerSession,
    }),
    deleteSession: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:web-runtime:delete-session",
      tag: WS_METHODS.webRuntimeDeleteSession,
      scheduler: sessionScheduler,
      concurrency: serialPerSession,
    }),
    startProxy: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:web-runtime:start-proxy",
      tag: WS_METHODS.webRuntimeStartProxy,
      scheduler: sessionScheduler,
      concurrency: serialPerSession,
    }),
    stopProxy: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:web-runtime:stop-proxy",
      tag: WS_METHODS.webRuntimeStopProxy,
      scheduler: sessionScheduler,
      concurrency: serialPerSession,
    }),
    saveScope: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:web-runtime:save-scope",
      tag: WS_METHODS.webRuntimeSaveScope,
      scheduler: sessionScheduler,
      concurrency: serialPerEnvironment,
    }),
    updateScope: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:web-runtime:update-scope",
      tag: WS_METHODS.webRuntimeUpdateScope,
      scheduler: sessionScheduler,
      concurrency: serialPerEnvironment,
    }),
    deleteScope: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:web-runtime:delete-scope",
      tag: WS_METHODS.webRuntimeDeleteScope,
      scheduler: sessionScheduler,
      concurrency: serialPerEnvironment,
    }),
    annotate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:web-runtime:annotate",
      tag: WS_METHODS.webRuntimeAnnotate,
      scheduler: evidenceScheduler,
      concurrency: {
        mode: "serial" as const,
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.targetType, input.targetId]),
      },
    }),
    updateAnnotation: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:web-runtime:update-annotation",
      tag: WS_METHODS.webRuntimeUpdateAnnotation,
      scheduler: evidenceScheduler,
      concurrency: {
        mode: "serial" as const,
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.id]),
      },
    }),
    deleteAnnotation: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:web-runtime:delete-annotation",
      tag: WS_METHODS.webRuntimeDeleteAnnotation,
      scheduler: evidenceScheduler,
      concurrency: {
        mode: "serial" as const,
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.id]),
      },
    }),
    replay: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:web-runtime:replay",
      tag: WS_METHODS.webRuntimeReplay,
      scheduler: evidenceScheduler,
      concurrency: {
        mode: "singleFlight" as const,
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.sessionId, input.replayId ?? input.observationId]),
      },
    }),
  };
}
