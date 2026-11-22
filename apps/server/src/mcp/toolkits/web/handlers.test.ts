import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  PreviewAutomationNoAvailableHostError,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as WebRuntimeClient from "../../../webRuntime/WebRuntimeClient.ts";
import { WebToolkitHandlersLive } from "./handlers.ts";
import { WebToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment-web-mcp-test");
const threadId = ThreadId.make("thread-web-mcp-test");
const invocation = {
  environmentId,
  threadId,
  providerSessionId: "provider-session-web-mcp-test",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["web"] as const),
  issuedAt: 1,
};
const browserInvocation: McpInvocationContext.McpInvocationScope = {
  ...invocation,
  capabilities: new Set(["web", "preview"]),
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "web-mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

interface RuntimeCall {
  readonly path: string;
  readonly request?: WebRuntimeClient.WebRuntimeRequest;
}

interface PreviewCall {
  readonly operation: PreviewAutomationBroker.PreviewAutomationInvokeInput["operation"];
  readonly input: unknown;
}

const previewProfile = {
  id: "profile-1",
  name: "Account A",
  isDefault: false,
  createdAt: "2026-11-20T12:00:00.000Z",
  updatedAt: "2026-11-20T12:00:00.000Z",
};

const makePreviewBroker = (
  invoke: (
    request: PreviewAutomationBroker.PreviewAutomationInvokeInput,
  ) => Effect.Effect<unknown, PreviewAutomationError>,
) =>
  PreviewAutomationBroker.PreviewAutomationBroker.of({
    connect: () => Effect.die("unused"),
    focusHost: () => Effect.void,
    respond: () => Effect.void,
    invoke: <A>(request: PreviewAutomationBroker.PreviewAutomationInvokeInput) =>
      invoke(request) as Effect.Effect<A, PreviewAutomationError>,
  });

const successfulPreviewBroker = (calls: Array<PreviewCall>) =>
  makePreviewBroker((request) =>
    Effect.sync(() => {
      calls.push({ operation: request.operation, input: request.input });
      switch (request.operation) {
        case "browserProfileSelect":
          return { profile: previewProfile, tabId: null };
        case "browserProfilesList":
          return { profiles: [previewProfile] };
        case "browserProfileProxy":
          return { profileId: previewProfile.id, configured: true };
        case "webRuntimeReachability":
          return { local: true };
        default:
          throw new Error(`Unexpected preview operation ${request.operation}`);
      }
    }),
  );

const makeRuntime = (calls: Array<RuntimeCall>) => {
  let sessionEnded = false;
  return WebRuntimeClient.WebRuntimeClient.of({
    health: Effect.die("unused"),
    connection: Effect.succeed({
      baseUrl: "http://127.0.0.1:4555",
      protocolVersion: 1,
      schemaVersion: 1,
    }),
    requestText: (path, request) =>
      Effect.sync(() => {
        calls.push({ path, ...(request === undefined ? {} : { request }) });
        return "ok";
      }),
    requestJson: (path, request) =>
      Effect.sync(() => {
        calls.push({ path, ...(request === undefined ? {} : { request }) });
        if (path.endsWith("/end") && request?.method === "POST") sessionEnded = true;
        const captureSession = {
          id: "session/1",
          label: "Agent capture",
          source: "agent",
          startedAt: "2026-11-20T12:00:00.000Z",
          endedAt: sessionEnded ? "2026-11-20T12:10:00.000Z" : null,
          scopeProfileId: "scope/1",
          upstreamTlsMode: "verify",
          proxy:
            path.endsWith("/proxy/stop") || sessionEnded
              ? null
              : {
                  url: "http://127.0.0.1:4444",
                  caEndpoint: "/v1/proxy/ca",
                  upstreamTlsMode: "verify",
                },
        };
        if (path === "/v1/sessions" && request === undefined) return [captureSession];
        if (path === "/v1/sessions/session%2F1" && request === undefined) return captureSession;
        if (path.startsWith("/v1/sessions?")) return captureSession;
        if (path.endsWith("/pairing") && request?.method === "POST") {
          return { token: "extension-pairing-token" };
        }
        if (
          path.endsWith("/proxy/start") ||
          path.endsWith("/proxy/stop") ||
          path.endsWith("/end")
        ) {
          return captureSession;
        }
        if (path === "/v1/sessions/session%2F1" && request?.method === "DELETE") {
          return { id: "session/1", observations: 3, websocketEvents: 2 };
        }
        const scopeProfile = {
          id: "scope/1",
          name: "Target",
          version: 1,
          createdAt: "2026-11-20T12:00:00.000Z",
          updatedAt: "2026-11-20T12:00:00.000Z",
          rules: [
            {
              id: "rule-1",
              action: "include",
              matcher: "host",
              pattern: "api.example.test",
              enabled: true,
              orderIndex: 0,
            },
          ],
        };
        if (path === "/v1/scope" && request === undefined) return [scopeProfile];
        if (path === "/v1/scope" && request?.method === "POST") return { id: "scope/1" };
        if (path === "/v1/scope/scope%2F1" && request?.method === "PUT") return scopeProfile;
        if (path.startsWith("/v1/traffic?")) return { items: [], nextCursor: null };
        if (path === "/v1/traffic/exchange%2F1") {
          return {
            summary: {
              id: "exchange/1",
              capturedAt: "2026-11-20T12:00:00.000Z",
              method: "GET",
              url: "https://api.example.test/items",
              host: "api.example.test",
              path: "/items",
              status: 200,
              durationMs: 12,
              scope: "in_scope",
              requestBodySize: 0,
              responseBodySize: 4,
            },
            requestHeaders: [],
            responseHeaders: [],
            requestBody: null,
            responseBody: null,
            error: null,
            metadata: {},
          };
        }
        if (path === "/v1/bodies/sha%2F256") {
          return {
            hash: "sha/256",
            dataBase64: "dGVzdA==",
            mime: "text/plain",
            capturedSize: 4,
            storedSize: 4,
            codec: "identity",
          };
        }
        if (path.startsWith("/v1/map?")) return { nodes: [] };
        if (path.startsWith("/v1/map/node%2F1?")) return { nodes: [], edges: [] };
        if (path.startsWith("/v1/gaps?")) {
          return [
            {
              id: "gap-1",
              sessionId: "session-1",
              source: "proxy",
              droppedEvents: 2,
              reason: "backpressure",
              observedAt: "2026-11-20T12:00:00.000Z",
            },
          ];
        }
        if (path.startsWith("/v1/websockets?")) return { items: [], nextCursor: null };
        if (path === "/v1/websockets/event%2F1") {
          return {
            summary: {
              id: "event/1",
              connectionId: "connection-1",
              capturedAt: "2026-11-20T12:00:00.000Z",
              kind: "frame",
              direction: "server_to_client",
              opcode: 1,
              url: "wss://api.example.test/socket",
              subprotocol: null,
              connectionState: "open",
              closeCode: null,
              closeReason: null,
              scope: "in_scope",
              payloadSize: 4,
              payloadOriginalSize: 4,
              error: null,
            },
            payload: {
              state: "complete",
              reason: null,
              capturedSize: 4,
              originalSize: 4,
              mime: "text/plain",
              textPreview: "ping",
              hash: "ws/hash",
            },
          };
        }
        if (
          path === "/v1/annotations" ||
          path.startsWith("/v1/annotations?") ||
          path === "/v1/annotations/annotation%2F1"
        ) {
          const annotation = {
            id: "annotation-1",
            targetType: "observation",
            targetId: "exchange-1",
            body: "Check auth boundary",
            tags: ["auth"],
            createdAt: "2026-11-20T12:00:00.000Z",
            updatedAt: "2026-11-20T12:00:00.000Z",
          };
          return request === undefined ? [annotation] : annotation;
        }
        if (path === "/v1/replay") {
          return {
            replayId: "replay-1",
            observationId: "exchange-2",
            status: 200,
            error: null,
          };
        }
        return { nodes: [] };
      }),
  });
};

const makeBrowserCaptureRuntime = (
  calls: Array<RuntimeCall>,
  options: {
    readonly failProxyStop?: boolean;
    readonly nullProxyOnCreate?: boolean;
    readonly nullProxyOnRead?: boolean;
  } = {},
) => {
  const activeSession = {
    id: "browser-session-1",
    label: "Browser capture",
    source: "browser:profile-1",
    startedAt: "2026-11-20T12:00:00.000Z",
    endedAt: null,
    scopeProfileId: "scope-1",
    upstreamTlsMode: "verify",
    proxy: {
      url: "http://127.0.0.1:4777",
      caEndpoint: "/v1/proxy/ca",
      upstreamTlsMode: "verify",
    },
  } as const;
  return WebRuntimeClient.WebRuntimeClient.of({
    health: Effect.die("unused"),
    connection: Effect.succeed({
      baseUrl: "http://127.0.0.1:4555",
      protocolVersion: 1,
      schemaVersion: 1,
    }),
    requestText: (path, request) =>
      Effect.sync(() => {
        calls.push({ path, ...(request === undefined ? {} : { request }) });
        return "trusted-ca-pem";
      }),
    requestJson: (path, request) => {
      calls.push({ path, ...(request === undefined ? {} : { request }) });
      if (options.failProxyStop && path.endsWith("/proxy/stop")) {
        return Effect.fail(new WebRuntimeClient.WebRuntimeRequestFailed({ path, status: 500 }));
      }
      return Effect.sync(() => {
        if (path === "/v1/sessions" && request === undefined) return [];
        if (path === "/v1/sessions?proxy=true" && request?.method === "POST") {
          const source =
            typeof request.body === "object" &&
            request.body !== null &&
            "source" in request.body &&
            typeof request.body.source === "string"
              ? request.body.source
              : activeSession.source;
          return {
            ...activeSession,
            source,
            proxy: options.nullProxyOnCreate ? null : activeSession.proxy,
          };
        }
        if (path === "/v1/sessions/browser-session-1") {
          return options.nullProxyOnRead ? { ...activeSession, proxy: null } : activeSession;
        }
        if (path.endsWith("/proxy/stop")) return { ...activeSession, proxy: null };
        if (path.endsWith("/end")) {
          return { ...activeSession, endedAt: "2026-11-20T12:10:00.000Z", proxy: null };
        }
        return activeSession;
      });
    },
  });
};

const makeTestLayer = (
  runtime: WebRuntimeClient.WebRuntimeClient["Service"],
  previewBroker?: PreviewAutomationBroker.PreviewAutomationBroker["Service"],
) => {
  const layer = McpServer.toolkit(WebToolkit).pipe(
    Layer.provide(WebToolkitHandlersLive),
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(Layer.succeed(WebRuntimeClient.WebRuntimeClient, runtime)),
  );
  return previewBroker === undefined
    ? layer
    : layer.pipe(
        Layer.provideMerge(
          Layer.succeed(PreviewAutomationBroker.PreviewAutomationBroker, previewBroker),
        ),
      );
};

const callTool = (
  name: string,
  args: Record<string, unknown>,
  scope: McpInvocationContext.McpInvocationScope = invocation,
) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

it.effect("forwards compact searches and write operations to the runtime contract", () => {
  const calls: Array<RuntimeCall> = [];
  return Effect.gen(function* () {
    const search = yield* callTool("web_traffic_search", {
      host: "api.example.test",
      method: "POST",
      status: 401,
      limit: 25,
    });
    expect(search.isError).toBe(false);
    expect(search.structuredContent).toEqual({ items: [], nextCursor: null });

    const exchange = yield* callTool("web_exchange_get", { id: "exchange/1" });
    expect(exchange.isError).toBe(false);
    expect(exchange.structuredContent).toMatchObject({ summary: { id: "exchange/1" } });

    const body = yield* callTool("web_body_get", { hash: "sha/256" });
    expect(body.isError).toBe(false);
    expect(body.structuredContent).toMatchObject({ hash: "sha/256", dataBase64: "dGVzdA==" });

    const map = yield* callTool("web_map_query", {
      sessionId: "session-1",
      kind: "parameter",
      text: "redirect",
      limit: 10,
      inScopeOnly: true,
    });
    expect(map.isError).toBe(false);

    const neighborhood = yield* callTool("web_map_neighborhood", {
      id: "node/1",
      sessionId: "session-1",
      scope: "in_scope",
      inScopeOnly: true,
    });
    expect(neighborhood.isError).toBe(false);

    const gaps = yield* callTool("web_capture_gaps", {
      sessionId: "session-1",
      limit: 10,
    });
    expect(gaps.isError).toBe(false);
    expect(gaps.structuredContent).toMatchObject({
      gaps: [{ id: "gap-1", droppedEvents: 2 }],
    });

    const websockets = yield* callTool("web_websocket_search", {
      sessionId: "session-1",
      url: "wss://api.example.test/socket",
      direction: "server_to_client",
      limit: 15,
    });
    expect(websockets.isError).toBe(false);

    const websocket = yield* callTool("web_websocket_get", { id: "event/1" });
    expect(websocket.isError).toBe(false);
    expect(websocket.structuredContent).toMatchObject({
      summary: { id: "event/1" },
      payload: { hash: "ws/hash" },
    });

    const annotation = yield* callTool("web_annotate", {
      targetType: "observation",
      targetId: "exchange-1",
      body: "Check auth boundary",
      tags: ["auth"],
    });
    expect(annotation.isError).toBe(false);

    const replay = yield* callTool("web_replay", {
      observationId: "exchange-2",
      sessionId: "session-1",
      method: "PATCH",
      followRedirects: false,
    });
    expect(replay.isError).toBe(false);

    expect(calls).toEqual([
      {
        path: "/v1/traffic?limit=25&host=api.example.test&method=POST&status=401",
      },
      { path: "/v1/traffic/exchange%2F1" },
      { path: "/v1/bodies/sha%2F256" },
      {
        path: "/v1/map?sessionId=session-1&kind=parameter&text=redirect&limit=10&inScopeOnly=true",
      },
      {
        path: "/v1/map/node%2F1?sessionId=session-1&scope=in_scope&inScopeOnly=true",
      },
      {
        path: "/v1/gaps?sessionId=session-1&limit=10",
      },
      {
        path: "/v1/websockets?sessionId=session-1&limit=15&url=wss%3A%2F%2Fapi.example.test%2Fsocket&direction=server_to_client",
      },
      { path: "/v1/websockets/event%2F1" },
      {
        path: "/v1/annotations",
        request: {
          method: "POST",
          body: {
            targetType: "observation",
            targetId: "exchange-1",
            body: "Check auth boundary",
            tags: ["auth"],
          },
        },
      },
      {
        path: "/v1/replay",
        request: {
          method: "POST",
          timeoutMs: 35_000,
          body: {
            observationId: "exchange-2",
            sessionId: "session-1",
            method: "PATCH",
            followRedirects: false,
          },
        },
      },
    ]);
  }).pipe(Effect.provide(makeTestLayer(makeRuntime(calls))));
});

it.effect("controls capture sessions, scope profiles, and annotations", () => {
  const calls: Array<RuntimeCall> = [];
  const previewCalls: Array<PreviewCall> = [];
  const scopeRule = {
    action: "include",
    matcher: "host",
    pattern: "api.example.test",
    enabled: true,
  } as const;
  return Effect.gen(function* () {
    const sessions = yield* callTool("web_capture_list", {});
    expect(sessions.isError).toBe(false);
    expect(sessions.structuredContent).toMatchObject({ sessions: [{ id: "session/1" }] });

    const started = yield* callTool("web_capture_start", {
      label: "Agent capture",
      source: "agent",
      scopeProfileId: "scope/1",
      proxy: true,
    });
    expect(started.isError).toBe(false);
    expect(started.structuredContent).toMatchObject({
      session: { id: "session/1" },
      caPem: "ok",
    });

    const pairing = yield* callTool(
      "web_extension_pair",
      { sessionId: "session/1" },
      browserInvocation,
    );
    expect(pairing.isError).toBe(false);
    expect(pairing.structuredContent).toEqual({
      serverUrl: "http://127.0.0.1:4555",
      sessionId: "session/1",
      token: "extension-pairing-token",
    });

    for (const action of ["resume", "pause", "end", "delete"] as const) {
      const controlled = yield* callTool("web_capture_control", {
        id: "session/1",
        action,
      });
      expect(controlled.isError).toBe(false);
    }

    const scopes = yield* callTool("web_scope_list", {});
    expect(scopes.isError).toBe(false);
    expect(scopes.structuredContent).toMatchObject({ profiles: [{ id: "scope/1" }] });

    const createdScope = yield* callTool("web_scope_save", {
      name: "Target",
      rules: [scopeRule],
    });
    expect(createdScope.isError).toBe(false);
    expect(createdScope.structuredContent).toEqual({ id: "scope/1" });

    const updatedScope = yield* callTool("web_scope_save", {
      id: "scope/1",
      name: "Target",
      rules: [scopeRule],
    });
    expect(updatedScope.isError).toBe(false);
    expect(updatedScope.structuredContent).toMatchObject({ id: "scope/1", version: 1 });

    const deletedScope = yield* callTool("web_scope_delete", { id: "scope/1" });
    expect(deletedScope.isError).toBe(false);

    const annotations = yield* callTool("web_annotation_list", {
      target: { type: "observation", id: "exchange-1" },
      limit: 10,
    });
    expect(annotations.isError).toBe(false);
    expect(annotations.structuredContent).toMatchObject({
      annotations: [{ id: "annotation-1" }],
    });

    const updatedAnnotation = yield* callTool("web_annotation_update", {
      id: "annotation/1",
      body: "Validated auth boundary",
      tags: ["validated"],
    });
    expect(updatedAnnotation.isError).toBe(false);
    expect(updatedAnnotation.structuredContent).toMatchObject({ id: "annotation-1" });

    const deletedAnnotation = yield* callTool("web_annotation_delete", {
      id: "annotation/1",
    });
    expect(deletedAnnotation.isError).toBe(false);

    expect(calls).toEqual([
      { path: "/v1/sessions" },
      {
        path: "/v1/sessions?proxy=true",
        request: {
          method: "POST",
          body: {
            label: "Agent capture",
            source: "agent",
            scopeProfileId: "scope/1",
          },
        },
      },
      { path: "/v1/proxy/ca" },
      {
        path: "/v1/sessions/session%2F1/pairing",
        request: { method: "POST" },
      },
      { path: "/v1/sessions/session%2F1" },
      {
        path: "/v1/sessions/session%2F1/proxy/start",
        request: { method: "POST" },
      },
      { path: "/v1/proxy/ca" },
      { path: "/v1/sessions/session%2F1" },
      {
        path: "/v1/sessions/session%2F1/proxy/stop",
        request: { method: "POST" },
      },
      { path: "/v1/sessions/session%2F1" },
      {
        path: "/v1/sessions/session%2F1/end",
        request: { method: "POST" },
      },
      { path: "/v1/sessions/session%2F1" },
      {
        path: "/v1/sessions/session%2F1",
        request: { method: "DELETE" },
      },
      { path: "/v1/scope" },
      {
        path: "/v1/scope",
        request: { method: "POST", body: { name: "Target", rules: [scopeRule] } },
      },
      {
        path: "/v1/scope/scope%2F1",
        request: { method: "PUT", body: { name: "Target", rules: [scopeRule] } },
      },
      {
        path: "/v1/scope/scope%2F1",
        request: { method: "DELETE" },
      },
      {
        path: "/v1/annotations?targetType=observation&targetId=exchange-1&limit=10",
      },
      {
        path: "/v1/annotations/annotation%2F1",
        request: {
          method: "PATCH",
          body: { body: "Validated auth boundary", tags: ["validated"] },
        },
      },
      {
        path: "/v1/annotations/annotation%2F1",
        request: { method: "DELETE" },
      },
    ]);
    expect(previewCalls).toContainEqual({ operation: "webRuntimeReachability", input: {} });
  }).pipe(Effect.provide(makeTestLayer(makeRuntime(calls), successfulPreviewBroker(previewCalls))));
});

it.effect("distinguishes live, paused, open, and ended capture sessions", () => {
  const running = {
    id: "running",
    label: "Running proxy",
    source: "agent",
    startedAt: "2026-11-20T12:00:00.000Z",
    endedAt: null,
    scopeProfileId: "scope-1",
    upstreamTlsMode: "verify",
    proxy: {
      url: "http://127.0.0.1:4777",
      caEndpoint: "/v1/proxy/ca",
      upstreamTlsMode: "verify",
    },
  } as const;
  const paused = { ...running, id: "paused", label: "Paused proxy", proxy: null };
  const ended = {
    ...paused,
    id: "ended",
    label: "Ended capture",
    endedAt: "2026-11-20T12:10:00.000Z",
  };
  const runtime = WebRuntimeClient.WebRuntimeClient.of({
    health: Effect.die("unused"),
    connection: Effect.succeed({
      baseUrl: "http://127.0.0.1:4555",
      protocolVersion: 1,
      schemaVersion: 1,
    }),
    requestText: () => Effect.die("unused"),
    requestJson: () => Effect.succeed([running, paused, ended]),
  });

  return Effect.gen(function* () {
    const active = yield* callTool("web_capture_list", { state: "active" });
    const pausedOnly = yield* callTool("web_capture_list", { state: "paused" });
    const open = yield* callTool("web_capture_list", { state: "open" });
    const endedOnly = yield* callTool("web_capture_list", { state: "ended" });

    expect(active.structuredContent).toMatchObject({ sessions: [{ id: "running" }] });
    expect(pausedOnly.structuredContent).toMatchObject({ sessions: [{ id: "paused" }] });
    expect(open.structuredContent).toMatchObject({
      sessions: [{ id: "running" }, { id: "paused" }],
    });
    expect(endedOnly.structuredContent).toMatchObject({ sessions: [{ id: "ended" }] });
  }).pipe(Effect.provide(makeTestLayer(runtime)));
});

it.effect("rejects mutually exclusive capture arguments before runtime work", () => {
  const calls: Array<RuntimeCall> = [];
  return Effect.gen(function* () {
    const mixedSource = yield* Effect.exit(
      callTool(
        "web_capture_start",
        {
          label: "Invalid capture",
          source: "extension",
          browserProfile: { profileId: previewProfile.id },
        },
        browserInvocation,
      ),
    );
    const tlsWithoutProxy = yield* Effect.exit(
      callTool("web_capture_start", {
        label: "Invalid TLS capture",
        proxy: false,
        upstreamTls: { mode: "insecure" },
      }),
    );

    expect(mixedSource._tag).toBe("Failure");
    expect(tlsWithoutProxy._tag).toBe("Failure");
    expect(calls).toEqual([]);
  }).pipe(Effect.provide(makeTestLayer(makeRuntime(calls))));
});

it.effect("rejects extension pairing when the runtime loopback is remote", () => {
  const runtimeCalls: Array<RuntimeCall> = [];
  const previewCalls: Array<PreviewCall> = [];
  return Effect.gen(function* () {
    const pairing = yield* callTool(
      "web_extension_pair",
      { sessionId: "session/1" },
      browserInvocation,
    );

    expect(pairing.isError).toBe(true);
    expect(previewCalls).toEqual([{ operation: "webRuntimeReachability", input: {} }]);
    expect(runtimeCalls).toEqual([]);
  }).pipe(
    Effect.provide(
      makeTestLayer(
        makeRuntime(runtimeCalls),
        makePreviewBroker((request) =>
          Effect.sync(() => {
            previewCalls.push({ operation: request.operation, input: request.input });
            return { local: false };
          }),
        ),
      ),
    ),
  );
});

it.effect("atomically binds a new capture proxy and CA to the selected browser profile", () => {
  const runtimeCalls: Array<RuntimeCall> = [];
  const previewCalls: Array<PreviewCall> = [];
  return Effect.gen(function* () {
    const result = yield* callTool(
      "web_capture_start",
      {
        label: "Browser capture",
        browserProfile: { profileId: previewProfile.id },
        upstreamTls: { mode: "customCa", caPem: "lab-ca-pem" },
      },
      browserInvocation,
    );

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      session: { id: "browser-session-1", source: "browser:profile-1" },
      caPem: "trusted-ca-pem",
    });
    expect(runtimeCalls).toEqual([
      { path: "/v1/sessions" },
      {
        path: "/v1/sessions?proxy=true",
        request: {
          method: "POST",
          body: {
            label: "Browser capture",
            source: "browser:profile-1",
            upstreamTls: { mode: "customCa", caPem: "lab-ca-pem" },
          },
        },
      },
      { path: "/v1/proxy/ca" },
    ]);
    expect(previewCalls).toEqual([
      {
        operation: "browserProfileSelect",
        input: { profile: { profileId: "profile-1" } },
      },
      {
        operation: "browserProfileProxy",
        input: {
          profile: { profileId: "profile-1" },
          proxy: {
            proxyUrl: "http://127.0.0.1:4777",
            caCertificatePem: "trusted-ca-pem",
          },
        },
      },
    ]);
  }).pipe(
    Effect.provide(
      makeTestLayer(makeBrowserCaptureRuntime(runtimeCalls), successfulPreviewBroker(previewCalls)),
    ),
  );
});

