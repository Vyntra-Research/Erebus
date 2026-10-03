// @effect-diagnostics nodeBuiltinImport:off - tests exercise real account auth files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ProviderInstanceId } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http";
import { describe, expect } from "vite-plus/test";

import { handleCodexGatewayRequest } from "./codexRequestGatewayHttp.ts";
import {
  CodexRequestGateway,
  makeCodexRequestGatewayService,
} from "./Layers/CodexRequestGateway.ts";
import { CodexAccountRouter } from "./Services/CodexAccountRouter.ts";
import { ProviderRegistry } from "./Services/ProviderRegistry.ts";

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

async function accountHome(accessToken: string, accountId: string): Promise<string> {
  const homePath = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "erebus-route-test-"));
  await NodeFSP.writeFile(
    NodePath.join(homePath, "auth.json"),
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: accessToken,
        id_token: jwt({ chatgpt_account_id: accountId }),
        refresh_token: "refresh-token",
        account_id: accountId,
      },
      last_refresh: "2026-10-03T00:00:00.000Z",
    }),
  );
  return homePath;
}

describe("Codex request gateway HTTP route", () => {
  it.effect("retries a quota-rejected request with another account inside the same turn", () =>
    Effect.gen(function* () {
      const primary = ProviderInstanceId.make("codex");
      const fallback = ProviderInstanceId.make("codex-2");
      const primaryToken = jwt({ exp: 4_102_444_800, account: "primary" });
      const fallbackToken = jwt({ exp: 4_102_444_800, account: "fallback" });
      const primaryHome = yield* Effect.promise(() =>
        accountHome(primaryToken, "workspace-primary"),
      );
      const fallbackHome = yield* Effect.promise(() =>
        accountHome(fallbackToken, "workspace-fallback"),
      );
      const upstreamAccounts: string[] = [];
      const gateway = makeCodexRequestGatewayService({
        endpoint: "http://127.0.0.1:3773/internal/codex",
        authorizationToken: "gateway-token",
        fetch: async (_input, init = {}) => {
          const accountId = new Headers(init.headers).get("chatgpt-account-id") ?? "";
          upstreamAccounts.push(accountId);
          return accountId === "workspace-primary"
            ? Response.json(
                { error: { code: "usage_limit_reached", message: "Usage limit reached" } },
                { status: 429 },
              )
            : new Response("event: response.completed\n\ndata: {}\n\n", {
                status: 200,
                headers: { "content-type": "text/event-stream" },
              });
        },
      });

      let active = primary;
      const router = CodexAccountRouter.of({
        activeInstanceId: Effect.sync(() => active),
        resolveModelSelection: Effect.succeed,
        failoverAfterUsageLimit: () => Effect.succeed(null),
        failoverInstanceAfterUsageLimit: () =>
          Effect.sync(() => {
            active = fallback;
            return fallback;
          }),
      });
      const registry = ProviderRegistry.of({
        getProviders: Effect.succeed([]),
        refresh: () => Effect.succeed([]),
        refreshInstance: () => Effect.succeed([]),
        getProviderMaintenanceCapabilitiesForInstance: () => Effect.die("unused"),
        setProviderMaintenanceActionState: () => Effect.succeed([]),
        streamChanges: Stream.empty,
      });
      const request = HttpServerRequest.fromWeb(
        new Request("http://127.0.0.1:3773/internal/codex/responses", {
          method: "POST",
          headers: {
            authorization: "Bearer gateway-token",
            "content-type": "application/json",
          },
          // @effect-diagnostics-next-line preferSchemaOverJson:off - raw HTTP fixture body.
          body: JSON.stringify({ model: "gpt-6.1-sol" }),
        }),
      );

      const response = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* gateway.registerAccount({ instanceId: primary, homePath: primaryHome });
          yield* gateway.registerAccount({ instanceId: fallback, homePath: fallbackHome });
          return yield* handleCodexGatewayRequest("POST").pipe(
            Effect.provideService(HttpServerRequest.HttpServerRequest, request),
            Effect.provideService(CodexAccountRouter, router),
            Effect.provideService(ProviderRegistry, registry),
            Effect.provideService(CodexRequestGateway, gateway),
          );
        }),
      );
      expect(response.status).toBe(200);
      expect(upstreamAccounts).toEqual(["workspace-primary", "workspace-fallback"]);
      expect(active).toBe(fallback);
      yield* Effect.promise(() =>
        Promise.all([
          NodeFSP.rm(primaryHome, { recursive: true, force: true }),
          NodeFSP.rm(fallbackHome, { recursive: true, force: true }),
        ]),
      );
    }),
  );

  it.effect("uses a newly selected primary on the next request without restarting the turn", () =>
    Effect.gen(function* () {
      const first = ProviderInstanceId.make("codex");
      const second = ProviderInstanceId.make("codex-2");
      const firstHome = yield* Effect.promise(() =>
        accountHome(jwt({ exp: 4_102_444_800, account: "first" }), "workspace-first"),
      );
      const secondHome = yield* Effect.promise(() =>
        accountHome(jwt({ exp: 4_102_444_800, account: "second" }), "workspace-second"),
      );
      const upstreamAccounts: string[] = [];
      const gateway = makeCodexRequestGatewayService({
        endpoint: "http://127.0.0.1:3773/internal/codex",
        authorizationToken: "gateway-token",
        fetch: async (_input, init = {}) => {
          upstreamAccounts.push(new Headers(init.headers).get("chatgpt-account-id") ?? "");
          return new Response("event: response.completed\n\ndata: {}\n\n", {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        },
      });
      let active = first;
      const router = CodexAccountRouter.of({
        activeInstanceId: Effect.sync(() => active),
        resolveModelSelection: Effect.succeed,
        failoverAfterUsageLimit: () => Effect.succeed(null),
        failoverInstanceAfterUsageLimit: () => Effect.succeed(null),
      });
      const registry = ProviderRegistry.of({
        getProviders: Effect.succeed([]),
        refresh: () => Effect.succeed([]),
        refreshInstance: () => Effect.succeed([]),
        getProviderMaintenanceCapabilitiesForInstance: () => Effect.die("unused"),
        setProviderMaintenanceActionState: () => Effect.succeed([]),
        streamChanges: Stream.empty,
      });
      const routeRequest = () =>
        handleCodexGatewayRequest("POST").pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              new Request("http://127.0.0.1:3773/internal/codex/responses", {
                method: "POST",
                headers: {
                  authorization: "Bearer gateway-token",
                  "content-type": "application/json",
                },
                body: JSON.stringify({ model: "gpt-6.1-sol" }),
              }),
            ),
          ),
          Effect.provideService(CodexAccountRouter, router),
          Effect.provideService(ProviderRegistry, registry),
          Effect.provideService(CodexRequestGateway, gateway),
        );

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* gateway.registerAccount({ instanceId: first, homePath: firstHome });
          yield* gateway.registerAccount({ instanceId: second, homePath: secondHome });
          const firstResponse = yield* routeRequest();
          expect(firstResponse.status).toBe(200);
          active = second;
          const secondResponse = yield* routeRequest();
          expect(secondResponse.status).toBe(200);
        }),
      );
      expect(upstreamAccounts).toEqual(["workspace-first", "workspace-second"]);
      yield* Effect.promise(() =>
        Promise.all([
          NodeFSP.rm(firstHome, { recursive: true, force: true }),
          NodeFSP.rm(secondHome, { recursive: true, force: true }),
        ]),
      );
    }),
  );
});
