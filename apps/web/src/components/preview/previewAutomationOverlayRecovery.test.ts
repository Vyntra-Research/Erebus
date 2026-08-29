import { describe, expect, it, vi } from "vite-plus/test";

import { recoverPreviewAutomationOverlay } from "./previewAutomationOverlayRecovery";

const statusValue = (available: boolean) => ({
  available,
  visible: available,
  tabId: available ? "runtime-tab-1" : null,
  url: available ? "http://127.0.0.1:3000" : null,
  title: available ? "Preview" : null,
  loading: false,
});

describe("recoverPreviewAutomationOverlay", () => {
  it("registers an attached webview when the desktop overlay state event was missed", async () => {
    const registerWebview = vi.fn(async () => undefined);
    const status = vi
      .fn()
      .mockResolvedValueOnce(statusValue(false))
      .mockResolvedValueOnce(statusValue(true));

    const result = await recoverPreviewAutomationOverlay({
      bridge: { registerWebview, automation: { status } },
      runtimeTabId: "runtime-tab-1",
      webview: { getWebContentsId: () => 42 },
      registeredWebContentsId: null,
    });

    expect(registerWebview).toHaveBeenCalledWith("runtime-tab-1", 42);
    expect(result).toEqual({ available: true, registeredWebContentsId: 42 });
  });

  it("does not register the same webview again while the overlay is still unavailable", async () => {
    const registerWebview = vi.fn(async () => undefined);
    const status = vi.fn(async () => statusValue(false));

    const result = await recoverPreviewAutomationOverlay({
      bridge: { registerWebview, automation: { status } },
      runtimeTabId: "runtime-tab-1",
      webview: { getWebContentsId: () => 42 },
      registeredWebContentsId: 42,
    });

    expect(registerWebview).not.toHaveBeenCalled();
    expect(result.available).toBe(false);
  });
});
