import {
  DEFAULT_DESKTOP_PREVIEW_BROWSER_PROFILE_ID,
  DesktopPreviewBrowserProfileIdSchema,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  browserProfileTabKey,
  resolveBrowserProfileId,
  useBrowserProfileSelectionStore,
} from "./browserProfileSelectionStore";

const ref = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};

describe("browser profile selection", () => {
  afterEach(() => {
    useBrowserProfileSelectionStore.setState({ byEnvironment: {}, byTab: {} });
  });

  it("prefers the tab selection over the environment default", () => {
    const tabProfile = DesktopPreviewBrowserProfileIdSchema.make("tab-profile");
    const environmentProfile = DesktopPreviewBrowserProfileIdSchema.make("environment-profile");

    expect(
      resolveBrowserProfileId(ref, "tab-1", {
        byEnvironment: { [ref.environmentId]: environmentProfile },
        byTab: {
          [browserProfileTabKey(ref, "tab-1")]: {
            profileId: tabProfile,
            updatedAt: 1,
          },
        },
      }),
    ).toBe(tabProfile);
  });

  it("falls back to the compatible default profile", () => {
    expect(resolveBrowserProfileId(ref, "tab-1", { byEnvironment: {}, byTab: {} })).toBe(
      DEFAULT_DESKTOP_PREVIEW_BROWSER_PROFILE_ID,
    );
  });

  it("changes one tab without changing the environment default", () => {
    const environmentProfile = DesktopPreviewBrowserProfileIdSchema.make("environment-profile");
    const tabProfile = DesktopPreviewBrowserProfileIdSchema.make("tab-profile");
    useBrowserProfileSelectionStore.setState({
      byEnvironment: { [ref.environmentId]: environmentProfile },
      byTab: {},
    });

    useBrowserProfileSelectionStore.getState().selectForTab(ref, "tab-1", tabProfile);

    const state = useBrowserProfileSelectionStore.getState();
    expect(state.byEnvironment[ref.environmentId]).toBe(environmentProfile);
    expect(resolveBrowserProfileId(ref, "tab-1", state)).toBe(tabProfile);
    expect(resolveBrowserProfileId(ref, "tab-2", state)).toBe(environmentProfile);
  });
});