it.effect("ends a newly created capture when browser profile binding fails", () => {
  const runtimeCalls: Array<RuntimeCall> = [];
  const previewCalls: Array<PreviewCall> = [];
  const broker = makePreviewBroker((request) => {
    previewCalls.push({ operation: request.operation, input: request.input });
    if (request.operation === "browserProfileSelect") {
      return Effect.succeed({ profile: previewProfile, tabId: null });
    }
    return Effect.fail(
      new PreviewAutomationNoAvailableHostError({
        operation: request.operation,
        environmentId: browserInvocation.environmentId,
        threadId: browserInvocation.threadId,
        providerSessionId: browserInvocation.providerSessionId,
        providerInstanceId: browserInvocation.providerInstanceId,
      }),
    );
  });

  return Effect.gen(function* () {
    const result = yield* callTool(
      "web_capture_start",
      { label: "Browser capture", browserProfile: { profileId: previewProfile.id } },
      browserInvocation,
    );

    expect(result.isError).toBe(true);
    expect(runtimeCalls).toContainEqual({
      path: "/v1/sessions/browser-session-1/end",
      request: { method: "POST" },
    });
    expect(previewCalls.filter((call) => call.operation === "browserProfileProxy")).toHaveLength(2);
  }).pipe(Effect.provide(makeTestLayer(makeBrowserCaptureRuntime(runtimeCalls), broker)));
});

