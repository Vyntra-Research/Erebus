// @effect-diagnostics nodeBuiltinImport:off - fixtures exercise filesystem package installation.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Tar from "tar";

import { installManagedProteusForCodex, resolveManagedProteusRuntime } from "./proteusRuntime.ts";

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
const decodeProteusPluginManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProteusPluginManifest),
);

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
      const manifest = yield* decodeProteusPluginManifest(manifestText);

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

  it.effect("retains the active and one previous owned Proteus version", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "erebus-proteus-retention-",
      });
      const codexHome = path.join(root, "codex-home");
      const managedRuntimeRoot = path.join(root, "managed-runtime");
      const runtimeVersionsRoot = path.join(managedRuntimeRoot, "packages");
      const pluginVersionsRoot = path.join(codexHome, "managed", "proteus");
      const checkedAt = Date.UTC(2026, 7, 30);
      const bundled = yield* resolveManagedProteusRuntime(path.join(root, "empty-runtime"));

      yield* Effect.promise(async () => {
        for (const version of ["2.1.5", "2.1.6", "2.1.7"]) {
          const runtimeRoot = path.join(runtimeVersionsRoot, version);
          const pluginRoot = path.join(pluginVersionsRoot, version);
          await NodeFSP.mkdir(runtimeRoot, { recursive: true });
          await NodeFSP.mkdir(pluginRoot, { recursive: true });
          await NodeFSP.writeFile(
            path.join(runtimeRoot, ".erebus-managed-runtime.json"),
            `{"owner":"Erebus","version":"${version}"}\n`,
          );
          await NodeFSP.writeFile(
            path.join(pluginRoot, ".erebus-managed.json"),
            `{"owner":"Erebus","version":"${version}"}\n`,
          );
        }
        await NodeFSP.mkdir(path.join(runtimeVersionsRoot, "2.1.4"), { recursive: true });
        await NodeFSP.mkdir(path.join(pluginVersionsRoot, "2.1.4"), { recursive: true });
        await NodeFSP.mkdir(managedRuntimeRoot, { recursive: true });
        await NodeFSP.writeFile(
          path.join(managedRuntimeRoot, "update-state.json"),
          `{"checkedAt":${checkedAt},"latestVersion":"${bundled.version}"}\n`,
        );
      });

      let requests = 0;
      const installed = yield* installManagedProteusForCodex(codexHome, {
        managedRuntimeRoot,
        now: () => checkedAt,
        fetch: (async (_input: string | URL | Request) => {
          requests += 1;
          return new Response(null, { status: 500 });
        }) as typeof globalThis.fetch,
      });
      const runtimeVersions = yield* Effect.promise(() =>
        NodeFSP.readdir(runtimeVersionsRoot).then((entries) => entries.sort()),
      );
      const pluginVersions = yield* Effect.promise(() =>
        NodeFSP.readdir(pluginVersionsRoot).then((entries) => entries.sort()),
      );

      expect(installed.version).toBe(bundled.version);
      expect(requests).toBe(0);
      expect(runtimeVersions).toEqual(["2.1.4", "2.1.7"]);
      expect(pluginVersions).toEqual(["2.1.4", "2.1.7", bundled.version]);
    }),
  );

  it.effect("installs a newer verified Proteus release once per update window", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "erebus-proteus-update-" });
      const codexHome = path.join(root, "codex-home");
      const managedRuntimeRoot = path.join(root, "managed-runtime");
      const packageParent = path.join(root, "fixture");
      const packageRoot = path.join(packageParent, "package");
      const archivePath = path.join(root, "proteus.tgz");
      const bundled = yield* resolveManagedProteusRuntime(path.join(root, "empty-runtime"));
      const futureVersion = "2.1.9";

      const archive = yield* Effect.promise(async () => {
        await NodeFSP.mkdir(packageParent, { recursive: true });
        await NodeFSP.cp(bundled.packageRoot, packageRoot, {
          recursive: true,
          force: true,
          dereference: true,
        });
        const packageJsonPath = path.join(packageRoot, "package.json");
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        const packageJson = JSON.parse(await NodeFSP.readFile(packageJsonPath, "utf8")) as Record<
          string,
          unknown
        >;
        packageJson.version = futureVersion;
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        await NodeFSP.writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
        await Tar.c({ cwd: packageParent, file: archivePath, gzip: true }, ["package"]);
        return NodeFSP.readFile(archivePath);
      });
      const digest = `sha256:${NodeCrypto.createHash("sha256").update(archive).digest("hex")}`;
      const assetUrl = `https://github.com/Vyntra-Research/Proteus/releases/download/v${futureVersion}/vyntra-research-proteus-${futureVersion}.tgz`;
      let requests = 0;
      const fetchMock = (async (input: string | URL | Request) => {
        requests += 1;
        const url = String(input);
        if (url.endsWith("/releases/latest")) {
          return Response.json({
            tag_name: `v${futureVersion}`,
            draft: false,
            prerelease: false,
            assets: [
              {
                name: `vyntra-research-proteus-${futureVersion}.tgz`,
                browser_download_url: assetUrl,
                digest,
                size: archive.byteLength,
              },
            ],
          });
        }
        if (url === assetUrl) return new Response(archive);
        return new Response(null, { status: 404 });
      }) as typeof globalThis.fetch;
      const options = {
        managedRuntimeRoot,
        fetch: fetchMock,
        now: () => Date.UTC(2026, 7, 30),
      };

      const first = yield* installManagedProteusForCodex(codexHome, options);
      const second = yield* installManagedProteusForCodex(codexHome, options);

      expect(first.version).toBe(futureVersion);
      expect(second.version).toBe(futureVersion);
      expect(requests).toBe(2);
      expect(first.packageRoot).toBe(path.join(managedRuntimeRoot, "packages", futureVersion));
      expect(yield* fileSystem.exists(path.join(first.packageRoot, "dist", "mcp.js"))).toBe(true);
    }),
  );

  it.effect("keeps the bundled runtime when a release package fails digest verification", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "erebus-proteus-rejected-update-",
      });
      const codexHome = path.join(root, "codex-home");
      const managedRuntimeRoot = path.join(root, "managed-runtime");
      const bundled = yield* resolveManagedProteusRuntime(path.join(root, "empty-runtime"));
      const futureVersion = "2.1.9";
      const assetUrl = `https://github.com/Vyntra-Research/Proteus/releases/download/v${futureVersion}/vyntra-research-proteus-${futureVersion}.tgz`;
      const corruptArchive = new Uint8Array([1, 2, 3]);
      let requests = 0;
      const fetchMock = (async (input: string | URL | Request) => {
        requests += 1;
        const url = String(input);
        if (url.endsWith("/releases/latest")) {
          return Response.json({
            tag_name: `v${futureVersion}`,
            draft: false,
            prerelease: false,
            assets: [
              {
                name: `vyntra-research-proteus-${futureVersion}.tgz`,
                browser_download_url: assetUrl,
                digest: `sha256:${"0".repeat(64)}`,
                size: corruptArchive.byteLength,
              },
            ],
          });
        }
        if (url === assetUrl) return new Response(corruptArchive);
        return new Response(null, { status: 404 });
      }) as typeof globalThis.fetch;

      const installed = yield* installManagedProteusForCodex(codexHome, {
        managedRuntimeRoot,
        fetch: fetchMock,
        now: () => Date.UTC(2026, 7, 30),
      });

      expect(installed.version).toBe(bundled.version);
      expect(requests).toBe(2);
      expect(
        yield* fileSystem.exists(path.join(managedRuntimeRoot, "packages", futureVersion)),
      ).toBe(false);
    }),
  );
});
