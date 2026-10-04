// @effect-diagnostics nodeBuiltinImport:off - the gateway must update Codex auth files atomically.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeTls from "node:tls";

import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { HttpServer } from "effect/unstable/http";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";

export const CODEX_REQUEST_GATEWAY_ROUTE_PREFIX = "/internal/codex";
export const CODEX_REQUEST_GATEWAY_TOKEN_ENV = "EREBUS_CODEX_REQUEST_GATEWAY_TOKEN";
export const CHATGPT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const CODEX_REQUEST_GATEWAY_PROVIDER_ID = "erebus_router";

const CHATGPT_TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ACCESS_TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1_000;
const FALLBACK_REFRESH_INTERVAL_MS = 8 * 24 * 60 * 60 * 1_000;

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function enableSystemCertificateAuthorities(): void {
  const certificates = new Set([
    ...NodeTls.getCACertificates("default"),
    ...NodeTls.getCACertificates("system"),
  ]);
  NodeTls.setDefaultCACertificates(Array.from(certificates));
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function codexRequestGatewayAppServerArgs(endpoint: string): ReadonlyArray<string> {
  const provider = `model_providers.${CODEX_REQUEST_GATEWAY_PROVIDER_ID}`;
  return [
    "-c",
    `model_provider=${tomlString(CODEX_REQUEST_GATEWAY_PROVIDER_ID)}`,
    "-c",
    `${provider}.name=${tomlString("OpenAI")}`,
    "-c",
    `${provider}.base_url=${tomlString(endpoint)}`,
    "-c",
    `${provider}.env_key=${tomlString(CODEX_REQUEST_GATEWAY_TOKEN_ENV)}`,
    "-c",
    `${provider}.wire_api=${tomlString("responses")}`,
    "-c",
    `${provider}.requires_openai_auth=false`,
    "-c",
    `${provider}.supports_websockets=false`,
  ];
}

interface CodexAuthTokens {
  readonly access_token?: unknown;
  readonly refresh_token?: unknown;
  readonly id_token?: unknown;
  readonly account_id?: unknown;
  readonly [key: string]: unknown;
}

interface CodexAuthFile {
  readonly tokens?: CodexAuthTokens;
  readonly last_refresh?: unknown;
  readonly [key: string]: unknown;
}

interface CodexCredentials {
  readonly accessToken: string;
  readonly refreshToken: string | undefined;
  readonly accountId: string;
  readonly authFile: CodexAuthFile;
}

interface RegisteredCodexAccount {
  readonly instanceId: ProviderInstanceId;
  readonly homePath: string;
  readonly registration: object;
}

export interface CodexGatewayRequest {
  readonly method: "GET" | "POST";
  readonly pathAndQuery: string;
  readonly headers: Headers;
  readonly body?: Uint8Array | undefined;
}

export class CodexRequestGatewayError extends Data.TaggedError("CodexRequestGatewayError")<{
  readonly detail: string;
  readonly cause?: unknown;
}> {
  override get message(): string {
    return this.detail;
  }
}

export interface CodexRequestGatewayShape {
  readonly enabled: boolean;
  readonly endpoint: string;
  readonly authorizationToken: string;
  readonly registerAccount: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly homePath: string;
  }) => Effect.Effect<void, never, Scope.Scope>;
  readonly registeredInstanceIds: Effect.Effect<ReadonlyArray<ProviderInstanceId>>;
  readonly forward: (
    instanceId: ProviderInstanceId,
    request: CodexGatewayRequest,
  ) => Effect.Effect<Response, CodexRequestGatewayError>;
}

const disabledGateway = (): CodexRequestGatewayShape => ({
  enabled: false,
  endpoint: "",
  authorizationToken: "",
  registerAccount: () => Effect.void,
  registeredInstanceIds: Effect.succeed([]),
  forward: () =>
    Effect.fail(
      new CodexRequestGatewayError({
        detail: "The Codex request gateway is not enabled.",
      }),
    ),
});

