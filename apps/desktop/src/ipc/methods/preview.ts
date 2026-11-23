import {
  DEFAULT_DESKTOP_PREVIEW_BROWSER_PROFILE_ID,
  DesktopPreviewAnnotationThemeInputSchema,
  DesktopPreviewArtifactInputSchema,
  DesktopPreviewBrowserProfileDeleteInputSchema,
  DesktopPreviewBrowserProfileDeleteResultSchema,
  DesktopPreviewBrowserProfilesClearEnvironmentInputSchema,
  DesktopPreviewBrowserProfileNameInputSchema,
  DesktopPreviewBrowserProfileSchema,
  DesktopPreviewBrowserProfileUpdateInputSchema,
  DesktopPreviewAutomationClickInputSchema,
  DesktopPreviewAutomationEvaluateInputSchema,
  DesktopPreviewAutomationPressInputSchema,
  DesktopPreviewAutomationScrollInputSchema,
  DesktopPreviewAutomationTypeInputSchema,
  DesktopPreviewAutomationWaitForInputSchema,
  DesktopPreviewConfigInputSchema,
  DesktopPreviewConfigureProxyInputSchema,
  DesktopPreviewNavigateInputSchema,
  DesktopPreviewRecordingArtifactSchema,
  DesktopPreviewRecordingSaveInputSchema,
  DesktopPreviewRegisterWebviewInputSchema,
  DesktopPreviewScreenshotArtifactSchema,
  DesktopPreviewSetAudioMutedInputSchema,
  DesktopPreviewSetColorSchemeInputSchema,
  DesktopPreviewCreateTabInputSchema,
  DesktopPreviewTabInputSchema,
  DesktopPreviewWebviewConfigSchema,
  PreviewAnnotationSubmissionResultSchema,
  PreviewAutomationSnapshot,
  PreviewAutomationStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as NodeURL from "node:url";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as ElectronShell from "../../electron/ElectronShell.ts";
import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as PreviewManager from "../../preview/Manager.ts";
import * as BrowserProfileRegistry from "../../preview/BrowserProfileRegistry.ts";
import * as BrowserSession from "../../preview/BrowserSession.ts";
import { PREVIEW_WEBVIEW_PREFERENCES } from "../../preview/WebviewPreferences.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const installPreviewEventForwarding = Effect.fn(
  "desktop.ipc.preview.installEventForwarding",
)(function* () {
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const manager = yield* PreviewManager.PreviewManager;
  yield* manager.subscribeStateChanges((tabId, state) =>
    electronWindow.sendAll(IpcChannels.PREVIEW_STATE_CHANGE_CHANNEL, tabId, state),
  );
  yield* manager.subscribeRecordingFrames((frame) =>
    electronWindow.sendAll(IpcChannels.PREVIEW_RECORDING_FRAME_CHANNEL, frame),
  );
  yield* manager.subscribePointerEvents((event) =>
    electronWindow.sendAll(IpcChannels.PREVIEW_POINTER_EVENT_CHANNEL, event),
  );
});

export const createTab = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_CREATE_TAB_CHANNEL,
  payload: DesktopPreviewCreateTabInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.createTab")(function* ({
    tabId,
    zoomFactor,
    colorScheme,
  }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.createTab(tabId, { zoomFactor, colorScheme });
  }),
});

export const closeTab = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_CLOSE_TAB_CHANNEL,
  payload: DesktopPreviewTabInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.closeTab")(function* ({ tabId }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.closeTab(tabId);
  }),
});

export const registerWebview = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_REGISTER_WEBVIEW_CHANNEL,
  payload: DesktopPreviewRegisterWebviewInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.registerWebview")(function* ({ tabId, webContentsId }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.registerWebview(tabId, webContentsId);
  }),
});

export const navigate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_NAVIGATE_CHANNEL,
  payload: DesktopPreviewNavigateInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.navigate")(function* ({ tabId, url }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.navigate(tabId, url);
  }),
});

const tabMethod = (
  channel: string,
  name: string,
  invoke: (
    manager: PreviewManager.PreviewManager["Service"],
    tabId: string,
  ) => Effect.Effect<void, PreviewManager.PreviewManagerError>,
) =>
  DesktopIpc.makeIpcMethod({
    channel,
    payload: DesktopPreviewTabInputSchema,
    result: Schema.Void,
    handler: Effect.fn(name)(function* ({ tabId }) {
      const manager = yield* PreviewManager.PreviewManager;
      yield* invoke(manager, tabId);
    }),
  });

