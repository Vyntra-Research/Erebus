import {
  DesktopPreviewBrowserProfileIdSchema,
  type WebRuntimeCaptureSession,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  browserCaptureSource,
  captureSourceConfiguration,
  captureRollbackFailure,
  endCaptureAfterProxyClear,
  findActiveProfileCapture,
  hasAnotherActiveCaptureForSource,
  mergeEvidenceById,
  parseAnnotationTags,
  parseReplayHeaders,
  resolveBrowserProfileCaptureState,
  runtimeRestartCleanup,
} from "./webSecurityPanelLogic";

const profileId = DesktopPreviewBrowserProfileIdSchema.make("profile-a");

function capture(
  id: string,
  options: { readonly ended?: boolean; readonly source?: string } = {},
): WebRuntimeCaptureSession {
  return {
    id,
    label: id,
    source: options.source ?? browserCaptureSource(profileId),
    startedAt: "2026-11-20T12:00:00.000Z",
    endedAt: options.ended ? "2026-11-20T12:01:00.000Z" : null,
    scopeProfileId: "default",
    upstreamTlsMode: "verify",
    proxy: null,
  };
}

describe("web security panel logic", () => {
  it("merges paged evidence without duplicates and preserves page order", () => {
    expect(
      mergeEvidenceById(
        [
          { id: "new", value: 1 },
          { id: "shared", value: 2 },
        ],
        [
          { id: "shared", value: 9 },
          { id: "old", value: 3 },
        ],
      ),
    ).toEqual([
      { id: "new", value: 1 },
      { id: "shared", value: 2 },
      { id: "old", value: 3 },
    ]);
  });

  it("parses replay headers without losing duplicate names", () => {
    expect(parseReplayHeaders("Accept: application/json\nX-Test: one\nX-Test: two")).toEqual({
      headers: [
        { name: "Accept", value: "application/json" },
        { name: "X-Test", value: "one" },
        { name: "X-Test", value: "two" },
      ],
    });
    expect(parseReplayHeaders("missing-colon")).toEqual({
      error: "Header line 1 needs a name followed by a colon.",
    });
  });

  it("normalizes annotation tags and removes duplicates", () => {
    expect(parseAnnotationTags("auth, api, auth,  ")).toEqual(["auth", "api"]);
  });

  it("finds only an active capture for the selected browser session", () => {
    const ended = capture("ended", { ended: true });
    const active = capture("active");
    expect(findActiveProfileCapture([ended, active], profileId)).toBe(active);
  });

  it("creates either a browser proxy capture or an extension-only capture", () => {
    expect(captureSourceConfiguration(profileId)).toEqual({
      source: "browser:profile-a",
      proxy: true,
    });
    expect(captureSourceConfiguration(null)).toEqual({
      source: "extension:chromium",
      proxy: false,
    });
    expect(captureSourceConfiguration(null, "firefox")).toEqual({
      source: "extension:firefox",
      proxy: true,
    });
  });

  it("does not clear a shared proxy while another capture still uses its source", () => {
    const first = capture("first");
    const second = capture("second");
    const otherProfile = capture("other", { source: "browser:profile-b" });

    expect(hasAnotherActiveCaptureForSource([first, second, otherProfile], first)).toBe(true);
    expect(hasAnotherActiveCaptureForSource([first, otherProfile], first)).toBe(false);
  });

  it("offers to resume a persisted active session whose proxy was lost", () => {
    const stale = capture("stale");
    const live = {
      ...capture("live"),
      proxy: {
        url: "http://127.0.0.1:9000",
        caEndpoint: "/ca",
        upstreamTlsMode: "verify" as const,
      },
    };

    expect(resolveBrowserProfileCaptureState([stale], profileId)).toEqual({
      kind: "resume",
      session: stale,
    });
    expect(resolveBrowserProfileCaptureState([live], profileId)).toEqual({
      kind: "capturing",
      session: live,
    });
  });

  it("clears dead browser proxies and pairing state only when the runtime restarts", () => {
    const stale = capture("stale");
    const live = {
      ...capture("live", { source: "browser:profile-b" }),
      proxy: {
        url: "http://127.0.0.1:9000",
        caEndpoint: "/ca",
        upstreamTlsMode: "verify" as const,
      },
    };

    expect(runtimeRestartCleanup(2, 2, [stale])).toEqual({
      restarted: false,
      profileIds: [],
    });
    expect(runtimeRestartCleanup(2, 3, [stale, live])).toEqual({
      restarted: true,
      profileIds: [profileId, "profile-b"],
    });
    expect(runtimeRestartCleanup(null, 3, [live])).toEqual({
      restarted: false,
      profileIds: [],
    });
  });

  it("reports both the proxy failure and a failed rollback", () => {
    expect(
      captureRollbackFailure(new Error("proxy refused"), new Error("runtime unavailable")).message,
    ).toContain("proxy refused");
    expect(
      captureRollbackFailure(new Error("proxy refused"), new Error("runtime unavailable")).message,
    ).toContain("runtime unavailable");
  });

  it("clears the browser proxy before ending a capture", async () => {
    const order: string[] = [];
    await endCaptureAfterProxyClear({
      clearProxy: async () => {
        order.push("clear");
      },
      endCapture: async () => {
        order.push("end");
      },
    });
    expect(order).toEqual(["clear", "end"]);
  });

  it("restores the browser proxy when ending the capture fails", async () => {
    const order: string[] = [];
    await expect(
      endCaptureAfterProxyClear({
        clearProxy: async () => {
          order.push("clear");
        },
        endCapture: async () => {
          order.push("end");
          throw new Error("runtime refused");
        },
        restoreProxy: async () => {
          order.push("restore");
        },
      }),
    ).rejects.toThrow("runtime refused");
    expect(order).toEqual(["clear", "end", "restore"]);
  });

  it("reports both failures when browser proxy restore also fails", async () => {
    await expect(
      endCaptureAfterProxyClear({
        clearProxy: async () => undefined,
        endCapture: async () => {
          throw new Error("runtime refused");
        },
        restoreProxy: async () => {
          throw new Error("profile unavailable");
        },
      }),
    ).rejects.toThrow(/runtime refused.*profile unavailable/);
  });
});
