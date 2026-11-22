import { EnvironmentId, PreviewTabId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import {
  PreviewAutomationBrowserProfileInUseHostError,
  PreviewAutomationOperationError,
  serializePreviewAutomationHostError,
} from "./previewAutomationErrors";

it("preserves a nested browser-profile-in-use reason without exposing the cause", () => {
  const error = PreviewAutomationOperationError.fromCause({
    requestId: "request-1",
    operation: "browserProfileDelete",
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    tabId: PreviewTabId.make("tab-1"),
    cause: {
      _tag: "PreviewOperationError",
      cause: {
        _tag: "BrowserProfileInUseError",
        profileId: "private-profile-id",
        activeTabCount: 2,
      },
    },
  });

  expect(error).toBeInstanceOf(PreviewAutomationBrowserProfileInUseHostError);
  expect(serializePreviewAutomationHostError(error)).toEqual({
    _tag: "PreviewAutomationExecutionError",
    message: "Close the 2 open browser tabs using this profile before deleting it.",
    detail: {
      requestId: "request-1",
      operation: "browserProfileDelete",
      environmentId: "environment-1",
      threadId: "thread-1",
      tabId: "tab-1",
      reason: "browser-profile-in-use",
      activeTabCount: 2,
    },
  });
});
