// @effect-diagnostics nodeBuiltinImport:off - tests exercise real auth-file persistence.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ProviderInstanceId } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import {
  CHATGPT_CODEX_BASE_URL,
  CODEX_REQUEST_GATEWAY_TOKEN_ENV,
  codexRequestGatewayAppServerArgs,
  makeCodexRequestGatewayService,
  parseCodexCredentials,
} from "./CodexRequestGateway.ts";

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

async function makeAccountHome(input: {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly accountId: string;
}): Promise<string> {
  const homePath = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "erebus-gateway-test-"));
  await NodeFSP.writeFile(
    NodePath.join(homePath, "auth.json"),
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: input.accessToken,
        id_token: jwt({ chatgpt_account_id: input.accountId }),
        ...(input.refreshToken ? { refresh_token: input.refreshToken } : {}),
        account_id: input.accountId,
      },
      last_refresh: "2026-10-03T00:00:00.000Z",
    }),
  );
  return homePath;
}

describe("CodexRequestGateway", () => {
  it("builds a non-WebSocket OpenAI responses provider for the loopback gateway", () => {
    const args = codexRequestGatewayAppServerArgs("http://127.0.0.1:3773/internal/codex");
    expect(args).toContain('model_provider="erebus_router"');
    expect(args).toContain('model_providers.erebus_router.name="OpenAI"');
    expect(args).toContain(
      'model_providers.erebus_router.base_url="http://127.0.0.1:3773/internal/codex"',
    );
    expect(args).toContain(
      `model_providers.erebus_router.env_key="${CODEX_REQUEST_GATEWAY_TOKEN_ENV}"`,
    );
    expect(args).toContain("model_providers.erebus_router.supports_websockets=false");
  });

  it("reads the account id from the token when the explicit field is absent", () => {
    const parsed = parseCodexCredentials({
      tokens: {
        access_token: jwt({ exp: 4_102_444_800 }),
        id_token: jwt({ chatgpt_account_id: "account-from-token" }),
      },
    });
    expect(parsed?.accountId).toBe("account-from-token");
  });

  it.effect(
    "replaces caller auth with the selected account without changing the request body",
    () =>
      Effect.gen(function* () {
        const accountId = ProviderInstanceId.make("codex-secondary");
        const homePath = yield* Effect.promise(() =>
          makeAccountHome({
            accessToken: jwt({ exp: 4_102_444_800 }),
            accountId: "workspace-secondary",
          }),
        );
        let observed: { readonly url: string; readonly init: RequestInit } | undefined;
        const gateway = makeCodexRequestGatewayService({
          endpoint: "http://127.0.0.1:3773/internal/codex",
          authorizationToken: "gateway-token",
          fetch: async (input, init = {}) => {
            observed = { url: input.toString(), init };
            return new Response("ok", { status: 200 });
          },
        });

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* gateway.registerAccount({ instanceId: accountId, homePath });
            return yield* gateway.forward(accountId, {
              method: "POST",
              pathAndQuery: "/responses?stream=true",
              headers: new Headers({
                authorization: "Bearer wrong-account",
                "chatgpt-account-id": "wrong-workspace",
                "content-type": "application/json",
              }),
              body: new TextEncoder().encode('{"model":"gpt-6.1-sol"}'),
            });
          }),
        );
        expect(observed?.url).toBe(`${CHATGPT_CODEX_BASE_URL}/responses?stream=true`);
        const headers = new Headers(observed?.init.headers);
        expect(headers.get("authorization")).toContain("Bearer header.");
        expect(headers.get("authorization")).not.toContain("wrong-account");
        expect(headers.get("chatgpt-account-id")).toBe("workspace-secondary");
        expect(new TextDecoder().decode(observed?.init.body as Uint8Array)).toBe(
          '{"model":"gpt-6.1-sol"}',
        );
        yield* Effect.promise(() => NodeFSP.rm(homePath, { recursive: true, force: true }));
      }),
  );

  it.effect("refreshes the same account after a 401 and retries only that HTTP request", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("codex");
      const oldAccessToken = jwt({ exp: 4_102_444_800 });
      const newAccessToken = jwt({ exp: 4_102_444_800, generation: 2 });
      const homePath = yield* Effect.promise(() =>
        makeAccountHome({
          accessToken: oldAccessToken,
          refreshToken: "refresh-1",
          accountId: "workspace-primary",
        }),
      );
      const upstreamAuthorization: string[] = [];
      let refreshCalls = 0;
      const gateway = makeCodexRequestGatewayService({
        endpoint: "http://127.0.0.1:3773/internal/codex",
        authorizationToken: "gateway-token",
        fetch: async (input, init = {}) => {
          const url = input.toString();
          if (url === "https://auth.openai.com/oauth/token") {
            refreshCalls++;
            return Response.json({
              access_token: newAccessToken,
              refresh_token: "refresh-2",
              id_token: jwt({ chatgpt_account_id: "workspace-primary" }),
            });
          }
          upstreamAuthorization.push(new Headers(init.headers).get("authorization") ?? "");
          return upstreamAuthorization.length === 1
            ? new Response("unauthorized", { status: 401 })
            : new Response("ok", { status: 200 });
        },
      });

      const response = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* gateway.registerAccount({ instanceId, homePath });
          return yield* gateway.forward(instanceId, {
            method: "POST",
            pathAndQuery: "/responses",
            headers: new Headers({ "content-type": "application/json" }),
            body: new TextEncoder().encode("{}"),
          });
        }),
      );
      expect(response.status).toBe(200);
      expect(refreshCalls).toBe(1);
      expect(upstreamAuthorization).toEqual([
        `Bearer ${oldAccessToken}`,
        `Bearer ${newAccessToken}`,
      ]);
      // @effect-diagnostics-next-line preferSchemaOverJson:off - fixture asserts the exact persisted auth representation.
      const persisted = JSON.parse(
        yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(homePath, "auth.json"), "utf8")),
      ) as { readonly tokens: { readonly refresh_token: string } };
      expect(persisted.tokens.refresh_token).toBe("refresh-2");
      yield* Effect.promise(() => NodeFSP.rm(homePath, { recursive: true, force: true }));
    }),
  );
});
