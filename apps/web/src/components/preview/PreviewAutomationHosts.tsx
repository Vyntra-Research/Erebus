"use client";

import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  FILL_PREVIEW_VIEWPORT,
  PREVIEW_AUTOMATION_OPERATIONS,
  type DesktopPreviewBrowserProfileId,
  type DesktopPreviewProxyConfiguration,
  type EnvironmentId,
  type PreviewAutomationNavigateInput,
  type PreviewAutomationOpenInput,
  type PreviewAutomationResizeInput,
  type PreviewAutomationResizeResult,
  type PreviewAutomationSetColorSchemeInput,
  type PreviewAutomationSetColorSchemeResult,
  type PreviewAutomationHost as PreviewAutomationHostState,
  type PreviewAutomationRequest,
  type PreviewAutomationStatus,
  type PreviewRenderedViewportSize,
  type PreviewViewportSetting,
  type ScopedThreadRef,
  type WebRuntimeExtensionAutomationClient,
} from "@t3tools/contracts";
import { resolvePreviewViewport } from "@t3tools/shared/previewViewport";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Atom } from "effect/unstable/reactivity";

import {
  applyPreviewServerSnapshot,
  readThreadPreviewState,
  reconcilePreviewServerSessions,
  updatePreviewServerSnapshot,
} from "~/previewStateStore";
import { usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import { resolveBrowserNavigationTarget } from "~/browser/browserTargetResolver";
import { useBrowserProfileSelectionStore } from "~/browser/browserProfileSelectionStore";
import {
  readActiveBrowserRecordingTargets,
  startBrowserRecording,
  stopBrowserRecording,
} from "~/browser/browserRecording";
import { resolveBrowserRecordingStopTarget } from "~/browser/browserRecordingScope";
import { useBrowserSurfaceStore } from "~/browser/browserSurfaceStore";
import { browserDefaultOpenViewport, resolveBrowserDefaults } from "~/browser/browserDefaults";
import { runBrowserViewportMutation } from "~/browser/browserViewportActions";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { isElectron } from "~/env";
import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { useEnvironments } from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { webRuntimeEnvironment } from "~/state/webRuntime";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { useAtomCommand } from "~/state/use-atom-command";

import { previewBridge } from "./previewBridge";
import { listPreviewAutomationTabs } from "./previewAutomationTabs";
import {
  browserProfileRemountWebContentsId,
  resolveAutomationBrowserProfile,
  type BrowserProfileSelector,
} from "./browserProfileAutomation";
import {
  PreviewAutomationBrowserProfileInUseHostError,
  PreviewAutomationOperationError,
  PreviewAutomationOverlayTimeoutError,
  PreviewAutomationRecordingNotActiveError,
  PreviewAutomationRemoteProxyUnavailableError,
  PreviewAutomationTargetUnavailableError,
  PreviewAutomationViewportTimeoutError,
} from "./previewAutomationErrors";
import {
  previewAutomationDefaultViewport,
  previewAutomationOpenNeedsOverlay,
  shouldOpenPreviewMiniPlayer,
} from "./previewAutomationOpenReadiness";
import { recoverPreviewAutomationOverlay } from "./previewAutomationOverlayRecovery";
import {
  assertPreviewRuntimeCurrent,
  waitForNavigationReadiness,
} from "./previewNavigationReadiness";
import { createPreviewAutomationRequestConsumerAtom } from "./previewAutomationRequestConsumer";
import { createPreviewAutomationClientId } from "./previewAutomationClientId";
import { closePreviewSession } from "./closePreviewSession";
import {
  needsPreviewAutomationSessionSync,
  resolvePreviewAutomationOpenTab,
  resolvePreviewAutomationTarget,
} from "./previewAutomationTarget";
import { isPreviewViewportReady } from "./previewViewportReadiness";
import { shouldRollbackPreviewViewport } from "./previewViewportRollback";
import { runtimeRestartCleanup } from "../web-security/webSecurityPanelLogic";
import {
  extensionAutomationBrowsers,
  extensionAutomationTabs,
  parseExtensionAutomationBrowserId,
  parseExtensionAutomationTabId,
  rewriteExtensionAutomationResult,
} from "./extensionAutomationTarget";

const PREVIEW_PRESENTATION_SETTLE_TIMEOUT_MS = 500;

const waitForPreviewPresentation = async (runtimeTabId: string): Promise<void> => {
  const deadline = Date.now() + PREVIEW_PRESENTATION_SETTLE_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    if (useBrowserSurfaceStore.getState().byTabId[runtimeTabId]?.visible) return;
    await new Promise<void>((resolve) => window.setTimeout(resolve, 16));
  }
};

