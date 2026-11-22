import { describe, expect, it } from "vite-plus/test";

import {
  extensionAutomationTabId,
  parseExtensionAutomationTabId,
  rewriteExtensionAutomationResult,
} from "./extensionAutomationTarget";

describe("extension automation targets", () => {
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
});