export const goBack = tabMethod(
  IpcChannels.PREVIEW_GO_BACK_CHANNEL,
  "desktop.ipc.preview.goBack",
  (manager, tabId) => manager.goBack(tabId),
);
export const goForward = tabMethod(
  IpcChannels.PREVIEW_GO_FORWARD_CHANNEL,
  "desktop.ipc.preview.goForward",
  (manager, tabId) => manager.goForward(tabId),
);
export const refresh = tabMethod(
  IpcChannels.PREVIEW_REFRESH_CHANNEL,
  "desktop.ipc.preview.refresh",
  (manager, tabId) => manager.refresh(tabId),
);
export const zoomIn = tabMethod(
  IpcChannels.PREVIEW_ZOOM_IN_CHANNEL,
  "desktop.ipc.preview.zoomIn",
  (manager, tabId) => manager.zoomIn(tabId),
);
export const zoomOut = tabMethod(
  IpcChannels.PREVIEW_ZOOM_OUT_CHANNEL,
  "desktop.ipc.preview.zoomOut",
  (manager, tabId) => manager.zoomOut(tabId),
);
export const resetZoom = tabMethod(
  IpcChannels.PREVIEW_RESET_ZOOM_CHANNEL,
  "desktop.ipc.preview.resetZoom",
  (manager, tabId) => manager.resetZoom(tabId),
);
export const hardReload = tabMethod(
  IpcChannels.PREVIEW_HARD_RELOAD_CHANNEL,
  "desktop.ipc.preview.hardReload",
  (manager, tabId) => manager.hardReload(tabId),
);
export const setColorScheme = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_SET_COLOR_SCHEME_CHANNEL,
  payload: DesktopPreviewSetColorSchemeInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.setColorScheme")(function* ({ tabId, colorScheme }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.setColorScheme(tabId, colorScheme);
  }),
});
export const setAudioMuted = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_SET_AUDIO_MUTED_CHANNEL,
  payload: DesktopPreviewSetAudioMutedInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.setAudioMuted")(function* ({ tabId, audioMuted }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.setAudioMuted(tabId, audioMuted);
  }),
});
export const openDevTools = tabMethod(
  IpcChannels.PREVIEW_OPEN_DEVTOOLS_CHANNEL,
  "desktop.ipc.preview.openDevTools",
  (manager, tabId) => manager.openDevTools(tabId),
);
export const cancelPickElement = tabMethod(
  IpcChannels.PREVIEW_CANCEL_PICK_ELEMENT_CHANNEL,
  "desktop.ipc.preview.cancelPickElement",
  (manager, tabId) => manager.cancelPickElement(tabId),
);
export const startRecording = tabMethod(
  IpcChannels.PREVIEW_RECORDING_START_CHANNEL,
  "desktop.ipc.preview.startRecording",
  (manager, tabId) => manager.startRecording(tabId),
);
export const stopRecording = tabMethod(
  IpcChannels.PREVIEW_RECORDING_STOP_CHANNEL,
  "desktop.ipc.preview.stopRecording",
  (manager, tabId) => manager.stopRecording(tabId),
);
export const openPictureInPicture = tabMethod(
  IpcChannels.PREVIEW_PICTURE_IN_PICTURE_OPEN_CHANNEL,
  "desktop.ipc.preview.openPictureInPicture",
  (manager, tabId) => manager.openPictureInPicture(tabId),
);
export const closePictureInPicture = tabMethod(
  IpcChannels.PREVIEW_PICTURE_IN_PICTURE_CLOSE_CHANNEL,
  "desktop.ipc.preview.closePictureInPicture",
  (manager, tabId) => manager.closePictureInPicture(tabId),
);

export const clearCookies = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_CLEAR_COOKIES_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.clearCookies")(function* () {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.clearCookies();
  }),
});

export const clearCache = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_CLEAR_CACHE_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.clearCache")(function* () {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.clearCache();
  }),
});

