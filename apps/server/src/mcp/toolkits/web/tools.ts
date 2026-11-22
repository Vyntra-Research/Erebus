import {
  PreviewAutomationError,
  WEB_RUNTIME_BROWSER_CAPTURE_SOURCE_PREFIX,
  WebRuntimeAnnotation,
  WebRuntimeBodyContent,
  WebRuntimeCaptureGap,
  WebRuntimeCaptureSession,
  WebRuntimeCaptureSessionWithCa,
  WebRuntimeExchangeDetail,
  WebRuntimeExtensionPairing,
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
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as WebRuntimeClient from "../../../webRuntime/WebRuntimeClient.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  PreviewAutomationBroker.PreviewAutomationBroker,
  WebRuntimeClient.WebRuntimeClient,
];

const text = (description: string) => Schema.String.annotate({ description });
const nonEmptyText = (description: string) =>
  Schema.String.check(Schema.isTrimmed()).check(Schema.isNonEmpty()).annotate({ description });
const positiveInt = (description: string) =>
  Schema.Int.check(Schema.isGreaterThan(0)).annotate({ description });
const optional = <S extends Schema.Top>(schema: S) => Schema.optionalKey(schema);

export const WebCaptureListInput = Schema.Struct({
  state: optional(
    Schema.Literals(["all", "open", "active", "paused", "ended"]).annotate({
      description:
        "Capture state filter. active means an open session with a live proxy; paused means an open session without a proxy; open includes both. Defaults to all sessions.",
    }),
  ),
  source: optional(text("Exact capture source filter.")),
});

const WebBrowserProfileSelector = Schema.Union([
  Schema.Struct({
    profileId: nonEmptyText("Exact internal browser profile id."),
  }),
  Schema.Struct({
    profileName: nonEmptyText(
      "Internal browser profile name, matched without case sensitivity and required to be unique.",
    ),
  }),
]).annotate({
  description:
    "Internal browser profile selector. Prefer the stable profile id when it is available.",
});

const WebUpstreamTls = Schema.Union([
  Schema.Struct({
    mode: Schema.Literal("verify"),
  }),
  Schema.Struct({
    mode: Schema.Literal("customCa"),
    caPem: nonEmptyText("PEM certificate authority trusted only by this capture proxy."),
  }),
  Schema.Struct({
    mode: Schema.Literal("insecure"),
  }),
]).annotate({
  description:
    "Upstream HTTPS trust for this proxy. It requires proxy=true. Defaults to normal certificate verification. Use customCa for a lab CA, or insecure only when the target certificate must be accepted without verification.",
});

export const WebCaptureStartInput = Schema.Struct({
  label: nonEmptyText("Human-readable label for the new capture session."),
  source: optional(
    nonEmptyText(
      "Capture source label for extension or imported traffic. It cannot be combined with browserProfile.",
    ),
  ),
  browserProfile: optional(WebBrowserProfileSelector),
  scopeProfileId: optional(nonEmptyText("Scope profile id applied to captured traffic.")),
  proxy: optional(
    Schema.Boolean.annotate({
      description: "Start a local HTTP and HTTPS capture proxy with the session. Defaults to true.",
    }),
  ),
  upstreamTls: optional(WebUpstreamTls),
}).check(
  Schema.makeFilter((input) => {
    if (input.browserProfile !== undefined && input.source !== undefined) {
      return "source cannot be combined with an internal browser profile selector.";
    }
    if (input.browserProfile !== undefined && input.proxy === false) {
      return "An internal browser profile capture requires proxy=true.";
    }
    if (input.proxy === false && input.upstreamTls !== undefined) {
      return "upstreamTls requires proxy=true.";
    }
    if (
      input.browserProfile === undefined &&
      input.source?.startsWith(WEB_RUNTIME_BROWSER_CAPTURE_SOURCE_PREFIX)
    ) {
      return `source cannot use the reserved ${WEB_RUNTIME_BROWSER_CAPTURE_SOURCE_PREFIX} prefix.`;
    }
    return true;
  }),
);

export const WebCaptureControlInput = Schema.Struct({
  id: nonEmptyText("Capture session id returned by web_capture_list or web_capture_start."),
  action: Schema.Literals(["resume", "pause", "end", "delete"]).annotate({
    description:
      "Action to apply: resume or pause the proxy, end capture while keeping evidence, or delete an ended session and its evidence.",
  }),
  upstreamTls: optional(WebUpstreamTls),
}).check(
  Schema.makeFilter((input) =>
    input.upstreamTls !== undefined && input.action !== "resume"
      ? "upstreamTls can only be supplied when resuming a capture proxy."
      : true,
  ),
);

