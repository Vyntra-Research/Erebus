import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { installManagedProteusForCodex } from "./proteusRuntime.ts";

const count = (value: string, needle: string): number => value.split(needle).length - 1;
const tomlString = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

const ProteusPluginManifest = Schema.Struct({
  mcpServers: Schema.optional(
    Schema.Struct({
      proteus: Schema.optional(
        Schema.Struct({
          command: Schema.optional(Schema.String),
          args: Schema.optional(Schema.Array(Schema.String)),
        }),
      ),
    }),
  ),
});

it.layer(NodeServices.layer)("managed Proteus runtime", (it) => {
  it.effect("installs the pinned plugin into an isolated Codex home idempotently", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const codexHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "erebus-proteus-" });
      const configPath = path.join(codexHome, "config.toml");
      yield* fileSystem.writeFileString(
        configPath,
        '[projects."C:/workspace"]\ntrust_level = "trusted"\n',
      );

      const first = yield* installManagedProteusForCodex(codexHome);
      const second = yield* installManagedProteusForCodex(codexHome);
      const config = yield* fileSystem.readFileString(configPath);
      const manifestText = yield* fileSystem.readFileString(
        path.join(first.installedPluginRoot, ".codex-plugin", "plugin.json"),
      );
      const manifest = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(ProteusPluginManifest),
      )(manifestText);

      expect(second.marketplaceRoot).toBe(first.marketplaceRoot);
      expect(config).toContain('[projects."C:/workspace"]');
      expect(config).toContain(`[marketplaces.proteus-marketplace]`);
      expect(config).toContain(`[plugins."proteus@proteus-marketplace"]`);
      expect(config).toContain(`source = ${tomlString(first.marketplaceRoot)}`);
      expect(count(config, "[marketplaces.proteus-marketplace]")).toBe(1);
      expect(count(config, '[plugins."proteus@proteus-marketplace"]')).toBe(1);
      expect(manifest.mcpServers?.proteus?.command).toBe(process.execPath);
      expect(manifest.mcpServers?.proteus?.args).toEqual([
        path.join(first.installedPluginRoot, "dist", "mcp.js"),
      ]);
      expect(yield* fileSystem.exists(path.join(first.installedPluginRoot, "skills"))).toBe(true);
      expect(
        yield* fileSystem.exists(path.join(first.marketplaceRoot, ".erebus-managed.json")),
      ).toBe(true);
    }),
  );
});