it.effect("ends a new capture when the runtime omits its requested proxy", () => {
  const runtimeCalls: Array<RuntimeCall> = [];
  const previewCalls: Array<PreviewCall> = [];
  return Effect.gen(function* () {
    const result = yield* callTool(
      "web_capture_start",
      { label: "Browser capture", browserProfile: { profileId: previewProfile.id } },
      browserInvocation,
    );

    expect(result.isError).toBe(true);
    expect(runtimeCalls).toContainEqual({
      path: "/v1/sessions/browser-session-1/end",
      request: { method: "POST" },
    });
    expect(previewCalls.filter((call) => call.operation === "browserProfileProxy")).toEqual([]);
  }).pipe(
    Effect.provide(
      makeTestLayer(
        makeBrowserCaptureRuntime(runtimeCalls, { nullProxyOnCreate: true }),
        successfulPreviewBroker(previewCalls),
      ),
    ),
  );
});

it.effect("restores the browser proxy when pausing the runtime fails", () => {
  const runtimeCalls: Array<RuntimeCall> = [];
  const previewCalls: Array<PreviewCall> = [];
  return Effect.gen(function* () {
    const result = yield* callTool(
      "web_capture_control",
      { id: "browser-session-1", action: "pause" },
      browserInvocation,
    );

    expect(result.isError).toBe(true);
    const proxyCalls = previewCalls.filter((call) => call.operation === "browserProfileProxy");
    expect(proxyCalls).toEqual([
      {
        operation: "browserProfileProxy",
        input: { profile: { profileId: "profile-1" }, proxy: null },
      },
      {
        operation: "browserProfileProxy",
        input: {
          profile: { profileId: "profile-1" },
          proxy: {
            proxyUrl: "http://127.0.0.1:4777",
            caCertificatePem: "trusted-ca-pem",
          },
        },
      },
    ]);
  }).pipe(
    Effect.provide(
      makeTestLayer(
        makeBrowserCaptureRuntime(runtimeCalls, { failProxyStop: true }),
        successfulPreviewBroker(previewCalls),
      ),
    ),
  );
});

