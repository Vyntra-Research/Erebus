// @effect-diagnostics nodeBuiltinImport:off - Proteus is a filesystem-distributed subprocess dependency.
import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeFSP from "node:fs/promises";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Tar from "tar";

const require = NodeModule.createRequire(import.meta.url);
const MARKETPLACE_NAME = "proteus-marketplace";
const MARKETPLACE_TABLE = `[marketplaces.${MARKETPLACE_NAME}]`;
const PLUGIN_TABLE = `[plugins."proteus@${MARKETPLACE_NAME}"]`;
const PROTEUS_PACKAGE_NAME = "@vyntra-research/proteus";
const PROTEUS_RELEASE_API = "https://api.github.com/repos/Vyntra-Research/Proteus/releases/latest";
const PROTEUS_RELEASE_BASE = "https://github.com/Vyntra-Research/Proteus/releases/download/";
const PROTEUS_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const PROTEUS_UPDATE_MAX_BYTES = 20 * 1024 * 1024;
const PROTEUS_UPDATE_TIMEOUT_MS = 30_000;
const PROTEUS_RETAINED_VERSIONS = 2;
const updatePromises = new Map<string, Promise<ManagedProteusRuntime>>();
let defaultManagedRuntimeRoot: string | undefined;

export class ProteusRuntimeError extends Schema.TaggedErrorClass<ProteusRuntimeError>()(
  "ProteusRuntimeError",
  {
    operation: Schema.Literals(["resolve", "install", "configure", "update"]),
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
  readonly name?: unknown;
  readonly version?: unknown;
}

interface ErebusManagedMarker {
  readonly owner?: unknown;
  readonly version?: unknown;
}

interface ErebusManagedRuntimeMarker extends ErebusManagedMarker {
  readonly digest?: unknown;
}

interface ProteusUpdateState {
  readonly checkedAt?: unknown;
  readonly latestVersion?: unknown;
}

interface GitHubReleaseAsset {
  readonly name?: unknown;
  readonly browser_download_url?: unknown;
  readonly digest?: unknown;
  readonly size?: unknown;
}

interface GitHubLatestRelease {
  readonly tag_name?: unknown;
  readonly draft?: unknown;
  readonly prerelease?: unknown;
  readonly assets?: unknown;
}

export interface ManagedProteusOptions {
  readonly managedRuntimeRoot?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly forceUpdateCheck?: boolean;
}

async function copyFilesystemTree(source: string, destination: string): Promise<void> {
  const sourceStat = await NodeFSP.stat(source);
  if (sourceStat.isDirectory()) {
    await NodeFSP.mkdir(destination, { recursive: true });
    const entries = await NodeFSP.readdir(source, { withFileTypes: true });
    for (const entry of entries) {
      await copyFilesystemTree(
        NodePath.join(source, entry.name),
        NodePath.join(destination, entry.name),
      );
    }
    return;
  }

  await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
  await NodeFSP.writeFile(destination, await NodeFSP.readFile(source));
  await NodeFSP.chmod(destination, sourceStat.mode).catch(() => undefined);
}

function parseVersion(value: string): readonly [number, number, number] | null {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part) || part < 0)) return null;
  return parts as unknown as readonly [number, number, number];
}