export const WebExtensionPairInput = Schema.Struct({
  sessionId: nonEmptyText("Active capture session id that will receive extension traffic."),
});

export const WebCaptureGapsInput = Schema.Struct({
  sessionId: optional(nonEmptyText("Capture session id. Omit it to inspect every session.")),
  limit: optional(positiveInt("Maximum number of capture gaps to return.")),
});

const WebCaptureControlResult = Schema.Union([
  WebRuntimeCaptureSessionWithCa,
  WebRuntimeCaptureSession,
  WebRuntimeSessionDeleteResult,
]);

const WebCaptureFailure = Schema.Union([WebRuntimeRpcError, PreviewAutomationError]);

const WebScopeRuleInput = Schema.Struct({
  action: Schema.Literals(["include", "exclude"]),
  matcher: Schema.Literals(["host", "host_wildcard", "url_wildcard", "regex", "cidr"]),
  pattern: nonEmptyText("Host, URL wildcard, regular expression, or CIDR matched by this rule."),
  enabled: optional(
    Schema.Boolean.annotate({
      description: "Whether this scope rule is active. Defaults to true.",
    }),
  ),
});

export const WebScopeSaveInput = Schema.Struct({
  id: optional(nonEmptyText("Existing scope profile id to replace. Omit it to create a profile.")),
  name: nonEmptyText("Scope profile name."),
  rules: Schema.Array(WebScopeRuleInput).annotate({
    description: "Ordered include and exclude rules that replace the profile's current rules.",
  }),
});

export const WebScopeListInput = Schema.Struct({
  name: optional(text("Case-insensitive scope profile name substring.")),
});

export const WebScopeIdInput = Schema.Struct({
  id: nonEmptyText("Scope profile id returned by web_scope_list or web_scope_save."),
});

export const WebAnnotationListInput = Schema.Struct({
  target: optional(
    Schema.Struct({
      type: Schema.Literals(["observation", "websocket_event", "graph_node"]).annotate({
        description: "Evidence type to filter.",
      }),
      id: optional(nonEmptyText("Evidence or graph node id within the selected type.")),
    }).annotate({
      description: "Optional evidence filter. Type is required whenever an id is supplied.",
    }),
  ),
  limit: optional(positiveInt("Maximum number of annotations to return.")),
});

export const WebAnnotationUpdateInput = Schema.Struct({
  id: nonEmptyText("Annotation id returned by web_annotation_list or web_annotate."),
  body: nonEmptyText("Replacement annotation text."),
  tags: optional(
    Schema.Array(nonEmptyText("One replacement annotation tag.")).annotate({
      description: "Complete replacement tag list. Omit it to clear the tags.",
    }),
  ),
});

export const WebAnnotationIdInput = Schema.Struct({
  id: nonEmptyText("Annotation id returned by web_annotation_list or web_annotate."),
});

const EmptyResult = Schema.Struct({});

export const WebTrafficSearchInput = Schema.Struct({
  sessionId: optional(nonEmptyText("Capture session id. Omit it to search every session.")),
  cursor: optional(nonEmptyText("Opaque cursor returned by the previous search page.")),
  limit: optional(positiveInt("Maximum number of exchanges to return.")),
  host: optional(text("Host substring or exact host filter.")),
  method: optional(text("HTTP method filter, such as GET or POST.")),
  path: optional(text("URL path filter.")),
  status: optional(Schema.Int.annotate({ description: "HTTP response status filter." })),
  scope: optional(text("Scope classification filter, such as in_scope or out_of_scope.")),
  text: optional(text("Full-text search across captured request and response evidence.")),
});

export const WebEvidenceIdInput = Schema.Struct({
  id: nonEmptyText("Captured HTTP exchange id returned by web_traffic_search."),
});

export const WebBodyGetInput = Schema.Struct({
  hash: nonEmptyText("Body content hash returned by web_exchange_get or a WebSocket event."),
});

export const WebMapQueryInput = Schema.Struct({
  sessionId: optional(nonEmptyText("Capture session id. Omit it to query the complete map.")),
  kind: optional(
    text("Node kind filter: host, origin, route, operation, parameter, content, or websocket."),
  ),
  text: optional(text("Text search across canonical keys, labels, and indexed node data.")),
  limit: optional(positiveInt("Maximum number of map nodes to return.")),
  inScopeOnly: optional(
    Schema.Boolean.annotate({
      description: "Return only nodes backed by in-scope evidence. Defaults to false.",
    }),
  ),
});

