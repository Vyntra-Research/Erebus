import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

const NullableString = Schema.NullOr(Schema.String);
const NullableNonNegativeInt = Schema.NullOr(NonNegativeInt);

export const WEB_RUNTIME_BROWSER_CAPTURE_SOURCE_PREFIX = "browser:";

export function webRuntimeBrowserCaptureSource(profileId: string): string {
  return `${WEB_RUNTIME_BROWSER_CAPTURE_SOURCE_PREFIX}${profileId}`;
}

export function webRuntimeBrowserProfileId(source: string): string | null {
  if (!source.startsWith(WEB_RUNTIME_BROWSER_CAPTURE_SOURCE_PREFIX)) return null;
  const profileId = source.slice(WEB_RUNTIME_BROWSER_CAPTURE_SOURCE_PREFIX.length);
  return profileId.length > 0 ? profileId : null;
}

export const WebRuntimeStatus = Schema.Literals([
  "disabled",
  "starting",
  "healthy",
  "degraded",
  "unavailable",
]);
export type WebRuntimeStatus = typeof WebRuntimeStatus.Type;

export const WebRuntimeHealth = Schema.Struct({
  status: WebRuntimeStatus,
  protocolVersion: Schema.NullOr(Schema.Literal(1)),
  schemaVersion: Schema.NullOr(PositiveInt),
  lastError: NullableString,
  restartCount: NonNegativeInt,
});
export type WebRuntimeHealth = typeof WebRuntimeHealth.Type;

export class WebRuntimeRpcError extends Schema.TaggedErrorClass<WebRuntimeRpcError>()(
  "WebRuntimeRpcError",
  {
    code: Schema.Literals(["unavailable", "request_failed", "invalid_response"]),
    operation: TrimmedNonEmptyString,
    message: TrimmedNonEmptyString,
    status: Schema.optionalKey(Schema.Int),
  },
) {}

export const WebRuntimeUpstreamTlsMode = Schema.Literals(["verify", "customCa", "insecure"]);
export type WebRuntimeUpstreamTlsMode = typeof WebRuntimeUpstreamTlsMode.Type;

export const WebRuntimeProxy = Schema.Struct({
  url: TrimmedNonEmptyString,
  caEndpoint: TrimmedNonEmptyString,
  upstreamTlsMode: WebRuntimeUpstreamTlsMode,
});
export type WebRuntimeProxy = typeof WebRuntimeProxy.Type;

export const WebRuntimeUpstreamTls = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("verify") }),
  Schema.Struct({ mode: Schema.Literal("customCa"), caPem: TrimmedNonEmptyString }),
  Schema.Struct({ mode: Schema.Literal("insecure") }),
]);
export type WebRuntimeUpstreamTls = typeof WebRuntimeUpstreamTls.Type;

export const WebRuntimeCaptureSession = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  source: TrimmedNonEmptyString,
  startedAt: TrimmedNonEmptyString,
  endedAt: NullableString,
  scopeProfileId: TrimmedNonEmptyString,
  upstreamTlsMode: WebRuntimeUpstreamTlsMode,
  proxy: Schema.NullOr(WebRuntimeProxy),
  proxyState: Schema.optionalKey(Schema.Literals(["running", "stopped"])),
});
export type WebRuntimeCaptureSession = typeof WebRuntimeCaptureSession.Type;

export const WebRuntimeCaptureSessionWithCa = Schema.Struct({
  session: WebRuntimeCaptureSession,
  caPem: NullableString,
});
export type WebRuntimeCaptureSessionWithCa = typeof WebRuntimeCaptureSessionWithCa.Type;

export const WebRuntimeExtensionPairingToken = Schema.Struct({
  token: TrimmedNonEmptyString,
});
export const WebRuntimeExtensionPairing = Schema.Struct({
  serverUrl: TrimmedNonEmptyString,
  sessionId: TrimmedNonEmptyString,
  token: TrimmedNonEmptyString,
  proxyUrl: Schema.optionalKey(TrimmedNonEmptyString),
  caPem: Schema.optionalKey(TrimmedNonEmptyString),
});
export type WebRuntimeExtensionPairing = typeof WebRuntimeExtensionPairing.Type;