export const getPreviewConfig = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_GET_CONFIG_CHANNEL,
  payload: DesktopPreviewConfigInputSchema,
  result: DesktopPreviewWebviewConfigSchema,
  handler: Effect.fn("desktop.ipc.preview.getConfig")(function* ({
    environmentId,
    browserProfileId,
  }) {
    const manager = yield* PreviewManager.PreviewManager;
    const profiles = yield* BrowserProfileRegistry.BrowserProfileRegistry;
    yield* profiles.assertExists(browserProfileId);
    const namedProfileId =
      browserProfileId === DEFAULT_DESKTOP_PREVIEW_BROWSER_PROFILE_ID
        ? undefined
        : browserProfileId;
    yield* manager.getBrowserSession(environmentId, namedProfileId);
    const partition = yield* manager.getBrowserPartition(environmentId, namedProfileId);
    yield* profiles.recordPartition(
      browserProfileId ?? DEFAULT_DESKTOP_PREVIEW_BROWSER_PROFILE_ID,
      partition,
      environmentId,
    );
    return {
      partition,
      webPreferences: PREVIEW_WEBVIEW_PREFERENCES,
      preloadUrl: NodeURL.pathToFileURL(`${__dirname}/preview-pick-preload.cjs`).href,
    };
  }),
});

export const resolveWebCaptureExtensionDirectory = Effect.fn(
  "desktop.ipc.preview.resolveWebCaptureExtensionDirectory",
)(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const relativeDirectory = environment.path.join("erebus-web", "extension");
  const candidates = environment.isDevelopment
    ? [
        environment.path.join(environment.rootDir, "native", "erebus-web", "extension", "dist"),
        environment.path.join(
          environment.rootDir,
          "apps",
          "desktop",
          "prod-resources",
          relativeDirectory,
        ),
      ]
    : environment.isPackaged
      ? [environment.path.join(environment.resourcesPath, relativeDirectory)]
      : environment.resolveResourcePathCandidates(relativeDirectory);

  for (const candidate of candidates) {
    const isDirectory = yield* fileSystem.stat(candidate).pipe(
      Effect.map((stat) => stat.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );
    if (!isDirectory) continue;
    if (!(environment.isPackaged && environment.platform === "linux")) {
      return Option.some(candidate);
    }

    const stableDirectory = environment.path.join(environment.stateDir, "web-capture-extension");
    const copied = yield* fileSystem
      .copy(candidate, stableDirectory, { overwrite: true })
      .pipe(Effect.option);
    return Option.isSome(copied) ? Option.some(stableDirectory) : Option.none<string>();
  }
  return Option.none<string>();
});

export const openCaptureExtensionFolder = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_OPEN_CAPTURE_EXTENSION_FOLDER_CHANNEL,
  payload: Schema.Void,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.preview.openCaptureExtensionFolder")(function* () {
    const extensionDirectory = yield* resolveWebCaptureExtensionDirectory();
    if (Option.isNone(extensionDirectory)) return false;
    return yield* (yield* ElectronShell.ElectronShell).openPath(extensionDirectory.value);
  }),
});

const CaptureExtensionBrowser = Schema.Literals(["chromium", "firefox"]);

export const downloadCaptureExtension = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_DOWNLOAD_CAPTURE_EXTENSION_CHANNEL,
  payload: Schema.Struct({ browser: CaptureExtensionBrowser }),
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn("desktop.ipc.preview.downloadCaptureExtension")(function* ({ browser }) {
    const extensionDirectory = yield* resolveWebCaptureExtensionDirectory();
    if (Option.isNone(extensionDirectory)) return null;

    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const electronApp = yield* ElectronApp.ElectronApp;
    const downloadsDirectory = electronApp.getPath
      ? yield* electronApp.getPath("downloads")
      : environment.path.join(environment.homeDirectory, "Downloads");
    const fileName =
      browser === "chromium" ? "erebus-chromium-extension.zip" : "erebus-firefox-extension.xpi";
    const source = environment.path.join(extensionDirectory.value, fileName);
    const destination = environment.path.join(downloadsDirectory, fileName);
    yield* fileSystem.makeDirectory(downloadsDirectory, { recursive: true });
    yield* fileSystem.copyFile(source, destination);
    return destination;
  }),
});

export const configureProxy = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_CONFIGURE_PROXY_CHANNEL,
  payload: DesktopPreviewConfigureProxyInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.configureProxy")(function* ({
    environmentId,
    browserProfileId,
    proxy,
  }) {
    const manager = yield* PreviewManager.PreviewManager;
    const profiles = yield* BrowserProfileRegistry.BrowserProfileRegistry;
    yield* profiles.assertExists(browserProfileId);
    const namedProfileId =
      browserProfileId === DEFAULT_DESKTOP_PREVIEW_BROWSER_PROFILE_ID
        ? undefined
        : browserProfileId;
    yield* profiles.recordPartition(
      browserProfileId ?? DEFAULT_DESKTOP_PREVIEW_BROWSER_PROFILE_ID,
      yield* manager.getBrowserPartition(environmentId, namedProfileId),
      environmentId,
    );
    yield* manager.configureBrowserProxy(environmentId, namedProfileId, proxy);
  }),
});