export const WebMapNeighborhoodInput = Schema.Struct({
  id: nonEmptyText("Map node id returned by web_map_query."),
  sessionId: optional(nonEmptyText("Capture session used to constrain neighborhood evidence.")),
  scope: optional(
    Schema.Literals(["in_scope", "out_of_scope", "unknown"]).annotate({
      description: "Scope classification used to constrain neighborhood evidence.",
    }),
  ),
  inScopeOnly: optional(
    Schema.Boolean.annotate({
      description: "Return only nodes and edges backed by in-scope evidence. Defaults to false.",
    }),
  ),
});

export const WebSocketSearchInput = Schema.Struct({
  sessionId: optional(nonEmptyText("Capture session id. Omit it to search every session.")),
  connectionId: optional(nonEmptyText("WebSocket connection id filter.")),
  cursor: optional(nonEmptyText("Opaque cursor returned by the previous search page.")),
  limit: optional(positiveInt("Maximum number of WebSocket events to return.")),
  url: optional(text("WebSocket URL filter.")),
  kind: optional(text("Event kind filter, such as open, frame, close, or error.")),
  direction: optional(
    Schema.Literals(["client_to_server", "server_to_client"]).annotate({
      description: "Frame direction filter.",
    }),
  ),
  opcode: optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
      description: "WebSocket opcode filter.",
    }),
  ),
  scope: optional(text("Scope classification filter.")),
  text: optional(text("Full-text search across WebSocket metadata and captured payloads.")),
});

export const WebSocketEventIdInput = Schema.Struct({
  id: nonEmptyText("Captured WebSocket event id returned by web_websocket_search."),
});

export const WebAnnotateInput = Schema.Struct({
  targetType: Schema.Literals(["observation", "websocket_event", "graph_node"]).annotate({
    description: "Evidence type to annotate.",
  }),
  targetId: nonEmptyText("Identifier of the captured evidence or map node."),
  body: nonEmptyText("Short evidence note, conclusion, or next action."),
  tags: optional(
    Schema.Array(nonEmptyText("One annotation tag.")).annotate({
      description: "Optional tags used to find and group the note.",
    }),
  ),
});

const WebReplayHeader = Schema.Struct({
  name: text("HTTP header name."),
  value: text("HTTP header value."),
});

const WebReplayBody = Schema.Struct({
  encoding: Schema.Literals(["utf8", "base64"]).annotate({
    description: "Encoding used by the supplied body data.",
  }),
  data: text("Literal UTF-8 text or base64 body data."),
  state: Schema.Literals(["complete", "truncated", "unavailable", "skipped", "evicted"]).annotate({
    description: "Capture state represented by this body.",
  }),
  reason: optional(text("Reason for a non-complete body state.")),
  originalSize: optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
      description: "Original body size when known.",
    }),
  ),
});

export const WebReplayInput = Schema.Struct({
  observationId: nonEmptyText("Captured HTTP observation id to replay."),
  sessionId: nonEmptyText("Active capture session that will own the replay result."),
  replayId: optional(
    nonEmptyText("Stable idempotency key. Reuse it to retrieve the same replay result."),
  ),
  method: optional(nonEmptyText("Optional replacement HTTP method.")),
  url: optional(nonEmptyText("Optional replacement absolute URL.")),
  headers: optional(
    Schema.Array(WebReplayHeader).annotate({
      description: "Optional complete replacement header list. Duplicate names are preserved.",
    }),
  ),
  body: optional(WebReplayBody.annotate({ description: "Optional replacement request body." })),
  followRedirects: optional(
    Schema.Boolean.annotate({ description: "Follow redirects when true. Defaults to false." }),
  ),
  timeoutMs: optional(positiveInt("Replay timeout in milliseconds.")),
});

const readonlyTool = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false) as T;

export const WebCaptureListTool = readonlyTool(
  Tool.make("web_capture_list", {
    description:
      "List web capture sessions with their source, scope profile, lifecycle state, and live proxy endpoint. An open session with proxy=null is paused, not actively proxying traffic; resume it before browser capture.",
    parameters: WebCaptureListInput,
    success: Schema.Struct({ sessions: Schema.Array(WebRuntimeCaptureSession) }),
    failure: WebRuntimeRpcError,
    dependencies,
  }).annotate(Tool.Title, "List web capture sessions"),
);