it.effect("clears a stale browser proxy after the runtime loses its proxy descriptor", () => {
  const runtimeCalls: Array<RuntimeCall> = [];
  const previewCalls: Array<PreviewCall> = [];
  return Effect.gen(function* () {
    const result = yield* callTool(
      "web_capture_control",
      { id: "browser-session-1", action: "end" },
      browserInvocation,
    );

    expect(result.isError).toBe(false);
    expect(previewCalls).toContainEqual({
      operation: "browserProfileProxy",
      input: { profile: { profileId: "profile-1" }, proxy: null },
    });
    expect(runtimeCalls).not.toContainEqual({ path: "/v1/proxy/ca" });
  }).pipe(
    Effect.provide(
      makeTestLayer(
        makeBrowserCaptureRuntime(runtimeCalls, { nullProxyOnRead: true }),
        successfulPreviewBroker(previewCalls),
      ),
    ),
  );
});

it.effect("rejects deletion of an active capture before clearing its browser profile", () => {
  const runtimeCalls: Array<RuntimeCall> = [];
  const previewCalls: Array<PreviewCall> = [];
  return Effect.gen(function* () {
    const result = yield* callTool(
      "web_capture_control",
      { id: "browser-session-1", action: "delete" },
      browserInvocation,
    );

    expect(result.isError).toBe(true);
    expect(runtimeCalls).toEqual([{ path: "/v1/sessions/browser-session-1" }]);
    expect(previewCalls).toEqual([]);
  }).pipe(
    Effect.provide(
      makeTestLayer(makeBrowserCaptureRuntime(runtimeCalls), successfulPreviewBroker(previewCalls)),
    ),
  );
});