function compareVersions(left: string, right: string): number {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  if (!leftParts || !rightParts) return 0;
  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

async function pruneOwnedVersions(
  versionsRoot: string,
  markerName: string,
  activeVersion: string,
): Promise<void> {
  const entries = await NodeFSP.readdir(versionsRoot, { withFileTypes: true }).catch(() => []);
  const owned: Array<{ readonly path: string; readonly version: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !parseVersion(entry.name)) continue;
    const versionRoot = NodePath.join(versionsRoot, entry.name);
    const marker = await NodeFSP.readFile(NodePath.join(versionRoot, markerName), "utf8")
      .then((value) => JSON.parse(value) as ErebusManagedMarker)
      .catch(() => null);
    if (marker?.owner === "Erebus" && marker.version === entry.name) {
      owned.push({ path: versionRoot, version: entry.name });
    }
  }

  owned.sort((left, right) => compareVersions(right.version, left.version));
  const retained = new Set([activeVersion]);
  for (const candidate of owned) {
    if (retained.size >= PROTEUS_RETAINED_VERSIONS) break;
    retained.add(candidate.version);
  }
  for (const candidate of owned) {
    if (!retained.has(candidate.version)) {
      await NodeFSP.rm(candidate.path, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function runtimeFromPackageRoot(
  packageRoot: string,
  expectedVersion?: string,
): Promise<ManagedProteusRuntime> {
  const packageJsonPath = NodePath.join(packageRoot, "package.json");
  const packageJson = JSON.parse(
    await NodeFSP.readFile(packageJsonPath, "utf8"),
  ) as ProteusPackageJson;
  if (
    packageJson.name !== PROTEUS_PACKAGE_NAME ||
    typeof packageJson.version !== "string" ||
    !parseVersion(packageJson.version) ||
    (expectedVersion !== undefined && packageJson.version !== expectedVersion)
  ) {
    throw new Error("Proteus package metadata is invalid.");
  }
  const runtime = {
    version: packageJson.version,
    packageRoot,
    cliPath: NodePath.join(packageRoot, "dist", "cli.js"),
    mcpPath: NodePath.join(packageRoot, "dist", "mcp.js"),
    pluginRoot: NodePath.join(packageRoot, "plugins", "proteus"),
  } satisfies ManagedProteusRuntime;
  await Promise.all([
    NodeFSP.access(runtime.cliPath),
    NodeFSP.access(runtime.mcpPath),
    NodeFSP.access(NodePath.join(runtime.pluginRoot, ".codex-plugin", "plugin.json")),
    NodeFSP.access(NodePath.join(packageRoot, ".agents", "plugins", "marketplace.json")),
  ]);
  return runtime;
}

async function bundledProteusRuntime(): Promise<ManagedProteusRuntime> {
  const packageJsonPath = require.resolve("@vyntra-research/proteus/package.json");
  return runtimeFromPackageRoot(NodePath.dirname(packageJsonPath));
}

async function installedProteusRuntimes(
  managedRuntimeRoot: string,
): Promise<ReadonlyArray<ManagedProteusRuntime>> {
  const packagesRoot = NodePath.join(managedRuntimeRoot, "packages");
  const entries = await NodeFSP.readdir(packagesRoot, { withFileTypes: true }).catch(() => []);
  const runtimes: ManagedProteusRuntime[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !parseVersion(entry.name)) continue;
    const packageRoot = NodePath.join(packagesRoot, entry.name);
    const marker = await NodeFSP.readFile(
      NodePath.join(packageRoot, ".erebus-managed-runtime.json"),
      "utf8",
    )
      .then((value) => JSON.parse(value) as ErebusManagedRuntimeMarker)
      .catch(() => null);
    if (
      marker?.owner !== "Erebus" ||
      marker.version !== entry.name ||
      typeof marker.digest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(marker.digest)
    ) {
      continue;
    }
    const runtime = await runtimeFromPackageRoot(packageRoot, entry.name).catch(() => null);
    if (runtime) runtimes.push(runtime);
  }
  return runtimes;
}

async function resolveRuntime(managedRuntimeRoot?: string): Promise<ManagedProteusRuntime> {
  const bundled = await bundledProteusRuntime();
  if (!managedRuntimeRoot) return bundled;
  const installed = await installedProteusRuntimes(managedRuntimeRoot);
  return installed.reduce(
    (selected, candidate) =>
      compareVersions(candidate.version, selected.version) > 0 ? candidate : selected,
    bundled,
  );
}

export const resolveManagedProteusRuntime = Effect.fn("ProteusRuntime.resolve")(function* (
  managedRuntimeRoot = defaultManagedRuntimeRoot,
) {
  return yield* Effect.tryPromise({
    try: () => resolveRuntime(managedRuntimeRoot),
    catch: (cause) =>
      new ProteusRuntimeError({
        operation: "resolve",
        detail: "Erebus could not resolve its managed Proteus runtime.",
        cause,
      }),
  });
});

function exactReleaseAsset(release: GitHubLatestRelease, version: string): GitHubReleaseAsset {
  if (release.draft === true || release.prerelease === true || !Array.isArray(release.assets)) {
    throw new Error("The latest Proteus release is not a stable published release.");
  }
  const expectedName = `vyntra-research-proteus-${version}.tgz`;
  const asset = (release.assets as GitHubReleaseAsset[]).find((item) => item.name === expectedName);
  if (
    !asset ||
    typeof asset.browser_download_url !== "string" ||
    asset.browser_download_url !== `${PROTEUS_RELEASE_BASE}v${version}/${expectedName}` ||
    typeof asset.digest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(asset.digest) ||
    typeof asset.size !== "number" ||
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0 ||
    asset.size > PROTEUS_UPDATE_MAX_BYTES
  ) {
    throw new Error("The latest Proteus release has no verifiable package asset.");
  }
  return asset;
}

async function fetchWithTimeout(
  fetchImplementation: typeof globalThis.fetch,
  input: string,
  accept: string,
): Promise<Response> {
  const response = await fetchImplementation(input, {
    headers: {
      accept,
      "user-agent": "Erebus Proteus Updater",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(PROTEUS_UPDATE_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Proteus update request failed with HTTP ${response.status}.`);
  return response;
}

async function installDownloadedRuntime(
  managedRuntimeRoot: string,
  version: string,
  digest: string,
  archive: Uint8Array,
): Promise<ManagedProteusRuntime> {
  const packagesRoot = NodePath.join(managedRuntimeRoot, "packages");
  const targetRoot = NodePath.join(packagesRoot, version);
  const stagingRoot = NodePath.join(
    managedRuntimeRoot,
    `.staging-${process.pid}-${NodeCrypto.randomUUID()}`,
  );
  const archivePath = NodePath.join(stagingRoot, "proteus.tgz");
  await NodeFSP.mkdir(stagingRoot, { recursive: true });
  try {
    await NodeFSP.writeFile(archivePath, archive);
    await Tar.x({
      cwd: stagingRoot,
      file: archivePath,
      filter: (_path, entry) =>
        "type" in entry && (entry.type === "File" || entry.type === "Directory"),
      gzip: true,
      preservePaths: false,
      strict: true,
      strip: 1,
    });
    await NodeFSP.rm(archivePath, { force: true });
    await runtimeFromPackageRoot(stagingRoot, version);
    await NodeFSP.writeFile(
      NodePath.join(stagingRoot, ".erebus-managed-runtime.json"),
      `${JSON.stringify({ owner: "Erebus", version, digest }, null, 2)}\n`,
      "utf8",
    );
    await NodeFSP.mkdir(packagesRoot, { recursive: true });
    await NodeFSP.rm(targetRoot, { recursive: true, force: true });
    await NodeFSP.rename(stagingRoot, targetRoot);
    return runtimeFromPackageRoot(targetRoot, version);
  } finally {
    await NodeFSP.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function writeUpdateState(
  managedRuntimeRoot: string,
  state: { readonly checkedAt: number; readonly latestVersion: string },
): Promise<void> {
  const statePath = NodePath.join(managedRuntimeRoot, "update-state.json");
  await NodeFSP.mkdir(managedRuntimeRoot, { recursive: true });
  await NodeFSP.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function refreshRuntime(
  managedRuntimeRoot: string,
  options: ManagedProteusOptions,
  now: number,
): Promise<ManagedProteusRuntime> {
  const current = await resolveRuntime(managedRuntimeRoot);
  const state = await NodeFSP.readFile(
    NodePath.join(managedRuntimeRoot, "update-state.json"),
    "utf8",
  )
    .then((value) => JSON.parse(value) as ProteusUpdateState)
    .catch(() => null);
  if (
    options.forceUpdateCheck !== true &&
    typeof state?.checkedAt === "number" &&
    Number.isFinite(state.checkedAt) &&
    now - state.checkedAt >= 0 &&
    now - state.checkedAt < PROTEUS_UPDATE_CHECK_INTERVAL_MS
  ) {
    return current;
  }

  // Record the attempt before network access so an unavailable release service cannot
  // stall every provider rebuild. A verified update replaces this state below.
  await writeUpdateState(managedRuntimeRoot, {
    checkedAt: now,
    latestVersion: current.version,
  });

  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const releaseResponse = await fetchWithTimeout(
    fetchImplementation,
    PROTEUS_RELEASE_API,
    "application/vnd.github+json",
  );
  const release = (await releaseResponse.json()) as GitHubLatestRelease;
  const tag = typeof release.tag_name === "string" ? release.tag_name : "";
  const version = tag.startsWith("v") ? tag.slice(1) : "";
  if (!parseVersion(version)) throw new Error("The latest Proteus release tag is invalid.");

  if (compareVersions(version, current.version) > 0) {
    const asset = exactReleaseAsset(release, version);
    const assetResponse = await fetchWithTimeout(
      fetchImplementation,
      asset.browser_download_url as string,
      "application/octet-stream",
    );
    const archive = new Uint8Array(await assetResponse.arrayBuffer());
    if (archive.byteLength !== asset.size || archive.byteLength > PROTEUS_UPDATE_MAX_BYTES) {
      throw new Error("The downloaded Proteus package size did not match its release metadata.");
    }
    const actualDigest = `sha256:${NodeCrypto.createHash("sha256").update(archive).digest("hex")}`;
    if (actualDigest !== asset.digest) {
      throw new Error("The downloaded Proteus package failed SHA-256 verification.");
    }
    await installDownloadedRuntime(managedRuntimeRoot, version, actualDigest, archive);
  }

  await writeUpdateState(managedRuntimeRoot, { checkedAt: now, latestVersion: version });
  return resolveRuntime(managedRuntimeRoot);
}

export const refreshManagedProteusRuntime = Effect.fn("ProteusRuntime.update")(function* (
  managedRuntimeRoot: string,
  options: ManagedProteusOptions = {},
) {
  const currentTime = options.now?.() ?? (yield* Clock.currentTimeMillis);
  return yield* Effect.tryPromise({
    try: () => {
      const normalizedRoot = NodePath.resolve(managedRuntimeRoot);
      const existing = updatePromises.get(normalizedRoot);
      if (existing) return existing;
      const pending = refreshRuntime(normalizedRoot, options, currentTime).finally(() => {
        if (updatePromises.get(normalizedRoot) === pending) updatePromises.delete(normalizedRoot);
      });
      updatePromises.set(normalizedRoot, pending);
      return pending;
    },
    catch: (cause) =>
      new ProteusRuntimeError({
        operation: "update",
        detail: "Erebus could not refresh Proteus and kept the last verified runtime.",
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function writeManagedProteusManifest(
  manifestPath: string,
  version: string,
  mcpPath: string,
  required: boolean,
): Promise<void> {
  const source = await NodeFSP.readFile(manifestPath, "utf8").catch((error: unknown) => {
    if (
      !required &&
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  });
  if (source === null) return;

  const manifest = JSON.parse(source) as Record<string, unknown>;
  if (manifest.name !== "proteus" || manifest.version !== version) {
    if (!required) return;
    throw new Error("The managed Proteus plugin manifest is invalid.");
  }
  manifest.mcpServers = {
    ...(isRecord(manifest.mcpServers) ? manifest.mcpServers : {}),
    proteus: {
      command: process.execPath,
      args: [mcpPath],
      env: {
        ELECTRON_RUN_AS_NODE: "1",
      },
    },
  };
  const next = `${JSON.stringify(manifest, null, 2)}\n`;
  if (next !== source) await NodeFSP.writeFile(manifestPath, next, "utf8");
}

export const installManagedProteusForCodex = Effect.fn("ProteusRuntime.installForCodex")(function* (
  codexHome: string,
  options: ManagedProteusOptions = {},
) {
  let runtime: ManagedProteusRuntime;
  if (options.managedRuntimeRoot) {
    defaultManagedRuntimeRoot = NodePath.resolve(options.managedRuntimeRoot);
    runtime = yield* refreshManagedProteusRuntime(options.managedRuntimeRoot, options).pipe(
      Effect.tapError((error) =>
        Effect.logWarning(error.detail, { operation: error.operation, cause: error.cause }),
      ),
      Effect.catch(() => resolveManagedProteusRuntime(options.managedRuntimeRoot)),
    );
  } else {
    runtime = yield* resolveManagedProteusRuntime();
  }
  return yield* Effect.tryPromise({
    try: async () => {
      if (options.managedRuntimeRoot) {
        await pruneOwnedVersions(
          NodePath.join(options.managedRuntimeRoot, "packages"),
          ".erebus-managed-runtime.json",
          runtime.version,
        );
      }
      const marketplaceRoot = NodePath.join(codexHome, "managed", "proteus", runtime.version);
      const installedPluginRoot = NodePath.join(marketplaceRoot, "plugins", "proteus");
      const markerPath = NodePath.join(marketplaceRoot, ".erebus-managed.json");
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
      const manifestPath = NodePath.join(installedPluginRoot, ".codex-plugin", "plugin.json");
      const markerMatches = await NodeFSP.readFile(markerPath, "utf8")
        .then((value) => {
          const marker = JSON.parse(value) as ErebusManagedMarker;
          return marker.owner === "Erebus" && marker.version === runtime.version;
        })
        .catch(() => false);
      const managedFilesExist = markerMatches
        ? await Promise.all([NodeFSP.access(manifestPath), NodeFSP.access(marketplacePath)])
            .then(() => true)
            .catch(() => false)
        : false;

      if (!managedFilesExist) {
        await NodeFSP.mkdir(NodePath.dirname(installedPluginRoot), { recursive: true });
        await copyFilesystemTree(runtime.pluginRoot, installedPluginRoot);
        await NodeFSP.mkdir(NodePath.dirname(marketplacePath), { recursive: true });
        await copyFilesystemTree(sourceMarketplacePath, marketplacePath);
        await NodeFSP.writeFile(
          markerPath,
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          `${JSON.stringify({ owner: "Erebus", version: runtime.version }, null, 2)}\n`,
          "utf8",
        );
      }

      const mcpPath = NodePath.join(installedPluginRoot, "dist", "mcp.js");
      await writeManagedProteusManifest(manifestPath, runtime.version, mcpPath, true);
      await writeManagedProteusManifest(
        NodePath.join(
          codexHome,
          "plugins",
          "cache",
          MARKETPLACE_NAME,
          "proteus",
          runtime.version,
          ".codex-plugin",
          "plugin.json",
        ),
        runtime.version,
        mcpPath,
        false,
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
      await pruneOwnedVersions(
        NodePath.join(codexHome, "managed", "proteus"),
        ".erebus-managed.json",
        runtime.version,
      );
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