export class CodexRequestGateway extends Context.Reference<CodexRequestGatewayShape>(
  "erebus/provider/Layers/CodexRequestGateway",
  { defaultValue: disabledGateway },
) {}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function decodeJwtPayload(token: unknown): Record<string, unknown> | undefined {
  if (typeof token !== "string") return undefined;
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
    const decoded = JSON.parse(Buffer.from(`${normalized}${padding}`, "base64").toString("utf8"));
    return typeof decoded === "object" && decoded !== null
      ? (decoded as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function accountIdFromClaims(claims: Record<string, unknown> | undefined): string | undefined {
  if (!claims) return undefined;
  const direct = nonEmptyString(claims.chatgpt_account_id);
  if (direct) return direct;
  const auth = claims["https://api.openai.com/auth"];
  if (typeof auth !== "object" || auth === null) return undefined;
  return nonEmptyString((auth as Record<string, unknown>).chatgpt_account_id);
}

export function parseCodexCredentials(authFile: unknown): CodexCredentials | undefined {
  if (typeof authFile !== "object" || authFile === null) return undefined;
  const decoded = authFile as CodexAuthFile;
  const tokens = decoded.tokens;
  if (typeof tokens !== "object" || tokens === null) return undefined;
  const accessToken = nonEmptyString(tokens.access_token);
  const accountId =
    nonEmptyString(tokens.account_id) ??
    accountIdFromClaims(decodeJwtPayload(tokens.id_token)) ??
    accountIdFromClaims(decodeJwtPayload(tokens.access_token));
  if (!accessToken || !accountId) return undefined;
  return {
    accessToken,
    refreshToken: nonEmptyString(tokens.refresh_token),
    accountId,
    authFile: decoded,
  };
}

function accessTokenNeedsRefresh(credentials: CodexCredentials, now: number): boolean {
  const claims = decodeJwtPayload(credentials.accessToken);
  const expiresAtSeconds = claims?.exp;
  if (typeof expiresAtSeconds === "number" && Number.isFinite(expiresAtSeconds)) {
    return expiresAtSeconds * 1_000 <= now + ACCESS_TOKEN_REFRESH_WINDOW_MS;
  }
  const lastRefresh = credentials.authFile.last_refresh;
  const lastRefreshAt = typeof lastRefresh === "string" ? Date.parse(lastRefresh) : Number.NaN;
  return Number.isFinite(lastRefreshAt) && lastRefreshAt <= now - FALLBACK_REFRESH_INTERVAL_MS;
}

async function readCredentials(homePath: string): Promise<CodexCredentials> {
  const authPath = NodePath.join(homePath, "auth.json");
  let decoded: unknown;
  try {
    decoded = JSON.parse(await NodeFSP.readFile(authPath, "utf8"));
  } catch (cause) {
    throw new CodexRequestGatewayError({
      detail: `The Codex account at '${homePath}' has no readable authentication state.`,
      cause,
    });
  }
  const credentials = parseCodexCredentials(decoded);
  if (!credentials) {
    throw new CodexRequestGatewayError({
      detail: `The Codex account at '${homePath}' does not contain usable ChatGPT credentials.`,
    });
  }
  return credentials;
}

async function writeAuthFileAtomically(authPath: string, authFile: CodexAuthFile): Promise<void> {
  const temporaryPath = `${authPath}.${process.pid}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    await NodeFSP.writeFile(temporaryPath, `${JSON.stringify(authFile, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await NodeFSP.rename(temporaryPath, authPath);
    await NodeFSP.chmod(authPath, 0o600).catch(() => undefined);
  } catch (cause) {
    await NodeFSP.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw cause;
  }
}

async function refreshCredentials(input: {
  readonly homePath: string;
  readonly current: CodexCredentials;
  readonly fetch: Fetch;
  readonly now: number;
}): Promise<CodexCredentials> {
  const refreshToken = input.current.refreshToken;
  if (!refreshToken) return input.current;

  const authPath = NodePath.join(input.homePath, "auth.json");
  const response = await input.fetch(CHATGPT_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: CODEX_OAUTH_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    redirect: "error",
  });

  if (!response.ok) {
    const latest = await readCredentials(input.homePath).catch(() => input.current);
    if (
      latest.accessToken !== input.current.accessToken ||
      latest.refreshToken !== input.current.refreshToken
    ) {
      return latest;
    }
    throw new CodexRequestGatewayError({
      detail: `Codex authentication refresh failed with HTTP ${response.status}.`,
    });
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const latest = await readCredentials(input.homePath);
  if (
    latest.accessToken !== input.current.accessToken ||
    latest.refreshToken !== input.current.refreshToken
  ) {
    return latest;
  }

  const accessToken = nonEmptyString(payload.access_token) ?? latest.accessToken;
  const nextRefreshToken = nonEmptyString(payload.refresh_token) ?? latest.refreshToken;
  const idToken = nonEmptyString(payload.id_token);
  const accountId = accountIdFromClaims(decodeJwtPayload(idToken)) ?? latest.accountId;
  const nextAuthFile: CodexAuthFile = {
    ...latest.authFile,
    tokens: {
      ...latest.authFile.tokens,
      access_token: accessToken,
      ...(nextRefreshToken ? { refresh_token: nextRefreshToken } : {}),
      ...(idToken ? { id_token: idToken } : {}),
      account_id: accountId,
    },
    last_refresh: DateTime.formatIso(DateTime.makeUnsafe(input.now)),
  };
  await writeAuthFileAtomically(authPath, nextAuthFile);
  const refreshed = parseCodexCredentials(nextAuthFile);
  if (!refreshed) {
    throw new CodexRequestGatewayError({
      detail: `Codex authentication refresh returned incomplete credentials.`,
    });
  }
  return refreshed;
}

function upstreamRequestHeaders(input: Headers, credentials: CodexCredentials): Headers {
  const headers = new Headers(input);
  for (const name of [
    "authorization",
    "chatgpt-account-id",
    "host",
    "connection",
    "content-length",
    "transfer-encoding",
  ]) {
    headers.delete(name);
  }
  headers.set("authorization", `Bearer ${credentials.accessToken}`);
  headers.set("chatgpt-account-id", credentials.accountId);
  return headers;
}

function upstreamUrl(pathAndQuery: string): string {
  const parsed = new URL(pathAndQuery, "http://127.0.0.1");
  const allowedPath = parsed.pathname.replace(/^\/+/, "");
  if (!new Set(["responses", "responses/compact", "models"]).has(allowedPath)) {
    throw new CodexRequestGatewayError({
      detail: `Unsupported Codex gateway path '${parsed.pathname}'.`,
    });
  }
  return `${CHATGPT_CODEX_BASE_URL}/${allowedPath}${parsed.search}`;
}

export function makeCodexRequestGatewayService(input: {
  readonly endpoint: string;
  readonly authorizationToken: string;
  readonly fetch?: Fetch;
  readonly now?: () => number;
}): CodexRequestGatewayShape {
  const accounts = new Map<ProviderInstanceId, RegisteredCodexAccount>();
  const refreshes = new Map<string, Promise<CodexCredentials>>();
  const fetch = input.fetch ?? globalThis.fetch;
  const now = input.now ?? Date.now;

  const resolveCredentials = async (
    account: RegisteredCodexAccount,
    forceRefresh: boolean,
  ): Promise<CodexCredentials> => {
    const current = await readCredentials(account.homePath);
    if (!current.refreshToken || (!forceRefresh && !accessTokenNeedsRefresh(current, now()))) {
      return current;
    }

    const authPath = NodePath.join(account.homePath, "auth.json");
    const existing = refreshes.get(authPath);
    if (existing) return existing;
    const refresh = refreshCredentials({
      homePath: account.homePath,
      current,
      fetch,
      now: now(),
    }).finally(() => {
      if (refreshes.get(authPath) === refresh) refreshes.delete(authPath);
    });
    refreshes.set(authPath, refresh);
    return refresh;
  };

  const registerAccount: CodexRequestGatewayShape["registerAccount"] = (registration) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const account: RegisteredCodexAccount = {
          ...registration,
          registration: {},
        };
        accounts.set(registration.instanceId, account);
        return account;
      }),
      (account) =>
        Effect.sync(() => {
          if (accounts.get(account.instanceId)?.registration === account.registration) {
            accounts.delete(account.instanceId);
          }
        }),
    ).pipe(Effect.asVoid);

  const forward: CodexRequestGatewayShape["forward"] = (instanceId, request) =>
    Effect.tryPromise({
      try: async () => {
        const account = accounts.get(instanceId);
        if (!account) {
          throw new CodexRequestGatewayError({
            detail: `Codex account '${instanceId}' is not registered with the request gateway.`,
          });
        }

        const send = async (credentials: CodexCredentials) =>
          fetch(upstreamUrl(request.pathAndQuery), {
            method: request.method,
            headers: upstreamRequestHeaders(request.headers, credentials),
            ...(request.body ? { body: request.body } : {}),
            redirect: "error",
          });

        let credentials = await resolveCredentials(account, false);
        let response = await send(credentials);
        if (response.status === 401 && credentials.refreshToken) {
          response.body?.cancel().catch(() => undefined);
          credentials = await resolveCredentials(account, true);
          response = await send(credentials);
        }
        return response;
      },
      catch: (cause) =>
        cause instanceof CodexRequestGatewayError
          ? cause
          : new CodexRequestGatewayError({
              detail: `The Codex request gateway could not reach the upstream service.`,
              cause,
            }),
    });

  return CodexRequestGateway.of({
    enabled: true,
    endpoint: input.endpoint,
    authorizationToken: input.authorizationToken,
    registerAccount,
    registeredInstanceIds: Effect.sync(() => Array.from(accounts.keys())),
    forward,
  });
}

const make = Effect.fn("CodexRequestGateway.make")(function* () {
  yield* Effect.sync(enableSystemCertificateAuthorities);
  const httpServer = yield* HttpServer.HttpServer;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const tokenBytes = yield* secrets.getOrCreateRandom("codex-request-gateway", 32).pipe(
    Effect.mapError(
      (cause) =>
        new CodexRequestGatewayError({
          detail: "Failed to initialize the Codex request gateway token.",
          cause,
        }),
    ),
  );
  const authorizationToken = Buffer.from(tokenBytes).toString("base64url");
  const endpoint =
    httpServer.address._tag === "TcpAddress"
      ? `http://127.0.0.1:${httpServer.address.port}${CODEX_REQUEST_GATEWAY_ROUTE_PREFIX}`
      : `http://127.0.0.1${CODEX_REQUEST_GATEWAY_ROUTE_PREFIX}`;
  return makeCodexRequestGatewayService({ endpoint, authorizationToken });
});

export const CodexRequestGatewayLive = Layer.effect(CodexRequestGateway, make());
