import {
  type DesktopPreviewBrowserProfile,
  type DesktopPreviewProxyConfiguration,
  type PreviewAutomationOperation,
  WebRuntimeAnnotation,
  WebRuntimeBodyContent,
  WebRuntimeCaptureGap,
  WebRuntimeCaptureSession,
  WebRuntimeExchangeDetail,
  WebRuntimeExtensionPairingToken,
  WebRuntimeGraphNeighborhood,
  WebRuntimeGraphPage,
  WebRuntimeReplayResult,
  WebRuntimeRpcError,
  WebRuntimeScopeProfile,
  WebRuntimeScopeSaved,
  WebRuntimeSessionDeleteResult,
  WebRuntimeTrafficPage,
  WebRuntimeWebSocketEventDetail,
  WebRuntimeWebSocketPage,
  webRuntimeBrowserCaptureSource,
  webRuntimeBrowserProfileId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import {
  decodeWebRuntimeResponse,
  webRuntimeRequestPath,
  webRuntimeRpcFailure,
} from "../../../webRuntime/WebRuntimeBridge.ts";
import * as WebRuntimeClient from "../../../webRuntime/WebRuntimeClient.ts";
import { WebToolkit } from "./tools.ts";

const requireWebWorkspaceRoot = Effect.fn("requireWebWorkspaceRoot")(function* () {
  const invocation = yield* McpInvocationContext.requireWebMcpCapability();
  if (!invocation.workspaceRoot) {
    return yield* new WebRuntimeRpcError({
      code: "unavailable",
      operation: "resolve web workspace",
      message: "This web tool call has no workspace context.",
    });
  }
  return invocation.workspaceRoot;
});

const requestJson = <A>(
  operation: string,
  schema: Schema.Decoder<A, never>,
  path: string,
  request?: WebRuntimeClient.WebRuntimeRequest,
) =>
  Effect.gen(function* () {
    const workspaceRoot = yield* requireWebWorkspaceRoot();
    const runtime = yield* WebRuntimeClient.WebRuntimeClient;
    const value = yield* runtime
      .requestJsonForWorkspace(workspaceRoot, path, request)
      .pipe(Effect.mapError((error) => webRuntimeRpcFailure(operation, error)));
    return yield* decodeWebRuntimeResponse(operation, schema, value);
  });

const requestText = (
  operation: string,
  path: string,
  request?: WebRuntimeClient.WebRuntimeRequest,
) =>
  Effect.gen(function* () {
    const workspaceRoot = yield* requireWebWorkspaceRoot();
    const runtime = yield* WebRuntimeClient.WebRuntimeClient;
    return yield* runtime
      .requestTextForWorkspace(workspaceRoot, path, request)
      .pipe(Effect.mapError((error) => webRuntimeRpcFailure(operation, error)));
  });

interface BrowserProfileSelector {
  readonly profileId?: string;
  readonly profileName?: string;
}

interface BrowserProfileListResult {
  readonly profiles: readonly DesktopPreviewBrowserProfile[];
}

interface BrowserProfileSelectResult {
  readonly profile: DesktopPreviewBrowserProfile;
  readonly tabId: string | null;
}

interface BrowserProfileProxyResult {
  readonly profileId: string;
  readonly configured: boolean;
}

interface WebRuntimeReachabilityResult {
  readonly local: boolean;
}

const invokePreview = Effect.fn("WebToolkit.invokePreview")(function* <A>(
  operation: PreviewAutomationOperation,
  input: unknown,
) {
  const scope = yield* McpInvocationContext.requireMcpCapability("preview");
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  return yield* broker.invoke<A>({ scope, operation, input });
});

const configureBrowserProfile = (
  profileId: string,
  proxy: DesktopPreviewProxyConfiguration | null,
) =>
  invokePreview<BrowserProfileProxyResult>("browserProfileProxy", {
    profile: { profileId },
    proxy,
  });

const listBrowserProfiles = () =>
  invokePreview<BrowserProfileListResult>("browserProfilesList", {}).pipe(
    Effect.map((result) => result.profiles),
  );

const browserProfileExists = (profileId: string) =>
  listBrowserProfiles().pipe(
    Effect.map((profiles) => profiles.some((profile) => profile.id === profileId)),
  );

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const combinedFailure = (operation: string, primary: unknown, rollback: unknown) =>
  new WebRuntimeRpcError({
    code: "request_failed",
    operation,
    message: `${errorMessage(primary)} Rollback also failed: ${errorMessage(rollback)}`,
  });

const captureMatchesState = (
  session: WebRuntimeCaptureSession,
  state: "all" | "open" | "active" | "paused" | "ended" | undefined,
): boolean => {
  switch (state) {
    case undefined:
    case "all":
      return true;
    case "open":
      return session.endedAt === null;
    case "active":
      return session.endedAt === null && session.proxy !== null;
    case "paused":
      return session.endedAt === null && session.proxy === null;
    case "ended":
      return session.endedAt !== null;
  }
};

const startProxyWithCa = (
  sessionId: string,
  operation: string,
  upstreamTls?: { readonly mode: "verify" | "customCa" | "insecure"; readonly caPem?: string },
) =>
  Effect.gen(function* () {
    const sessionPath = `/v1/sessions/${encodeURIComponent(sessionId)}`;
    const session = yield* requestJson(
      operation,
      WebRuntimeCaptureSession,
      `${sessionPath}/proxy/start`,
      {
        method: "POST",
        ...(upstreamTls === undefined ? {} : { body: { upstreamTls } }),
      },
    );
    if (session.proxy === null) {
      return yield* new WebRuntimeRpcError({
        code: "invalid_response",
        operation,
        message: "The capture runtime did not return a proxy endpoint.",
      });
    }
    const caPem = yield* requestText("read web capture CA", "/v1/proxy/ca").pipe(
      Effect.tapError(() =>
        requestJson(
          "rollback web capture proxy",
          WebRuntimeCaptureSession,
          `${sessionPath}/proxy/stop`,
          { method: "POST" },
        ).pipe(Effect.ignore),
      ),
    );
    return { session, caPem };
  });

const bindProfileToCapture = Effect.fn("WebToolkit.bindProfileToCapture")(function* (
  profileId: string,
  capture: { readonly session: WebRuntimeCaptureSession; readonly caPem: string },
) {
  if (capture.session.proxy === null) {
    return yield* new WebRuntimeRpcError({
      code: "invalid_response",
      operation: "bind browser profile to web capture",
      message: "The capture runtime did not return a proxy endpoint.",
    });
  }
  return yield* configureBrowserProfile(profileId, {
    proxyUrl: capture.session.proxy.url,
    caCertificatePem: capture.caPem,
  });
});

const handlers = {
  web_capture_list: (input) =>
    requestJson(
      "list web capture sessions",
      Schema.Array(WebRuntimeCaptureSession),
      "/v1/sessions",
    ).pipe(
      Effect.map((sessions) => ({
        sessions: sessions.filter(
          (session) =>
            captureMatchesState(session, input.state) &&
            (input.source === undefined || session.source === input.source),
        ),
      })),
    ),
  web_capture_start: (input) =>
    Effect.gen(function* () {
      yield* McpInvocationContext.requireWebMcpCapability();
      const proxy = input.proxy ?? true;
      const browserSelector: BrowserProfileSelector | null = input.browserProfile ?? null;
      const browserProfile =
        browserSelector === null
          ? null
          : (yield* invokePreview<BrowserProfileSelectResult>("browserProfileSelect", {
              profile: browserSelector,
            })).profile;
      const source =
        browserProfile === null
          ? (input.source ?? "agent")
          : webRuntimeBrowserCaptureSource(browserProfile.id);

      if (browserProfile !== null) {
        const sessions = yield* requestJson(
          "check browser capture session",
          Schema.Array(WebRuntimeCaptureSession),
          "/v1/sessions",
        );
        const existing = sessions.find(
          (session) => session.endedAt === null && session.source === source,
        );
        if (existing) {
          return yield* new WebRuntimeRpcError({
            code: "request_failed",
            operation: "start web capture session",
            message: `Browser profile ${browserProfile.name} already has active capture ${existing.id}. Resume or end that capture first.`,
          });
        }
      }

      const session = yield* requestJson(
        "start web capture session",
        WebRuntimeCaptureSession,
        webRuntimeRequestPath("/v1/sessions", { proxy }),
        {
          method: "POST",
          body: {
            label: input.label,
            source,
            ...(input.scopeProfileId === undefined ? {} : { scopeProfileId: input.scopeProfileId }),
            ...(input.upstreamTls === undefined ? {} : { upstreamTls: input.upstreamTls }),
          },
        },
      );
      if (!proxy) return { session, caPem: null };
      if (session.proxy === null) {
        const failure = new WebRuntimeRpcError({
          code: "invalid_response",
          operation: "start web capture session",
          message: "The capture runtime did not return a proxy endpoint.",
        });
        const rollback = yield* requestJson(
          "rollback web capture session",
          WebRuntimeCaptureSession,
          `/v1/sessions/${encodeURIComponent(session.id)}/end`,
          { method: "POST" },
        ).pipe(Effect.result);
        if (rollback._tag === "Failure") {
          return yield* combinedFailure("start web capture session", failure, rollback.failure);
        }
        return yield* failure;
      }
      const caPem = yield* requestText("read web capture CA", "/v1/proxy/ca").pipe(
        Effect.tapError(() =>
          requestJson(
            "rollback web capture session",
            WebRuntimeCaptureSession,
            `/v1/sessions/${encodeURIComponent(session.id)}/end`,
            { method: "POST" },
          ).pipe(Effect.ignore),
        ),
      );
      if (browserProfile !== null) {
        const binding = yield* bindProfileToCapture(browserProfile.id, {
          session,
          caPem,
        }).pipe((effect) => Effect.result(effect));
        if (binding._tag === "Failure") {
          yield* configureBrowserProfile(browserProfile.id, null).pipe(Effect.ignore);
          const rollback = yield* requestJson(
            "rollback web capture session",
            WebRuntimeCaptureSession,
            `/v1/sessions/${encodeURIComponent(session.id)}/end`,
            { method: "POST" },
          ).pipe(Effect.result);
          if (rollback._tag === "Failure") {
            return yield* combinedFailure(
              "bind browser profile to web capture",
              binding.failure,
              rollback.failure,
            );
          }
          return yield* binding.failure;
        }
      }
      return { session, caPem };
    }),
  web_capture_control: (input) =>
    Effect.gen(function* () {
      const sessionPath = `/v1/sessions/${encodeURIComponent(input.id)}`;
      const current = yield* requestJson(
        "read web capture session",
        WebRuntimeCaptureSession,
        sessionPath,
      );
      const profileId = webRuntimeBrowserProfileId(current.source);
      if (input.action === "delete" && current.endedAt === null) {
        return yield* new WebRuntimeRpcError({
          code: "request_failed",
          operation: "delete web capture session",
          message: "End the capture session before deleting it.",
        });
      }
      switch (input.action) {
        case "resume": {
          const capture = yield* startProxyWithCa(
            input.id,
            "resume web capture proxy",
            input.upstreamTls,
          );
          if (profileId === null) return capture;
          const binding = yield* Effect.result(bindProfileToCapture(profileId, capture));
          if (binding._tag === "Success") return capture;
          const rollback = yield* requestJson(
            "rollback web capture proxy",
            WebRuntimeCaptureSession,
            `${sessionPath}/proxy/stop`,
            { method: "POST" },
          ).pipe(Effect.result);
          if (rollback._tag === "Failure") {
            return yield* combinedFailure(
              "resume browser profile capture",
              binding.failure,
              rollback.failure,
            );
          }
          return yield* binding.failure;
        }
        case "pause":
        case "end":
        case "delete": {
          let clearedProfile = false;
          let caPem: string | null = null;
          if (profileId !== null && (yield* browserProfileExists(profileId))) {
            if (current.proxy !== null) {
              caPem = yield* requestText("read web capture CA", "/v1/proxy/ca");
            }
            yield* configureBrowserProfile(profileId, null);
            clearedProfile = true;
          }

          const mutation =
            input.action === "pause"
              ? yield* Effect.result(
                  requestJson(
                    "pause web capture proxy",
                    WebRuntimeCaptureSession,
                    `${sessionPath}/proxy/stop`,
                    { method: "POST" },
                  ),
                )
              : input.action === "end"
                ? yield* Effect.result(
                    requestJson(
                      "end web capture session",
                      WebRuntimeCaptureSession,
                      `${sessionPath}/end`,
                      { method: "POST" },
                    ),
                  )
                : yield* Effect.result(
                    requestJson(
                      "delete web capture session",
                      WebRuntimeSessionDeleteResult,
                      sessionPath,
                      { method: "DELETE" },
                    ),
                  );

          if (mutation._tag === "Failure") {
            if (clearedProfile && profileId !== null && current.proxy !== null && caPem !== null) {
              const restore = yield* Effect.result(
                configureBrowserProfile(profileId, {
                  proxyUrl: current.proxy.url,
                  caCertificatePem: caPem,
                }),
              );
              if (restore._tag === "Failure") {
                return yield* combinedFailure(
                  `${input.action} browser profile capture`,
                  mutation.failure,
                  restore.failure,
                );
              }
            }
            return yield* mutation.failure;
          }

          return mutation.success;
        }
      }
    }),
  web_extension_pair: (input) =>
    Effect.gen(function* () {
      const reachability = yield* invokePreview<WebRuntimeReachabilityResult>(
        "webRuntimeReachability",
        {},
      ).pipe(
        Effect.mapError(
          (error) =>
            new WebRuntimeRpcError({
              code: "unavailable",
              operation: "check web runtime reachability",
              message: errorMessage(error),
            }),
        ),
      );
      if (!reachability.local) {
        return yield* new WebRuntimeRpcError({
          code: "unavailable",
          operation: "create web extension pairing",
          message:
            "The capture runtime is remote and its loopback endpoint has no tunnel to this device.",
        });
      }
      const pairing = yield* requestJson(
        "create web extension pairing",
        WebRuntimeExtensionPairingToken,
        `/v1/sessions/${encodeURIComponent(input.sessionId)}/pairing`,
        { method: "POST" },
      );
      const workspaceRoot = yield* requireWebWorkspaceRoot();
      const runtime = yield* WebRuntimeClient.WebRuntimeClient;
      const connection = yield* runtime
        .connectionForWorkspace(workspaceRoot)
        .pipe(
          Effect.mapError((error) => webRuntimeRpcFailure("create web extension pairing", error)),
        );
      return {
        serverUrl: connection.baseUrl,
        sessionId: input.sessionId,
        token: pairing.token,
      };
    }),
  web_capture_gaps: (input) =>
    requestJson(
      "list web capture gaps",
      Schema.Array(WebRuntimeCaptureGap),
      webRuntimeRequestPath("/v1/gaps", input),
    ).pipe(Effect.map((gaps) => ({ gaps }))),
  web_scope_list: (input) =>
    requestJson("list web scope profiles", Schema.Array(WebRuntimeScopeProfile), "/v1/scope").pipe(
      Effect.map((profiles) => {
        const name = input.name?.toLocaleLowerCase();
        return {
          profiles:
            name === undefined
              ? profiles
              : profiles.filter((profile) => profile.name.toLocaleLowerCase().includes(name)),
        };
      }),
    ),
  web_scope_save: (input) =>
    input.id === undefined
      ? requestJson("create web scope profile", WebRuntimeScopeSaved, "/v1/scope", {
          method: "POST",
          body: { name: input.name, rules: input.rules },
        })
      : requestJson(
          "update web scope profile",
          WebRuntimeScopeProfile,
          `/v1/scope/${encodeURIComponent(input.id)}`,
          { method: "PUT", body: { name: input.name, rules: input.rules } },
        ),
  web_scope_delete: (input) =>
    requestText("delete web scope profile", `/v1/scope/${encodeURIComponent(input.id)}`, {
      method: "DELETE",
    }).pipe(Effect.as({})),
  web_traffic_search: (input) =>
    requestJson(
      "search captured HTTP traffic",
      WebRuntimeTrafficPage,
      webRuntimeRequestPath("/v1/traffic", input),
    ),
  web_exchange_get: (input) =>
    requestJson(
      "read captured HTTP exchange",
      WebRuntimeExchangeDetail,
      `/v1/traffic/${encodeURIComponent(input.id)}`,
    ),
  web_body_get: (input) =>
    requestJson(
      "read captured body",
      WebRuntimeBodyContent,
      `/v1/bodies/${encodeURIComponent(input.hash)}`,
    ),
  web_map_query: (input) =>
    requestJson(
      "query web surface map",
      WebRuntimeGraphPage,
      webRuntimeRequestPath("/v1/map", input),
    ),
  web_map_neighborhood: (input) =>
    requestJson(
      "read web map neighborhood",
      WebRuntimeGraphNeighborhood,
      webRuntimeRequestPath(`/v1/map/${encodeURIComponent(input.id)}`, {
        sessionId: input.sessionId,
        scope: input.scope,
        inScopeOnly: input.inScopeOnly,
      }),
    ),
  web_websocket_search: (input) =>
    requestJson(
      "search captured WebSocket traffic",
      WebRuntimeWebSocketPage,
      webRuntimeRequestPath("/v1/websockets", input),
    ),
  web_websocket_get: (input) =>
    requestJson(
      "read captured WebSocket event",
      WebRuntimeWebSocketEventDetail,
      `/v1/websockets/${encodeURIComponent(input.id)}`,
    ),
  web_annotate: (input) =>
    requestJson("annotate captured web evidence", WebRuntimeAnnotation, "/v1/annotations", {
      method: "POST",
      body: input,
    }),
  web_annotation_list: (input) =>
    requestJson(
      "list web evidence annotations",
      Schema.Array(WebRuntimeAnnotation),
      webRuntimeRequestPath("/v1/annotations", {
        targetType: input.target?.type,
        targetId: input.target?.id,
        limit: input.limit,
      }),
    ).pipe(Effect.map((annotations) => ({ annotations }))),
  web_annotation_update: (input) =>
    requestJson(
      "update web evidence annotation",
      WebRuntimeAnnotation,
      `/v1/annotations/${encodeURIComponent(input.id)}`,
      { method: "PATCH", body: { body: input.body, tags: input.tags ?? [] } },
    ),
  web_annotation_delete: (input) =>
    requestText(
      "delete web evidence annotation",
      `/v1/annotations/${encodeURIComponent(input.id)}`,
      { method: "DELETE" },
    ).pipe(Effect.as({})),
  web_replay: (input) =>
    requestJson("replay captured HTTP request", WebRuntimeReplayResult, "/v1/replay", {
      method: "POST",
      body: input,
      timeoutMs: Math.min(125_000, Math.max(35_000, (input.timeoutMs ?? 30_000) + 5_000)),
    }),
} satisfies Parameters<typeof WebToolkit.toLayer>[0];

export const WebToolkitHandlersLive = WebToolkit.toLayer(handlers);
