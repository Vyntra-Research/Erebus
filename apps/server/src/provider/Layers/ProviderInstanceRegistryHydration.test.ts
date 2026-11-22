import { ProviderInstanceId, ServerSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);

describe("deriveProviderInstanceConfigMap", () => {
  it("hydrates Codex and OpenCode while excluding inactive provider bindings", () => {
    const settings = decodeSettings({
      providers: {
        claudeAgent: { enabled: true },
        cursor: { enabled: true },
        grok: { enabled: true },
        opencode: { enabled: true },
      },
      providerInstances: {
        codex_work: {
          driver: "codex",
          config: { homePath: "C:/profiles/codex-work" },
        },
        claude_work: {
          driver: "claudeAgent",
          config: { enabled: true },
        },
      },
    });

    const instances = deriveProviderInstanceConfigMap(settings);

    expect(Object.keys(instances).sort()).toEqual(["codex", "codex_work", "opencode"]);
    expect(instances[ProviderInstanceId.make("codex_work")]?.driver).toBe("codex");
    expect(instances[ProviderInstanceId.make("opencode")]?.driver).toBe("opencode");
    expect(instances[ProviderInstanceId.make("opencode")]?.config).toMatchObject({ enabled: true });
    expect(instances[ProviderInstanceId.make("claude_work")]).toBeUndefined();
  });

  it("keeps an explicit OpenCode instance over its legacy settings", () => {
    const settings = decodeSettings({
      providers: { opencode: { enabled: true } },
      providerInstances: {
        opencode: {
          driver: "opencode",
          enabled: false,
          config: { binaryPath: "custom-opencode" },
        },
      },
    });

    const instances = deriveProviderInstanceConfigMap(settings);

    expect(instances[ProviderInstanceId.make("opencode")]).toMatchObject({
      driver: "opencode",
      enabled: false,
      config: { binaryPath: "custom-opencode" },
    });
  });
});
