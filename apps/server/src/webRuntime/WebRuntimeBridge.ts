import * as WebRuntimeContract from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as WebRuntimeClient from "./WebRuntimeClient.ts";

const isWebRuntimeUnavailable = Schema.is(WebRuntimeClient.WebRuntimeUnavailable);

export function webRuntimeRpcFailure(
  operation: string,
  error: WebRuntimeClient.WebRuntimeUnavailable | WebRuntimeClient.WebRuntimeRequestFailed,
): WebRuntimeContract.WebRuntimeRpcError {
  if (isWebRuntimeUnavailable(error)) {
    return new WebRuntimeContract.WebRuntimeRpcError({
      code: "unavailable",
      operation,
      message: "Web capture runtime is unavailable.",
    });
  }
  const message =
    error.status === 404
      ? "The requested web capture item was not found."
      : error.status === 429
        ? `Web capture runtime is busy.${
            error.retryAfterSeconds === undefined
              ? " Retry shortly."
              : ` Retry after ${error.retryAfterSeconds} second${error.retryAfterSeconds === 1 ? "" : "s"}.`
          }`
        : error.detail === undefined
          ? "Web capture runtime request failed."
          : `Web capture runtime rejected the request: ${error.detail}`;
  return new WebRuntimeContract.WebRuntimeRpcError({
    code: "request_failed",
    operation,
    message,
    ...(error.status === undefined ? {} : { status: error.status }),
  });
}

export function webRuntimeRequestPath(
  path: string,
  query: Readonly<Record<string, string | number | boolean | undefined>>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded === "" ? path : `${path}?${encoded}`;
}

export function decodeWebRuntimeResponse<A>(
  operation: string,
  schema: Schema.Decoder<A, never>,
  value: unknown,
): Effect.Effect<A, WebRuntimeContract.WebRuntimeRpcError> {
  return Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(
      () =>
        new WebRuntimeContract.WebRuntimeRpcError({
          code: "invalid_response",
          operation,
          message: "Web capture runtime returned invalid data.",
        }),
    ),
  );
}
