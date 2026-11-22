import { describe, expect, it } from "vite-plus/test";

import { normalizeOpenCodeApiUrl } from "./opencodeClient.ts";

describe("OpenCode V2 client", () => {
  it("passes the server root to the official client", () => {
    expect(normalizeOpenCodeApiUrl("http://127.0.0.1:4096")).toBe("http://127.0.0.1:4096");
    expect(normalizeOpenCodeApiUrl("http://127.0.0.1:4096/")).toBe("http://127.0.0.1:4096");
    expect(normalizeOpenCodeApiUrl("http://127.0.0.1:4096/api")).toBe("http://127.0.0.1:4096");
  });
});
