"use client";

import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_DESKTOP_PREVIEW_BROWSER_PROFILE_ID,
  type DesktopPreviewBrowserProfile,
  type DesktopPreviewBrowserProfileId,
  type EnvironmentId,
  type WebRuntimeCaptureGap,
  type WebRuntimeCaptureSession,
  type WebRuntimeAnnotation,
  type WebRuntimeExchangeDetail,
  type WebRuntimeExtensionPairing,
  type WebRuntimeGraphEdge,
  type WebRuntimeGraphNode,
  type WebRuntimeHealth,
  type WebRuntimeScopeProfile,
  type WebRuntimeTrafficSummary,
  type WebRuntimeUpstreamTls,
  type WebRuntimeWebSocketEventDetail,
  type WebRuntimeWebSocketEventSummary,
} from "@t3tools/contracts";
import {
  AlertTriangle,
  Braces,
  CircleStop,
  Copy,
  Download,
  ExternalLink,
  Filter,
  FolderOpen,
  Network,
  Play,
  Radio,
  RefreshCw,
  Route,
  Search,
  Send,
  ShieldCheck,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { previewBridge } from "~/components/preview/previewBridge";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Textarea } from "~/components/ui/textarea";
import { toastManager } from "~/components/ui/toast";
import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { cn } from "~/lib/utils";
import { useEnvironment } from "~/state/environments";
import { webRuntimeEnvironment } from "~/state/webRuntime";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

import {
  captureSourceConfiguration,
  captureRollbackFailure,
  endCaptureAfterProxyClear,
  mergeEvidenceById,
  parseAnnotationTags,
  parseReplayHeaders,
  resolveBrowserProfileCaptureState,
  runtimeRestartCleanup,
} from "./webSecurityPanelLogic";

type WebTab = "traffic" | "map" | "websockets" | "scope";
type UpstreamTlsMode = WebRuntimeUpstreamTls["mode"];
type ScopeRuleDraft = {
  draftId: string;
  action: "include" | "exclude";
  matcher: "host" | "host_wildcard" | "url_wildcard" | "regex" | "cidr";
  pattern: string;
  enabled: boolean;
};

let nextScopeRuleDraftId = 0;

function allocateScopeRuleDraftId(): string {
  nextScopeRuleDraftId += 1;
  return `scope-rule-draft-${nextScopeRuleDraftId}`;
}

function createScopeRuleDraft(
  rule: Omit<ScopeRuleDraft, "draftId">,
  draftId = allocateScopeRuleDraftId(),
): ScopeRuleDraft {
  return { draftId, ...rule };
}

interface WebSecurityPanelProps {
  environmentId: EnvironmentId;
}

const EMPTY_STATUS: WebRuntimeHealth = {
  status: "starting",
  protocolVersion: null,
  schemaVersion: null,
  lastError: null,
  restartCount: 0,
};

const EVIDENCE_PAGE_SIZE = 500;

function commandError(result: { readonly cause: unknown }): string {
  const error = squashAtomCommandFailure(result as never);
  return error instanceof Error ? error.message : "The operation failed.";
}

function showOperationFailure(title: string, result: { readonly cause: unknown }): void {
  toastManager.add({ type: "error", title, description: commandError(result) });
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function shortTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.valueOf())
    ? iso
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function copyText(value: string, title = "Copied"): void {
  void navigator.clipboard.writeText(value).then(
    () => toastManager.add({ type: "success", title }),
    () => toastManager.add({ type: "error", title: "Could not copy to the clipboard" }),
  );
}

