import {
  DesktopPreviewBrowserProfileIdSchema,
  DesktopPreviewBrowserProfileSchema,
  DesktopPreviewProxyConfigurationSchema,
  PreviewAutomationClickInput,
  PreviewAutomationError,
  PreviewAutomationEvaluateInput,
  PreviewAutomationNavigateInput,
  PreviewAutomationOpenInput,
  PreviewAutomationPressInput,
  PreviewAutomationRecordingArtifact,
  PreviewAutomationRecordingStatus,
  PreviewAutomationResizeInput,
  PreviewAutomationResizeResult,
  PreviewAutomationScrollInput,
  PreviewAutomationSetColorSchemeInput,
  PreviewAutomationSetColorSchemeResult,
  PreviewAutomationSnapshot,
  PreviewAutomationStatus,
  PreviewAutomationTabTargetInput,
  PreviewAutomationTypeInput,
  PreviewAutomationWaitForInput,
  PreviewTabId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  PreviewAutomationBroker.PreviewAutomationBroker,
];

const PreviewActionResult = Schema.Record(Schema.String, Schema.Never).annotate({
  description: "The preview action completed successfully.",
});

/*
 * Keep the selector as a nested union. Effect filters validate flat optional
 * fields at runtime but cannot advertise the exclusive choice to MCP clients.
 */
const BrowserProfileSelector = Schema.Union([
  Schema.Struct({
    profileId: DesktopPreviewBrowserProfileIdSchema.annotate({
      description: "Exact browser session id. Prefer this stable selector.",
    }),
  }),
  Schema.Struct({
    profileName: Schema.String.annotate({
      description: "Browser session name. Matching is case-insensitive and must be unique.",
    }),
  }),
]).annotate({
  description:
    "Browser session selector. Use profileId when it is available, otherwise profileName.",
});

const BrowserProfileSelectorField = {
  profile: BrowserProfileSelector,
};

export const PreviewBrowserProfileListInput = Schema.Record(Schema.String, Schema.Never).annotate({
  description: "No input is required.",
});
export const PreviewBrowserProfileListResult = Schema.Struct({
  profiles: Schema.Array(DesktopPreviewBrowserProfileSchema),
});
export type PreviewBrowserProfileListResult = typeof PreviewBrowserProfileListResult.Type;

export const PreviewBrowserProfileCreateInput = Schema.Struct({
  name: Schema.String.annotate({ description: "Name for the isolated browser session." }),
});

export const PreviewBrowserProfileRenameInput = Schema.Struct({
  ...BrowserProfileSelectorField,
  name: Schema.String.annotate({ description: "New browser session name." }),
});

export const PreviewBrowserProfileDeleteInput = Schema.Struct({
  ...BrowserProfileSelectorField,
});

export const PreviewBrowserProfileSelectInput = Schema.Struct({
  ...BrowserProfileSelectorField,
  tabId: Schema.optional(
    PreviewTabId.annotate({
      description: "Exact collaborative browser tab. Omit to use the current tab.",
    }),
  ).annotate({ description: "Exact collaborative browser tab. Omit to use the current tab." }),
});
export const PreviewBrowserProfileSelectResult = Schema.Struct({
  profile: DesktopPreviewBrowserProfileSchema,
  tabId: Schema.NullOr(PreviewTabId),
});
export type PreviewBrowserProfileSelectResult = typeof PreviewBrowserProfileSelectResult.Type;

export const PreviewBrowserProfileProxyInput = Schema.Struct({
  ...BrowserProfileSelectorField,
  proxy: Schema.NullOr(DesktopPreviewProxyConfigurationSchema).annotate({
    description: "Validated loopback capture proxy configuration, or null to remove it.",
  }),
});
export const PreviewBrowserProfileProxyResult = Schema.Struct({
  profileId: DesktopPreviewBrowserProfileIdSchema,
  configured: Schema.Boolean,
});
export type PreviewBrowserProfileProxyResult = typeof PreviewBrowserProfileProxyResult.Type;

export const PreviewBrowserProfileDeleteResult = Schema.Struct({
  deletedProfileId: DesktopPreviewBrowserProfileIdSchema,
});
export type PreviewBrowserProfileDeleteResult = typeof PreviewBrowserProfileDeleteResult.Type;