export const listBrowserProfiles = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_BROWSER_PROFILES_LIST_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(DesktopPreviewBrowserProfileSchema),
  handler: Effect.fn("desktop.ipc.preview.listBrowserProfiles")(function* () {
    return yield* (yield* BrowserProfileRegistry.BrowserProfileRegistry).list;
  }),
});

export const createBrowserProfile = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_BROWSER_PROFILES_CREATE_CHANNEL,
  payload: DesktopPreviewBrowserProfileNameInputSchema,
  result: DesktopPreviewBrowserProfileSchema,
  handler: Effect.fn("desktop.ipc.preview.createBrowserProfile")(function* ({ name }) {
    return yield* (yield* BrowserProfileRegistry.BrowserProfileRegistry).create(name);
  }),
});

export const renameBrowserProfile = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_BROWSER_PROFILES_RENAME_CHANNEL,
  payload: DesktopPreviewBrowserProfileUpdateInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.renameBrowserProfile")(function* ({ profileId, name }) {
    yield* (yield* BrowserProfileRegistry.BrowserProfileRegistry).rename(profileId, name);
  }),
});

export const deleteBrowserProfile = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_BROWSER_PROFILES_DELETE_CHANNEL,
  payload: DesktopPreviewBrowserProfileDeleteInputSchema,
  result: DesktopPreviewBrowserProfileDeleteResultSchema,
  handler: Effect.fn("desktop.ipc.preview.deleteBrowserProfile")(function* ({ profileId }) {
    const profiles = yield* BrowserProfileRegistry.BrowserProfileRegistry;
    const manager = yield* PreviewManager.PreviewManager;
    const partitions = yield* profiles.partitions(profileId);
    const clearResult = yield* manager.clearBrowserProfile(profileId, partitions).pipe(
      Effect.as({ status: "deleted" } as const),
      Effect.catch((error) => {
        const cause = PreviewManager.isPreviewOperationError(error) ? error.cause : error;
        return BrowserSession.isBrowserProfileInUseError(cause)
          ? Effect.succeed({
              status: "in-use" as const,
              activeTabCount: cause.activeTabCount,
            })
          : Effect.fail(error);
      }),
    );
    if (clearResult.status === "in-use") return clearResult;
    yield* profiles.remove(profileId);
    return clearResult;
  }),
});

export const clearBrowserProfileEnvironment = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_BROWSER_PROFILES_CLEAR_ENVIRONMENT_CHANNEL,
  payload: DesktopPreviewBrowserProfilesClearEnvironmentInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.clearBrowserProfileEnvironment")(function* ({
    environmentId,
  }) {
    const profiles = yield* BrowserProfileRegistry.BrowserProfileRegistry;
    const manager = yield* PreviewManager.PreviewManager;
    const owners = [...(yield* profiles.environmentPartitions(environmentId))];
    for (const legacy of yield* profiles.unownedPartitions) {
      const namedProfileId =
        legacy.profileId === DEFAULT_DESKTOP_PREVIEW_BROWSER_PROFILE_ID
          ? undefined
          : legacy.profileId;
      const expectedPartition = yield* manager.getBrowserPartition(environmentId, namedProfileId);
      if (expectedPartition !== legacy.partition) continue;
      yield* profiles.recordPartition(legacy.profileId, legacy.partition, environmentId);
      owners.push({ ...legacy, environmentId });
    }
    const partitionsByProfile = new Map<string, string[]>();
    for (const owner of owners) {
      const partitions = partitionsByProfile.get(owner.profileId) ?? [];
      partitions.push(owner.partition);
      partitionsByProfile.set(owner.profileId, partitions);
    }
    yield* Effect.forEach(
      partitionsByProfile,
      ([profileId, partitions]) => manager.clearBrowserProfile(profileId, partitions),
      { concurrency: 2, discard: true },
    );
    yield* profiles.removeEnvironment(environmentId);
  }),
});

export const setAnnotationTheme = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_SET_ANNOTATION_THEME_CHANNEL,
  payload: DesktopPreviewAnnotationThemeInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.setAnnotationTheme")(function* ({ theme }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.setAnnotationTheme(theme);
  }),
});

export const pickElement = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_PICK_ELEMENT_CHANNEL,
  payload: DesktopPreviewTabInputSchema,
  result: Schema.NullOr(PreviewAnnotationSubmissionResultSchema),
  handler: Effect.fn("desktop.ipc.preview.pickElement")(function* ({ tabId }) {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* manager.pickElement(tabId);
  }),
});

