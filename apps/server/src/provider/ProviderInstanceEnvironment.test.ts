import { describe, expect, it } from "vite-plus/test";

import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";

describe("mergeProviderInstanceEnvironment", () => {
  it("overrides inherited environment values and preserves empty strings", () => {
    expect(
      mergeProviderInstanceEnvironment(
        [
          { name: "OPENROUTER_API_KEY", value: "sk-or-test", sensitive: true },
          { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
        ],
        { ANTHROPIC_API_KEY: "inherited", PATH: "/bin" },
      ),
    ).toMatchObject({
      OPENROUTER_API_KEY: "sk-or-test",
      ANTHROPIC_API_KEY: "",
      PATH: "/bin",
    });
  });

  it("does not leak the T3 server NODE_ENV unless the provider sets it", () => {
    expect(
      mergeProviderInstanceEnvironment(undefined, { NODE_ENV: "development", PATH: "/bin" }),
    ).toEqual({
      PATH: "/bin",
    });
    expect(
      mergeProviderInstanceEnvironment(
        [{ name: "NODE_ENV", value: "production", sensitive: false }],
        { NODE_ENV: "development", PATH: "/bin" },
      ),
    ).toEqual({ NODE_ENV: "production", PATH: "/bin" });
  });
});
