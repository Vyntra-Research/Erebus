import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { isCodexUsageLimitDetail } from "./codexUsageLimit.ts";
import {
  CODEX_REQUEST_GATEWAY_ROUTE_PREFIX,
  CodexRequestGateway,
} from "./Layers/CodexRequestGateway.ts";
import { CodexAccountRouter } from "./Services/CodexAccountRouter.ts";
import { ProviderRegistry } from "./Services/ProviderRegistry.ts";

const MAX_CODEX_REQUEST_BODY_BYTES = FileSystem.Size(128 * 1024 * 1024);
const RESPONSE_HEADERS_TO_DROP = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

async function isUsageLimitResponse(response: Response): Promise<boolean> {
  if (response.status < 400) return false;
  const detail = await response
    .clone()
    .text()
    .catch(() => "");
  return isCodexUsageLimitDetail(detail);
}

function toServerResponse(response: Response): HttpServerResponse.HttpServerResponse {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    if (!RESPONSE_HEADERS_TO_DROP.has(name.toLowerCase())) headers[name] = value;
  });
  if (response.body === null) {
    return HttpServerResponse.empty({
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  return HttpServerResponse.fromWeb(
    new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }),
  );
}

export const handleCodexGatewayRequest = (method: "GET" | "POST") =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const gateway = yield* CodexRequestGateway;
    const accountRouter = yield* CodexAccountRouter;
    const providerRegistry = yield* ProviderRegistry;
    if (request.headers.authorization !== `Bearer ${gateway.authorizationToken}`) {
      return HttpServerResponse.empty({ status: 404 });
    }

    const requestUrl = HttpServerRequest.toURL(request);
    if (Option.isNone(requestUrl)) {
      return HttpServerResponse.text("Invalid Codex gateway request.", { status: 400 });
    }
    const suffix = requestUrl.value.pathname.slice(CODEX_REQUEST_GATEWAY_ROUTE_PREFIX.length);
    const pathAndQuery = `${suffix}${requestUrl.value.search}`;
    const body =
      method === "POST"
        ? new Uint8Array(
            yield* request.arrayBuffer.pipe(
              Effect.provideService(HttpServerRequest.MaxBodySize, MAX_CODEX_REQUEST_BODY_BYTES),
            ),
          )
        : undefined;
    const registered = yield* gateway.registeredInstanceIds;
    let activeInstanceId = (yield* accountRouter.activeInstanceId) ?? registered[0] ?? null;
    const attempted = new Set<string>();

    while (activeInstanceId !== null && !attempted.has(activeInstanceId)) {
      attempted.add(activeInstanceId);
      const response = yield* gateway
        .forward(activeInstanceId, {
          method,
          pathAndQuery,
          headers: new Headers(request.headers as Record<string, string>),
          ...(body ? { body } : {}),
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("Codex request gateway failed", {
              instanceId: activeInstanceId,
              detail: error.detail,
              cause: error.cause,
            }).pipe(
              Effect.as(
                new Response(
                  JSON.stringify({
                    error: {
                      type: "erebus_account_routing_error",
                      message: error.detail,
                    },
                  }),
                  {
                    status: 502,
                    headers: { "content-type": "application/json" },
                  },
                ),
              ),
            ),
          ),
        );

      if (!(yield* Effect.promise(() => isUsageLimitResponse(response)))) {
        return toServerResponse(response);
      }

      const exhaustedInstanceId = activeInstanceId;
      activeInstanceId = yield* accountRouter.failoverInstanceAfterUsageLimit(exhaustedInstanceId);
      yield* providerRegistry.refreshInstance(exhaustedInstanceId).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to refresh exhausted Codex account usage", {
            instanceId: exhaustedInstanceId,
            cause,
          }),
        ),
        Effect.forkDetach,
      );
      if (activeInstanceId === null || attempted.has(activeInstanceId)) {
        return toServerResponse(response);
      }
      if (response.body !== null) {
        yield* Effect.promise(() => response.body!.cancel().catch(() => undefined));
      }
      yield* Effect.logWarning("Retrying a Codex model request through another account", {
        exhaustedInstanceId,
        activeInstanceId,
      });
    }

    return HttpServerResponse.jsonUnsafe(
      {
        error: {
          type: "erebus_account_routing_error",
          message: "No authenticated Codex account is available for this request.",
        },
      },
      { status: 503 },
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Codex request gateway rejected a request", { cause }).pipe(
        Effect.as(
          HttpServerResponse.jsonUnsafe(
            {
              error: {
                type: "erebus_account_routing_error",
                message: "The Codex request gateway could not process this request.",
              },
            },
            { status: 502 },
          ),
        ),
      ),
    ),
  );

export const codexRequestGatewayHttpLayer = Layer.mergeAll(
  HttpRouter.add(
    "GET",
    `${CODEX_REQUEST_GATEWAY_ROUTE_PREFIX}/*`,
    handleCodexGatewayRequest("GET"),
  ),
  HttpRouter.add(
    "POST",
    `${CODEX_REQUEST_GATEWAY_ROUTE_PREFIX}/*`,
    handleCodexGatewayRequest("POST"),
  ),
);