export const WebRuntimeExtensionBrowserTab = Schema.Struct({
  tabId: Schema.Int,
  windowId: Schema.Int,
  active: Schema.Boolean,
  attached: Schema.Boolean,
  title: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
});
export type WebRuntimeExtensionBrowserTab = typeof WebRuntimeExtensionBrowserTab.Type;

export const WebRuntimeExtensionAutomationClient = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  producerId: TrimmedNonEmptyString,
  browser: TrimmedNonEmptyString,
  version: TrimmedNonEmptyString,
  lastSeenMs: NonNegativeInt,
  connected: Schema.Boolean,
  tabs: Schema.Array(WebRuntimeExtensionBrowserTab),
});
export type WebRuntimeExtensionAutomationClient = typeof WebRuntimeExtensionAutomationClient.Type;

export const WebRuntimeExtensionAutomationInvokeInput = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  producerId: TrimmedNonEmptyString,
  tabId: Schema.optionalKey(Schema.Int),
  operation: TrimmedNonEmptyString,
  input: Schema.optionalKey(Schema.Unknown),
  timeoutMs: PositiveInt,
});
export type WebRuntimeExtensionAutomationInvokeInput =
  typeof WebRuntimeExtensionAutomationInvokeInput.Type;

export const WebRuntimeExtensionAutomationError = Schema.Struct({
  tag: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
  detail: Schema.optionalKey(Schema.Unknown),
});

export const WebRuntimeExtensionAutomationResult = Schema.Struct({
  commandId: TrimmedNonEmptyString,
  ok: Schema.Boolean,
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(WebRuntimeExtensionAutomationError),
});
export type WebRuntimeExtensionAutomationResult = typeof WebRuntimeExtensionAutomationResult.Type;

export const WebRuntimeCreateSessionInput = Schema.Struct({
  label: TrimmedNonEmptyString,
  source: Schema.optionalKey(TrimmedNonEmptyString),
  scopeProfileId: Schema.optionalKey(TrimmedNonEmptyString),
  proxy: Schema.optionalKey(Schema.Boolean),
  upstreamTls: Schema.optionalKey(WebRuntimeUpstreamTls),
});
export type WebRuntimeCreateSessionInput = typeof WebRuntimeCreateSessionInput.Type;

export const WebRuntimeSessionDeleteResult = Schema.Struct({
  id: TrimmedNonEmptyString,
  observations: NonNegativeInt,
  websocketEvents: NonNegativeInt,
});
export type WebRuntimeSessionDeleteResult = typeof WebRuntimeSessionDeleteResult.Type;

export const WebRuntimeScopeAction = Schema.Literals(["include", "exclude"]);
export const WebRuntimeScopeMatcher = Schema.Literals([
  "host",
  "host_wildcard",
  "url_wildcard",
  "regex",
  "cidr",
]);
export const WebRuntimeScopeRuleInput = Schema.Struct({
  action: WebRuntimeScopeAction,
  matcher: WebRuntimeScopeMatcher,
  pattern: TrimmedNonEmptyString,
  enabled: Schema.optionalKey(Schema.Boolean),
});
export const WebRuntimeSaveScopeInput = Schema.Struct({
  name: TrimmedNonEmptyString,
  rules: Schema.Array(WebRuntimeScopeRuleInput),
});
export type WebRuntimeSaveScopeInput = typeof WebRuntimeSaveScopeInput.Type;
export const WebRuntimeScopeSaved = Schema.Struct({ id: TrimmedNonEmptyString });

export const WebRuntimeScopeRule = Schema.Struct({
  id: TrimmedNonEmptyString,
  action: WebRuntimeScopeAction,
  matcher: WebRuntimeScopeMatcher,
  pattern: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  orderIndex: NonNegativeInt,
});
export type WebRuntimeScopeRule = typeof WebRuntimeScopeRule.Type;

