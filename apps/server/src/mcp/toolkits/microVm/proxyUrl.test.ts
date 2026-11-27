import { describe, expect, it } from "vite-plus/test";

import { normalizeMicroVmProxyUrl } from "./proxyUrl.ts";

describe("normalizeMicroVmProxyUrl", () => {
  it("rewrites loopback proxies and removes the path added by URL serialization", () => {
    expect(normalizeMicroVmProxyUrl("http://127.0.0.1:4777/")).toBe(
      "http://host.microsandbox.internal:4777",
    );
    expect(normalizeMicroVmProxyUrl("http://localhost:4777/path?q=1")).toBe(
      "http://host.microsandbox.internal:4777",
    );
    expect(normalizeMicroVmProxyUrl("http://[::1]:4777/")).toBe(
      "http://host.microsandbox.internal:4777",
    );
  });

  it("keeps non-loopback proxy hosts without a path or trailing slash", () => {
    expect(normalizeMicroVmProxyUrl("http://proxy.example:8080/")).toBe(
      "http://proxy.example:8080",
    );
  });

  it("leaves an invalid value untouched for the browser to report", () => {
    expect(normalizeMicroVmProxyUrl("not a proxy")).toBe("not a proxy");
  });
});
