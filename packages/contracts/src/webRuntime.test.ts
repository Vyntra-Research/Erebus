import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  WebRuntimeBodyContent,
  WebRuntimeBodyInput,
  WebRuntimeAnnotationInput,
  WebRuntimeGraphQuery,
  WebRuntimeScopeProfile,
  WebRuntimeUpstreamTls,
  WebRuntimeUpdateAnnotationInput,
  webRuntimeBrowserCaptureSource,
  webRuntimeBrowserProfileId,
} from "./webRuntime.ts";

const decodeBodyInput = Schema.decodeUnknownSync(WebRuntimeBodyInput);
const decodeBodyContent = Schema.decodeUnknownSync(WebRuntimeBodyContent);
const decodeScopeProfile = Schema.decodeUnknownSync(WebRuntimeScopeProfile);
const decodeAnnotationUpdate = Schema.decodeUnknownSync(WebRuntimeUpdateAnnotationInput);
const decodeAnnotation = Schema.decodeUnknownSync(WebRuntimeAnnotationInput);
const decodeGraph = Schema.decodeUnknownSync(WebRuntimeGraphQuery);
const decodeUpstreamTls = Schema.decodeUnknownSync(WebRuntimeUpstreamTls);

describe("web runtime contracts", () => {
  it("round-trips browser profile capture sources without matching unrelated sources", () => {
    expect(webRuntimeBrowserCaptureSource("profile-a")).toBe("browser:profile-a");
    expect(webRuntimeBrowserProfileId("browser:profile-a")).toBe("profile-a");
    expect(webRuntimeBrowserProfileId("browser:")).toBeNull();
    expect(webRuntimeBrowserProfileId("extension:profile-a")).toBeNull();
  });

  it("requires an explicit body encoding, payload, and capture state", () => {
    expect(() => decodeBodyInput({ data: "payload", state: "complete" })).toThrow();
    expect(() => decodeBodyInput({ encoding: "utf8", state: "complete" })).toThrow();
    expect(() => decodeBodyInput({ encoding: "utf8", data: "payload" })).toThrow();
    expect(decodeBodyInput({ encoding: "utf8", data: "payload", state: "complete" })).toEqual({
      encoding: "utf8",
      data: "payload",
      state: "complete",
    });
  });

  it("decodes stored body bytes without deriving a per-reference original size", () => {
    const decoded = decodeBodyContent({
      hash: "sha256:body",
      mime: "application/json",
      capturedSize: 24,
      storedSize: 18,
      codec: "zstd",
      dataBase64: "e30=",
    });

    expect(decoded.storedSize).toBe(18);
    expect("originalSize" in decoded).toBe(false);
  });

  it("validates mutable scope and annotation records at the bridge boundary", () => {
    const scope = decodeScopeProfile({
      id: "scope-1",
      name: "Target",
      version: 2,
      createdAt: "2026-11-20T00:00:00Z",
      updatedAt: "2026-11-20T00:01:00Z",
      rules: [
        {
          id: "rule-1",
          action: "include",
          matcher: "host_wildcard",
          pattern: "*.example.com",
          enabled: true,
          orderIndex: 0,
        },
      ],
    });
    const update = decodeAnnotationUpdate({
      id: "annotation-1",
      body: "Confirmed from replay.",
      tags: ["confirmed"],
    });

    expect(scope.rules[0]?.matcher).toBe("host_wildcard");
    expect(update.tags).toEqual(["confirmed"]);
  });

  it("keeps annotation targets and graph scope aligned with the runtime", () => {
    expect(
      decodeAnnotation({ targetType: "observation", targetId: "request-1", body: "Confirmed" }),
    ).toEqual({ targetType: "observation", targetId: "request-1", body: "Confirmed" });
    expect(() =>
      decodeAnnotation({ targetType: "http_exchange", targetId: "request-1", body: "Invalid" }),
    ).toThrow();
    expect(decodeGraph({ scope: "out_of_scope", inScopeOnly: false })).toEqual({
      scope: "out_of_scope",
      inScopeOnly: false,
    });
  });

  it("keeps upstream TLS verification explicit and requires a CA for custom trust", () => {
    expect(decodeUpstreamTls({ mode: "verify" })).toEqual({ mode: "verify" });
    expect(decodeUpstreamTls({ mode: "insecure" })).toEqual({ mode: "insecure" });
    expect(decodeUpstreamTls({ mode: "customCa", caPem: "-----BEGIN CERTIFICATE-----" })).toEqual({
      mode: "customCa",
      caPem: "-----BEGIN CERTIFICATE-----",
    });
    expect(() => decodeUpstreamTls({ mode: "customCa" })).toThrow();
  });
});