export const WebRuntimeScopeProfile = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  version: NonNegativeInt,
  createdAt: TrimmedNonEmptyString,
  updatedAt: TrimmedNonEmptyString,
  rules: Schema.Array(WebRuntimeScopeRule),
});
export type WebRuntimeScopeProfile = typeof WebRuntimeScopeProfile.Type;

export const WebRuntimeUpdateScopeInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  rules: Schema.Array(WebRuntimeScopeRuleInput),
});
export type WebRuntimeUpdateScopeInput = typeof WebRuntimeUpdateScopeInput.Type;

export const WebRuntimeHeaderField = Schema.Struct({
  name: Schema.String,
  value: Schema.String,
});
export type WebRuntimeHeaderField = typeof WebRuntimeHeaderField.Type;

export const WebRuntimeBodyInput = Schema.Struct({
  encoding: Schema.Literals(["utf8", "base64"]),
  data: Schema.String,
  state: Schema.Literals(["complete", "truncated", "unavailable", "skipped", "evicted"]),
  reason: Schema.optionalKey(Schema.String),
  originalSize: Schema.optionalKey(NonNegativeInt),
});
export type WebRuntimeBodyInput = typeof WebRuntimeBodyInput.Type;

export const WebRuntimeBodyDetail = Schema.Struct({
  state: Schema.String,
  reason: NullableString,
  capturedSize: NonNegativeInt,
  originalSize: NonNegativeInt,
  mime: NullableString,
  textPreview: NullableString,
  hash: NullableString,
});
export type WebRuntimeBodyDetail = typeof WebRuntimeBodyDetail.Type;

export const WebRuntimeBodyContent = Schema.Struct({
  hash: TrimmedNonEmptyString,
  dataBase64: Schema.String,
  mime: NullableString,
  capturedSize: NonNegativeInt,
  storedSize: NonNegativeInt,
  codec: TrimmedNonEmptyString,
});
export type WebRuntimeBodyContent = typeof WebRuntimeBodyContent.Type;

export const WebRuntimeTrafficQuery = Schema.Struct({
  sessionId: Schema.optionalKey(TrimmedNonEmptyString),
  cursor: Schema.optionalKey(TrimmedNonEmptyString),
  limit: Schema.optionalKey(PositiveInt),
  host: Schema.optionalKey(Schema.String),
  method: Schema.optionalKey(Schema.String),
  path: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.Int),
  scope: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
});
export type WebRuntimeTrafficQuery = typeof WebRuntimeTrafficQuery.Type;

export const WebRuntimeTrafficSummary = Schema.Struct({
  id: TrimmedNonEmptyString,
  capturedAt: TrimmedNonEmptyString,
  method: Schema.String,
  url: Schema.String,
  host: Schema.String,
  path: Schema.String,
  status: Schema.NullOr(Schema.Int),
  durationMs: NullableNonNegativeInt,
  scope: Schema.String,
  requestBodySize: NonNegativeInt,
  responseBodySize: NonNegativeInt,
});
export type WebRuntimeTrafficSummary = typeof WebRuntimeTrafficSummary.Type;

export const WebRuntimeTrafficPage = Schema.Struct({
  items: Schema.Array(WebRuntimeTrafficSummary),
  nextCursor: NullableString,
});
export type WebRuntimeTrafficPage = typeof WebRuntimeTrafficPage.Type;

export const WebRuntimeExchangeDetail = Schema.Struct({
  summary: WebRuntimeTrafficSummary,
  requestHeaders: Schema.Array(WebRuntimeHeaderField),
  responseHeaders: Schema.Array(WebRuntimeHeaderField),
  requestBody: Schema.NullOr(WebRuntimeBodyDetail),
  responseBody: Schema.NullOr(WebRuntimeBodyDetail),
  error: NullableString,
  metadata: Schema.Unknown,
});
export type WebRuntimeExchangeDetail = typeof WebRuntimeExchangeDetail.Type;

