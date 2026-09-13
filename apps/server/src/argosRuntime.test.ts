// @effect-diagnostics nodeBuiltinImport:off - fixtures exercise filesystem plugin installation.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Tar from "tar";

import {
  installManagedArgosForCodex,
  refreshManagedArgosRuntime,
  resolveManagedArgosRuntime,
} from "./argosRuntime.ts";

const count = (value: string, needle: string): number => value.split(needle).length - 1;
const nextPatchVersion = (version: string): string => {
  const [major, minor, patch] = version.split(".").map(Number);
  return `${major}.${minor}.${(patch ?? 0) + 1}`;
};
const tomlString = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

const ArgosPluginManifest = Schema.Struct({
  version: Schema.String,
  skills: Schema.String,
  mcpServers: Schema.Struct({
    argos: Schema.Struct({
      command: Schema.String,
      args: Schema.Array(Schema.String),
      env: Schema.Record(Schema.String, Schema.String),
    }),
  }),
});
const decodeArgosPluginManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ArgosPluginManifest),
);

it.layer(NodeServices.layer)("managed Argos runtime", (it) => {
  it.effect("installs the pinned MCP and skills into an isolated Codex home", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const codexHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "erebus-argos-" });
      const configPath = path.join(codexHome, "config.toml");
      yield* fileSystem.writeFileString(
        configPath,
        '[projects."C:/workspace"]\ntrust_level = "trusted"\n',
      );

      const first = yield* installManagedArgosForCodex(codexHome);
      const second = yield* installManagedArgosForCodex(codexHome);
      const manifestPath = path.join(first.installedPluginRoot, ".codex-plugin", "plugin.json");
      const manifest = yield* fileSystem
        .readFileString(manifestPath)
        .pipe(Effect.flatMap(decodeArgosPluginManifest));
      const config = yield* fileSystem.readFileString(configPath);

      expect(second.marketplaceRoot).toBe(first.marketplaceRoot);
      expect(config).toContain('[projects."C:/workspace"]');
      expect(config).toContain("[marketplaces.argos-marketplace]");
      expect(config).toContain('[plugins."argos@argos-marketplace"]');
      expect(config).toContain(`source = ${tomlString(first.marketplaceRoot)}`);
      expect(count(config, "[marketplaces.argos-marketplace]")).toBe(1);
      expect(count(config, '[plugins."argos@argos-marketplace"]')).toBe(1);
      expect(manifest.mcpServers.argos.command).toBe(process.execPath);
      expect(manifest.mcpServers.argos.args).toEqual([first.mcpPath]);
      expect(manifest.mcpServers.argos.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
      expect(manifest.skills).toBe("./skills/");
      expect(
        yield* fileSystem.exists(
          path.join(first.installedPluginRoot, "skills", "argos", "SKILL.md"),
        ),
      ).toBe(true);
      expect(
        yield* fileSystem.exists(
          path.join(first.installedPluginRoot, "skills", "chain-discovery", "SKILL.md"),
        ),
      ).toBe(true);
      expect(
        yield* fileSystem.exists(path.join(first.marketplaceRoot, ".erebus-managed.json")),
      ).toBe(true);
    }),
  );

  it.effect("keeps the active and one previous owned plugin version", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const codexHome = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "erebus-argos-retention-",
      });
      const versionsRoot = path.join(codexHome, "managed", "argos");

      yield* Effect.promise(async () => {
        for (const version of ["0.0.7", "0.0.8", "0.0.9"]) {
          const versionRoot = path.join(versionsRoot, version);
          await NodeFSP.mkdir(versionRoot, { recursive: true });
          await NodeFSP.writeFile(
            path.join(versionRoot, ".erebus-managed.json"),
            `{"owner":"Erebus","version":"${version}"}\n`,
          );
        }
        await NodeFSP.mkdir(path.join(versionsRoot, "0.0.6"), { recursive: true });
      });

      const installed = yield* installManagedArgosForCodex(codexHome);
      const versions = yield* Effect.promise(() =>
        NodeFSP.readdir(versionsRoot).then((entries) => entries.sort()),
      );

      expect(versions).toEqual(["0.0.6", "0.0.9", installed.version]);
    }),
  );

  it.effect("installs a newer verified Argos release once per update window", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "erebus-argos-update-" });
      const codexHome = path.join(root, "codex-home");
      const managedRuntimeRoot = path.join(root, "managed-runtime");
      const packageParent = path.join(root, "fixture");
      const packageRoot = path.join(packageParent, "package");
      const archivePath = path.join(root, "argos.tgz");
      const bundled = yield* resolveManagedArgosRuntime(path.join(root, "empty-runtime"));
      const futureVersion = nextPatchVersion(bundled.version);

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
        const pluginManifestPath = path.join(
          packageRoot,
          "plugins",
          "argos",
          ".codex-plugin",
          "plugin.json",
        );
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        const pluginManifest = JSON.parse(
          await NodeFSP.readFile(pluginManifestPath, "utf8"),
        ) as Record<string, unknown>;
        pluginManifest.version = futureVersion;
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        await NodeFSP.writeFile(pluginManifestPath, `${JSON.stringify(pluginManifest, null, 2)}\n`);
        await Tar.c({ cwd: packageParent, file: archivePath, gzip: true }, ["package"]);
        return NodeFSP.readFile(archivePath);
      });
      const digest = `sha256:${NodeCrypto.createHash("sha256").update(archive).digest("hex")}`;
      const assetUrl = `https://github.com/rafabd1/Argos/releases/download/v${futureVersion}/rafabd1-argos-${futureVersion}.tgz`;
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
                name: `rafabd1-argos-${futureVersion}.tgz`,
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
        now: () => Date.UTC(2026, 8, 12),
      };

      const first = yield* installManagedArgosForCodex(codexHome, options);
      const second = yield* installManagedArgosForCodex(codexHome, options);
      const forced = yield* refreshManagedArgosRuntime(managedRuntimeRoot, {
        ...options,
        forceUpdateCheck: true,
      });

      expect(first.version).toBe(futureVersion);
      expect(second.version).toBe(futureVersion);
      expect(forced.version).toBe(futureVersion);
      expect(requests).toBe(3);
      expect(first.packageRoot).toBe(path.join(managedRuntimeRoot, "packages", futureVersion));
      expect(yield* fileSystem.exists(path.join(first.packageRoot, "dist", "mcp.js"))).toBe(true);
    }),
  );

  it.effect("keeps the bundled runtime when an Argos release fails digest verification", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "erebus-argos-rejected-update-",
      });
      const codexHome = path.join(root, "codex-home");
      const managedRuntimeRoot = path.join(root, "managed-runtime");
      const bundled = yield* resolveManagedArgosRuntime(path.join(root, "empty-runtime"));
      const futureVersion = nextPatchVersion(bundled.version);
      const assetUrl = `https://github.com/rafabd1/Argos/releases/download/v${futureVersion}/rafabd1-argos-${futureVersion}.tgz`;
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
                name: `rafabd1-argos-${futureVersion}.tgz`,
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

      const installed = yield* installManagedArgosForCodex(codexHome, {
        managedRuntimeRoot,
        fetch: fetchMock,
        now: () => Date.UTC(2026, 8, 12),
      });

      expect(installed.version).toBe(bundled.version);
      expect(requests).toBe(2);
      expect(
        yield* fileSystem.exists(path.join(managedRuntimeRoot, "packages", futureVersion)),
      ).toBe(false);
    }),
  );
});