function downloadTextFile(name: string, value: string): void {
  const url = URL.createObjectURL(new Blob([value], { type: "application/x-pem-file" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function useMeasuredHeight<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [height, setHeight] = useState(360);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setHeight(entry.contentRect.height);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, height] as const;
}

function VirtualTrafficList(props: {
  items: readonly WebRuntimeTrafficSummary[];
  selectedId: string | null;
  onSelect: (item: WebRuntimeTrafficSummary) => void;
}) {
  const rowHeight = 35;
  const overscan = 8;
  const [scrollTop, setScrollTop] = useState(0);
  const [containerRef, height] = useMeasuredHeight<HTMLDivElement>();
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(props.items.length, Math.ceil((scrollTop + height) / rowHeight) + overscan);
  const visible = props.items.slice(start, end);

  return (
    <div
      ref={containerRef}
      className="min-h-0 flex-1 overflow-auto"
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      data-web-traffic-list
    >
      <div className="relative" style={{ height: props.items.length * rowHeight }}>
        {visible.map((item, index) => {
          const top = (start + index) * rowHeight;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => props.onSelect(item)}
              className={cn(
                "absolute inset-x-0 grid h-[35px] grid-cols-[4.5rem_3rem_minmax(0,1fr)_3.5rem] items-center gap-2 border-b border-border/35 px-3 text-left text-[11px] hover:bg-accent/50",
                item.id === props.selectedId && "bg-accent text-foreground",
              )}
              style={{ top }}
            >
              <span className="truncate font-mono text-muted-foreground">
                {shortTime(item.capturedAt)}
              </span>
              <span className="truncate font-semibold">{item.method}</span>
              <span className="min-w-0 truncate">
                <span className="font-medium">{item.host}</span>
                <span className="text-muted-foreground">{item.path}</span>
              </span>
              <span
                className={cn(
                  "text-right font-mono",
                  item.status !== null && item.status >= 400 && "text-destructive",
                )}
              >
                {item.status ?? "—"}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function DetailSection(props: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {props.title}
      </h4>
      {props.children}
    </section>
  );
}

function HeaderTable(props: { headers: readonly { name: string; value: string }[] }) {
  const occurrences = new Map<string, number>();
  return (
    <div className="overflow-hidden rounded-md bg-muted/25 font-mono text-[11px]">
      {props.headers.length === 0 ? (
        <div className="p-2 text-muted-foreground">No headers captured.</div>
      ) : (
        props.headers.map((header) => {
          const baseKey = `${header.name}\u0000${header.value}`;
          const occurrence = occurrences.get(baseKey) ?? 0;
          occurrences.set(baseKey, occurrence + 1);
          return (
            <div
              key={`${baseKey}\u0000${occurrence}`}
              className="grid grid-cols-[minmax(6rem,0.35fr)_minmax(0,1fr)] gap-2 border-b border-border/25 px-2 py-1 last:border-0"
            >
              <span className="truncate text-muted-foreground">{header.name}</span>
              <span className="break-all">{header.value}</span>
            </div>
          );
        })
      )}
    </div>
  );
}

function decodeBody(dataBase64: string): string {
  try {
    const bytes = Uint8Array.from(atob(dataBase64), (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return "Body is binary or could not be decoded.";
  }
}

function CaptureGapNotice({ gaps }: { gaps: readonly WebRuntimeCaptureGap[] }) {
  if (gaps.length === 0) return null;
  const dropped = gaps.reduce((total, gap) => total + gap.droppedEvents, 0);
  return (
    <div className="flex items-start gap-2 bg-warning/8 px-3 py-2 text-xs text-warning-foreground">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <span>
        Capture is incomplete: {dropped} {dropped === 1 ? "event" : "events"} dropped. The gap
        records remain attached to this session.
      </span>
    </div>
  );
}

function GraphCanvas(props: {
  nodes: readonly WebRuntimeGraphNode[];
  edges: readonly WebRuntimeGraphEdge[];
  selectedId: string | null;
  onSelect: (node: WebRuntimeGraphNode) => void;
}) {
  const width = 960;
  const rowHeight = 62;
  const kinds = [...new Set(props.nodes.map((node) => node.kind))];
  const grouped = new Map(
    kinds.map((kind) => [kind, props.nodes.filter((node) => node.kind === kind)]),
  );
  const positions = new Map<string, { x: number; y: number }>();
  const columnWidth = Math.max(180, width / Math.max(1, kinds.length));
  let maxRows = 1;
  kinds.forEach((kind, column) => {
    const nodes = grouped.get(kind) ?? [];
    maxRows = Math.max(maxRows, nodes.length);
    nodes.forEach((node, row) => {
      positions.set(node.id, {
        x: column * columnWidth + columnWidth / 2,
        y: 48 + row * rowHeight,
      });
    });
  });
  const height = Math.max(240, 80 + maxRows * rowHeight);

  return (
    <div className="min-h-0 flex-1 overflow-auto bg-background/30">
      <svg width={width} height={height} role="img" aria-label="Captured web surface map">
        {props.edges.map((edge) => {
          const source = positions.get(edge.sourceId);
          const target = positions.get(edge.targetId);
          if (!source || !target) return null;
          return (
            <line
              key={`${edge.sourceId}:${edge.targetId}:${edge.kind}`}
              x1={source.x}
              y1={source.y}
              x2={target.x}
              y2={target.y}
              className="stroke-border"
              strokeWidth={Math.min(4, 1 + Math.log2(edge.evidenceCount + 1))}
            />
          );
        })}
        {kinds.map((kind, column) => (
          <text
            key={kind}
            x={column * columnWidth + 12}
            y={20}
            className="fill-muted-foreground text-[11px] font-semibold uppercase"
          >
            {kind}
          </text>
        ))}
        {props.nodes.map((node) => {
          const position = positions.get(node.id);
          if (!position) return null;
          const selected = node.id === props.selectedId;
          return (
            <g
              key={node.id}
              role="button"
              tabIndex={0}
              onClick={() => props.onSelect(node)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") props.onSelect(node);
              }}
              className="cursor-pointer"
              transform={`translate(${position.x - 74} ${position.y - 18})`}
            >
              <rect
                width="148"
                height="36"
                rx="8"
                className={selected ? "fill-primary/20 stroke-primary" : "fill-card stroke-border"}
              />
              <text x="9" y="16" className="fill-foreground text-[10px] font-medium">
                {node.label.slice(0, 22)}
              </text>
              <text x="9" y="29" className="fill-muted-foreground text-[9px]">
                {node.evidenceCount} evidence
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function AnnotationEditor(props: {
  annotations: readonly WebRuntimeAnnotation[];
  note: string;
  tags: string;
  editingId: string | null;
  disabled: boolean;
  onNoteChange: (value: string) => void;
  onTagsChange: (value: string) => void;
  onSave: () => void;
  onEdit: (annotation: WebRuntimeAnnotation) => void;
  onDelete: (id: string) => void;
  onCancelEdit: () => void;
}) {
  return (
    <DetailSection title="Annotations">
      {props.annotations.length > 0 ? (
        <div className="space-y-1.5">
          {props.annotations.map((annotation) => (
            <div key={annotation.id} className="rounded-md bg-muted/25 p-2 text-xs">
              <p className="whitespace-pre-wrap break-words">{annotation.body}</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-1">
                {annotation.tags.map((tag) => (
                  <Badge key={tag} variant="outline" className="text-[9px]">
                    {tag}
                  </Badge>
                ))}
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  className="ml-auto"
                  onClick={() => props.onEdit(annotation)}
                >
                  Edit
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={() => props.onDelete(annotation.id)}
                >
                  Delete
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
      <Textarea
        value={props.note}
        onChange={(event) => props.onNoteChange(event.target.value)}
        placeholder="Add a concise observation or next step…"
        className="min-h-20 text-xs"
      />
      <Input
        value={props.tags}
        onChange={(event) => props.onTagsChange(event.target.value)}
        placeholder="Tags, comma separated"
        className="h-7 text-xs"
      />
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          className="gap-1.5"
          disabled={props.disabled || !props.note.trim()}
          onClick={props.onSave}
        >
          <Send className="size-3.5" />
          {props.editingId ? "Update note" : "Save note"}
        </Button>
        {props.editingId ? (
          <Button type="button" size="sm" variant="ghost" onClick={props.onCancelEdit}>
            Cancel
          </Button>
        ) : null}
      </div>
    </DetailSection>
  );
}

export function WebSecurityPanel({ environmentId }: WebSecurityPanelProps) {
  const environment = useEnvironment(environmentId);
  const browserIntegrationLocal =
    environment !== null &&
    (environment.entry.target._tag === "PrimaryConnectionTarget" ||
      isDesktopLocalConnectionTarget(environment.entry.target));
  const [tab, setTab] = useState<WebTab>("traffic");
  const [status, setStatus] = useState<WebRuntimeHealth>(EMPTY_STATUS);
  const [sessions, setSessions] = useState<readonly WebRuntimeCaptureSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [traffic, setTraffic] = useState<readonly WebRuntimeTrafficSummary[]>([]);
  const [trafficNextCursor, setTrafficNextCursor] = useState<string | null>(null);
  const [webSockets, setWebSockets] = useState<readonly WebRuntimeWebSocketEventSummary[]>([]);
  const [webSocketNextCursor, setWebSocketNextCursor] = useState<string | null>(null);
  const [selectedWebSocketId, setSelectedWebSocketId] = useState<string | null>(null);
  const [selectedWebSocket, setSelectedWebSocket] = useState<WebRuntimeWebSocketEventDetail | null>(
    null,
  );
  const [gaps, setGaps] = useState<readonly WebRuntimeCaptureGap[]>([]);
  const [graphNodes, setGraphNodes] = useState<readonly WebRuntimeGraphNode[]>([]);
  const [graphEdges, setGraphEdges] = useState<readonly WebRuntimeGraphEdge[]>([]);
  const [selectedGraphNodeId, setSelectedGraphNodeId] = useState<string | null>(null);
  const [selectedExchange, setSelectedExchange] = useState<WebRuntimeExchangeDetail | null>(null);
  const [selectedTrafficId, setSelectedTrafficId] = useState<string | null>(null);
  const [bodyText, setBodyText] = useState<Record<string, string>>({});
  const [profiles, setProfiles] = useState<readonly DesktopPreviewBrowserProfile[]>([]);
  const [profileId, setProfileId] = useState<DesktopPreviewBrowserProfileId | null>(
    DEFAULT_DESKTOP_PREVIEW_BROWSER_PROFILE_ID,
  );
  const [extensionBrowser, setExtensionBrowser] = useState<"chromium" | "firefox">("chromium");
  const [extensionHelpOpen, setExtensionHelpOpen] = useState(false);
  const [captureLabel, setCaptureLabel] = useState("Web capture");
  const [upstreamTlsMode, setUpstreamTlsMode] = useState<UpstreamTlsMode>("verify");
  const [upstreamCaPem, setUpstreamCaPem] = useState("");
  const [upstreamTlsOverrideDirty, setUpstreamTlsOverrideDirty] = useState(false);
  const [search, setSearch] = useState("");
  const [method, setMethod] = useState("");
  const [trafficHost, setTrafficHost] = useState("");
  const [trafficPath, setTrafficPath] = useState("");
  const [trafficStatus, setTrafficStatus] = useState("");
  const [webSocketKind, setWebSocketKind] = useState("");
  const [webSocketDirection, setWebSocketDirection] = useState("");
  const [webSocketConnection, setWebSocketConnection] = useState("");
  const [mapKind, setMapKind] = useState("");
  const [scopeFilter, setScopeFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingMore, setLoadingMore] = useState<"traffic" | "websockets" | null>(null);
  const [pairing, setPairing] = useState<WebRuntimeExtensionPairing | null>(null);
  const [note, setNote] = useState("");
  const [noteTags, setNoteTags] = useState("");
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(null);
  const [annotations, setAnnotations] = useState<readonly WebRuntimeAnnotation[]>([]);
  const [replayOpen, setReplayOpen] = useState(false);
  const [replaySessionId, setReplaySessionId] = useState("");
  const [replayMethod, setReplayMethod] = useState("");
  const [replayUrl, setReplayUrl] = useState("");
  const [replayOverrideHeaders, setReplayOverrideHeaders] = useState(false);
  const [replayHeaders, setReplayHeaders] = useState("");
  const [replayOverrideBody, setReplayOverrideBody] = useState(false);
  const [replayBody, setReplayBody] = useState("");
  const [replayFollowRedirects, setReplayFollowRedirects] = useState(false);
  const [scopeName, setScopeName] = useState("Web target");
  const [scopes, setScopes] = useState<readonly WebRuntimeScopeProfile[]>([]);
  const [selectedScopeId, setSelectedScopeId] = useState<string | null>(null);
  const [scopeRules, setScopeRules] = useState<ScopeRuleDraft[]>(() => [
    createScopeRuleDraft({
      action: "include",
      matcher: "host_wildcard",
      pattern: "*.example.com",
      enabled: true,
    }),
  ]);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const scopeInitializedRef = useRef(false);
  const trafficExtendedRef = useRef(false);
  const webSocketsExtendedRef = useRef(false);
  const evidenceContextGenerationRef = useRef(0);
  const evidenceRefreshRequestRef = useRef(0);
  const refreshRequestRef = useRef(0);
  const runtimeRestartCountRef = useRef<number | null>(null);
  const sessionsRef = useRef<readonly WebRuntimeCaptureSession[]>([]);
  const graphSelectionRequestRef = useRef(0);
  const invalidateEvidenceRequests = useCallback(() => {
    evidenceContextGenerationRef.current += 1;
    evidenceRefreshRequestRef.current += 1;
  }, []);
  const selectedTrafficRequestRef = useRef<string | null>(null);
  const selectedWebSocketRequestRef = useRef<string | null>(null);

  const getStatus = useAtomQueryRunner(webRuntimeEnvironment.status, { reportFailure: false });
  const listSessions = useAtomQueryRunner(webRuntimeEnvironment.sessions, { reportFailure: false });
  const listScopes = useAtomQueryRunner(webRuntimeEnvironment.scopes, { reportFailure: false });
  const listTraffic = useAtomQueryRunner(webRuntimeEnvironment.traffic, { reportFailure: false });
  const getExchange = useAtomQueryRunner(webRuntimeEnvironment.exchange, { reportFailure: false });
  const readBody = useAtomQueryRunner(webRuntimeEnvironment.body, { reportFailure: false });
  const listWebSockets = useAtomQueryRunner(webRuntimeEnvironment.webSockets, {
    reportFailure: false,
  });
  const getWebSocket = useAtomQueryRunner(webRuntimeEnvironment.webSocketEvent, {
    reportFailure: false,
  });
  const listGaps = useAtomQueryRunner(webRuntimeEnvironment.gaps, { reportFailure: false });
  const getMap = useAtomQueryRunner(webRuntimeEnvironment.map, { reportFailure: false });
  const getNeighborhood = useAtomQueryRunner(webRuntimeEnvironment.neighborhood, {
    reportFailure: false,
  });
  const listAnnotations = useAtomQueryRunner(webRuntimeEnvironment.annotations, {
    reportFailure: false,
  });
  const createSession = useAtomCommand(webRuntimeEnvironment.createSession, {
    reportFailure: false,
  });
  const createPairing = useAtomCommand(webRuntimeEnvironment.createExtensionPairing, {
    reportFailure: false,
  });
  const endSession = useAtomCommand(webRuntimeEnvironment.endSession, { reportFailure: false });
  const startProxy = useAtomCommand(webRuntimeEnvironment.startProxy, { reportFailure: false });
  const stopProxy = useAtomCommand(webRuntimeEnvironment.stopProxy, { reportFailure: false });
  const deleteSession = useAtomCommand(webRuntimeEnvironment.deleteSession, {
    reportFailure: false,
  });
  const saveScope = useAtomCommand(webRuntimeEnvironment.saveScope, { reportFailure: false });
  const updateScope = useAtomCommand(webRuntimeEnvironment.updateScope, { reportFailure: false });
  const deleteScope = useAtomCommand(webRuntimeEnvironment.deleteScope, { reportFailure: false });
  const annotate = useAtomCommand(webRuntimeEnvironment.annotate, { reportFailure: false });
  const updateAnnotation = useAtomCommand(webRuntimeEnvironment.updateAnnotation, {
    reportFailure: false,
  });
  const deleteAnnotation = useAtomCommand(webRuntimeEnvironment.deleteAnnotation, {
    reportFailure: false,
  });
  const replay = useAtomCommand(webRuntimeEnvironment.replay, { reportFailure: false });

  const refreshProfiles = useCallback(async () => {
    if (!previewBridge) return;
    try {
      const nextProfiles = await previewBridge.browserProfiles.list();
      setProfiles(nextProfiles);
      setProfileId((current) =>
        current === null || nextProfiles.some((profile) => profile.id === current)
          ? current
          : DEFAULT_DESKTOP_PREVIEW_BROWSER_PROFILE_ID,
      );
      setProfileError(null);
    } catch (error) {
      setProfileError(
        error instanceof Error ? error.message : "Could not load the browser profiles.",
      );
    }
  }, []);

  const refresh = useCallback(async () => {
    const requestId = refreshRequestRef.current + 1;
    refreshRequestRef.current = requestId;
    void refreshProfiles();
    const target = { environmentId, input: {} } as const;
    const [nextStatus, nextSessions, nextScopes] = await Promise.all([
      getStatus(target),
      listSessions(target),
      listScopes(target),
    ]);
    if (requestId !== refreshRequestRef.current) return;
    const errors: string[] = [];
    if (nextStatus._tag === "Success") {
      const currentSessions =
        nextSessions._tag === "Success" ? nextSessions.value : sessionsRef.current;
      const cleanup = runtimeRestartCleanup(
        runtimeRestartCountRef.current,
        nextStatus.value.restartCount,
        [...sessionsRef.current, ...currentSessions],
      );
      runtimeRestartCountRef.current = nextStatus.value.restartCount;
      if (cleanup.restarted) {
        setPairing(null);
        invalidateEvidenceRequests();
      }
      setStatus(nextStatus.value);
    } else errors.push(`Runtime: ${commandError(nextStatus)}`);
    if (nextSessions._tag === "Success") {
      sessionsRef.current = nextSessions.value;
      setSessions(nextSessions.value);
      setSelectedSessionId((current) => {
        if (current && nextSessions.value.some((session) => session.id === current)) return current;
        return (
          nextSessions.value.find((session) => session.endedAt === null)?.id ??
          nextSessions.value[0]?.id ??
          null
        );
      });
    } else errors.push(`Sessions: ${commandError(nextSessions)}`);
    if (nextScopes._tag === "Success") {
      setScopes(nextScopes.value);
      const firstScope = nextScopes.value[0];
      if (!scopeInitializedRef.current && firstScope) {
        scopeInitializedRef.current = true;
        setSelectedScopeId(firstScope.id);
        setScopeName(firstScope.name);
        setScopeRules(
          firstScope.rules.map((rule) => ({
            draftId: rule.id,
            action: rule.action,
            matcher: rule.matcher,
            pattern: rule.pattern,
            enabled: rule.enabled,
          })),
        );
      }
    } else errors.push(`Scopes: ${commandError(nextScopes)}`);
    if (nextStatus._tag === "Success" && nextStatus.value.lastError) {
      errors.push(nextStatus.value.lastError);
    }
    setRefreshError(errors.length > 0 ? errors.join(" ") : null);
  }, [
    environmentId,
    getStatus,
    invalidateEvidenceRequests,
    listScopes,
    listSessions,
    refreshProfiles,
  ]);

  const refreshEvidence = useCallback(async () => {
    const contextGeneration = evidenceContextGenerationRef.current;
    const requestId = evidenceRefreshRequestRef.current + 1;
    evidenceRefreshRequestRef.current = requestId;
    const sessionId = selectedSessionId ?? undefined;
    const graphRequest = selectedGraphNodeId
      ? getNeighborhood({
          environmentId,
          input: {
            id: selectedGraphNodeId,
            ...(sessionId ? { sessionId } : {}),
            inScopeOnly: false,
            ...(scopeFilter
              ? { scope: scopeFilter as "in_scope" | "out_of_scope" | "unknown" }
              : {}),
          },
        })
      : getMap({
          environmentId,
          input: {
            ...(sessionId ? { sessionId } : {}),
            limit: EVIDENCE_PAGE_SIZE,
            ...(search.trim() ? { text: search.trim() } : {}),
            ...(mapKind ? { kind: mapKind } : {}),
            inScopeOnly: false,
            ...(scopeFilter
              ? { scope: scopeFilter as "in_scope" | "out_of_scope" | "unknown" }
              : {}),
          },
        });
    const [nextTraffic, nextSockets, nextGaps, nextGraph] = await Promise.all([
      listTraffic({
        environmentId,
        input: {
          ...(sessionId ? { sessionId } : {}),
          limit: EVIDENCE_PAGE_SIZE,
          ...(search.trim() ? { text: search.trim() } : {}),
          ...(method ? { method } : {}),
          ...(trafficHost.trim() ? { host: trafficHost.trim() } : {}),
          ...(trafficPath.trim() ? { path: trafficPath.trim() } : {}),
          ...(trafficStatus ? { status: Number(trafficStatus) } : {}),
          ...(scopeFilter ? { scope: scopeFilter } : {}),
        },
      }),
      listWebSockets({
        environmentId,
        input: {
          ...(sessionId ? { sessionId } : {}),
          limit: EVIDENCE_PAGE_SIZE,
          ...(search.trim() ? { text: search.trim() } : {}),
          ...(webSocketKind ? { kind: webSocketKind } : {}),
          ...(webSocketDirection ? { direction: webSocketDirection } : {}),
          ...(webSocketConnection.trim() ? { connectionId: webSocketConnection.trim() } : {}),
          ...(scopeFilter ? { scope: scopeFilter } : {}),
        },
      }),
      listGaps({
        environmentId,
        input: { ...(sessionId ? { sessionId } : {}), limit: 100 },
      }),
      graphRequest,
    ]);
    if (
      contextGeneration !== evidenceContextGenerationRef.current ||
      requestId !== evidenceRefreshRequestRef.current
    ) {
      return;
    }
    const errors: string[] = [];
    if (nextTraffic._tag === "Success") {
      setTraffic((current) =>
        trafficExtendedRef.current
          ? mergeEvidenceById(nextTraffic.value.items, current)
          : nextTraffic.value.items,
      );
      if (!trafficExtendedRef.current) setTrafficNextCursor(nextTraffic.value.nextCursor);
    } else errors.push(`Traffic: ${commandError(nextTraffic)}`);
    if (nextSockets._tag === "Success") {
      setWebSockets((current) =>
        webSocketsExtendedRef.current
          ? mergeEvidenceById(nextSockets.value.items, current)
          : nextSockets.value.items,
      );
      if (!webSocketsExtendedRef.current) setWebSocketNextCursor(nextSockets.value.nextCursor);
    } else errors.push(`WebSockets: ${commandError(nextSockets)}`);
    if (nextGaps._tag === "Success") setGaps(nextGaps.value);
    else errors.push(`Gaps: ${commandError(nextGaps)}`);
    if (nextGraph._tag === "Success") {
      setGraphNodes(nextGraph.value.nodes);
      setGraphEdges(
        "edges" in nextGraph.value ? (nextGraph.value.edges as readonly WebRuntimeGraphEdge[]) : [],
      );
    } else errors.push(`Map: ${commandError(nextGraph)}`);
    setEvidenceError(errors.length > 0 ? errors.join(" ") : null);
  }, [
    environmentId,
    getMap,
    getNeighborhood,
    listGaps,
    listTraffic,
    listWebSockets,
    mapKind,
    method,
    scopeFilter,
    search,
    selectedGraphNodeId,
    selectedSessionId,
    trafficHost,
    trafficPath,
    trafficStatus,
    webSocketConnection,
    webSocketDirection,
    webSocketKind,
  ]);

  useEffect(() => {
    invalidateEvidenceRequests();
    trafficExtendedRef.current = false;
    webSocketsExtendedRef.current = false;
    selectedTrafficRequestRef.current = null;
    selectedWebSocketRequestRef.current = null;
    setTraffic([]);
    setTrafficNextCursor(null);
    setWebSockets([]);
    setWebSocketNextCursor(null);
    setSelectedTrafficId(null);
    setSelectedExchange(null);
    setSelectedWebSocketId(null);
    setSelectedWebSocket(null);
    setSelectedGraphNodeId(null);
    setAnnotations([]);
    setNote("");
    setNoteTags("");
    setEditingAnnotationId(null);
    setReplayOpen(false);
    graphSelectionRequestRef.current += 1;
    setGraphEdges([]);
    setEvidenceError(null);
  }, [
    environmentId,
    invalidateEvidenceRequests,
    mapKind,
    method,
    scopeFilter,
    search,
    selectedSessionId,
    trafficHost,
    trafficPath,
    trafficStatus,
    webSocketConnection,
    webSocketDirection,
    webSocketKind,
  ]);

  useEffect(() => {
    refreshRequestRef.current += 1;
    runtimeRestartCountRef.current = null;
    sessionsRef.current = [];
    setPairing(null);
    scopeInitializedRef.current = false;
    setSelectedScopeId(null);
    setScopes([]);
    setScopeName("Web target");
    setScopeRules([
      createScopeRuleDraft({
        action: "include",
        matcher: "host_wildcard",
        pattern: "*.example.com",
        enabled: true,
      }),
    ]);
  }, [environmentId]);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  useEffect(() => {
    void refreshEvidence();
    const interval = window.setInterval(() => void refreshEvidence(), 2_000);
    return () => window.clearInterval(interval);
  }, [refreshEvidence]);

  useEffect(() => {
    setPairing(null);
  }, [selectedSessionId]);

  const activeSession = sessions.find((session) => session.id === selectedSessionId) ?? null;
  const activeCaptureSessions = sessions.filter((session) => session.endedAt === null);
  const selectedGraphNode = graphNodes.find((node) => node.id === selectedGraphNodeId) ?? null;
  const profileCaptureState =
    profileId === null
      ? ({ kind: "idle" } as const)
      : resolveBrowserProfileCaptureState(sessions, profileId);
  const resumableSession =
    profileCaptureState.kind === "resume" ? profileCaptureState.session : null;
  useEffect(() => {
    setUpstreamTlsOverrideDirty(false);
    setUpstreamCaPem("");
    if (resumableSession) setUpstreamTlsMode(resumableSession.upstreamTlsMode);
  }, [profileId, resumableSession?.id, resumableSession?.upstreamTlsMode]);
  const selectedUpstreamTls = (): WebRuntimeUpstreamTls => {
    if (upstreamTlsMode === "customCa") {
      const caPem = upstreamCaPem.trim();
      if (!caPem) throw new Error("Paste the upstream CA PEM before starting the proxy.");
      return { mode: "customCa", caPem };
    }
    return { mode: upstreamTlsMode };
  };

  const resumeCapture = async (session: WebRuntimeCaptureSession) => {
    if (profileId === null || !previewBridge) return;
    setBusy(true);
    try {
      const resumed = await startProxy({
        environmentId,
        input: {
          id: session.id,
          ...(upstreamTlsOverrideDirty ? { upstreamTls: selectedUpstreamTls() } : {}),
        },
      });
      if (resumed._tag === "Failure") throw new Error(commandError(resumed));
      if (!resumed.value.session.proxy || !resumed.value.caPem) {
        throw new Error("The capture proxy did not return its connection details.");
      }
      try {
        await previewBridge.configureProxy(
          environmentId,
          {
            proxyUrl: resumed.value.session.proxy.url,
            caCertificatePem: resumed.value.caPem,
          },
          profileId,
        );
      } catch (error) {
        const rollback = await stopProxy({ environmentId, input: { id: session.id } });
        if (rollback._tag === "Failure") {
          throw captureRollbackFailure(error, new Error(commandError(rollback)));
        }
        throw error;
      }
      setSelectedSessionId(session.id);
      setPairing(null);
      setUpstreamTlsOverrideDirty(false);
      await refresh();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not resume capture",
        description: error instanceof Error ? error.message : "The operation failed.",
      });
    } finally {
      setBusy(false);
    }
  };

  const startCapture = async () => {
    if (!browserIntegrationLocal) {
      toastManager.add({
        type: "error",
        title: "Browser capture needs a local web runtime",
        description:
          "This environment has no tunnel from its loopback capture proxy to this device.",
      });
      return;
    }
    if (profileId !== null && profileCaptureState.kind === "capturing") {
      setSelectedSessionId(profileCaptureState.session.id);
      toastManager.add({
        type: "warning",
        title: "This browser session is already being captured",
      });
      return;
    }
    if (profileId !== null && profileCaptureState.kind === "resume") {
      await resumeCapture(profileCaptureState.session);
      return;
    }
    if (profileId !== null && !previewBridge) {
      toastManager.add({
        type: "error",
        title: "The desktop browser is not available",
      });
      return;
    }
    setBusy(true);
    try {
      const captureSource = captureSourceConfiguration(profileId, extensionBrowser);
      const result = await createSession({
        environmentId,
        input: {
          label: captureLabel.trim() || "Web capture",
          source: captureSource.source,
          ...(selectedScopeId ? { scopeProfileId: selectedScopeId } : {}),
          proxy: captureSource.proxy,
          ...(captureSource.proxy ? { upstreamTls: selectedUpstreamTls() } : {}),
        },
      });
      if (result._tag === "Failure") throw new Error(commandError(result));
      const created = result.value;
      if (profileId !== null && previewBridge) {
        try {
          if (!created.session.proxy || !created.caPem) {
            throw new Error("The capture proxy did not return its connection details.");
          }
          await previewBridge.configureProxy(
            environmentId,
            {
              proxyUrl: created.session.proxy.url,
              caCertificatePem: created.caPem,
            },
            profileId,
          );
        } catch (error) {
          const rollback = await endSession({
            environmentId,
            input: { id: created.session.id },
          });
          if (rollback._tag === "Failure") {
            throw captureRollbackFailure(error, new Error(commandError(rollback)));
          }
          throw error;
        }
      }
      setSelectedSessionId(created.session.id);
      setPairing(null);
      if (profileId === null) {
        const nextPairing = await createPairing({
          environmentId,
          input: { sessionId: created.session.id },
        });
        if (nextPairing._tag === "Success") setPairing(nextPairing.value);
        else showOperationFailure("Capture started, but extension pairing failed", nextPairing);
      }
      await refresh();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not start capture",
        description: error instanceof Error ? error.message : "The operation failed.",
      });
    } finally {
      setBusy(false);
    }
  };

  const stopCapture = async (session: WebRuntimeCaptureSession) => {
    setBusy(true);
    try {
      const bridge = previewBridge;
      let restoreProxy: {
        profileId: DesktopPreviewBrowserProfileId;
        proxyUrl: string;
        caCertificatePem: string;
      } | null = null;
      if (session.source.startsWith("browser:")) {
        if (!bridge) throw new Error("The desktop browser is not available.");
        const sessionProfileId = session.source.slice(
          "browser:".length,
        ) as DesktopPreviewBrowserProfileId;
        if (session.proxy !== null) {
          const currentProxy = await startProxy({ environmentId, input: { id: session.id } });
          if (currentProxy._tag === "Failure") throw new Error(commandError(currentProxy));
          if (!currentProxy.value.session.proxy || !currentProxy.value.caPem) {
            throw new Error("The capture proxy did not return its connection details.");
          }
          restoreProxy = {
            profileId: sessionProfileId,
            proxyUrl: currentProxy.value.session.proxy.url,
            caCertificatePem: currentProxy.value.caPem,
          };
        }
      }
      await endCaptureAfterProxyClear({
        clearProxy: async () => {
          if (session.source.startsWith("browser:") && bridge) {
            const sessionProfileId = session.source.slice(
              "browser:".length,
            ) as DesktopPreviewBrowserProfileId;
            await bridge.configureProxy(environmentId, null, sessionProfileId);
          }
        },
        endCapture: async () => {
          const result = await endSession({ environmentId, input: { id: session.id } });
          if (result._tag === "Failure") throw new Error(commandError(result));
        },
        ...(restoreProxy && bridge
          ? {
              restoreProxy: async () => {
                await bridge.configureProxy(
                  environmentId,
                  {
                    proxyUrl: restoreProxy.proxyUrl,
                    caCertificatePem: restoreProxy.caCertificatePem,
                  },
                  restoreProxy.profileId,
                );
              },
            }
          : {}),
      });
      setPairing(null);
      await refresh();
      await refreshEvidence();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not stop capture",
        description: error instanceof Error ? error.message : "The operation failed.",
      });
    } finally {
      setBusy(false);
    }
  };

  const deleteCapture = async (session: WebRuntimeCaptureSession) => {
    if (!window.confirm(`Delete capture “${session.label}” and its stored evidence?`)) return;
    const result = await deleteSession({ environmentId, input: { id: session.id } });
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Could not delete capture",
        description: commandError(result),
      });
      return;
    }
    setSelectedSessionId(null);
    setPairing(null);
    setSelectedExchange(null);
    setSelectedTrafficId(null);
    setSelectedWebSocket(null);
    setSelectedWebSocketId(null);
    await refresh();
    await refreshEvidence();
  };

  const selectTraffic = async (item: WebRuntimeTrafficSummary) => {
    selectedTrafficRequestRef.current = item.id;
    setSelectedTrafficId(item.id);
    setSelectedExchange(null);
    setAnnotations([]);
    setNote("");
    setNoteTags("");
    setEditingAnnotationId(null);
    setReplayOpen(false);
    const [result, notes] = await Promise.all([
      getExchange({ environmentId, input: { id: item.id } }),
      listAnnotations({
        environmentId,
        input: { targetType: "observation", targetId: item.id, limit: 100 },
      }),
    ]);
    if (selectedTrafficRequestRef.current !== item.id) return;
    if (result._tag === "Success") {
      setSelectedExchange(result.value);
      setReplayMethod(result.value.summary.method);
      setReplayUrl(result.value.summary.url);
      setReplayHeaders(
        result.value.requestHeaders.map((header) => `${header.name}: ${header.value}`).join("\n"),
      );
      setReplayOverrideHeaders(false);
      setReplayBody("");
      setReplayOverrideBody(false);
      setReplayFollowRedirects(false);
      setReplaySessionId(
        activeSession?.endedAt === null ? activeSession.id : (activeCaptureSessions[0]?.id ?? ""),
      );
    } else showOperationFailure("Could not load request details", result);
    if (notes._tag === "Success") setAnnotations(notes.value);
    else showOperationFailure("Could not load annotations", notes);
  };

  const loadBody = async (hash: string) => {
    if (bodyText[hash] !== undefined) return;
    const result = await readBody({ environmentId, input: { hash } });
    if (result._tag === "Success") {
      setBodyText((current) => ({ ...current, [hash]: decodeBody(result.value.dataBase64) }));
    } else showOperationFailure("Could not load body", result);
  };

  const loadMoreTraffic = async () => {
    if (!trafficNextCursor || loadingMore) return;
    const contextGeneration = evidenceContextGenerationRef.current;
    setLoadingMore("traffic");
    const result = await listTraffic({
      environmentId,
      input: {
        ...(selectedSessionId ? { sessionId: selectedSessionId } : {}),
        cursor: trafficNextCursor,
        limit: EVIDENCE_PAGE_SIZE,
        ...(search.trim() ? { text: search.trim() } : {}),
        ...(method ? { method } : {}),
        ...(trafficHost.trim() ? { host: trafficHost.trim() } : {}),
        ...(trafficPath.trim() ? { path: trafficPath.trim() } : {}),
        ...(trafficStatus ? { status: Number(trafficStatus) } : {}),
        ...(scopeFilter ? { scope: scopeFilter } : {}),
      },
    });
    if (contextGeneration !== evidenceContextGenerationRef.current) {
      setLoadingMore(null);
      return;
    }
    if (result._tag === "Success") {
      trafficExtendedRef.current = true;
      setTraffic((current) => mergeEvidenceById(current, result.value.items));
      setTrafficNextCursor(result.value.nextCursor);
    } else showOperationFailure("Could not load more traffic", result);
    setLoadingMore(null);
  };

  const loadMoreWebSockets = async () => {
    if (!webSocketNextCursor || loadingMore) return;
    const contextGeneration = evidenceContextGenerationRef.current;
    setLoadingMore("websockets");
    const result = await listWebSockets({
      environmentId,
      input: {
        ...(selectedSessionId ? { sessionId: selectedSessionId } : {}),
        cursor: webSocketNextCursor,
        limit: EVIDENCE_PAGE_SIZE,
        ...(search.trim() ? { text: search.trim() } : {}),
        ...(webSocketKind ? { kind: webSocketKind } : {}),
        ...(webSocketDirection ? { direction: webSocketDirection } : {}),
        ...(webSocketConnection.trim() ? { connectionId: webSocketConnection.trim() } : {}),
        ...(scopeFilter ? { scope: scopeFilter } : {}),
      },
    });
    if (contextGeneration !== evidenceContextGenerationRef.current) {
      setLoadingMore(null);
      return;
    }
    if (result._tag === "Success") {
      webSocketsExtendedRef.current = true;
      setWebSockets((current) => mergeEvidenceById(current, result.value.items));
      setWebSocketNextCursor(result.value.nextCursor);
    } else showOperationFailure("Could not load more WebSocket events", result);
    setLoadingMore(null);
  };

  const selectWebSocket = async (event: WebRuntimeWebSocketEventSummary) => {
    selectedWebSocketRequestRef.current = event.id;
    setSelectedWebSocketId(event.id);
    setSelectedWebSocket(null);
    setAnnotations([]);
    setNote("");
    setNoteTags("");
    setEditingAnnotationId(null);
    const [result, notes] = await Promise.all([
      getWebSocket({ environmentId, input: { id: event.id } }),
      listAnnotations({
        environmentId,
        input: { targetType: "websocket_event", targetId: event.id, limit: 100 },
      }),
    ]);
    if (selectedWebSocketRequestRef.current !== event.id) return;
    if (result._tag === "Success") setSelectedWebSocket(result.value);
    else showOperationFailure("Could not load WebSocket event", result);
    if (notes._tag === "Success") setAnnotations(notes.value);
    else showOperationFailure("Could not load annotations", notes);
  };

  const selectGraphNode = async (node: WebRuntimeGraphNode) => {
    const requestId = graphSelectionRequestRef.current + 1;
    graphSelectionRequestRef.current = requestId;
    evidenceRefreshRequestRef.current += 1;
    setSelectedGraphNodeId(node.id);
    setAnnotations([]);
    setNote("");
    setNoteTags("");
    setEditingAnnotationId(null);
    const [result, notes] = await Promise.all([
      getNeighborhood({
        environmentId,
        input: {
          id: node.id,
          ...(selectedSessionId ? { sessionId: selectedSessionId } : {}),
          inScopeOnly: false,
          ...(scopeFilter ? { scope: scopeFilter as "in_scope" | "out_of_scope" | "unknown" } : {}),
        },
      }),
      listAnnotations({
        environmentId,
        input: { targetType: "graph_node", targetId: node.id, limit: 100 },
      }),
    ]);
    if (requestId !== graphSelectionRequestRef.current) return;
    if (result._tag === "Success") {
      setGraphNodes(result.value.nodes);
      setGraphEdges(result.value.edges);
    } else showOperationFailure("Could not load map neighborhood", result);
    if (notes._tag === "Success") setAnnotations(notes.value);
    else showOperationFailure("Could not load annotations", notes);
  };

  const makePairing = async () => {
    if (!selectedSessionId) return;
    setPairing(null);
    const result = await createPairing({
      environmentId,
      input: { sessionId: selectedSessionId },
    });
    if (result._tag === "Success") setPairing(result.value);
    else showOperationFailure("Could not pair the capture extension", result);
  };

  const openExtensionFolder = async () => {
    if (!previewBridge) return;
    try {
      const opened = await previewBridge.openCaptureExtensionFolder();
      if (!opened) {
        toastManager.add({
          type: "error",
          title: "Capture extension is not available in this build",
        });
      }
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not open the capture extension folder",
        description: error instanceof Error ? error.message : "The operation failed.",
      });
    }
  };

  const annotationTarget =
    tab === "traffic" && selectedExchange
      ? ({ targetType: "observation", targetId: selectedExchange.summary.id } as const)
      : tab === "websockets" && selectedWebSocket
        ? ({ targetType: "websocket_event", targetId: selectedWebSocket.summary.id } as const)
        : tab === "map" && selectedGraphNodeId
          ? ({ targetType: "graph_node", targetId: selectedGraphNodeId } as const)
          : null;

  const cancelAnnotationEdit = () => {
    setEditingAnnotationId(null);
    setNote("");
    setNoteTags("");
  };

  const editAnnotation = (annotation: WebRuntimeAnnotation) => {
    setEditingAnnotationId(annotation.id);
    setNote(annotation.body);
    setNoteTags(annotation.tags.join(", "));
  };

  const saveAnnotation = async () => {
    if (!annotationTarget || !note.trim()) return;
    const tags = parseAnnotationTags(noteTags);
    const result = editingAnnotationId
      ? await updateAnnotation({
          environmentId,
          input: { id: editingAnnotationId, body: note.trim(), tags },
        })
      : await annotate({
          environmentId,
          input: { ...annotationTarget, body: note.trim(), tags },
        });
    if (result._tag === "Success") {
      setAnnotations((current) =>
        editingAnnotationId
          ? current.map((annotation) =>
              annotation.id === editingAnnotationId ? result.value : annotation,
            )
          : [...current, result.value],
      );
      cancelAnnotationEdit();
      toastManager.add({
        type: "success",
        title: editingAnnotationId ? "Annotation updated" : "Annotation saved",
      });
    } else showOperationFailure("Could not save annotation", result);
  };

  const removeAnnotation = async (id: string) => {
    const result = await deleteAnnotation({ environmentId, input: { id } });
    if (result._tag === "Success") {
      setAnnotations((current) => current.filter((annotation) => annotation.id !== id));
      if (editingAnnotationId === id) cancelAnnotationEdit();
    } else showOperationFailure("Could not delete annotation", result);
  };

  const replaySelected = async () => {
    if (
      !selectedExchange ||
      !activeCaptureSessions.some((session) => session.id === replaySessionId) ||
      !replayMethod.trim() ||
      !replayUrl.trim()
    ) {
      return;
    }
    if (!URL.canParse(replayUrl)) {
      toastManager.add({ type: "error", title: "Replay URL must be absolute" });
      return;
    }
    const parsedHeaders = parseReplayHeaders(replayHeaders);
    if (replayOverrideHeaders && "error" in parsedHeaders) {
      toastManager.add({
        type: "error",
        title: "Could not parse replay headers",
        description: parsedHeaders.error,
      });
      return;
    }
    const result = await replay({
      environmentId,
      input: {
        observationId: selectedExchange.summary.id,
        sessionId: replaySessionId,
        method: replayMethod.trim(),
        url: replayUrl.trim(),
        followRedirects: replayFollowRedirects,
        ...(replayOverrideHeaders && "headers" in parsedHeaders
          ? { headers: parsedHeaders.headers }
          : {}),
        ...(replayOverrideBody
          ? {
              body: {
                encoding: "utf8" as const,
                data: replayBody,
                state: "complete" as const,
                originalSize: new TextEncoder().encode(replayBody).byteLength,
              },
            }
          : {}),
      },
    });
    if (result._tag === "Success") {
      toastManager.add({
        type: result.value.error ? "error" : "success",
        title: result.value.error ? "Replay failed" : "Request replayed",
        description: result.value.error ?? undefined,
      });
      await refreshEvidence();
    } else showOperationFailure("Could not replay request", result);
  };

  const persistScope = async () => {
    const rules = scopeRules.filter((rule) => rule.pattern.trim());
    if (!scopeName.trim() || rules.length === 0) return;
    const input = {
      name: scopeName.trim(),
      rules: rules.map((rule) => ({
        action: rule.action,
        matcher: rule.matcher,
        pattern: rule.pattern.trim(),
        enabled: rule.enabled,
      })),
    };
    const result = selectedScopeId
      ? await updateScope({ environmentId, input: { id: selectedScopeId, ...input } })
      : await saveScope({ environmentId, input });
    if (result._tag === "Success") {
      toastManager.add({ type: "success", title: "Scope saved" });
      if (!selectedScopeId && "id" in result.value) setSelectedScopeId(result.value.id);
      await refresh();
    } else showOperationFailure("Could not save scope", result);
  };

  const selectScope = (scopeId: string) => {
    setSelectedScopeId(scopeId || null);
    const scope = scopes.find((entry) => entry.id === scopeId);
    if (!scope) {
      setScopeName("New scope");
      setScopeRules([
        createScopeRuleDraft({ action: "include", matcher: "host", pattern: "", enabled: true }),
      ]);
      return;
    }
    setScopeName(scope.name);
    setScopeRules(
      scope.rules.map((rule) => ({
        draftId: rule.id,
        action: rule.action,
        matcher: rule.matcher,
        pattern: rule.pattern,
        enabled: rule.enabled,
      })),
    );
  };

  const removeSelectedScope = async () => {
    if (!selectedScopeId) return;
    const result = await deleteScope({ environmentId, input: { id: selectedScopeId } });
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Could not delete scope",
        description: commandError(result),
      });
      return;
    }
    setSelectedScopeId(null);
    setScopeName("New scope");
    setScopeRules([
      createScopeRuleDraft({ action: "include", matcher: "host", pattern: "", enabled: true }),
    ]);
    await refresh();
  };

  const sessionOptions = sessions.toSorted((left, right) =>
    right.startedAt.localeCompare(left.startedAt),
  );
  const statusTone =
    status.status === "healthy"
      ? "success"
      : status.status === "degraded" || status.status === "starting"
        ? "warning"
        : "error";
  const topError = [refreshError, profileError].filter(Boolean).join(" ") || null;
  const panelError = [topError, evidenceError].filter(Boolean).join(" ") || null;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background" data-web-security-panel>
      <div className="space-y-2 border-b border-border/60 p-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-primary" />
          <span className="font-semibold text-sm">Web pentest</span>
          <Badge variant={statusTone}>{status.status}</Badge>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="ml-auto"
            onClick={() => {
              void refresh();
              void refreshEvidence();
            }}
            aria-label="Refresh web evidence"
          >
            <RefreshCw className="size-3.5" />
          </Button>
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)_8rem_8rem_auto] gap-2">
          <Input
            value={captureLabel}
            onChange={(event) => setCaptureLabel(event.target.value)}
            placeholder="Capture label"
            className="h-7 text-xs"
          />
          <select
            value={profileId ?? `extension:${extensionBrowser}`}
            onChange={(event) => {
              if (event.target.value === "extension:chromium") {
                setProfileId(null);
                setExtensionBrowser("chromium");
                return;
              }
              if (event.target.value === "extension:firefox") {
                setProfileId(null);
                setExtensionBrowser("firefox");
                return;
              }
              setProfileId(event.target.value as DesktopPreviewBrowserProfileId);
            }}
            className="h-7 rounded-md border border-input bg-background px-2 text-xs"
            aria-label="Capture source"
          >
            <option value="extension:chromium">Chrome / Edge extension</option>
            <option value="extension:firefox">Firefox extension</option>
            {(profiles.length > 0
              ? profiles
              : [
                  {
                    id: DEFAULT_DESKTOP_PREVIEW_BROWSER_PROFILE_ID,
                    name: "Default",
                    isDefault: true,
                    createdAt: "",
                    updatedAt: "",
                  },
                ]
            ).map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
          <select
            value={upstreamTlsMode}
            onChange={(event) => {
              setUpstreamTlsMode(event.target.value as UpstreamTlsMode);
              setUpstreamTlsOverrideDirty(true);
            }}
            disabled={profileId === null && extensionBrowser === "chromium"}
            className="h-7 rounded-md border border-input bg-background px-2 text-xs"
            aria-label="Upstream HTTPS trust"
          >
            <option value="verify">Verify TLS</option>
            <option value="customCa">Lab CA</option>
            <option value="insecure">Accept invalid</option>
          </select>
          <Button
            type="button"
            size="sm"
            className="h-7 gap-1.5"
            disabled={
              busy ||
              profileCaptureState.kind === "capturing" ||
              status.status === "disabled" ||
              status.status === "unavailable" ||
              !browserIntegrationLocal
            }
            onClick={() => void startCapture()}
            aria-label={
              profileCaptureState.kind === "capturing"
                ? "This browser session already has an active capture"
                : profileCaptureState.kind === "resume"
                  ? "Resume web capture"
                  : profileId === null
                    ? "Start extension capture"
                    : "Start web capture"
            }
          >
            <Radio className="size-3.5" />
            {profileCaptureState.kind === "resume" ? "Resume" : "Capture"}
          </Button>
        </div>
        {(profileId !== null || extensionBrowser === "firefox") &&
        upstreamTlsMode === "customCa" &&
        upstreamTlsOverrideDirty ? (
          <Textarea
            value={upstreamCaPem}
            onChange={(event) => setUpstreamCaPem(event.target.value)}
            placeholder="-----BEGIN CERTIFICATE-----"
            className="min-h-16 font-mono text-[11px]"
            aria-label="Upstream CA PEM"
          />
        ) : (profileId !== null || extensionBrowser === "firefox") &&
          upstreamTlsMode === "customCa" &&
          profileCaptureState.kind === "resume" ? (
          <p className="text-[11px] text-muted-foreground">
            This capture will reuse its stored upstream CA.
          </p>
        ) : null}
        {(profileId !== null || extensionBrowser === "firefox") &&
        upstreamTlsMode === "insecure" ? (
          <div className="text-[11px] text-warning">
            This capture accepts invalid upstream certificates.
          </div>
        ) : null}

        {!browserIntegrationLocal ? (
          <p className="text-[11px] text-muted-foreground">
            Browser and extension capture need a local environment. Remote loopback proxies are not
            applied without a tunnel.
          </p>
        ) : null}

        <div className="flex items-center gap-2 text-[11px]">
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="gap-1"
            onClick={() => setExtensionHelpOpen((current) => !current)}
          >
            <FolderOpen className="size-3" />
            Install browser extension
          </Button>
          <span className="text-muted-foreground">
            Use an existing signed-in browser session as an agent-controlled capture source.
          </span>
        </div>
        {extensionHelpOpen ? (
          <div className="grid gap-3 rounded-md border border-border/60 bg-muted/20 p-3 text-[11px] md:grid-cols-2">
            <div className="space-y-1.5">
              <div className="font-semibold">Chrome, Edge, Brave</div>
              <ol className="list-decimal space-y-1 pl-4 text-muted-foreground">
                <li>Open the extensions page and enable Developer mode.</li>
                <li>Choose Load unpacked and select the folder opened by Erebus.</li>
                <li>
                  Start a Chrome / Edge extension capture, copy its pairing record, and import it in
                  the extension.
                </li>
              </ol>
            </div>
            <div className="space-y-1.5">
              <div className="font-semibold">Firefox</div>
              <ol className="list-decimal space-y-1 pl-4 text-muted-foreground">
                <li>Open about:debugging, choose This Firefox, then Load Temporary Add-on.</li>
                <li>Select firefox/manifest.json or the packaged XPI.</li>
                <li>
                  Start a Firefox extension capture, import its CA under Certificate Authorities,
                  then import the pairing record.
                </li>
              </ol>
            </div>
            <div className="flex gap-2 md:col-span-2">
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => void openExtensionFolder()}
              >
                <FolderOpen className="mr-1 size-3" />
                Open extension files
              </Button>
              {pairing?.caPem ? (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={() => downloadTextFile("erebus-capture-ca.pem", pairing.caPem!)}
                >
                  <Download className="mr-1 size-3" />
                  Download capture CA
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="flex items-center gap-2">
          <select
            value={selectedSessionId ?? ""}
            onChange={(event) => {
              invalidateEvidenceRequests();
              setSelectedSessionId(event.target.value || null);
              setSelectedTrafficId(null);
              setSelectedExchange(null);
              setSelectedGraphNodeId(null);
              setGraphEdges([]);
              setSelectedWebSocketId(null);
              setSelectedWebSocket(null);
              setPairing(null);
            }}
            className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs"
            aria-label="Capture session"
          >
            <option value="">All sessions</option>
            {sessionOptions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.endedAt === null ? "● " : ""}
                {session.label} · {shortTime(session.startedAt)}
              </option>
            ))}
          </select>
          {activeSession?.endedAt === null ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 gap-1.5"
              disabled={busy}
              onClick={() => void stopCapture(activeSession)}
            >
              <CircleStop className="size-3.5" />
              Stop
            </Button>
          ) : null}
          {activeSession?.endedAt !== null && activeSession ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7"
              onClick={() => void deleteCapture(activeSession)}
            >
              Delete
            </Button>
          ) : null}
          {activeSession?.endedAt === null ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 gap-1.5"
              onClick={() => void makePairing()}
            >
              <ExternalLink className="size-3.5" />
              Extension
            </Button>
          ) : null}
        </div>
      </div>

      {panelError ? (
        <div className="flex items-start gap-2 border-b border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="break-words">{panelError}</span>
        </div>
      ) : null}

      {pairing ? (
        <div className="flex items-center gap-2 border-b border-border/50 bg-muted/25 px-3 py-2 text-[11px]">
          <span className="min-w-0 flex-1 truncate font-mono">
            {pairing.serverUrl} · {pairing.sessionId}
          </span>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="gap-1"
            onClick={() => copyText(JSON.stringify(pairing), "Extension pairing copied")}
          >
            <Copy className="size-3" />
            Copy
          </Button>
          {pairing.caPem ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className="gap-1"
              onClick={() => downloadTextFile("erebus-capture-ca.pem", pairing.caPem!)}
            >
              <Download className="size-3" />
              CA
            </Button>
          ) : null}
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="gap-1"
            onClick={() => void openExtensionFolder()}
          >
            <FolderOpen className="size-3" />
            Load
          </Button>
        </div>
      ) : null}

      <CaptureGapNotice gaps={gaps} />

      <div className="flex items-center gap-1 border-b border-border/60 px-2 py-1.5">
        {(
          [
            ["traffic", "Traffic", Route],
            ["map", "Map", Network],
            ["websockets", "WebSockets", Radio],
            ["scope", "Scope", Filter],
          ] as const
        ).map(([id, label, Icon]) => (
          <Button
            key={id}
            type="button"
            variant={tab === id ? "secondary" : "ghost"}
            size="xs"
            className="gap-1.5"
            onClick={() => {
              if (tab === id) return;
              invalidateEvidenceRequests();
              setTab(id);
              setSelectedTrafficId(null);
              setSelectedExchange(null);
              setSelectedWebSocketId(null);
              setSelectedWebSocket(null);
              setSelectedGraphNodeId(null);
              setGraphEdges([]);
              setAnnotations([]);
              cancelAnnotationEdit();
              setReplayOpen(false);
            }}
          >
            <Icon className="size-3.5" />
            {label}
          </Button>
        ))}
      </div>

      {tab !== "scope" ? (
        <div className="space-y-2 border-b border-border/50 p-2">
          <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => {
                  invalidateEvidenceRequests();
                  setSearch(event.target.value);
                }}
                placeholder="Search URL, body, header, parameter…"
                className="h-7 pl-7 text-xs"
              />
            </div>
            <select
              value={scopeFilter}
              onChange={(event) => {
                invalidateEvidenceRequests();
                setScopeFilter(event.target.value);
              }}
              className="h-7 rounded-md border border-input bg-background px-1.5 text-xs"
              aria-label="Scope filter"
            >
              <option value="">All scope</option>
              <option value="in_scope">In scope</option>
              <option value="out_of_scope">Out of scope</option>
              <option value="unknown">Unknown</option>
            </select>
          </div>
          {tab === "traffic" ? (
            <div className="grid grid-cols-[5rem_minmax(7rem,1fr)_minmax(7rem,1fr)_5rem] gap-2">
              <select
                value={method}
                onChange={(event) => setMethod(event.target.value)}
                className="h-7 rounded-md border border-input bg-background px-1.5 text-xs"
                aria-label="HTTP method filter"
              >
                <option value="">Method</option>
                {["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
              <Input
                value={trafficHost}
                onChange={(event) => setTrafficHost(event.target.value)}
                placeholder="Host"
                className="h-7 text-xs"
              />
              <Input
                value={trafficPath}
                onChange={(event) => setTrafficPath(event.target.value)}
                placeholder="Path"
                className="h-7 text-xs"
              />
              <Input
                type="number"
                value={trafficStatus}
                onChange={(event) => setTrafficStatus(event.target.value)}
                placeholder="Status"
                className="h-7 text-xs"
              />
            </div>
          ) : null}
          {tab === "websockets" ? (
            <div className="grid grid-cols-[minmax(6rem,1fr)_8rem_minmax(8rem,1fr)] gap-2">
              <Input
                value={webSocketKind}
                onChange={(event) => setWebSocketKind(event.target.value)}
                placeholder="Kind (frame, open…)"
                className="h-7 text-xs"
              />
              <select
                value={webSocketDirection}
                onChange={(event) => setWebSocketDirection(event.target.value)}
                className="h-7 rounded-md border border-input bg-background px-1.5 text-xs"
                aria-label="WebSocket direction filter"
              >
                <option value="">Direction</option>
                <option value="client_to_server">Client → server</option>
                <option value="server_to_client">Server → client</option>
              </select>
              <Input
                value={webSocketConnection}
                onChange={(event) => setWebSocketConnection(event.target.value)}
                placeholder="Connection ID"
                className="h-7 text-xs"
              />
            </div>
          ) : null}
          {tab === "map" ? (
            <Input
              value={mapKind}
              onChange={(event) => setMapKind(event.target.value)}
              placeholder="Node kind (host, path, parameter…)"
              className="h-7 text-xs"
            />
          ) : null}
        </div>
      ) : null}

      {tab === "traffic" ? (
        <div className="flex min-h-0 flex-1">
          <div className={cn("flex min-h-0 flex-col", selectedExchange ? "w-[54%]" : "w-full")}>
            <VirtualTrafficList
              items={traffic}
              selectedId={selectedTrafficId}
              onSelect={(item) => void selectTraffic(item)}
            />
            {trafficNextCursor ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="m-2 h-7 shrink-0"
                disabled={loadingMore !== null}
                onClick={() => void loadMoreTraffic()}
              >
                {loadingMore === "traffic" ? "Loading…" : "Load older traffic"}
              </Button>
            ) : null}
          </div>
          {selectedExchange ? (
            <ScrollArea className="w-[46%] border-l border-border/60">
              <div className="space-y-5 p-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">{selectedExchange.summary.method}</Badge>
                    <span className="font-mono text-xs">
                      {selectedExchange.summary.status ?? "—"}
                    </span>
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      className="ml-auto gap-1"
                      disabled={activeCaptureSessions.length === 0}
                      onClick={() => setReplayOpen((current) => !current)}
                    >
                      <Play className="size-3" />
                      Replay
                    </Button>
                  </div>
                  <p className="break-all text-xs">{selectedExchange.summary.url}</p>
                </div>
                {replayOpen ? (
                  <DetailSection title="Replay request">
                    <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-2">
                      <Input
                        value={replayMethod}
                        onChange={(event) => setReplayMethod(event.target.value.toUpperCase())}
                        className="h-7 font-mono text-xs"
                        placeholder="Method"
                      />
                      <select
                        value={replaySessionId}
                        onChange={(event) => setReplaySessionId(event.target.value)}
                        className="h-7 rounded-md border border-input bg-background px-2 text-xs"
                        aria-label="Replay capture session"
                      >
                        <option value="">Active capture…</option>
                        {activeCaptureSessions.map((session) => (
                          <option key={session.id} value={session.id}>
                            {session.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <Input
                      value={replayUrl}
                      onChange={(event) => setReplayUrl(event.target.value)}
                      className="h-7 font-mono text-xs"
                      placeholder="https://target.example/path"
                    />
                    <label className="flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={replayOverrideHeaders}
                        onChange={(event) => setReplayOverrideHeaders(event.target.checked)}
                      />
                      Replace request headers
                    </label>
                    {replayOverrideHeaders ? (
                      <Textarea
                        value={replayHeaders}
                        onChange={(event) => setReplayHeaders(event.target.value)}
                        className="min-h-24 font-mono text-[11px]"
                        placeholder="Header-Name: value"
                      />
                    ) : null}
                    <label className="flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={replayOverrideBody}
                        onChange={(event) => setReplayOverrideBody(event.target.checked)}
                      />
                      Replace request body
                    </label>
                    {replayOverrideBody ? (
                      <Textarea
                        value={replayBody}
                        onChange={(event) => setReplayBody(event.target.value)}
                        className="min-h-28 font-mono text-[11px]"
                        placeholder="Request body"
                      />
                    ) : null}
                    <div className="flex items-center gap-3">
                      <label className="flex items-center gap-2 text-xs">
                        <input
                          type="checkbox"
                          checked={replayFollowRedirects}
                          onChange={(event) => setReplayFollowRedirects(event.target.checked)}
                        />
                        Follow redirects
                      </label>
                      <Button
                        type="button"
                        size="sm"
                        className="ml-auto gap-1.5"
                        disabled={
                          !activeCaptureSessions.some(
                            (session) => session.id === replaySessionId,
                          ) ||
                          !replayMethod.trim() ||
                          !replayUrl.trim()
                        }
                        onClick={() => void replaySelected()}
                      >
                        <Play className="size-3.5" />
                        Send replay
                      </Button>
                    </div>
                  </DetailSection>
                ) : null}
                <DetailSection title="Request headers">
                  <HeaderTable headers={selectedExchange.requestHeaders} />
                </DetailSection>
                {selectedExchange.requestBody ? (
                  <DetailSection title="Request body">
                    <div className="rounded-md bg-muted/25 p-2 font-mono text-[11px]">
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <span>{selectedExchange.requestBody.state}</span>
                        <span>{formatBytes(selectedExchange.requestBody.capturedSize)}</span>
                        {selectedExchange.requestBody.hash ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            className="ml-auto"
                            onClick={() => void loadBody(selectedExchange.requestBody!.hash!)}
                          >
                            Load
                          </Button>
                        ) : null}
                      </div>
                      {selectedExchange.requestBody.textPreview ||
                      (selectedExchange.requestBody.hash &&
                        bodyText[selectedExchange.requestBody.hash]) ? (
                        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all">
                          {selectedExchange.requestBody.hash &&
                          bodyText[selectedExchange.requestBody.hash]
                            ? bodyText[selectedExchange.requestBody.hash]
                            : selectedExchange.requestBody.textPreview}
                        </pre>
                      ) : null}
                    </div>
                  </DetailSection>
                ) : null}
                <DetailSection title="Response headers">
                  <HeaderTable headers={selectedExchange.responseHeaders} />
                </DetailSection>
                {selectedExchange.responseBody ? (
                  <DetailSection title="Response body">
                    <div className="rounded-md bg-muted/25 p-2 font-mono text-[11px]">
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <span>{selectedExchange.responseBody.state}</span>
                        <span>{formatBytes(selectedExchange.responseBody.capturedSize)}</span>
                        {selectedExchange.responseBody.hash ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            className="ml-auto"
                            onClick={() => void loadBody(selectedExchange.responseBody!.hash!)}
                          >
                            Load
                          </Button>
                        ) : null}
                      </div>
                      {selectedExchange.responseBody.textPreview ||
                      (selectedExchange.responseBody.hash &&
                        bodyText[selectedExchange.responseBody.hash]) ? (
                        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all">
                          {selectedExchange.responseBody.hash &&
                          bodyText[selectedExchange.responseBody.hash]
                            ? bodyText[selectedExchange.responseBody.hash]
                            : selectedExchange.responseBody.textPreview}
                        </pre>
                      ) : null}
                    </div>
                  </DetailSection>
                ) : null}
                <AnnotationEditor
                  annotations={annotations}
                  note={note}
                  tags={noteTags}
                  editingId={editingAnnotationId}
                  disabled={annotationTarget === null}
                  onNoteChange={setNote}
                  onTagsChange={setNoteTags}
                  onSave={() => void saveAnnotation()}
                  onEdit={editAnnotation}
                  onDelete={(id) => void removeAnnotation(id)}
                  onCancelEdit={cancelAnnotationEdit}
                />
              </div>
            </ScrollArea>
          ) : null}
        </div>
      ) : null}

      {tab === "map" ? (
        <div className="flex min-h-0 flex-1">
          <div className={cn("flex min-h-0", selectedGraphNodeId ? "w-[64%]" : "w-full")}>
            <GraphCanvas
              nodes={graphNodes}
              edges={graphEdges}
              selectedId={selectedGraphNodeId}
              onSelect={(node) => void selectGraphNode(node)}
            />
          </div>
          {selectedGraphNodeId ? (
            <ScrollArea className="w-[36%] border-l border-border/60">
              <div className="space-y-5 p-3">
                <div className="space-y-1">
                  <Badge variant="outline">{selectedGraphNode?.kind ?? "node"}</Badge>
                  <p className="break-all text-xs">
                    {selectedGraphNode?.label ?? selectedGraphNodeId}
                  </p>
                  {selectedGraphNode ? (
                    <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/25 p-2 text-[10px] text-muted-foreground">
                      {JSON.stringify(selectedGraphNode.metadata, null, 2)}
                    </pre>
                  ) : null}
                </div>
                <AnnotationEditor
                  annotations={annotations}
                  note={note}
                  tags={noteTags}
                  editingId={editingAnnotationId}
                  disabled={annotationTarget === null}
                  onNoteChange={setNote}
                  onTagsChange={setNoteTags}
                  onSave={() => void saveAnnotation()}
                  onEdit={editAnnotation}
                  onDelete={(id) => void removeAnnotation(id)}
                  onCancelEdit={cancelAnnotationEdit}
                />
              </div>
            </ScrollArea>
          ) : null}
        </div>
      ) : null}

      {tab === "websockets" ? (
        <div className="flex min-h-0 flex-1">
          <ScrollArea className={cn("min-h-0", selectedWebSocket ? "w-[58%]" : "w-full")}>
            <div className="divide-y divide-border/35">
              {webSockets.map((event) => (
                <button
                  key={event.id}
                  type="button"
                  onClick={() => void selectWebSocket(event)}
                  className={cn(
                    "grid w-full grid-cols-[5rem_4rem_minmax(0,1fr)_5rem] gap-2 px-3 py-2 text-left text-[11px] hover:bg-accent/50",
                    event.id === selectedWebSocketId && "bg-accent text-foreground",
                  )}
                >
                  <span className="font-mono text-muted-foreground">
                    {shortTime(event.capturedAt)}
                  </span>
                  <span className="font-semibold">{event.kind}</span>
                  <span className="truncate">{event.url ?? event.connectionId}</span>
                  <span className="text-right text-muted-foreground">
                    {formatBytes(event.payloadSize)}
                  </span>
                </button>
              ))}
              {webSockets.length === 0 ? (
                <div className="p-8 text-center text-xs text-muted-foreground">
                  No WebSocket events match this view.
                </div>
              ) : null}
              {webSocketNextCursor ? (
                <div className="p-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 w-full"
                    disabled={loadingMore !== null}
                    onClick={() => void loadMoreWebSockets()}
                  >
                    {loadingMore === "websockets" ? "Loading…" : "Load older WebSocket events"}
                  </Button>
                </div>
              ) : null}
            </div>
          </ScrollArea>
          {selectedWebSocket ? (
            <ScrollArea className="w-[42%] border-l border-border/60">
              <div className="space-y-5 p-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">{selectedWebSocket.summary.kind}</Badge>
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {selectedWebSocket.summary.direction ?? "event"}
                    </span>
                    {selectedWebSocket.summary.opcode !== null ? (
                      <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                        opcode {selectedWebSocket.summary.opcode}
                      </span>
                    ) : null}
                  </div>
                  <p className="break-all text-xs">
                    {selectedWebSocket.summary.url ?? selectedWebSocket.summary.connectionId}
                  </p>
                </div>
                {selectedWebSocket.payload ? (
                  <DetailSection title="Payload">
                    <div className="rounded-md bg-muted/25 p-2 font-mono text-[11px]">
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <span>{selectedWebSocket.payload.state}</span>
                        <span>{formatBytes(selectedWebSocket.payload.capturedSize)}</span>
                        {selectedWebSocket.payload.hash ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            className="ml-auto"
                            onClick={() => void loadBody(selectedWebSocket.payload!.hash!)}
                          >
                            Load
                          </Button>
                        ) : null}
                      </div>
                      {selectedWebSocket.payload.textPreview ||
                      (selectedWebSocket.payload.hash &&
                        bodyText[selectedWebSocket.payload.hash]) ? (
                        <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-all">
                          {selectedWebSocket.payload.hash &&
                          bodyText[selectedWebSocket.payload.hash]
                            ? bodyText[selectedWebSocket.payload.hash]
                            : selectedWebSocket.payload.textPreview}
                        </pre>
                      ) : null}
                    </div>
                  </DetailSection>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    This event has no captured payload.
                  </p>
                )}
                <AnnotationEditor
                  annotations={annotations}
                  note={note}
                  tags={noteTags}
                  editingId={editingAnnotationId}
                  disabled={annotationTarget === null}
                  onNoteChange={setNote}
                  onTagsChange={setNoteTags}
                  onSave={() => void saveAnnotation()}
                  onEdit={editAnnotation}
                  onDelete={(id) => void removeAnnotation(id)}
                  onCancelEdit={cancelAnnotationEdit}
                />
              </div>
            </ScrollArea>
          ) : null}
        </div>
      ) : null}

      {tab === "scope" ? (
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-4 p-4">
            <div>
              <h3 className="font-medium text-sm">Scope profile</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Rules run in order. The first match decides whether traffic enters the actionable
                map.
              </p>
            </div>
            <div className="flex gap-2">
              <select
                value={selectedScopeId ?? ""}
                onChange={(event) => selectScope(event.target.value)}
                className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs"
                aria-label="Scope profile"
              >
                <option value="">New scope</option>
                {scopes.map((scope) => (
                  <option key={scope.id} value={scope.id}>
                    {scope.name}
                  </option>
                ))}
              </select>
              <Button type="button" variant="outline" size="sm" onClick={() => selectScope("")}>
                New
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!selectedScopeId}
                onClick={() => void removeSelectedScope()}
              >
                Delete
              </Button>
            </div>
            <Input
              value={scopeName}
              onChange={(event) => setScopeName(event.target.value)}
              placeholder="Scope name"
            />
            <div className="space-y-2">
              {scopeRules.map((rule, index) => (
                <div
                  key={rule.draftId}
                  className={cn(
                    "grid grid-cols-[6rem_8rem_minmax(0,1fr)_3rem_auto] gap-2",
                    !rule.enabled && "opacity-60",
                  )}
                >
                  <select
                    value={rule.action}
                    onChange={(event) =>
                      setScopeRules((current) =>
                        current.map((entry, entryIndex) =>
                          entryIndex === index
                            ? { ...entry, action: event.target.value as "include" | "exclude" }
                            : entry,
                        ),
                      )
                    }
                    className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                  >
                    <option value="include">Include</option>
                    <option value="exclude">Exclude</option>
                  </select>
                  <select
                    value={rule.matcher}
                    onChange={(event) =>
                      setScopeRules((current) =>
                        current.map((entry, entryIndex) =>
                          entryIndex === index
                            ? {
                                ...entry,
                                matcher: event.target.value as typeof entry.matcher,
                              }
                            : entry,
                        ),
                      )
                    }
                    className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                  >
                    <option value="host">Host</option>
                    <option value="host_wildcard">Host wildcard</option>
                    <option value="url_wildcard">URL wildcard</option>
                    <option value="regex">Regex</option>
                    <option value="cidr">CIDR</option>
                  </select>
                  <Input
                    value={rule.pattern}
                    onChange={(event) =>
                      setScopeRules((current) =>
                        current.map((entry, entryIndex) =>
                          entryIndex === index ? { ...entry, pattern: event.target.value } : entry,
                        ),
                      )
                    }
                    className="h-8 font-mono text-xs"
                    placeholder="*.example.com"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    aria-pressed={rule.enabled}
                    onClick={() =>
                      setScopeRules((current) =>
                        current.map((entry, entryIndex) =>
                          entryIndex === index ? { ...entry, enabled: !entry.enabled } : entry,
                        ),
                      )
                    }
                  >
                    {rule.enabled ? "On" : "Off"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() =>
                      setScopeRules((current) =>
                        current.filter((_, entryIndex) => entryIndex !== index),
                      )
                    }
                  >
                    Remove
                  </Button>
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setScopeRules((current) => [
                    ...current,
                    createScopeRuleDraft({
                      action: "include",
                      matcher: "host" as const,
                      pattern: "",
                      enabled: true,
                    }),
                  ])
                }
              >
                Add rule
              </Button>
              <Button type="button" size="sm" onClick={() => void persistScope()}>
                Save scope
              </Button>
            </div>
            <div className="rounded-lg bg-muted/25 p-3 text-xs text-muted-foreground">
              <div className="mb-1 flex items-center gap-2 font-medium text-foreground">
                <Braces className="size-3.5" />
                Matchers
              </div>
              Exact hosts, host and URL wildcards, regular expressions, and CIDR ranges share the
              same ordered rule list.
            </div>
          </div>
        </ScrollArea>
      ) : null}
    </div>
  );
}
