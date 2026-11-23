import * as Effect from "effect/Effect";
import type {
  DesktopPreviewBrowserProfile,
  PreviewAutomationOperation,
  PreviewAutomationOpenInput,
  PreviewAutomationRecordingArtifact,
  PreviewAutomationRecordingStatus,
  PreviewAutomationResizeResult,
  PreviewAutomationSetColorSchemeResult,
  PreviewAutomationSnapshot,
  PreviewAutomationStatus,
  PreviewTabId,
} from "@t3tools/contracts";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as WebRuntimeClient from "../../../webRuntime/WebRuntimeClient.ts";
import {
  type PreviewBrowserProfileDeleteResult,
  type PreviewBrowserProfileListResult,
  type PreviewBrowserProfileProxyResult,
  type PreviewBrowserProfileSelectResult,
  type PreviewBrowserTabCloseResult,
  type PreviewBrowserTabsResult,
  PreviewSnapshotToolkit,
  PreviewStandardToolkit,
  PreviewToolkit,
} from "./tools.ts";

/**
 * Collapses the `show` alias onto `open` and defaults tab reuse.
 *
 * Deliberately leaves an unstated `open` unstated. Whether a preview the agent
 * said nothing about surfaces is the user's `browserAutoShowFloatingPreview`
 * preference, which is desktop-local and unreadable from here — filling in
 * `true` would silently override it for every `preview_open`.
 */
export function normalizePreviewOpenInput(
  input: PreviewAutomationOpenInput,
): PreviewAutomationOpenInput {
  const open = input.open ?? input.show;
  return {
    ...input,
    ...(open === undefined ? {} : { open, show: open }),
    reuseExistingTab: input.reuseExistingTab ?? true,
  };
}

const invoke = Effect.fn("PreviewToolkit.invoke")(function* <A>(
  operation: PreviewAutomationOperation,
  input: unknown,
  timeoutMs?: number,
  tabId?: PreviewTabId,
): Effect.fn.Return<
  A,
  import("@t3tools/contracts").PreviewAutomationError,
  | McpInvocationContext.McpInvocationContext
  | PreviewAutomationBroker.PreviewAutomationBroker
  | WebRuntimeClient.WebRuntimeClient
> {
  const scope = yield* McpInvocationContext.requireMcpCapability("preview");
  if (scope.workspaceRoot && scope.capabilities.has("web")) {
    const webRuntime = yield* WebRuntimeClient.WebRuntimeClient;
    yield* webRuntime.connectionForWorkspace(scope.workspaceRoot).pipe(Effect.ignore);
  }
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  return yield* broker.invoke<A>({
    scope,
    operation,
    input,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(tabId === undefined ? {} : { tabId }),
  });
});

const invokeTargeted = <A>(
  operation: PreviewAutomationOperation,
  input: {
    readonly tabId?: PreviewTabId | undefined;
    readonly [key: string]: unknown;
  },
  timeoutMs?: number,
) => {
  const { tabId, ...operationInput } = input;
  return invoke<A>(operation, operationInput, timeoutMs, tabId);
};

const handlers = {
  preview_status: (input) => invokeTargeted<PreviewAutomationStatus>("status", input ?? {}),
  preview_browser_profiles: () =>
    invoke<PreviewBrowserProfileListResult>("browserProfilesList", {}),
  preview_browser_profile_create: (input) =>
    invoke<DesktopPreviewBrowserProfile>("browserProfileCreate", input),
  preview_browser_profile_rename: (input) =>
    invoke<DesktopPreviewBrowserProfile>("browserProfileRename", input),
  preview_browser_profile_delete: (input) =>
    invoke<PreviewBrowserProfileDeleteResult>("browserProfileDelete", input),
  preview_browser_profile_select: (input) =>
    invokeTargeted<PreviewBrowserProfileSelectResult>("browserProfileSelect", input),
  preview_browser_profile_proxy: (input) =>
    invoke<PreviewBrowserProfileProxyResult>("browserProfileProxy", input),
  preview_tabs: () => invoke<PreviewBrowserTabsResult>("tabsList", {}),
  extension_browser_list: () =>
    invoke<PreviewBrowserTabsResult>("tabsList", {}).pipe(
      Effect.map((result) => ({
        browsers: result.browsers.filter((browser) => browser.kind === "extension"),
        tabs: result.tabs.filter((tab) => tab.tabId.startsWith("extension:")),
      })),
    ),
  extension_browser_open: (input) =>
    invoke<PreviewAutomationStatus>("open", {
      browserId: input.browserId,
      ...(input.url === undefined ? {} : { url: input.url }),
      reuseExistingTab: false,
    }),
  preview_tab_close: (input) =>
    invokeTargeted<PreviewBrowserTabCloseResult>("tabClose", input ?? {}),
  preview_back: (input) => invokeTargeted<PreviewAutomationStatus>("back", input, input.timeoutMs),
  preview_forward: (input) =>
    invokeTargeted<PreviewAutomationStatus>("forward", input, input.timeoutMs),
  preview_reload: (input) =>
    invokeTargeted<PreviewAutomationStatus>("reload", input, input.timeoutMs),
  preview_open: (input) =>
    invokeTargeted<PreviewAutomationStatus>("open", normalizePreviewOpenInput(input)),
  preview_navigate: (input) =>
    invokeTargeted<PreviewAutomationStatus>("navigate", input, input.timeoutMs),
  preview_resize: (input) =>
    invokeTargeted<PreviewAutomationResizeResult>("resize", input, input.timeoutMs),
  preview_set_appearance: (input) =>
    invokeTargeted<PreviewAutomationSetColorSchemeResult>("setColorScheme", input),
  preview_snapshot: (input) => invokeTargeted<PreviewAutomationSnapshot>("snapshot", input ?? {}),
  preview_click: (input) =>
    invokeTargeted<void>("click", input, input.timeoutMs).pipe(Effect.as({})),
  preview_type: (input) => invokeTargeted<void>("type", input, input.timeoutMs).pipe(Effect.as({})),
  preview_press: (input) => invokeTargeted<void>("press", input).pipe(Effect.as({})),
  preview_scroll: (input) => invokeTargeted<void>("scroll", input).pipe(Effect.as({})),
  preview_evaluate: (input) =>
    invokeTargeted<unknown>("evaluate", input).pipe(
      Effect.map((result) => ({ value: result ?? null })),
    ),
  preview_wait_for: (input) =>
    invokeTargeted<void>("waitFor", input, input.timeoutMs).pipe(Effect.as({})),
  preview_recording_start: (input) =>
    invokeTargeted<PreviewAutomationRecordingStatus>("recordingStart", input ?? {}),
  preview_recording_stop: (input) =>
    invokeTargeted<PreviewAutomationRecordingArtifact>("recordingStop", input ?? {}),
} satisfies Parameters<typeof PreviewToolkit.toLayer>[0];

const { preview_snapshot, ...standardHandlers } = handlers;

export const PreviewStandardToolkitHandlersLive = PreviewStandardToolkit.toLayer(standardHandlers);

export const PreviewSnapshotToolkitHandlersLive = PreviewSnapshotToolkit.toLayer({
  preview_snapshot,
});

export const PreviewToolkitHandlersLive = PreviewToolkit.toLayer(handlers);