export const WebCaptureStartTool = Tool.make("web_capture_start", {
  description:
    "Create a web capture session. Pass browserProfile with an id or unique name to select that isolated internal browser profile and bind its HTTP and HTTPS interception proxy atomically. source and browserProfile are mutually exclusive. upstreamTls requires proxy=true. Omit browserProfile for extension or imported traffic.",
  parameters: WebCaptureStartInput,
  success: WebRuntimeCaptureSessionWithCa,
  failure: WebCaptureFailure,
  dependencies,
})
  .annotate(Tool.Title, "Start web capture session")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const WebCaptureControlTool = Tool.make("web_capture_control", {
  description:
    "Resume or pause a capture proxy, end a capture while retaining evidence, or delete a capture session and its stored evidence. Browser-profile captures update that profile's proxy in the same operation.",
  parameters: WebCaptureControlInput,
  success: WebCaptureControlResult,
  failure: WebCaptureFailure,
  dependencies,
})
  .annotate(Tool.Title, "Control web capture session")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const WebExtensionPairTool = Tool.make("web_extension_pair", {
  description:
    "Create a session-bound extension pairing record for one active capture session. Returns only the local runtime URL, session id, and extension token.",
  parameters: WebExtensionPairInput,
  success: WebRuntimeExtensionPairing,
  failure: WebRuntimeRpcError,
  dependencies,
})
  .annotate(Tool.Title, "Pair browser extension with capture")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const WebCaptureGapsTool = readonlyTool(
  Tool.make("web_capture_gaps", {
    description:
      "List explicit capture gaps where the runtime dropped events, including their source, reason, count, session, and observation time.",
    parameters: WebCaptureGapsInput,
    success: Schema.Struct({ gaps: Schema.Array(WebRuntimeCaptureGap) }),
    failure: WebRuntimeRpcError,
    dependencies,
  }).annotate(Tool.Title, "List web capture gaps"),
);

export const WebScopeListTool = readonlyTool(
  Tool.make("web_scope_list", {
    description:
      "List saved web scope profiles and their ordered include and exclude rules for capture classification.",
    parameters: WebScopeListInput,
    success: Schema.Struct({ profiles: Schema.Array(WebRuntimeScopeProfile) }),
    failure: WebRuntimeRpcError,
    dependencies,
  }).annotate(Tool.Title, "List web scope profiles"),
);

export const WebScopeSaveTool = Tool.make("web_scope_save", {
  description:
    "Create a web scope profile or replace an existing profile's name and ordered include and exclude rules.",
  parameters: WebScopeSaveInput,
  success: Schema.Union([WebRuntimeScopeProfile, WebRuntimeScopeSaved]),
  failure: WebRuntimeRpcError,
  dependencies,
})
  .annotate(Tool.Title, "Save web scope profile")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const WebScopeDeleteTool = Tool.make("web_scope_delete", {
  description:
    "Delete a saved web scope profile after its capture sessions no longer depend on that profile.",
  parameters: WebScopeIdInput,
  success: EmptyResult,
  failure: WebRuntimeRpcError,
  dependencies,
})
  .annotate(Tool.Title, "Delete web scope profile")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const WebAnnotationListTool = readonlyTool(
  Tool.make("web_annotation_list", {
    description:
      "List saved annotations, optionally filtered by evidence type and exact evidence or graph node id.",
    parameters: WebAnnotationListInput,
    success: Schema.Struct({ annotations: Schema.Array(WebRuntimeAnnotation) }),
    failure: WebRuntimeRpcError,
    dependencies,
  }).annotate(Tool.Title, "List web evidence annotations"),
);

export const WebAnnotationUpdateTool = Tool.make("web_annotation_update", {
  description:
    "Replace the text and tags of an existing web evidence annotation while preserving its target.",
  parameters: WebAnnotationUpdateInput,
  success: WebRuntimeAnnotation,
  failure: WebRuntimeRpcError,
  dependencies,
})
  .annotate(Tool.Title, "Update web evidence annotation")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const WebAnnotationDeleteTool = Tool.make("web_annotation_delete", {
  description: "Delete one saved annotation without changing the captured evidence it described.",
  parameters: WebAnnotationIdInput,
  success: EmptyResult,
  failure: WebRuntimeRpcError,
  dependencies,
})
  .annotate(Tool.Title, "Delete web evidence annotation")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const WebTrafficSearchTool = readonlyTool(
  Tool.make("web_traffic_search", {
    description:
      "Search captured HTTP exchanges with session, host, method, path, status, scope, and full-text filters. Returns compact rows; use web_exchange_get for one request and response.",
    parameters: WebTrafficSearchInput,
    success: WebRuntimeTrafficPage,
    failure: WebRuntimeRpcError,
    dependencies,
  }).annotate(Tool.Title, "Search captured HTTP traffic"),
);

