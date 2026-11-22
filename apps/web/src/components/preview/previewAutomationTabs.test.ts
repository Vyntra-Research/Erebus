import {
  PreviewTabId,
  ThreadId,
  type PreviewAutomationStatus,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { listPreviewAutomationTabs } from "./previewAutomationTabs";

const threadId = ThreadId.make("thread-1");

const snapshot = (tabId: string, updatedAt: string, url: string): PreviewSessionSnapshot => ({
  threadId,
  tabId: PreviewTabId.make(tabId),
  navStatus: { _tag: "Loading", url, title: "Stale title" },
  canGoBack: true,
  canGoForward: false,
  updatedAt,
});

const liveStatus = (tabId: PreviewTabId, url: string, title: string): PreviewAutomationStatus => ({
  available: true,
  visible: false,
  tabId,
  url,
  title,
  loading: false,
});

describe("listPreviewAutomationTabs", () => {
  it("uses live desktop navigation state and falls back per unavailable tab", async () => {
    const current = snapshot("tab-current", "2026-11-21T13:00:00.000Z", "https://old.test/");
    const unavailable = snapshot(
      "tab-unavailable",
      "2026-11-21T14:00:00.000Z",
      "https://fallback.test/",
    );
    const readStatus = vi.fn(async (tabId: PreviewTabId) => {
      if (tabId === unavailable.tabId) throw new Error("tab closed during listing");
      return liveStatus(tabId, "https://current.test/", "Current title");
    });

    const tabs = await listPreviewAutomationTabs([current, unavailable], current.tabId, readStatus);

    expect(tabs).toEqual([
      {
        tabId: unavailable.tabId,
        active: false,
        url: "https://fallback.test/",
        title: "Stale title",
        loading: true,
        canGoBack: true,
        canGoForward: false,
      },
      {
        tabId: current.tabId,
        active: true,
        url: "https://current.test/",
        title: "Current title",
        loading: false,
        canGoBack: true,
        canGoForward: false,
      },
    ]);
    expect(readStatus).toHaveBeenCalledTimes(2);
  });
});
