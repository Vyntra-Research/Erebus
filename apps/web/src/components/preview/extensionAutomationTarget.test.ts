import { describe, expect, it } from "vite-plus/test";

import {
  extensionAutomationBrowserId,
  extensionAutomationBrowsers,
  extensionAutomationTabId,
  isExtensionAutomationTargetOperation,
  parseExtensionAutomationBrowserId,
  parseExtensionAutomationTabId,
  rewriteExtensionAutomationResult,
} from "./extensionAutomationTarget";

describe("extension automation targets", () => {
  it("round-trips extension browser ids", () => {
    const id = extensionAutomationBrowserId("producer:one");
    expect(parseExtensionAutomationBrowserId(id)).toBe("producer:one");
  });

  it("lists connected extension browsers even before they have a controlled tab", () => {
    expect(
      extensionAutomationBrowsers([
        {
          sessionId: "session",
          producerId: "brave",
          browser: "chromium",
          version: "1.0.0",
          lastSeenMs: 1,
          connected: true,
          tabs: [],
        },
      ]),
    ).toEqual([
      {
        browserId: "extension-client:brave",
        kind: "extension",
        browser: "chromium",
        version: "1.0.0",
        connected: true,
        tabCount: 0,
      },
    ]);
  });

  it("round-trips producer and tab ids", () => {
    const id = extensionAutomationTabId("producer:one", 17);
    expect(parseExtensionAutomationTabId(id)).toEqual({ producerId: "producer:one", tabId: 17 });
  });

  it("rewrites tab ids returned by the extension", () => {
    expect(
      rewriteExtensionAutomationResult("producer", {
        tabId: 4,
        tabs: [{ tabId: 5 }],
        viewport: { width: 800 },
      }),
    ).toEqual({
      tabId: "extension:producer:4",
      tabs: [{ tabId: "extension:producer:5" }],
      viewport: { width: 800 },
    });
  });

  it("keeps global tab and profile operations out of the extension command channel", () => {
    expect(isExtensionAutomationTargetOperation("status")).toBe(true);
    expect(isExtensionAutomationTargetOperation("tabsList")).toBe(false);
    expect(isExtensionAutomationTargetOperation("browserProfilesList")).toBe(false);
    expect(isExtensionAutomationTargetOperation("webRuntimeReachability")).toBe(false);
  });
});
