import { describe, expect, it } from "vite-plus/test";

import { normalizeOpenCodeApiUrl, resolveOpenCodeFormOptionValue } from "./opencodeClient.ts";

describe("OpenCode V2 client", () => {
  it("passes the server root to the official client", () => {
    expect(normalizeOpenCodeApiUrl("http://127.0.0.1:4096")).toBe("http://127.0.0.1:4096");
    expect(normalizeOpenCodeApiUrl("http://127.0.0.1:4096/")).toBe("http://127.0.0.1:4096");
    expect(normalizeOpenCodeApiUrl("http://127.0.0.1:4096/api")).toBe("http://127.0.0.1:4096");
  });

  it("maps the visible form label back to the OpenCode option value", () => {
    const options = [
      {
        value: "allow",
        label: "Allow search via Exa, Firecrawl, Parallel, Tavily, TinyFish",
      },
      { value: "disable", label: "Disable web search" },
    ];
    expect(resolveOpenCodeFormOptionValue(options, options[0]!.label)).toBe("allow");
    expect(resolveOpenCodeFormOptionValue(options, "allow")).toBe("allow");
    expect(resolveOpenCodeFormOptionValue(options, "custom answer")).toBe("custom answer");
  });
});