const PreviewBrowserTabTargetFields = {
  tabId: Schema.optional(
    PreviewTabId.annotate({
      description: "Exact collaborative browser tab. Omit to use the current tab.",
    }),
  ).annotate({ description: "Exact collaborative browser tab. Omit to use the current tab." }),
};
const PreviewBrowserNavigationHistoryInput = Schema.Struct({
  ...PreviewBrowserTabTargetFields,
  timeoutMs: Schema.optional(
    Schema.Int.check(Schema.isGreaterThan(0))
      .check(Schema.isLessThanOrEqualTo(60_000))
      .annotate({ description: "Maximum wait in milliseconds. Defaults to 15000." }),
  ).annotate({ description: "Maximum wait in milliseconds. Defaults to 15000." }),
});

export const PreviewBrowserTabsInput = Schema.Record(Schema.String, Schema.Never).annotate({
  description: "No input is required.",
});
export const PreviewBrowserTabsResult = Schema.Struct({
  browsers: Schema.Array(
    Schema.Struct({
      browserId: Schema.String,
      kind: Schema.Literals(["internal", "extension"]),
      browser: Schema.String,
      version: Schema.NullOr(Schema.String),
      connected: Schema.Boolean,
      tabCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    }),
  ),
  tabs: Schema.Array(
    Schema.Struct({
      tabId: PreviewTabId,
      active: Schema.Boolean,
      url: Schema.NullOr(Schema.String),
      title: Schema.NullOr(Schema.String),
      loading: Schema.Boolean,
      canGoBack: Schema.Boolean,
      canGoForward: Schema.Boolean,
    }),
  ),
});
export type PreviewBrowserTabsResult = typeof PreviewBrowserTabsResult.Type;

export const ExtensionBrowserOpenInput = Schema.Struct({
  browserId: Schema.String.annotate({
    description: "Exact external browser id returned by extension_browser_list.",
  }),
  url: Schema.optional(Schema.String).annotate({
    description: "Optional initial http or https URL. Omit to open a blank controlled tab.",
  }),
});

export const PreviewBrowserTabCloseInput = Schema.Struct(PreviewBrowserTabTargetFields);
export const PreviewBrowserTabCloseResult = Schema.Struct({
  closedTabId: PreviewTabId,
  tabId: Schema.Null,
});
export type PreviewBrowserTabCloseResult = typeof PreviewBrowserTabCloseResult.Type;

const browserTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.OpenWorld, true).annotate(Tool.Destructive, true) as T;

const safeBrowserTool = <T extends Tool.Any>(tool: T): T =>
  browserTool(tool).annotate(Tool.Destructive, false) as T;

const readonlyBrowserTool = <T extends Tool.Any>(tool: T): T =>
  safeBrowserTool(tool).annotate(Tool.Readonly, true).annotate(Tool.Idempotent, true) as T;

