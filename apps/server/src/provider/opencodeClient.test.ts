import { describe, expect, it } from "vite-plus/test";

import {
  normalizeOpenCodeApiUrl,
  resolveOpenCodeFormOptionValue,
  translateEvents,
} from "./opencodeClient.ts";

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

  it("preserves automatic compaction lifecycle events", async () => {
    async function* source() {
      yield {
        type: "session.compaction.started",
        data: { sessionID: "session-1", reason: "auto" },
      } as any;
      yield {
        type: "session.compaction.ended",
        data: {
          sessionID: "session-1",
          reason: "auto",
          text: "summary",
          tokens: { input: 10, output: 2 },
        },
      } as any;
    }

    const translated = [];
    for await (const event of translateEvents(source(), new Map())) translated.push(event);

    expect(translated).toEqual([
      {
        type: "session.compaction.started",
        properties: {
          sessionID: "session-1",
          reason: "auto",
          compactionID: "session-1:0",
        },
      },
      {
        type: "session.compaction.ended",
        properties: {
          sessionID: "session-1",
          reason: "auto",
          text: "summary",
          tokens: { input: 10, output: 2 },
          compactionID: "session-1:0",
        },
      },
    ]);
  });
});
