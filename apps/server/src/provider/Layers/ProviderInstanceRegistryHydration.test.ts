import { ProviderInstanceId, ServerSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);

describe("deriveProviderInstanceConfigMap", () => {
  it("hydrates Codex and excludes every inactive provider binding", () => {
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

    expect(Object.keys(instances).sort()).toEqual(["codex", "codex_work"]);
    expect(instances[ProviderInstanceId.make("codex_work")]?.driver).toBe("codex");
    expect(instances[ProviderInstanceId.make("claude_work")]).toBeUndefined();
  });
});