const waitForDesktopOverlay = async (
  threadRef: ScopedThreadRef,
  requestId: string,
  tabId: string,
  runtimeTabId: string,
  operation: PreviewAutomationRequest["operation"],
  timeoutMs: number,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let registeredWebContentsId: number | null = null;
  while (Date.now() <= deadline) {
    assertPreviewRuntimeCurrent(threadRef, tabId, runtimeTabId, {
      operation,
      requestId,
    });
    if (previewBridge) {
      const recovered = await recoverPreviewAutomationOverlay({
        bridge: previewBridge,
        runtimeTabId,
        webview: findPreviewWebview(runtimeTabId),
        registeredWebContentsId,
      });
      registeredWebContentsId = recovered.registeredWebContentsId;
      if (recovered.available) return;
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
  }
  throw new PreviewAutomationOverlayTimeoutError({
    requestId,
    environmentId: threadRef.environmentId,
    threadId: threadRef.threadId,
    timeoutMs,
  });
};

interface ExecutablePreviewWebview extends Element {
  readonly executeJavaScript: (code: string, userGesture?: boolean) => Promise<unknown>;
  readonly getWebContentsId: () => number;
}

const findPreviewWebview = (tabId: string): ExecutablePreviewWebview | null =>
  Array.from(document.querySelectorAll<ExecutablePreviewWebview>("webview[data-preview-tab]")).find(
    (candidate) => candidate.getAttribute("data-preview-tab") === tabId,
  ) ?? null;

const readWebContentsId = (webview: ExecutablePreviewWebview): number | null => {
  try {
    const webContentsId = webview.getWebContentsId();
    return Number.isInteger(webContentsId) && webContentsId > 0 ? webContentsId : null;
  } catch {
    return null;
  }
};

const waitForBrowserProfileRemount = async (input: {
  readonly threadRef: ScopedThreadRef;
  readonly request: PreviewAutomationRequest;
  readonly tabId: string;
  readonly runtimeTabId: string;
  readonly profileId: DesktopPreviewBrowserProfileId;
  readonly previousWebContentsId: number | null;
}): Promise<void> => {
  const deadline = Date.now() + input.request.timeoutMs;
  while (Date.now() <= deadline) {
    assertPreviewRuntimeCurrent(input.threadRef, input.tabId, input.runtimeTabId, input.request);
    const webview = findPreviewWebview(input.runtimeTabId);
    const webContentsId = browserProfileRemountWebContentsId({
      expectedProfileId: input.profileId,
      currentProfileId: webview?.getAttribute("data-preview-browser-profile") ?? null,
      previousWebContentsId: input.previousWebContentsId,
      currentWebContentsId: webview ? readWebContentsId(webview) : null,
    });
    if (webContentsId !== null && previewBridge) {
      await previewBridge.registerWebview(input.runtimeTabId, webContentsId);
      const status = await previewBridge.automation.status(input.runtimeTabId);
      if (status.available) return;
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
  }
  throw new PreviewAutomationOverlayTimeoutError({
    requestId: input.request.requestId,
    environmentId: input.threadRef.environmentId,
    threadId: input.threadRef.threadId,
    timeoutMs: input.request.timeoutMs,
  });
};

const readWebviewViewport = async (
  webview: ExecutablePreviewWebview,
): Promise<PreviewRenderedViewportSize | null> => {
  const value = await webview.executeJavaScript(
    "({ width: window.innerWidth, height: window.innerHeight })",
  );
  if (typeof value !== "object" || value === null) return null;
  const { width, height } = value as { readonly width?: unknown; readonly height?: unknown };
  return typeof width === "number" &&
    Number.isInteger(width) &&
    width > 0 &&
    typeof height === "number" &&
    Number.isInteger(height) &&
    height > 0
    ? { width, height }
    : null;
};

const readRenderedViewport = async (
  runtimeTabId: string,
): Promise<PreviewRenderedViewportSize | null> => {
  const webview = findPreviewWebview(runtimeTabId);
  if (!webview) return null;
  return await readWebviewViewport(webview);
};

const readDeclaredViewport = (
  webview: ExecutablePreviewWebview | null,
): PreviewRenderedViewportSize | null => {
  const width = Number(webview?.getAttribute("data-preview-css-width"));
  const height = Number(webview?.getAttribute("data-preview-css-height"));
  return Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0
    ? { width, height }
    : null;
};

const waitForRenderedViewport = async (
  threadRef: ScopedThreadRef,
  tabId: string,
  runtimeTabId: string,
  setting: PreviewViewportSetting,
  timeoutMs: number,
  context: {
    readonly requestId: PreviewAutomationRequest["requestId"];
    readonly operation: PreviewAutomationRequest["operation"];
    readonly environmentId: EnvironmentId;
    readonly threadId: PreviewAutomationRequest["threadId"];
  },
): Promise<PreviewRenderedViewportSize> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    assertPreviewRuntimeCurrent(threadRef, tabId, runtimeTabId, context);
    try {
      const webview = findPreviewWebview(runtimeTabId);
      const appliedSettingKey = webview?.getAttribute("data-preview-viewport-key") ?? null;
      const declaredViewport = readDeclaredViewport(webview);
      const renderedViewport = webview ? await readWebviewViewport(webview) : null;
      if (
        renderedViewport &&
        isPreviewViewportReady({
          setting,
          appliedSettingKey,
          declaredViewport,
          renderedViewport,
        })
      ) {
        return renderedViewport;
      }
    } catch {
      // Registration and navigation can transiently replace the guest while
      // React applies the server snapshot. Retry until the operation deadline.
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
  }
  throw new PreviewAutomationViewportTimeoutError({
    ...context,
    tabId,
    timeoutMs,
  });
};

const currentStatus = async (
  threadRef: ScopedThreadRef,
  requestedTabId: string | null,
): Promise<PreviewAutomationStatus> => {
  const state = readThreadPreviewState(threadRef);
  const { snapshot, tabId } = resolvePreviewAutomationTarget(state, requestedTabId);
  const runtimeTabId = tabId ? previewRuntimeTabId(threadRef, state.serverEpoch, tabId) : null;
  const visible = runtimeTabId
    ? (useBrowserSurfaceStore.getState().byTabId[runtimeTabId]?.visible ?? false)
    : false;
  const viewportSetting = snapshot ? (snapshot.viewport ?? FILL_PREVIEW_VIEWPORT) : undefined;
  const viewport = runtimeTabId ? await readRenderedViewport(runtimeTabId).catch(() => null) : null;
  const viewportStatus = {
    ...(viewportSetting === undefined ? {} : { viewportSetting }),
    ...(viewport === null ? {} : { viewport }),
  };
  if (runtimeTabId && tabId && previewBridge && state.desktopByTabId[tabId]) {
    const status = await previewBridge.automation.status(runtimeTabId);
    return { ...status, tabId, visible, ...viewportStatus };
  }
  const navStatus = snapshot?.navStatus;
  return {
    available: Boolean(previewBridge?.automation),
    visible,
    tabId,
    url: navStatus && navStatus._tag !== "Idle" ? navStatus.url : null,
    title: navStatus && navStatus._tag !== "Idle" ? navStatus.title : null,
    loading: navStatus?._tag === "Loading",
    ...viewportStatus,
  };
};

const raiseAtomCommandFailure = (result: Parameters<typeof squashAtomCommandFailure>[0]): never => {
  throw squashAtomCommandFailure(result);
};

const raisePreviewAutomationHostError = (
  error: PreviewAutomationRecordingNotActiveError,
): never => {
  throw error;
};

export function PreviewAutomationHosts() {
  const { environments, isReady } = useEnvironments();
  const knownEnvironmentIdsRef = useRef<ReadonlySet<EnvironmentId> | null>(null);
  const currentEnvironmentIdsRef = useRef<ReadonlySet<EnvironmentId>>(new Set());
  const pendingEnvironmentCleanupRef = useRef<Set<EnvironmentId>>(new Set());

  useEffect(() => {
    const bridge = previewBridge;
    if (!isReady || !bridge) return;
    const nextIds = new Set(environments.map(({ environmentId }) => environmentId));
    const previousIds = knownEnvironmentIdsRef.current;
    knownEnvironmentIdsRef.current = nextIds;
    currentEnvironmentIdsRef.current = nextIds;
    if (previousIds !== null) {
      for (const environmentId of previousIds) {
        if (!nextIds.has(environmentId)) {
          pendingEnvironmentCleanupRef.current.add(environmentId);
        }
      }
    }
    for (const environmentId of nextIds) {
      pendingEnvironmentCleanupRef.current.delete(environmentId);
    }

    let disposed = false;
    let retryTimer: number | undefined;
    const clearRemovedEnvironments = async () => {
      for (const environmentId of pendingEnvironmentCleanupRef.current) {
        if (disposed || currentEnvironmentIdsRef.current.has(environmentId)) continue;
        try {
          await bridge.browserProfiles.clearEnvironment(environmentId);
          if (!currentEnvironmentIdsRef.current.has(environmentId)) {
            pendingEnvironmentCleanupRef.current.delete(environmentId);
          }
        } catch (error) {
          console.error("Could not clear browser data for a removed environment.", error);
        }
      }
      if (!disposed && pendingEnvironmentCleanupRef.current.size > 0) {
        retryTimer = window.setTimeout(() => void clearRemovedEnvironments(), 5_000);
      }
    };
    if (pendingEnvironmentCleanupRef.current.size > 0) {
      retryTimer = window.setTimeout(() => void clearRemovedEnvironments(), 5_000);
    }
    return () => {
      disposed = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [environments, isReady]);

  if (!isElectron || !previewBridge?.automation) return null;
  return (
    <>
      {/*
       * Host lifetime follows the desktop runtime's environment connections,
       * not the routed thread. This keeps background threads automatable and
       * lets the subscription runtime own reconnects for every saved target.
       */}
      {environments.map((environment) => (
        <PreviewAutomationHost
          key={environment.environmentId}
          environmentId={environment.environmentId}
          browserProxyReachable={
            environment.entry.target._tag === "PrimaryConnectionTarget" ||
            isDesktopLocalConnectionTarget(environment.entry.target)
          }
        />
      ))}
    </>
  );
}

function PreviewAutomationHost(props: {
  readonly environmentId: EnvironmentId;
  readonly browserProxyReachable: boolean;
}) {
  const { browserProxyReachable, environmentId } = props;
  const registry = useContext(RegistryContext);
  const [automationClientId] = useState(createPreviewAutomationClientId);
  const initialAutomationHost = useMemo<PreviewAutomationHostState>(
    () => ({
      clientId: automationClientId,
      environmentId,
      supportedOperations: [...PREVIEW_AUTOMATION_OPERATIONS],
    }),
    [automationClientId, environmentId],
  );
  const automationRequestsAtom = previewEnvironment.automationRequests({
    environmentId,
    input: initialAutomationHost,
  });
  const listPreviews = useAtomQueryRunner(previewEnvironment.list, {
    reportFailure: false,
  });
  const open = useAtomCommand(previewEnvironment.open, {
    reportFailure: false,
  });
  const resize = useAtomCommand(previewEnvironment.resize, {
    reportFailure: false,
  });
  const close = useAtomCommand(previewEnvironment.close, {
    reportFailure: false,
  });
  const respondToAutomation = useAtomCommand(
    previewEnvironment.respondToAutomation,
    "preview automation response",
  );
  const focusAutomationHost = useAtomCommand(
    previewEnvironment.focusAutomationHost,
    "preview automation host focus",
  );
  const [automationConnectionAtom] = useState(() => Atom.make<string | null>(null));
  const automationConnectionId = useAtomValue(automationConnectionAtom);
  const getWebRuntimeStatus = useAtomQueryRunner(webRuntimeEnvironment.status, {
    reportFailure: false,
  });
  const listWebRuntimeSessions = useAtomQueryRunner(webRuntimeEnvironment.sessions, {
    reportFailure: false,
  });
  const listExtensionClients = useAtomQueryRunner(webRuntimeEnvironment.extensionClients, {
    reportFailure: false,
  });
  const invokeExtension = useAtomCommand(webRuntimeEnvironment.invokeExtension, {
    reportFailure: false,
  });
  const runtimeRestartCountRef = useRef<number | null>(null);

  useEffect(() => {
    let disposed = false;
    let refreshing = false;
    const recoverBrowserProfiles = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const target = { environmentId, input: {} } as const;
        const status = await getWebRuntimeStatus(target);
        if (disposed || status._tag !== "Success") return;
        const previousRestartCount = runtimeRestartCountRef.current;
        if (previousRestartCount === null) {
          runtimeRestartCountRef.current = status.value.restartCount;
          return;
        }
        if (previousRestartCount === status.value.restartCount) return;

        const sessions = await listWebRuntimeSessions(target);
        if (disposed || sessions._tag !== "Success") return;
        const cleanup = runtimeRestartCleanup(
          previousRestartCount,
          status.value.restartCount,
          sessions.value,
        );
        const bridge = previewBridge;
        if (!cleanup.restarted || !bridge) return;
        const results = await Promise.allSettled(
          cleanup.profileIds.map((profileId) =>
            bridge.configureProxy(environmentId, null, profileId),
          ),
        );
        if (disposed) return;
        const failures = results.filter(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (failures.length > 0) {
          for (const failure of failures) {
            console.error(
              "Could not clear a browser proxy after the web runtime restarted.",
              failure.reason,
            );
          }
          return;
        }
        runtimeRestartCountRef.current = status.value.restartCount;
      } finally {
        refreshing = false;
      }
    };
    void recoverBrowserProfiles();
    const interval = window.setInterval(() => void recoverBrowserProfiles(), 5_000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [environmentId, getWebRuntimeStatus, listWebRuntimeSessions]);

  const handleRequest = useCallback(
    async (request: PreviewAutomationRequest): Promise<unknown> => {
      const threadRef: ScopedThreadRef = {
        environmentId,
        threadId: request.threadId,
      };
      let tabId = request.tabId ?? null;
      try {
        const externalTarget = parseExtensionAutomationTabId(tabId);
        const openInput =
          request.operation === "open" ? (request.input as PreviewAutomationOpenInput) : null;
        const externalBrowserProducerId = parseExtensionAutomationBrowserId(openInput?.browserId);
        if (externalTarget || externalBrowserProducerId) {
          const clientsResult = await listExtensionClients({ environmentId, input: {} });
          if (clientsResult._tag === "Failure") return raiseAtomCommandFailure(clientsResult);
          const producerId = externalTarget?.producerId ?? externalBrowserProducerId!;
          const client = clientsResult.value.find(
            (candidate) => candidate.connected && candidate.producerId === producerId,
          );
          if (!client) throw new Error("The selected browser extension is no longer connected.");

          let input = request.input;
          if (request.operation === "navigate") {
            const navigateInput = request.input as PreviewAutomationNavigateInput;
            const resolution = resolveBrowserNavigationTarget(
              environmentId,
              navigateInput.target ?? { kind: "url", url: navigateInput.url! },
            );
            input = { ...navigateInput, url: resolution.resolvedUrl, target: undefined };
          } else if (request.operation === "open") {
            const { browserId: _browserId, ...extensionOpenInput } = openInput!;
            input = extensionOpenInput.url
              ? {
                  ...extensionOpenInput,
                  url: resolveBrowserNavigationTarget(environmentId, {
                    kind: "url",
                    url: extensionOpenInput.url,
                  }).resolvedUrl,
                }
              : extensionOpenInput;
          }

          const invocation = await invokeExtension({
            environmentId,
            input: {
              sessionId: client.sessionId,
              producerId: client.producerId,
              ...(externalTarget ? { tabId: externalTarget.tabId } : {}),
              operation: request.operation,
              input,
              timeoutMs: Math.min(request.timeoutMs, 60_000),
            },
          });
          if (invocation._tag === "Failure") return raiseAtomCommandFailure(invocation);
          if (!invocation.value.ok) {
            const remote = invocation.value.error;
            const error = new Error(
              remote?.message ?? "Browser extension command failed.",
            ) as Error & {
              _tag?: string;
              detail?: unknown;
            };
            if (remote?.tag) error._tag = remote.tag;
            if (remote?.detail !== undefined) error.detail = remote.detail;
            throw error;
          }
          return rewriteExtensionAutomationResult(client.producerId, invocation.value.result);
        }

        let state = readThreadPreviewState(threadRef);
        const needsSessionSync = needsPreviewAutomationSessionSync(state, request.tabId);
        if (needsSessionSync) {
          const listTarget = {
            environmentId,
            input: { threadId: request.threadId },
          } as const;
          registry.refresh(previewEnvironment.list(listTarget));
          const result = await listPreviews(listTarget);
          if (result._tag === "Failure") {
            return raiseAtomCommandFailure(result);
          }
          reconcilePreviewServerSessions(threadRef, result.value);
          state = readThreadPreviewState(threadRef);
        }
        tabId = request.tabId ?? state.snapshot?.tabId ?? null;
        const unavailableTarget = {
          requestId: request.requestId,
          operation: request.operation,
          environmentId,
          threadId: request.threadId,
          tabId,
          bridgeAvailable: Boolean(previewBridge),
        };
        const requireReadyTab = async () => {
          const bridge = previewBridge;
          const readyTabId = tabId;
          if (!bridge || !readyTabId) {
            throw new PreviewAutomationTargetUnavailableError(unavailableTarget);
          }
          const readyState = readThreadPreviewState(threadRef);
          const runtimeTabId = previewRuntimeTabId(threadRef, readyState.serverEpoch, readyTabId);
          await waitForDesktopOverlay(
            threadRef,
            request.requestId,
            readyTabId,
            runtimeTabId,
            request.operation,
            request.timeoutMs,
          );
          return {
            bridge,
            tabId: readyTabId,
            runtimeTabId,
          };
        };
        switch (request.operation) {
          case "tabsList": {
            const activeTabId = tabId;
            const [internalTabs, extensionClientsResult] = await Promise.all([
              listPreviewAutomationTabs(Object.values(state.sessions), activeTabId, (listedTabId) =>
                currentStatus(threadRef, listedTabId),
              ),
              listExtensionClients({ environmentId, input: {} }),
            ]);
            return {
              browsers: [
                {
                  browserId: "internal",
                  kind: "internal" as const,
                  browser: "erebus",
                  version: null,
                  connected: Boolean(previewBridge),
                  tabCount: internalTabs.length,
                },
                ...(extensionClientsResult._tag === "Success"
                  ? extensionAutomationBrowsers(
                      extensionClientsResult.value as ReadonlyArray<WebRuntimeExtensionAutomationClient>,
                    )
                  : []),
              ],
              tabs: [
                ...internalTabs,
                ...(extensionClientsResult._tag === "Success"
                  ? extensionAutomationTabs(
                      extensionClientsResult.value as ReadonlyArray<WebRuntimeExtensionAutomationClient>,
                    )
                  : []),
              ],
            };
          }
          case "tabClose": {
            if (!tabId) {
              throw new PreviewAutomationTargetUnavailableError(unavailableTarget);
            }
            const result = await closePreviewSession({
              closePreview: close,
              snapshot:
                state.sessions[tabId] ?? (state.snapshot?.tabId === tabId ? state.snapshot : null),
              tabId,
              threadRef,
            });
            if (result._tag === "Failure") return raiseAtomCommandFailure(result);
            return { closedTabId: tabId, tabId: null };
          }
          case "browserProfilesList": {
            if (!previewBridge) {
              throw new PreviewAutomationTargetUnavailableError(unavailableTarget);
            }
            return {
              profiles: await previewBridge.browserProfiles.list(),
            };
          }
          case "browserProfileCreate": {
            if (!previewBridge) {
              throw new PreviewAutomationTargetUnavailableError(unavailableTarget);
            }
            const input = request.input as { readonly name: string };
            return await previewBridge.browserProfiles.create(input.name);
          }
          case "browserProfileRename": {
            if (!previewBridge) {
              throw new PreviewAutomationTargetUnavailableError(unavailableTarget);
            }
            const input = request.input as {
              readonly profile: BrowserProfileSelector;
              readonly name: string;
            };
            const profiles = await previewBridge.browserProfiles.list();
            const profile = resolveAutomationBrowserProfile(profiles, input.profile);
            await previewBridge.browserProfiles.rename(profile.id, input.name);
            const updatedProfiles = await previewBridge.browserProfiles.list();
            return resolveAutomationBrowserProfile(updatedProfiles, { profileId: profile.id });
          }
          case "browserProfileDelete": {
            if (!previewBridge) {
              throw new PreviewAutomationTargetUnavailableError(unavailableTarget);
            }
            const input = request.input as { readonly profile: BrowserProfileSelector };
            const profiles = await previewBridge.browserProfiles.list();
            const profile = resolveAutomationBrowserProfile(profiles, input.profile);
            const result = await previewBridge.browserProfiles.delete(profile.id);
            if (result?.status === "in-use") {
              throw new PreviewAutomationBrowserProfileInUseHostError({
                ...unavailableTarget,
                reason: "browser-profile-in-use",
                activeTabCount: result.activeTabCount,
              });
            }
            useBrowserProfileSelectionStore.getState().removeProfile(profile.id);
            return { deletedProfileId: profile.id };
          }
          case "browserProfileSelect": {
            if (!previewBridge) {
              throw new PreviewAutomationTargetUnavailableError(unavailableTarget);
            }
            const input = request.input as { readonly profile: BrowserProfileSelector };
            const profiles = await previewBridge.browserProfiles.list();
            const profile = resolveAutomationBrowserProfile(profiles, input.profile);
            const selection = useBrowserProfileSelectionStore.getState();
            if (tabId) {
              if (state.sessions[tabId] === undefined) {
                throw new PreviewAutomationTargetUnavailableError(unavailableTarget);
              }
              const runtimeTabId = previewRuntimeTabId(threadRef, state.serverEpoch, tabId);
              const previousWebview = findPreviewWebview(runtimeTabId);
              const previousProfileId = previousWebview?.getAttribute(
                "data-preview-browser-profile",
              );
              const previousWebContentsId = previousWebview
                ? readWebContentsId(previousWebview)
                : null;
              selection.selectForTab(threadRef, tabId, profile.id);
              if (previousWebview && previousProfileId !== profile.id) {
                await waitForBrowserProfileRemount({
                  threadRef,
                  request,
                  tabId,
                  runtimeTabId,
                  profileId: profile.id,
                  previousWebContentsId,
                });
              }
            } else {
              selection.setEnvironmentDefault(environmentId, profile.id);
            }
            return { profile, tabId };
          }
          case "browserProfileProxy": {
            if (!previewBridge) {
              throw new PreviewAutomationTargetUnavailableError(unavailableTarget);
            }
            const input = request.input as {
              readonly profile: BrowserProfileSelector;
              readonly proxy: DesktopPreviewProxyConfiguration | null;
            };
            if (input.proxy !== null && !browserProxyReachable) {
              throw new PreviewAutomationRemoteProxyUnavailableError({
                requestId: request.requestId,
                environmentId,
                threadId: request.threadId,
              });
            }
            const profiles = await previewBridge.browserProfiles.list();
            const profile = resolveAutomationBrowserProfile(profiles, input.profile);
            await previewBridge.configureProxy(environmentId, input.proxy, profile.id);
            return {
              profileId: profile.id,
              configured: input.proxy !== null,
            };
          }
          case "webRuntimeReachability":
            return { local: browserProxyReachable };
          case "status":
            return await currentStatus(threadRef, tabId);
          case "open": {
            const input = request.input as PreviewAutomationOpenInput;
            const resolvedInputUrl = input.url
              ? resolveBrowserNavigationTarget(environmentId, {
                  kind: "url",
                  url: input.url,
                }).resolvedUrl
              : undefined;
            let activeTabId = resolvePreviewAutomationOpenTab(
              state,
              request.tabId,
              input.reuseExistingTab ?? true,
            );
            let activeSnapshot = activeTabId
              ? (state.sessions[activeTabId] ?? state.snapshot ?? undefined)
              : undefined;
            const reusedExistingTab = activeTabId !== null;
            tabId = activeTabId;
            if (!activeTabId) {
              const result = await open({
                environmentId,
                input: {
                  threadId: request.threadId,
                  ...(resolvedInputUrl ? { url: resolvedInputUrl } : {}),
                  // An agent that didn't state a size gets the user's
                  // configured default, same as a hand-opened tab.
                  viewport: browserDefaultOpenViewport(await resolveBrowserDefaults()),
                },
              });
              if (result._tag === "Failure") {
                return raiseAtomCommandFailure(result);
              }
              const snapshot = result.value;
              applyPreviewServerSnapshot(threadRef, snapshot);
              activeTabId = snapshot.tabId;
              activeSnapshot = snapshot;
              tabId = activeTabId;
            }
            const activeRuntimeTabId = previewRuntimeTabId(
              threadRef,
              readThreadPreviewState(threadRef).serverEpoch,
              activeTabId,
            );
            if (activeSnapshot) {
              const defaultViewport = previewAutomationDefaultViewport(
                reusedExistingTab,
                activeSnapshot,
              );
              if (defaultViewport) {
                const resizeResult = await runBrowserViewportMutation(
                  activeRuntimeTabId,
                  async () => {
                    assertPreviewRuntimeCurrent(
                      threadRef,
                      activeTabId,
                      activeRuntimeTabId,
                      request,
                    );
                    return await resize({
                      environmentId,
                      input: {
                        threadId: request.threadId,
                        tabId: activeTabId,
                        viewport: defaultViewport,
                      },
                    });
                  },
                );
                if (resizeResult._tag === "Failure") {
                  return raiseAtomCommandFailure(resizeResult);
                }
                activeSnapshot = resizeResult.value;
                updatePreviewServerSnapshot(threadRef, resizeResult.value);
              }
            }
            const shouldPresentPreview = shouldOpenPreviewMiniPlayer(
              input,
              (await resolveBrowserDefaults()).autoShowFloatingPreview,
            );
            if (shouldPresentPreview) {
              usePreviewMiniPlayerStore.getState().open(threadRef, activeTabId);
            }
            if (activeSnapshot && previewAutomationOpenNeedsOverlay(input, activeSnapshot)) {
              await waitForDesktopOverlay(
                threadRef,
                request.requestId,
                activeTabId,
                activeRuntimeTabId,
                request.operation,
                request.timeoutMs,
              );
            }
            if (shouldPresentPreview) {
              // React commits the thread-bound surface asynchronously. Settle
              // briefly so active-thread opens report visible=true, without
              // turning a background thread's offscreen mini player into an
              // operation failure.
              await waitForPreviewPresentation(activeRuntimeTabId);
            }
            if (reusedExistingTab && resolvedInputUrl && previewBridge) {
              assertPreviewRuntimeCurrent(threadRef, activeTabId, activeRuntimeTabId, request);
              await previewBridge.navigate(activeRuntimeTabId, resolvedInputUrl);
              await waitForNavigationReadiness(
                threadRef,
                request.requestId,
                activeTabId,
                activeRuntimeTabId,
                request.operation,
                "load",
                request.timeoutMs,
              );
            }
            return await currentStatus(threadRef, activeTabId);
          }
          case "navigate": {
            const ready = await requireReadyTab();
            const input = request.input as PreviewAutomationNavigateInput;
            const resolution = resolveBrowserNavigationTarget(
              environmentId,
              input.target ?? {
                kind: "url",
                url: input.url!,
              },
            );
            await ready.bridge.navigate(ready.runtimeTabId, resolution.resolvedUrl);
            await waitForNavigationReadiness(
              threadRef,
              request.requestId,
              ready.tabId,
              ready.runtimeTabId,
              request.operation,
              input.readiness ?? "load",
              input.timeoutMs ?? request.timeoutMs,
            );
            return await currentStatus(threadRef, ready.tabId);
          }
          case "back":
          case "forward":
          case "reload": {
            const ready = await requireReadyTab();
            const input = request.input as { readonly timeoutMs?: number };
            if (request.operation === "back") await ready.bridge.goBack(ready.runtimeTabId);
            else if (request.operation === "forward") {
              await ready.bridge.goForward(ready.runtimeTabId);
            } else {
              await ready.bridge.refresh(ready.runtimeTabId);
            }
            await waitForNavigationReadiness(
              threadRef,
              request.requestId,
              ready.tabId,
              ready.runtimeTabId,
              request.operation,
              "load",
              input.timeoutMs ?? request.timeoutMs,
            );
            return await currentStatus(threadRef, ready.tabId);
          }
          case "resize": {
            const ready = await requireReadyTab();
            const input = request.input as PreviewAutomationResizeInput;
            const setting = resolvePreviewViewport(input);
            const applied = await runBrowserViewportMutation(ready.runtimeTabId, async () => {
              const operationState = assertPreviewRuntimeCurrent(
                threadRef,
                ready.tabId,
                ready.runtimeTabId,
                request,
              );
              const previousSetting =
                operationState.sessions[ready.tabId]?.viewport ?? FILL_PREVIEW_VIEWPORT;
              const result = await resize({
                environmentId,
                input: {
                  threadId: request.threadId,
                  tabId: ready.tabId,
                  viewport: setting,
                },
              });
              if (result._tag === "Failure") {
                return raiseAtomCommandFailure(result);
              }
              updatePreviewServerSnapshot(threadRef, result.value);
              return {
                previousSetting,
                serverEpoch: operationState.serverEpoch,
              };
            });
            let viewport: PreviewRenderedViewportSize;
            try {
              viewport = await waitForRenderedViewport(
                threadRef,
                ready.tabId,
                ready.runtimeTabId,
                setting,
                input.timeoutMs ?? request.timeoutMs,
                {
                  requestId: request.requestId,
                  operation: request.operation,
                  environmentId,
                  threadId: request.threadId,
                },
              );
            } catch (cause) {
              await runBrowserViewportMutation(ready.runtimeTabId, async () => {
                const latestState = readThreadPreviewState(threadRef);
                const latestSetting =
                  latestState.sessions[ready.tabId]?.viewport ?? FILL_PREVIEW_VIEWPORT;
                if (
                  shouldRollbackPreviewViewport(
                    applied.previousSetting,
                    setting,
                    latestSetting,
                    applied.serverEpoch,
                    latestState.serverEpoch,
                  )
                ) {
                  const rollback = await resize({
                    environmentId,
                    input: {
                      threadId: request.threadId,
                      tabId: ready.tabId,
                      viewport: applied.previousSetting,
                    },
                  });
                  if (rollback._tag !== "Failure") {
                    updatePreviewServerSnapshot(threadRef, rollback.value);
                  }
                }
              });
              throw cause;
            }
            return {
              tabId: ready.tabId,
              setting,
              viewport,
            } satisfies PreviewAutomationResizeResult;
          }
          case "setColorScheme": {
            const ready = await requireReadyTab();
            const input = request.input as PreviewAutomationSetColorSchemeInput;
            await ready.bridge.setColorScheme(ready.runtimeTabId, input.colorScheme);
            return {
              tabId: ready.tabId,
              colorScheme: input.colorScheme,
            } satisfies PreviewAutomationSetColorSchemeResult;
          }
          case "snapshot": {
            const ready = await requireReadyTab();
            return await ready.bridge.automation.snapshot(ready.runtimeTabId);
          }
          case "click": {
            const ready = await requireReadyTab();
            return await ready.bridge.automation.click(
              ready.runtimeTabId,
              request.input as Parameters<typeof ready.bridge.automation.click>[1],
            );
          }
          case "type": {
            const ready = await requireReadyTab();
            return await ready.bridge.automation.type(
              ready.runtimeTabId,
              request.input as Parameters<typeof ready.bridge.automation.type>[1],
            );
          }
          case "press": {
            const ready = await requireReadyTab();
            return await ready.bridge.automation.press(
              ready.runtimeTabId,
              request.input as Parameters<typeof ready.bridge.automation.press>[1],
            );
          }
          case "scroll": {
            const ready = await requireReadyTab();
            return await ready.bridge.automation.scroll(
              ready.runtimeTabId,
              request.input as Parameters<typeof ready.bridge.automation.scroll>[1],
            );
          }
          case "evaluate": {
            const ready = await requireReadyTab();
            return await ready.bridge.automation.evaluate(
              ready.runtimeTabId,
              request.input as Parameters<typeof ready.bridge.automation.evaluate>[1],
            );
          }
          case "waitFor": {
            const ready = await requireReadyTab();
            return await ready.bridge.automation.waitFor(
              ready.runtimeTabId,
              request.input as Parameters<typeof ready.bridge.automation.waitFor>[1],
            );
          }
          case "recordingStart": {
            const ready = await requireReadyTab();
            const startedAt = await startBrowserRecording(
              ready.runtimeTabId,
              threadRef,
              ready.tabId,
            );
            return {
              tabId: ready.tabId,
              recording: true,
              startedAt,
            };
          }
          case "recordingStop": {
            const activeRecordings = readActiveBrowserRecordingTargets(threadRef);
            const activeTabIds = new Set(
              activeRecordings.map((recording) => recording.serverTabId),
            );
            const stopTabId = resolveBrowserRecordingStopTarget(
              activeTabIds,
              tabId,
              request.tabIdExplicit ? request.tabId : undefined,
            );
            tabId = stopTabId ?? tabId;
            const stopRuntimeTabId =
              activeRecordings.find((recording) => recording.serverTabId === stopTabId)
                ?.runtimeTabId ?? null;
            const artifact = stopRuntimeTabId ? await stopBrowserRecording(stopRuntimeTabId) : null;
            if (!artifact || !stopTabId) {
              return raisePreviewAutomationHostError(
                new PreviewAutomationRecordingNotActiveError({
                  requestId: request.requestId,
                  environmentId,
                  threadId: request.threadId,
                  tabId,
                }),
              );
            }
            return { ...artifact, tabId: stopTabId };
          }
        }
      } catch (cause) {
        throw PreviewAutomationOperationError.fromCause({
          requestId: request.requestId,
          operation: request.operation,
          environmentId,
          threadId: request.threadId,
          tabId,
          cause,
        });
      }
    },
    [
      browserProxyReachable,
      close,
      environmentId,
      invokeExtension,
      listExtensionClients,
      listPreviews,
      open,
      registry,
      resize,
    ],
  );
  const [requestHandlerAtom] = useState(() => Atom.make({ handle: handleRequest }));
  const setRequestHandler = useAtomSet(requestHandlerAtom);
  useEffect(() => {
    setRequestHandler({ handle: handleRequest });
  }, [handleRequest, setRequestHandler]);

  const automationRequestConsumerAtom = useMemo(
    () =>
      createPreviewAutomationRequestConsumerAtom({
        requestsAtom: automationRequestsAtom,
        clientId: automationClientId,
        connectionAtom: automationConnectionAtom,
        environmentId,
        requestHandlerAtom,
        respond: (response) =>
          respondToAutomation({
            environmentId,
            input: response,
          }),
        label: `preview:automation-host:${environmentId}:${automationClientId}`,
      }),
    [
      automationClientId,
      automationConnectionAtom,
      automationRequestsAtom,
      requestHandlerAtom,
      respondToAutomation,
      environmentId,
    ],
  );
  useAtomValue(automationRequestConsumerAtom);

  useEffect(() => {
    const report = () => {
      if (!automationConnectionId) return;
      void focusAutomationHost({
        environmentId,
        input: {
          clientId: automationClientId,
          environmentId,
          connectionId: automationConnectionId,
          focused: document.hasFocus(),
        },
      });
    };
    report();
    window.addEventListener("focus", report);
    window.addEventListener("blur", report);
    return () => {
      window.removeEventListener("focus", report);
      window.removeEventListener("blur", report);
    };
  }, [automationClientId, automationConnectionId, environmentId, focusAutomationHost]);

  return null;
}