export const WebRuntimeWebSocketQuery = Schema.Struct({
  sessionId: Schema.optionalKey(TrimmedNonEmptyString),
  connectionId: Schema.optionalKey(TrimmedNonEmptyString),
  cursor: Schema.optionalKey(TrimmedNonEmptyString),
  limit: Schema.optionalKey(PositiveInt),
  url: Schema.optionalKey(Schema.String),
  kind: Schema.optionalKey(Schema.String),
  direction: Schema.optionalKey(Schema.String),
  opcode: Schema.optionalKey(NonNegativeInt),
  scope: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
});
export type WebRuntimeWebSocketQuery = typeof WebRuntimeWebSocketQuery.Type;

export const WebRuntimeWebSocketConnectionState = Schema.Literals(["open", "close", "error"]);
export type WebRuntimeWebSocketConnectionState = typeof WebRuntimeWebSocketConnectionState.Type;

export const WebRuntimeWebSocketEventSummary = Schema.Struct({
  id: TrimmedNonEmptyString,
  connectionId: TrimmedNonEmptyString,
  capturedAt: TrimmedNonEmptyString,
  kind: Schema.String,
  direction: NullableString,
  opcode: Schema.NullOr(NonNegativeInt),
  url: NullableString,
  subprotocol: NullableString,
  connectionState: WebRuntimeWebSocketConnectionState,
  closeCode: Schema.NullOr(NonNegativeInt),
  closeReason: NullableString,
  scope: Schema.String,
  payloadSize: NonNegativeInt,
  payloadOriginalSize: NonNegativeInt,
  error: NullableString,
});
export type WebRuntimeWebSocketEventSummary = typeof WebRuntimeWebSocketEventSummary.Type;

export const WebRuntimeWebSocketPage = Schema.Struct({
  items: Schema.Array(WebRuntimeWebSocketEventSummary),
  nextCursor: NullableString,
});
export type WebRuntimeWebSocketPage = typeof WebRuntimeWebSocketPage.Type;

export const WebRuntimeWebSocketEventDetail = Schema.Struct({
  summary: WebRuntimeWebSocketEventSummary,
  payload: Schema.NullOr(WebRuntimeBodyDetail),
});
export type WebRuntimeWebSocketEventDetail = typeof WebRuntimeWebSocketEventDetail.Type;

export const WebRuntimeGapQuery = Schema.Struct({
  sessionId: Schema.optionalKey(TrimmedNonEmptyString),
  limit: Schema.optionalKey(PositiveInt),
});
export type WebRuntimeGapQuery = typeof WebRuntimeGapQuery.Type;

export const WebRuntimeCaptureGap = Schema.Struct({
  id: TrimmedNonEmptyString,
  sessionId: TrimmedNonEmptyString,
  source: Schema.String,
  droppedEvents: NonNegativeInt,
  reason: Schema.String,
  observedAt: TrimmedNonEmptyString,
});
export type WebRuntimeCaptureGap = typeof WebRuntimeCaptureGap.Type;

export const WebRuntimeGraphQuery = Schema.Struct({
  sessionId: Schema.optionalKey(TrimmedNonEmptyString),
  kind: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(PositiveInt),
  inScopeOnly: Schema.optionalKey(Schema.Boolean),
  scope: Schema.optionalKey(Schema.Literals(["in_scope", "out_of_scope", "unknown"])),
});
export type WebRuntimeGraphQuery = typeof WebRuntimeGraphQuery.Type;

export const WebRuntimeGraphNode = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: Schema.String,
  canonicalKey: Schema.String,
  label: Schema.String,
  metadata: Schema.Unknown,
  firstSeen: TrimmedNonEmptyString,
  lastSeen: TrimmedNonEmptyString,
  evidenceCount: NonNegativeInt,
});
export type WebRuntimeGraphNode = typeof WebRuntimeGraphNode.Type;

