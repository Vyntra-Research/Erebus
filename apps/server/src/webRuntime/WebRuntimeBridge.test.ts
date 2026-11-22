import { WebRuntimeTrafficPage } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  decodeWebRuntimeResponse,
  webRuntimeRequestPath,
  webRuntimeRpcFailure,
} from "./WebRuntimeBridge.ts";
import { WebRuntimeRequestFailed, WebRuntimeUnavailable } from "./WebRuntimeClient.ts";

describe("WebRuntimeBridge", () => {
  it("encodes filters without dropping false and omits missing values", () => {
    expect(
      webRuntimeRequestPath("/v1/traffic", {
        text: "a b&c",
        inScopeOnly: false,
        limit: 50,
        cursor: undefined,
      }),
    ).toBe("/v1/traffic?text=a+b%26c&inScopeOnly=false&limit=50");
  });

  it("maps runtime failures without exposing their internal cause", () => {
    const missing = webRuntimeRpcFailure(
      "read exchange",
      new WebRuntimeRequestFailed({
        path: "/v1/traffic/secret-internal-id",
        status: 404,
        cause: new Error("private diagnostic"),
      }),
    );
    expect(missing).toMatchObject({
      code: "request_failed",
      operation: "read exchange",
      status: 404,
      message: "The requested web capture item was not found.",
    });
    expect(JSON.stringify(missing)).not.toContain("private diagnostic");

    const busy = webRuntimeRpcFailure(
      "read graph",
      new WebRuntimeRequestFailed({
        path: "/v1/graph",
        status: 429,
        detail: "runtime is busy",
        retryAfterSeconds: 1,
      }),
    );
    expect(busy).toMatchObject({
      code: "request_failed",
      operation: "read graph",
      status: 429,
      message: "Web capture runtime is busy. Retry after 1 second.",
    });

    const unavailable = webRuntimeRpcFailure(
      "list traffic",
      new WebRuntimeUnavailable({ message: "private process failure" }),
    );
    expect(unavailable).toMatchObject({
      code: "unavailable",
      message: "Web capture runtime is unavailable.",
    });
  });

  it.effect("rejects malformed runtime responses at the bridge", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decodeWebRuntimeResponse("list traffic", WebRuntimeTrafficPage, {
          items: [{ id: "incomplete" }],
          nextCursor: null,
        }),
      );
      expect(error).toMatchObject({
        code: "invalid_response",
        operation: "list traffic",
      });
    }),
  );
});