export const WebExchangeGetTool = readonlyTool(
  Tool.make("web_exchange_get", {
    description:
      "Read one captured HTTP exchange with ordered request and response headers, body metadata and previews, capture errors, and structured metadata.",
    parameters: WebEvidenceIdInput,
    success: WebRuntimeExchangeDetail,
    failure: WebRuntimeRpcError,
    dependencies,
  }).annotate(Tool.Title, "Read captured HTTP exchange"),
);

export const WebBodyGetTool = readonlyTool(
  Tool.make("web_body_get", {
    description:
      "Load a captured body by its content hash when an exchange or WebSocket record says the body is available. Returns its codec, MIME type, sizes, and base64 data.",
    parameters: WebBodyGetInput,
    success: WebRuntimeBodyContent,
    failure: WebRuntimeRpcError,
    dependencies,
  }).annotate(Tool.Title, "Read captured body"),
);

export const WebMapQueryTool = readonlyTool(
  Tool.make("web_map_query", {
    description:
      "Query the deduplicated, evidence-backed web surface map for hosts, routes, operations, parameters, content, and other indexed nodes. Filter by session, kind, text, or scope. Omitted scope filters return all evidence.",
    parameters: WebMapQueryInput,
    success: WebRuntimeGraphPage,
    failure: WebRuntimeRpcError,
    dependencies,
  }).annotate(Tool.Title, "Query web surface map"),
);

export const WebMapNeighborhoodTool = readonlyTool(
  Tool.make("web_map_neighborhood", {
    description:
      "Read the evidence-backed nodes and edges adjacent to one web map node, optionally constrained by session or scope. Omitted scope filters return all evidence.",
    parameters: WebMapNeighborhoodInput,
    success: WebRuntimeGraphNeighborhood,
    failure: WebRuntimeRpcError,
    dependencies,
  }).annotate(Tool.Title, "Read web map neighborhood"),
);

export const WebSocketSearchTool = readonlyTool(
  Tool.make("web_websocket_search", {
    description:
      "Search captured WebSocket connections and frames by session, connection, URL, kind, direction, opcode, scope, or payload text.",
    parameters: WebSocketSearchInput,
    success: WebRuntimeWebSocketPage,
    failure: WebRuntimeRpcError,
    dependencies,
  }).annotate(Tool.Title, "Search captured WebSocket traffic"),
);

export const WebSocketGetTool = readonlyTool(
  Tool.make("web_websocket_get", {
    description:
      "Read one captured WebSocket event with connection metadata and payload capture details, including the content hash used by web_body_get when available.",
    parameters: WebSocketEventIdInput,
    success: WebRuntimeWebSocketEventDetail,
    failure: WebRuntimeRpcError,
    dependencies,
  }).annotate(Tool.Title, "Read captured WebSocket event"),
);

export const WebAnnotateTool = Tool.make("web_annotate", {
  description:
    "Attach a concise note and optional tags to captured HTTP, WebSocket, or graph evidence without changing the evidence itself.",
  parameters: WebAnnotateInput,
  success: WebRuntimeAnnotation,
  failure: WebRuntimeRpcError,
  dependencies,
})
  .annotate(Tool.Title, "Annotate captured web evidence")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const WebReplayTool = Tool.make("web_replay", {
  description:
    "Replay a captured HTTP request, optionally replacing its method, URL, ordered headers, or body. The response is captured in the selected active session.",
  parameters: WebReplayInput,
  success: WebRuntimeReplayResult,
  failure: WebRuntimeRpcError,
  dependencies,
})
  .annotate(Tool.Title, "Replay captured HTTP request")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const WebToolkit = Toolkit.make(
  WebCaptureListTool,
  WebCaptureStartTool,
  WebCaptureControlTool,
  WebExtensionPairTool,
  WebCaptureGapsTool,
  WebScopeListTool,
  WebScopeSaveTool,
  WebScopeDeleteTool,
  WebTrafficSearchTool,
  WebExchangeGetTool,
  WebBodyGetTool,
  WebMapQueryTool,
  WebMapNeighborhoodTool,
  WebSocketSearchTool,
  WebSocketGetTool,
  WebAnnotateTool,
  WebAnnotationListTool,
  WebAnnotationUpdateTool,
  WebAnnotationDeleteTool,
  WebReplayTool,
);