export const PreviewStatusTool = Tool.make("preview_status", {
  description:
    "Report whether a collaborative browser tab is automation-capable, including its URL, title, visibility, loading state, viewport mode, and measured CSS-pixel size. Pass tabId to inspect a specific tab; omit it to use this agent session's current tab.",
  parameters: PreviewAutomationTabTargetInput,
  success: PreviewAutomationStatus,
  failure: PreviewAutomationError,
  dependencies,
})
  .annotate(Tool.Title, "Get preview status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const PreviewBrowserProfilesListTool = readonlyBrowserTool(
  Tool.make("preview_browser_profiles", {
    description:
      "List persistent browser sessions. Each profile has isolated cookies, storage, cache, service workers, and proxy settings.",
    parameters: PreviewBrowserProfileListInput,
    success: PreviewBrowserProfileListResult,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "List browser sessions"),
);

export const PreviewBrowserProfileCreateTool = safeBrowserTool(
  Tool.make("preview_browser_profile_create", {
    description: "Create an isolated persistent browser session.",
    parameters: PreviewBrowserProfileCreateInput,
    success: DesktopPreviewBrowserProfileSchema,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Create browser session"),
);

export const PreviewBrowserProfileRenameTool = safeBrowserTool(
  Tool.make("preview_browser_profile_rename", {
    description: "Rename a browser session selected by id or name.",
    parameters: PreviewBrowserProfileRenameInput,
    success: DesktopPreviewBrowserProfileSchema,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Rename browser session"),
);

export const PreviewBrowserProfileDeleteTool = browserTool(
  Tool.make("preview_browser_profile_delete", {
    description:
      "Delete a non-default browser session and its cookies, storage, cache, service workers, and proxy route.",
    parameters: PreviewBrowserProfileDeleteInput,
    success: PreviewBrowserProfileDeleteResult,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Delete browser session"),
);

export const PreviewBrowserProfileSelectTool = safeBrowserTool(
  Tool.make("preview_browser_profile_select", {
    description:
      "Select an isolated browser session for a collaborative tab. Pass tabId to target a known tab; omit it to use the agent session's current tab or the environment default when no tab exists.",
    parameters: PreviewBrowserProfileSelectInput,
    success: PreviewBrowserProfileSelectResult,
    failure: PreviewAutomationError,
    dependencies,
  })
    .annotate(Tool.Title, "Select browser session")
    .annotate(Tool.Idempotent, true),
);

export const PreviewBrowserProfileProxyTool = browserTool(
  Tool.make("preview_browser_profile_proxy", {
    description:
      "Apply a validated loopback capture proxy and CA to one isolated browser session, or pass proxy=null to restore direct networking.",
    parameters: PreviewBrowserProfileProxyInput,
    success: PreviewBrowserProfileProxyResult,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Configure browser capture proxy"),
);

export const PreviewBrowserTabsTool = readonlyBrowserTool(
  Tool.make("preview_tabs", {
    description:
      "List every connected browser and collaborative tab, including browserId, active tab, URL, title, loading state, and history availability. Use a returned browserId with preview_open to create the first controlled tab in Brave, Chrome, Firefox, or another connected extension browser.",
    parameters: PreviewBrowserTabsInput,
    success: PreviewBrowserTabsResult,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "List browser tabs"),
);

export const ExtensionBrowserListTool = readonlyBrowserTool(
  Tool.make("extension_browser_list", {
    description:
      "List Brave, Chrome, Firefox, and other browsers connected through the Erebus extension, including browserId and every controlled tab. This is the entry point for external-browser automation and capture.",
    parameters: PreviewBrowserTabsInput,
    success: PreviewBrowserTabsResult,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "List connected extension browsers"),
);

export const ExtensionBrowserOpenTool = safeBrowserTool(
  Tool.make("extension_browser_open", {
    description:
      "Open the first controlled tab in a browser connected through the Erebus extension. Get browserId from extension_browser_list, then use the returned tabId with preview_navigate, preview_snapshot, preview_click, preview_type, and the other preview tools.",
    parameters: ExtensionBrowserOpenInput,
    success: PreviewAutomationStatus,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Open extension browser tab"),
);

export const PreviewBrowserTabCloseTool = browserTool(
  Tool.make("preview_tab_close", {
    description:
      "Close a collaborative browser tab. Pass tabId for an exact tab or omit it to close the current tab.",
    parameters: PreviewBrowserTabCloseInput,
    success: PreviewBrowserTabCloseResult,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Close browser tab"),
);

export const PreviewBrowserBackTool = safeBrowserTool(
  Tool.make("preview_back", {
    description:
      "Move a collaborative browser tab one entry back in its navigation history and wait for the page to load.",
    parameters: PreviewBrowserNavigationHistoryInput,
    success: PreviewAutomationStatus,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Go back in browser"),
);

export const PreviewBrowserForwardTool = safeBrowserTool(
  Tool.make("preview_forward", {
    description:
      "Move a collaborative browser tab one entry forward in its navigation history and wait for the page to load.",
    parameters: PreviewBrowserNavigationHistoryInput,
    success: PreviewAutomationStatus,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Go forward in browser"),
);

export const PreviewBrowserReloadTool = safeBrowserTool(
  Tool.make("preview_reload", {
    description:
      "Reload a collaborative browser tab and wait for the page to load. This uses the normal browser cache policy.",
    parameters: PreviewBrowserNavigationHistoryInput,
    success: PreviewAutomationStatus,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Reload browser tab"),
);

export const PreviewOpenTool = browserTool(
  Tool.make("preview_open", {
    description:
      "Open or show a collaborative browser tab. Pass browserId from preview_tabs to create the first controlled tab in an external browser extension. Without browserId it uses the Erebus browser. open=true controls inline visibility only, tabId reuses an exact tab, and reuseExistingTab=false creates a new tab.",
    parameters: PreviewAutomationOpenInput,
    success: PreviewAutomationStatus,
    failure: PreviewAutomationError,
    dependencies,
  })
    .annotate(Tool.Title, "Open browser preview")
    .annotate(Tool.Destructive, false),
);

export const PreviewNavigateTool = safeBrowserTool(
  Tool.make("preview_navigate", {
    description:
      "Navigate a collaborative browser tab. Pass tabId to target a specific tab, plus {url:'https://t3.chat'} for a website or {target:{kind:'environment-port',port:5173}} for a dev server. Exactly one of url or target is required.",
    parameters: PreviewAutomationNavigateInput,
    success: PreviewAutomationStatus,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Navigate browser preview"),
);

export const PreviewResizeTool = safeBrowserTool(
  Tool.make("preview_resize", {
    description:
      "Resize a collaborative browser tab, optionally selected by tabId. Use {mode:'fill'}, {mode:'freeform',width:1024,height:768}, or {mode:'preset',preset:'iphone-12-pro',orientation:'portrait'}. This changes CSS layout breakpoints without changing the desktop browser user agent.",
    parameters: PreviewAutomationResizeInput,
    success: PreviewAutomationResizeResult,
    failure: PreviewAutomationError,
    dependencies,
  })
    .annotate(Tool.Title, "Resize browser viewport")
    .annotate(Tool.Idempotent, true),
);

export const PreviewSetAppearanceTool = safeBrowserTool(
  Tool.make("preview_set_appearance", {
    description:
      "Emulate prefers-color-scheme in a collaborative browser tab, optionally selected by tabId. Use {colorScheme:'dark'} or {colorScheme:'light'} to preview the page in that appearance, and {colorScheme:'system'} to clear the override and follow the OS appearance.",
    parameters: PreviewAutomationSetColorSchemeInput,
    success: PreviewAutomationSetColorSchemeResult,
    failure: PreviewAutomationError,
    dependencies,
  })
    .annotate(Tool.Title, "Set preview appearance")
    .annotate(Tool.Idempotent, true),
);

export const PreviewSnapshotTool = readonlyBrowserTool(
  Tool.make("preview_snapshot", {
    description:
      "Inspect a page before interacting. Pass tabId to inspect a specific tab; omit it to use this agent session's current tab. Returns page state, semantic elements, diagnostics, action history, and a PNG screenshot when capture is available.",
    parameters: PreviewAutomationTabTargetInput,
    success: PreviewAutomationSnapshot,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Inspect browser page"),
);

export const PreviewClickTool = browserTool(
  Tool.make("preview_click", {
    description:
      "Click exactly one target in the tab selected by tabId, or this agent session's current tab when omitted. Prefer a Playwright locator; selector accepts legacy CSS; x and y must be supplied together.",
    parameters: PreviewAutomationClickInput,
    success: PreviewActionResult,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Click preview page"),
);

export const PreviewTypeTool = browserTool(
  Tool.make("preview_type", {
    description:
      "Insert literal text into one input in the tab selected by tabId, or this agent session's current tab when omitted. Prefer a Playwright locator; set clear=true to replace existing text.",
    parameters: PreviewAutomationTypeInput,
    success: PreviewActionResult,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Type into preview page"),
);

export const PreviewPressTool = browserTool(
  Tool.make("preview_press", {
    description:
      "Press one keyboard key in the tab selected by tabId, or this agent session's current tab when omitted. Examples: {key:'Enter'}, {key:'Escape'}, or {key:'a',modifiers:['Meta']}.",
    parameters: PreviewAutomationPressInput,
    success: PreviewActionResult,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Press key in preview page"),
);

export const PreviewScrollTool = safeBrowserTool(
  Tool.make("preview_scroll", {
    description:
      "Scroll the tab selected by tabId, or this agent session's current tab when omitted. Positive deltaY scrolls down and positive deltaX scrolls right; a locator/selector targets a container.",
    parameters: PreviewAutomationScrollInput,
    success: PreviewActionResult,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Scroll preview page"),
);

export const PreviewEvaluateTool = browserTool(
  Tool.make("preview_evaluate", {
    description:
      "Evaluate JavaScript in the tab selected by tabId, or this agent session's current tab when omitted. Returns a serializable result up to 64 KB; the expression may mutate page state.",
    parameters: PreviewAutomationEvaluateInput,
    success: Schema.Struct({ value: Schema.Unknown }),
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Evaluate JavaScript in preview"),
);

export const PreviewWaitForTool = readonlyBrowserTool(
  Tool.make("preview_wait_for", {
    description:
      "Wait in the tab selected by tabId, or this agent session's current tab when omitted, until all supplied locator, selector, text, and URL conditions match.",
    parameters: PreviewAutomationWaitForInput,
    success: PreviewActionResult,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Wait for preview page condition"),
);

export const PreviewRecordingStartTool = safeBrowserTool(
  Tool.make("preview_recording_start", {
    description:
      "Start recording the collaborative browser tab selected by tabId, or this agent session's current tab when omitted.",
    parameters: PreviewAutomationTabTargetInput,
    success: PreviewAutomationRecordingStatus,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Start browser recording"),
);

export const PreviewRecordingStopTool = safeBrowserTool(
  Tool.make("preview_recording_stop", {
    description:
      "Stop recording the collaborative browser tab selected by tabId, or this agent session's current tab when omitted, and save it as a local evidence artifact.",
    parameters: PreviewAutomationTabTargetInput,
    success: PreviewAutomationRecordingArtifact,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Stop browser recording"),
);

export const PreviewToolkit = Toolkit.make(
  PreviewStatusTool,
  PreviewBrowserProfilesListTool,
  PreviewBrowserProfileCreateTool,
  PreviewBrowserProfileRenameTool,
  PreviewBrowserProfileDeleteTool,
  PreviewBrowserProfileSelectTool,
  PreviewBrowserProfileProxyTool,
  PreviewBrowserTabsTool,
  ExtensionBrowserListTool,
  ExtensionBrowserOpenTool,
  PreviewBrowserTabCloseTool,
  PreviewBrowserBackTool,
  PreviewBrowserForwardTool,
  PreviewBrowserReloadTool,
  PreviewOpenTool,
  PreviewNavigateTool,
  PreviewResizeTool,
  PreviewSetAppearanceTool,
  PreviewSnapshotTool,
  PreviewClickTool,
  PreviewTypeTool,
  PreviewPressTool,
  PreviewScrollTool,
  PreviewEvaluateTool,
  PreviewWaitForTool,
  PreviewRecordingStartTool,
  PreviewRecordingStopTool,
);

export const PreviewStandardToolkit = Toolkit.make(
  PreviewStatusTool,
  PreviewBrowserProfilesListTool,
  PreviewBrowserProfileCreateTool,
  PreviewBrowserProfileRenameTool,
  PreviewBrowserProfileDeleteTool,
  PreviewBrowserProfileSelectTool,
  PreviewBrowserProfileProxyTool,
  PreviewBrowserTabsTool,
  ExtensionBrowserListTool,
  ExtensionBrowserOpenTool,
  PreviewBrowserTabCloseTool,
  PreviewBrowserBackTool,
  PreviewBrowserForwardTool,
  PreviewBrowserReloadTool,
  PreviewOpenTool,
  PreviewNavigateTool,
  PreviewResizeTool,
  PreviewSetAppearanceTool,
  PreviewClickTool,
  PreviewTypeTool,
  PreviewPressTool,
  PreviewScrollTool,
  PreviewEvaluateTool,
  PreviewWaitForTool,
  PreviewRecordingStartTool,
  PreviewRecordingStopTool,
);

export const PreviewSnapshotToolkit = Toolkit.make(PreviewSnapshotTool);
