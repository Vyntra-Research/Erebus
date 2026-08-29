// @effect-diagnostics nodeBuiltinImport:off - Proteus is a filesystem-distributed subprocess dependency.
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeFSP from "node:fs/promises";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const require = NodeModule.createRequire(import.meta.url);
const MARKETPLACE_NAME = "proteus-marketplace";
const MARKETPLACE_TABLE = `[marketplaces.${MARKETPLACE_NAME}]`;
const PLUGIN_TABLE = `[plugins."proteus@${MARKETPLACE_NAME}"]`;

export class ProteusRuntimeError extends Schema.TaggedErrorClass<ProteusRuntimeError>()(
  "ProteusRuntimeError",
  {
    operation: Schema.Literals(["resolve", "install", "configure"]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface ManagedProteusRuntime {
  readonly version: string;
  readonly packageRoot: string;
  readonly cliPath: string;
  readonly mcpPath: string;
  readonly pluginRoot: string;
}

interface ProteusPackageJson {
  readonly version?: unknown;
}

export const resolveManagedProteusRuntime = Effect.fn("ProteusRuntime.resolve")(function* () {
  return yield* Effect.tryPromise({
    try: async (): Promise<ManagedProteusRuntime> => {
      const packageJsonPath = require.resolve("@vyntra-research/proteus/package.json");
      const packageRoot = NodePath.dirname(packageJsonPath);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const packageJson = JSON.parse(
        await NodeFSP.readFile(packageJsonPath, "utf8"),
      ) as ProteusPackageJson;
      if (typeof packageJson.version !== "string" || packageJson.version.trim().length === 0) {
        throw new Error("Proteus package metadata has no version.");
      }
      return {
        version: packageJson.version,
        packageRoot,
        cliPath: NodePath.join(packageRoot, "dist", "cli.js"),
        mcpPath: NodePath.join(packageRoot, "dist", "mcp.js"),
        pluginRoot: NodePath.join(packageRoot, "plugins", "proteus"),
      };
    },
    catch: (cause) =>
      new ProteusRuntimeError({
        operation: "resolve",
        detail: "Erebus could not resolve its pinned Proteus runtime.",
        cause,
      }),
  });
});

function removeTomlTable(source: string, table: string): string {
  const lines = source.split(/\r?\n/);
  const output: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === table) {
      skipping = true;
      continue;
    }
    if (skipping && /^\[[^\]]+\]$/.test(trimmed)) {
      skipping = false;
    }
    if (!skipping) output.push(line);
  }
  return output.join("\n").trimEnd();
}

function withManagedProteusConfig(source: string, marketplaceRoot: string): string {
  const withoutMarketplace = removeTomlTable(source, MARKETPLACE_TABLE);
  const withoutPlugin = removeTomlTable(withoutMarketplace, PLUGIN_TABLE);
  const managed = [
    MARKETPLACE_TABLE,
    'source_type = "local"',
    `source = ${JSON.stringify(marketplaceRoot)}`,
    "",
    PLUGIN_TABLE,
    "enabled = true",
  ].join("\n");
  return `${withoutPlugin.trimEnd()}${withoutPlugin.trim().length > 0 ? "\n\n" : ""}${managed}\n`;
}

export const installManagedProteusForCodex = Effect.fn("ProteusRuntime.installForCodex")(function* (
  codexHome: string,
) {
  const runtime = yield* resolveManagedProteusRuntime();
  return yield* Effect.tryPromise({
    try: async () => {
      const marketplaceRoot = NodePath.join(codexHome, "managed", "proteus", runtime.version);
      const installedPluginRoot = NodePath.join(marketplaceRoot, "plugins", "proteus");
      const markerPath = NodePath.join(marketplaceRoot, ".erebus-managed.json");
      await NodeFSP.mkdir(NodePath.dirname(installedPluginRoot), { recursive: true });
      await NodeFSP.cp(runtime.pluginRoot, installedPluginRoot, {
        recursive: true,
        force: true,
        dereference: true,
      });

      const sourceMarketplacePath = NodePath.join(
        runtime.packageRoot,
        ".agents",
        "plugins",
        "marketplace.json",
      );
      const marketplacePath = NodePath.join(
        marketplaceRoot,
        ".agents",
        "plugins",
        "marketplace.json",
      );
      await NodeFSP.mkdir(NodePath.dirname(marketplacePath), { recursive: true });
      await NodeFSP.copyFile(sourceMarketplacePath, marketplacePath);

      const manifestPath = NodePath.join(installedPluginRoot, ".codex-plugin", "plugin.json");
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const manifest = JSON.parse(await NodeFSP.readFile(manifestPath, "utf8")) as Record<
        string,
        unknown
      >;
      manifest.mcpServers = {
        proteus: {
          command: process.execPath,
          args: [NodePath.join(installedPluginRoot, "dist", "mcp.js")],
        },
      };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      await NodeFSP.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      await NodeFSP.writeFile(
        markerPath,
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        `${JSON.stringify({ owner: "Erebus", version: runtime.version }, null, 2)}\n`,
        "utf8",
      );

      const configPath = NodePath.join(codexHome, "config.toml");
      const currentConfig = await NodeFSP.readFile(configPath, "utf8").catch((error: unknown) => {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return "";
        }
        throw error;
      });
      const nextConfig = withManagedProteusConfig(currentConfig, marketplaceRoot);
      if (nextConfig !== currentConfig) {
        await NodeFSP.mkdir(codexHome, { recursive: true });
        const temporaryPath = `${configPath}.erebus-${process.pid}.tmp`;
        await NodeFSP.writeFile(temporaryPath, nextConfig, "utf8");
        await NodeFSP.rename(temporaryPath, configPath);
      }
      return {
        ...runtime,
        marketplaceRoot,
        installedPluginRoot,
      };
    },
    catch: (cause) =>
      new ProteusRuntimeError({
        operation: "install",
        detail: "Erebus could not install its managed Proteus plugin into the Codex home.",
        cause,
      }),
  });
});