export const captureScreenshot = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_CAPTURE_SCREENSHOT_CHANNEL,
  payload: DesktopPreviewTabInputSchema,
  result: DesktopPreviewScreenshotArtifactSchema,
  handler: Effect.fn("desktop.ipc.preview.captureScreenshot")(function* ({ tabId }) {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* manager.captureScreenshot(tabId);
  }),
});

export const revealArtifact = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_REVEAL_ARTIFACT_CHANNEL,
  payload: DesktopPreviewArtifactInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.revealArtifact")(function* ({ path }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.revealArtifact(path);
  }),
});

export const copyArtifactToClipboard = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_COPY_ARTIFACT_CHANNEL,
  payload: DesktopPreviewArtifactInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.copyArtifactToClipboard")(function* ({ path }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.copyArtifactToClipboard(path);
  }),
});

export const automationStatus = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_AUTOMATION_STATUS_CHANNEL,
  payload: DesktopPreviewTabInputSchema,
  result: PreviewAutomationStatus,
  handler: Effect.fn("desktop.ipc.preview.automationStatus")(function* ({ tabId }) {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* manager.automationStatus(tabId);
  }),
});

export const automationSnapshot = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_AUTOMATION_SNAPSHOT_CHANNEL,
  payload: DesktopPreviewTabInputSchema,
  result: PreviewAutomationSnapshot,
  handler: Effect.fn("desktop.ipc.preview.automationSnapshot")(function* ({ tabId }) {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* manager.automationSnapshot(tabId);
  }),
});

export const automationClick = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_AUTOMATION_CLICK_CHANNEL,
  payload: DesktopPreviewAutomationClickInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.automationClick")(function* ({ tabId, input }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.automationClick(tabId, input);
  }),
});

export const automationType = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_AUTOMATION_TYPE_CHANNEL,
  payload: DesktopPreviewAutomationTypeInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.automationType")(function* ({ tabId, input }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.automationType(tabId, input);
  }),
});

export const automationPress = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_AUTOMATION_PRESS_CHANNEL,
  payload: DesktopPreviewAutomationPressInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.automationPress")(function* ({ tabId, input }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.automationPress(tabId, input);
  }),
});

export const automationScroll = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_AUTOMATION_SCROLL_CHANNEL,
  payload: DesktopPreviewAutomationScrollInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.automationScroll")(function* ({ tabId, input }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.automationScroll(tabId, input);
  }),
});

export const automationEvaluate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_AUTOMATION_EVALUATE_CHANNEL,
  payload: DesktopPreviewAutomationEvaluateInputSchema,
  result: Schema.Unknown,
  handler: Effect.fn("desktop.ipc.preview.automationEvaluate")(function* ({ tabId, input }) {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* manager.automationEvaluate(tabId, input);
  }),
});

export const automationWaitFor = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_AUTOMATION_WAIT_FOR_CHANNEL,
  payload: DesktopPreviewAutomationWaitForInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.automationWaitFor")(function* ({ tabId, input }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.automationWaitFor(tabId, input);
  }),
});

export const saveRecording = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_RECORDING_SAVE_CHANNEL,
  payload: DesktopPreviewRecordingSaveInputSchema,
  result: DesktopPreviewRecordingArtifactSchema,
  handler: Effect.fn("desktop.ipc.preview.saveRecording")(function* ({ tabId, mimeType, data }) {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* manager.saveRecording(tabId, mimeType, data);
  }),
});

export const methods = [
  createTab,
  closeTab,
  registerWebview,
  navigate,
  goBack,
  goForward,
  refresh,
  zoomIn,
  zoomOut,
  resetZoom,
  hardReload,
  setColorScheme,
  setAudioMuted,
  openDevTools,
  clearCookies,
  clearCache,
  getPreviewConfig,
  configureProxy,
  listBrowserProfiles,
  createBrowserProfile,
  renameBrowserProfile,
  deleteBrowserProfile,
  clearBrowserProfileEnvironment,
  setAnnotationTheme,
  pickElement,
  cancelPickElement,
  captureScreenshot,
  revealArtifact,
  copyArtifactToClipboard,
  openPictureInPicture,
  closePictureInPicture,
  automationStatus,
  automationSnapshot,
  automationClick,
  automationType,
  automationPress,
  automationScroll,
  automationEvaluate,
  automationWaitFor,
  startRecording,
  stopRecording,
  saveRecording,
] as const;
