// @effect-diagnostics nodeBuiltinImport:off - fixtures exercise an isolated migration tree.
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { removeLegacyManagedProteusRuntime } from "./legacyResearchRuntimeCleanup.ts";

it.layer(NodeServices.layer)("legacy research runtime cleanup", (it) => {
  it.effect("removes only the managed Proteus entries and stays idempotent", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "erebus-legacy-research-runtime-",
      });
      const stateDir = path.join(root, "userdata");
      const codexHome = path.join(stateDir, "providers", "codex");
      const configPath = path.join(codexHome, "config.toml");
      const proteusRuntime = path.join(stateDir, "managed", "proteus-runtime");
      const proteusManagedPlugin = path.join(codexHome, "managed", "proteus");
      const proteusCache = path.join(
        codexHome,
        "plugins",
        "cache",
        "proteus-marketplace",
        "proteus",
      );
      const argosManagedPlugin = path.join(codexHome, "managed", "argos");
      const unrelatedCache = path.join(codexHome, "plugins", "cache", "other", "plugin");
      const config = [
        'model = "gpt-6-sol"',
        "",
        "[marketplaces.argos-marketplace]",
        'source_type = "local"',
        'source = "C:/argos"',
        "",
        "[marketplaces.proteus-marketplace]",
        'source_type = "local"',
        'source = "C:/proteus"',
        "",
        '[plugins."proteus@proteus-marketplace"]',
        "enabled = true",
        "",
        '[plugins."argos@argos-marketplace"]',
        "enabled = true",
        "",
        '[projects."C:/workspace"]',
        'trust_level = "trusted"',
        "",
      ].join("\n");

      yield* Effect.promise(async () => {
        await Promise.all([
          NodeFSP.mkdir(proteusRuntime, { recursive: true }),
          NodeFSP.mkdir(proteusManagedPlugin, { recursive: true }),
          NodeFSP.mkdir(proteusCache, { recursive: true }),
          NodeFSP.mkdir(argosManagedPlugin, { recursive: true }),
          NodeFSP.mkdir(unrelatedCache, { recursive: true }),
        ]);
        await NodeFSP.writeFile(configPath, config, "utf8");
      });

      yield* removeLegacyManagedProteusRuntime(codexHome, stateDir);
      const firstConfig = yield* fileSystem.readFileString(configPath);

      expect(firstConfig).not.toContain("proteus-marketplace");
      expect(firstConfig).not.toContain('source = "C:/proteus"');
      expect(firstConfig).toContain("[marketplaces.argos-marketplace]");
      expect(firstConfig).toContain('[plugins."argos@argos-marketplace"]');
      expect(firstConfig).toContain('[projects."C:/workspace"]');
      expect(yield* fileSystem.exists(proteusRuntime)).toBe(false);
      expect(yield* fileSystem.exists(proteusManagedPlugin)).toBe(false);
      expect(yield* fileSystem.exists(proteusCache)).toBe(false);
      expect(yield* fileSystem.exists(argosManagedPlugin)).toBe(true);
      expect(yield* fileSystem.exists(unrelatedCache)).toBe(true);

      yield* removeLegacyManagedProteusRuntime(codexHome, stateDir);
      expect(yield* fileSystem.readFileString(configPath)).toBe(firstConfig);
      expect(yield* fileSystem.exists(argosManagedPlugin)).toBe(true);
      expect(yield* fileSystem.exists(unrelatedCache)).toBe(true);
    }),
  );

  it.effect("accepts a Codex home without a config file", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "erebus-legacy-research-runtime-empty-",
      });
      const stateDir = path.join(root, "userdata");
      const codexHome = path.join(stateDir, "providers", "codex");

      yield* removeLegacyManagedProteusRuntime(codexHome, stateDir);

      expect(yield* fileSystem.exists(path.join(codexHome, "config.toml"))).toBe(false);
    }),
  );
});