it.effect("starts extension capture with only the web capability", () => {
  const calls: Array<RuntimeCall> = [];
  return Effect.gen(function* () {
    const result = yield* callTool("web_capture_start", {
      label: "Extension capture",
      source: "extension",
    });

    expect(result.isError).toBe(false);
    expect(calls).toContainEqual({
      path: "/v1/sessions?proxy=true",
      request: {
        method: "POST",
        body: { label: "Extension capture", source: "extension" },
      },
    });
  }).pipe(Effect.provide(makeTestLayer(makeRuntime(calls))));
});

it.effect("checks web capability before selecting a browser profile", () => {
  const runtimeCalls: Array<RuntimeCall> = [];
  const previewCalls: Array<PreviewCall> = [];
  const previewOnlyInvocation: McpInvocationContext.McpInvocationScope = {
    ...invocation,
    capabilities: new Set(["preview"]),
  };
  return Effect.gen(function* () {
    const result = yield* callTool(
      "web_capture_start",
      { label: "Browser capture", browserProfile: { profileId: previewProfile.id } },
      previewOnlyInvocation,
    );

    expect(result.isError).toBe(true);
    expect(runtimeCalls).toEqual([]);
    expect(previewCalls).toEqual([]);
  }).pipe(
    Effect.provide(
      makeTestLayer(makeBrowserCaptureRuntime(runtimeCalls), successfulPreviewBroker(previewCalls)),
    ),
  );
});

it.effect("rejects reserved browser capture sources before touching the runtime", () => {
  const calls: Array<RuntimeCall> = [];
  return Effect.gen(function* () {
    const result = yield* Effect.result(
      callTool("web_capture_start", {
        label: "Forged browser capture",
        source: "browser:profile-1",
      }),
    );

    expect(result._tag).toBe("Failure");
    expect(calls).toEqual([]);
  }).pipe(Effect.provide(makeTestLayer(makeRuntime(calls))));
});

it.effect(
  "rejects web tools before touching the runtime when the credential lacks capability",
  () => {
    const calls: Array<RuntimeCall> = [];
    const deniedInvocation: McpInvocationContext.McpInvocationScope = {
      ...invocation,
      capabilities: new Set(),
    };
    return Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({ name: "web_map_query", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, deniedInvocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(result.isError).toBe(true);
      expect(calls).toEqual([]);
    }).pipe(Effect.provide(makeTestLayer(makeRuntime(calls))));
  },
);