export const WebRuntimeGraphEdge = Schema.Struct({
  sourceId: TrimmedNonEmptyString,
  targetId: TrimmedNonEmptyString,
  kind: Schema.String,
  firstSeen: TrimmedNonEmptyString,
  lastSeen: TrimmedNonEmptyString,
  evidenceCount: NonNegativeInt,
});
export type WebRuntimeGraphEdge = typeof WebRuntimeGraphEdge.Type;

export const WebRuntimeGraphPage = Schema.Struct({ nodes: Schema.Array(WebRuntimeGraphNode) });
export type WebRuntimeGraphPage = typeof WebRuntimeGraphPage.Type;
export const WebRuntimeGraphNeighborhood = Schema.Struct({
  nodes: Schema.Array(WebRuntimeGraphNode),
  edges: Schema.Array(WebRuntimeGraphEdge),
});
export type WebRuntimeGraphNeighborhood = typeof WebRuntimeGraphNeighborhood.Type;

export const WebRuntimeNeighborhoodInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  sessionId: Schema.optionalKey(TrimmedNonEmptyString),
  inScopeOnly: Schema.optionalKey(Schema.Boolean),
  scope: Schema.optionalKey(Schema.Literals(["in_scope", "out_of_scope", "unknown"])),
});
export type WebRuntimeNeighborhoodInput = typeof WebRuntimeNeighborhoodInput.Type;

export const WebRuntimeAnnotationTargetType = Schema.Literals([
  "observation",
  "websocket_event",
  "graph_node",
]);
export type WebRuntimeAnnotationTargetType = typeof WebRuntimeAnnotationTargetType.Type;

export const WebRuntimeAnnotationInput = Schema.Struct({
  targetType: WebRuntimeAnnotationTargetType,
  targetId: TrimmedNonEmptyString,
  body: TrimmedNonEmptyString,
  tags: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
});
export type WebRuntimeAnnotationInput = typeof WebRuntimeAnnotationInput.Type;

export const WebRuntimeAnnotationQuery = Schema.Struct({
  targetType: Schema.optionalKey(WebRuntimeAnnotationTargetType),
  targetId: Schema.optionalKey(TrimmedNonEmptyString),
  limit: Schema.optionalKey(PositiveInt),
});
export type WebRuntimeAnnotationQuery = typeof WebRuntimeAnnotationQuery.Type;

export const WebRuntimeUpdateAnnotationInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  body: TrimmedNonEmptyString,
  tags: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
});
export type WebRuntimeUpdateAnnotationInput = typeof WebRuntimeUpdateAnnotationInput.Type;

export const WebRuntimeAnnotation = Schema.Struct({
  id: TrimmedNonEmptyString,
  targetType: WebRuntimeAnnotationTargetType,
  targetId: TrimmedNonEmptyString,
  body: Schema.String,
  tags: Schema.Array(Schema.String),
  createdAt: TrimmedNonEmptyString,
  updatedAt: TrimmedNonEmptyString,
});
export type WebRuntimeAnnotation = typeof WebRuntimeAnnotation.Type;

export const WebRuntimeReplayInput = Schema.Struct({
  observationId: TrimmedNonEmptyString,
  sessionId: TrimmedNonEmptyString,
  replayId: Schema.optionalKey(TrimmedNonEmptyString),
  method: Schema.optionalKey(TrimmedNonEmptyString),
  url: Schema.optionalKey(TrimmedNonEmptyString),
  headers: Schema.optionalKey(Schema.Array(WebRuntimeHeaderField)),
  body: Schema.optionalKey(WebRuntimeBodyInput),
  followRedirects: Schema.optionalKey(Schema.Boolean),
  timeoutMs: Schema.optionalKey(PositiveInt),
});
export type WebRuntimeReplayInput = typeof WebRuntimeReplayInput.Type;

export const WebRuntimeReplayResult = Schema.Struct({
  replayId: TrimmedNonEmptyString,
  observationId: TrimmedNonEmptyString,
  status: Schema.NullOr(Schema.Int),
  error: NullableString,
});
export type WebRuntimeReplayResult = typeof WebRuntimeReplayResult.Type;
