import { describe, expect, it } from "vite-plus/test";

import {
  mergeTurnFinishedOutcome,
  TURN_FINISHED_OVERLAY_DATA_URLS,
  turnFinishedDockBadge,
  turnFinishedOverlayDescription,
} from "./turnFinishedIndicator.logic.ts";

describe("turn finished indicator", () => {
  it("ships distinct PNG overlay icons for success and failure", () => {
    for (const dataUrl of Object.values(TURN_FINISHED_OVERLAY_DATA_URLS)) {
      expect(dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    }
    expect(TURN_FINISHED_OVERLAY_DATA_URLS.success).not.toBe(TURN_FINISHED_OVERLAY_DATA_URLS.error);
  });

  it("keeps an error indicator until the window regains focus", () => {
    expect(mergeTurnFinishedOutcome(null, "success")).toBe("success");
    expect(mergeTurnFinishedOutcome("success", "success")).toBe("success");
    expect(mergeTurnFinishedOutcome("success", "error")).toBe("error");
    expect(mergeTurnFinishedOutcome("error", "success")).toBe("error");
  });

  it("distinguishes the two outcomes in shell chrome", () => {
    expect(turnFinishedDockBadge("success")).not.toBe(turnFinishedDockBadge("error"));
    expect(turnFinishedOverlayDescription("success")).not.toBe(
      turnFinishedOverlayDescription("error"),
    );
  });
});
