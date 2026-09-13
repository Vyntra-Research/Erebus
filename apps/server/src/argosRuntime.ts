// @effect-diagnostics nodeBuiltinImport:off - Argos is a filesystem-distributed subprocess dependency.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Tar from "tar";

const require = NodeModule.createRequire(import.meta.url);
const MARKETPLACE_NAME = "argos-marketplace";
const MARKETPLACE_TABLE = `[marketplaces.${MARKETPLACE_NAME}]`;
const PLUGIN_TABLE = `[plugins."argos@${MARKETPLACE_NAME}"]`;
const ARGOS_PACKAGE_NAME = "@rafabd1/argos";
const ARGOS_RELEASE_API = "https://api.github.com/repos/rafabd1/Argos/releases/latest";
const ARGOS_RELEASE_BASE = "https://github.com/rafabd1/Argos/releases/download/";
const ARGOS_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const ARGOS_UPDATE_MAX_BYTES = 20 * 1024 * 1024;
const ARGOS_UPDATE_TIMEOUT_MS = 30_000;
const ARGOS_RETAINED_RUNTIME_VERSIONS = 2;
const ARGOS_RETAINED_PLUGIN_VERSIONS = 2;
const ARGOS_MARKETPLACE_MANIFEST = `{
  "name": "argos-marketplace",
  "interface": {
    "displayName": "Argos Marketplace"
  },
  "plugins": [
    {
      "name": "argos",
      "source": {
        "source": "local",
        "path": "./plugins/argos"
      },
      "policy": {
        "installation": "INSTALLED_BY_DEFAULT",
        "authentication": "ON_INSTALL"
      },
      "category": "Developer Tools"
    }
  ]
}
`;
const updatePromises = new Map<string, Promise<ManagedArgosRuntime>>();
let defaultManagedRuntimeRoot: string | undefined;

export class ArgosRuntimeError extends Schema.TaggedErrorClass<ArgosRuntimeError>()(
  "ArgosRuntimeError",
  {
    operation: Schema.Literals(["resolve", "install", "update"]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface ManagedArgosRuntime {
  readonly version: string;
  readonly packageRoot: string;
  readonly cliPath: string;
  readonly mcpPath: string;
  readonly pluginRoot: string;
}

export interface ManagedArgosUpdateStatus {
  readonly version: string;
  readonly latestVersion: string;
  readonly updateAvailable: boolean;
  readonly checkedAt: number;
}

export interface ManagedArgosOptions {
  readonly managedRuntimeRoot?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly forceUpdateCheck?: boolean;
}

interface ArgosPackageJson {
  readonly name?: unknown;
  readonly version?: unknown;
}

interface ErebusManagedArgosMarker {
  readonly owner?: unknown;
  readonly version?: unknown;
  readonly sourceRevision?: unknown;
  readonly mode?: unknown;
}

interface ErebusManagedRuntimeMarker {
  readonly owner?: unknown;
  readonly version?: unknown;
  readonly digest?: unknown;
}

interface ArgosUpdateState {
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
    if (skipping && /^\[[^\]]+\]$/.test(trimmed)) skipping = false;
    if (!skipping) output.push(line);
  }
  return output.join("\n").trimEnd();
}

function withManagedArgosConfig(source: string, marketplaceRoot: string): string {
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

async function runtimeFromPackageRoot(
  packageRoot: string,
  expectedVersion?: string,
): Promise<ManagedArgosRuntime> {
  const packageJson = JSON.parse(
    await NodeFSP.readFile(NodePath.join(packageRoot, "package.json"), "utf8"),
  ) as ArgosPackageJson;
  if (
    packageJson.name !== ARGOS_PACKAGE_NAME ||
    typeof packageJson.version !== "string" ||
    !parseVersion(packageJson.version) ||
    (expectedVersion !== undefined && packageJson.version !== expectedVersion)
  ) {
    throw new Error("Argos package metadata is invalid.");
  }
  const runtime = {
    version: packageJson.version,
    packageRoot,
    cliPath: NodePath.join(packageRoot, "dist", "cli.js"),
    mcpPath: NodePath.join(packageRoot, "dist", "mcp.js"),
    pluginRoot: NodePath.join(packageRoot, "plugins", "argos"),
  } satisfies ManagedArgosRuntime;
  await Promise.all([
    NodeFSP.access(runtime.cliPath),
    NodeFSP.access(runtime.mcpPath),
    NodeFSP.access(NodePath.join(runtime.pluginRoot, ".codex-plugin", "plugin.json")),
    NodeFSP.access(NodePath.join(runtime.pluginRoot, "skills", "argos", "SKILL.md")),
  ]);
  return runtime;
}

async function bundledArgosRuntime(): Promise<ManagedArgosRuntime> {
  const packageJsonPath = require.resolve("@rafabd1/argos/package.json");
  return runtimeFromPackageRoot(NodePath.dirname(packageJsonPath));
}

async function installedArgosRuntimes(
  managedRuntimeRoot: string,
): Promise<ReadonlyArray<ManagedArgosRuntime>> {
  const packagesRoot = NodePath.join(managedRuntimeRoot, "packages");
  const entries = await NodeFSP.readdir(packagesRoot, { withFileTypes: true }).catch(() => []);
  const runtimes: ManagedArgosRuntime[] = [];
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

async function resolveRuntime(managedRuntimeRoot?: string): Promise<ManagedArgosRuntime> {
  const bundled = await bundledArgosRuntime();
  if (!managedRuntimeRoot) return bundled;
  const installed = await installedArgosRuntimes(managedRuntimeRoot);
  return installed.reduce(
    (selected, candidate) =>
      compareVersions(candidate.version, selected.version) > 0 ? candidate : selected,
    bundled,
  );
}

export const resolveManagedArgosRuntime = Effect.fn("ArgosRuntime.resolve")(function* (
  managedRuntimeRoot = defaultManagedRuntimeRoot,
) {
  return yield* Effect.tryPromise({
    try: () => resolveRuntime(managedRuntimeRoot),
    catch: (cause) =>
      new ArgosRuntimeError({
        operation: "resolve",
        detail: "Erebus could not resolve its managed Argos runtime.",
        cause,
      }),
  });
});

function exactReleaseAsset(release: GitHubLatestRelease, version: string): GitHubReleaseAsset {
  if (release.draft === true || release.prerelease === true || !Array.isArray(release.assets)) {
    throw new Error("The latest Argos release is not a stable published release.");
  }
  const expectedName = `rafabd1-argos-${version}.tgz`;
  const asset = (release.assets as GitHubReleaseAsset[]).find((item) => item.name === expectedName);
  if (
    !asset ||
    typeof asset.browser_download_url !== "string" ||
    asset.browser_download_url !== `${ARGOS_RELEASE_BASE}v${version}/${expectedName}` ||
    typeof asset.digest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(asset.digest) ||
    typeof asset.size !== "number" ||
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0 ||
    asset.size > ARGOS_UPDATE_MAX_BYTES
  ) {
    throw new Error("The latest Argos release has no verifiable package asset.");
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
      "user-agent": "Erebus Argos Updater",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(ARGOS_UPDATE_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Argos update request failed with HTTP ${response.status}.`);
  return response;
}

async function installDownloadedRuntime(
  managedRuntimeRoot: string,
  version: string,
  digest: string,
  archive: Uint8Array,
): Promise<ManagedArgosRuntime> {
  const packagesRoot = NodePath.join(managedRuntimeRoot, "packages");
  const targetRoot = NodePath.join(packagesRoot, version);
  const stagingRoot = NodePath.join(
    managedRuntimeRoot,
    `.staging-${process.pid}-${NodeCrypto.randomUUID()}`,
  );
  const archivePath = NodePath.join(stagingRoot, "argos.tgz");
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
  await NodeFSP.mkdir(managedRuntimeRoot, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(managedRuntimeRoot, "update-state.json"),
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8",
  );
}

async function readUpdateState(managedRuntimeRoot: string): Promise<ArgosUpdateState | null> {
  return NodeFSP.readFile(NodePath.join(managedRuntimeRoot, "update-state.json"), "utf8")
    .then((value) => JSON.parse(value) as ArgosUpdateState)
    .catch(() => null);
}

function latestReleaseVersion(release: GitHubLatestRelease): string {
  if (release.draft === true || release.prerelease === true) {
    throw new Error("The latest Argos release is not a stable published release.");
  }
  const tag = typeof release.tag_name === "string" ? release.tag_name : "";
  const version = tag.startsWith("v") ? tag.slice(1) : "";
  if (!parseVersion(version)) throw new Error("The latest Argos release tag is invalid.");
  return version;
}

async function inspectRuntimeUpdate(
  managedRuntimeRoot: string,
  options: ManagedArgosOptions,
  now: number,
): Promise<ManagedArgosUpdateStatus> {
  const current = await resolveRuntime(managedRuntimeRoot);
  const state = await readUpdateState(managedRuntimeRoot);
  if (
    options.forceUpdateCheck !== true &&
    typeof state?.checkedAt === "number" &&
    Number.isFinite(state.checkedAt) &&
    now - state.checkedAt >= 0 &&
    now - state.checkedAt < ARGOS_UPDATE_CHECK_INTERVAL_MS &&
    typeof state.latestVersion === "string" &&
    parseVersion(state.latestVersion)
  ) {
    return {
      version: current.version,
      latestVersion: state.latestVersion,
      updateAvailable: compareVersions(state.latestVersion, current.version) > 0,
      checkedAt: state.checkedAt,
    };
  }

  const releaseResponse = await fetchWithTimeout(
    options.fetch ?? globalThis.fetch,
    ARGOS_RELEASE_API,
    "application/vnd.github+json",
  );
  const release = (await releaseResponse.json()) as GitHubLatestRelease;
  const latestVersion = latestReleaseVersion(release);
  if (compareVersions(latestVersion, current.version) > 0) {
    exactReleaseAsset(release, latestVersion);
  }
  await writeUpdateState(managedRuntimeRoot, { checkedAt: now, latestVersion });
  return {
    version: current.version,
    latestVersion,
    updateAvailable: compareVersions(latestVersion, current.version) > 0,
    checkedAt: now,
  };
}

export const inspectManagedArgosUpdate = Effect.fn("ArgosRuntime.inspectUpdate")(function* (
  managedRuntimeRoot: string,
  options: ManagedArgosOptions = {},
) {
  const currentTime = options.now?.() ?? (yield* Clock.currentTimeMillis);
  return yield* Effect.tryPromise({
    try: () => inspectRuntimeUpdate(NodePath.resolve(managedRuntimeRoot), options, currentTime),
    catch: (cause) =>
      new ArgosRuntimeError({
        operation: "update",
        detail: "Erebus could not check the latest Argos release.",
        cause,
      }),
  });
});

async function refreshRuntime(
  managedRuntimeRoot: string,
  options: ManagedArgosOptions,
  now: number,
): Promise<ManagedArgosRuntime> {
  const current = await resolveRuntime(managedRuntimeRoot);
  const state = await readUpdateState(managedRuntimeRoot);
  if (
    options.forceUpdateCheck !== true &&
    typeof state?.checkedAt === "number" &&
    Number.isFinite(state.checkedAt) &&
    now - state.checkedAt >= 0 &&
    now - state.checkedAt < ARGOS_UPDATE_CHECK_INTERVAL_MS
  ) {
    return current;
  }

  await writeUpdateState(managedRuntimeRoot, {
    checkedAt: now,
    latestVersion: current.version,
  });
  const releaseResponse = await fetchWithTimeout(
    options.fetch ?? globalThis.fetch,
    ARGOS_RELEASE_API,
    "application/vnd.github+json",
  );
  const release = (await releaseResponse.json()) as GitHubLatestRelease;
  const version = latestReleaseVersion(release);

  if (compareVersions(version, current.version) > 0) {
    const asset = exactReleaseAsset(release, version);
    const assetResponse = await fetchWithTimeout(
      options.fetch ?? globalThis.fetch,
      asset.browser_download_url as string,
      "application/octet-stream",
    );
    const archive = new Uint8Array(await assetResponse.arrayBuffer());
    if (archive.byteLength !== asset.size || archive.byteLength > ARGOS_UPDATE_MAX_BYTES) {
      throw new Error("The downloaded Argos package size did not match its release metadata.");
    }
    const actualDigest = `sha256:${NodeCrypto.createHash("sha256").update(archive).digest("hex")}`;
    if (actualDigest !== asset.digest) {
      throw new Error("The downloaded Argos package failed SHA-256 verification.");
    }
    await installDownloadedRuntime(managedRuntimeRoot, version, actualDigest, archive);
  }

  await writeUpdateState(managedRuntimeRoot, { checkedAt: now, latestVersion: version });
  return resolveRuntime(managedRuntimeRoot);
}

export const refreshManagedArgosRuntime = Effect.fn("ArgosRuntime.update")(function* (
  managedRuntimeRoot: string,
  options: ManagedArgosOptions = {},
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
      new ArgosRuntimeError({
        operation: "update",
        detail: "Erebus could not refresh Argos and kept the last verified runtime.",
        cause,
      }),
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function writeManagedArgosManifest(
  manifestPath: string,
  version: string,
  mcpEntrypoint: string,
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
  if (manifest.name !== "argos" || manifest.version !== version) {
    if (!required) return;
    throw new Error("The managed Argos plugin manifest is invalid.");
  }
  manifest.mcpServers = {
    ...(isRecord(manifest.mcpServers) ? manifest.mcpServers : {}),
    argos: {
      command: process.execPath,
      args: [mcpEntrypoint],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    },
  };
  const next = `${JSON.stringify(manifest, null, 2)}\n`;
  if (next !== source) await NodeFSP.writeFile(manifestPath, next, "utf8");
}

async function pruneOwnedPluginVersions(
  versionsRoot: string,
  activeVersion: string,
): Promise<void> {
  const entries = await NodeFSP.readdir(versionsRoot, { withFileTypes: true }).catch(() => []);
  const owned: Array<{ readonly path: string; readonly version: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !parseVersion(entry.name)) continue;
    const versionRoot = NodePath.join(versionsRoot, entry.name);
    const marker = await NodeFSP.readFile(
      NodePath.join(versionRoot, ".erebus-managed.json"),
      "utf8",
    )
      .then((value) => JSON.parse(value) as ErebusManagedArgosMarker)
      .catch(() => null);
    if (marker?.owner === "Erebus" && marker.version === entry.name) {
      owned.push({ path: versionRoot, version: entry.name });
    }
  }
  owned.sort((left, right) => compareVersions(right.version, left.version));
  const retained = new Set([activeVersion]);
  for (const candidate of owned) {
    if (retained.size >= ARGOS_RETAINED_PLUGIN_VERSIONS) break;
    retained.add(candidate.version);
  }
  for (const candidate of owned) {
    if (!retained.has(candidate.version)) {
      await NodeFSP.rm(candidate.path, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function pruneOwnedRuntimeVersions(
  versionsRoot: string,
  activeVersion: string,
): Promise<void> {
  const entries = await NodeFSP.readdir(versionsRoot, { withFileTypes: true }).catch(() => []);
  const owned: Array<{ readonly path: string; readonly version: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !parseVersion(entry.name)) continue;
    const versionRoot = NodePath.join(versionsRoot, entry.name);
    const marker = await NodeFSP.readFile(
      NodePath.join(versionRoot, ".erebus-managed-runtime.json"),
      "utf8",
    )
      .then((value) => JSON.parse(value) as ErebusManagedRuntimeMarker)
      .catch(() => null);
    if (marker?.owner === "Erebus" && marker.version === entry.name) {
      owned.push({ path: versionRoot, version: entry.name });
    }
  }
  owned.sort((left, right) => compareVersions(right.version, left.version));
  const retained = new Set([activeVersion]);
  for (const candidate of owned) {
    if (retained.size >= ARGOS_RETAINED_RUNTIME_VERSIONS) break;
    retained.add(candidate.version);
  }
  for (const candidate of owned) {
    if (!retained.has(candidate.version)) {
      await NodeFSP.rm(candidate.path, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export const installManagedArgosForCodex = Effect.fn("ArgosRuntime.installForCodex")(function* (
  codexHome: string,
  options: ManagedArgosOptions = {},
) {
  let runtime: ManagedArgosRuntime;
  if (options.managedRuntimeRoot) {
    defaultManagedRuntimeRoot = NodePath.resolve(options.managedRuntimeRoot);
    runtime = yield* refreshManagedArgosRuntime(options.managedRuntimeRoot, options).pipe(
      Effect.tapError((error) =>
        Effect.logWarning(error.detail, { operation: error.operation, cause: error.cause }),
      ),
      Effect.catch(() => resolveManagedArgosRuntime(options.managedRuntimeRoot)),
    );
  } else {
    runtime = yield* resolveManagedArgosRuntime();
  }
  return yield* Effect.tryPromise({
    try: async () => {
      if (options.managedRuntimeRoot) {
        await pruneOwnedRuntimeVersions(
          NodePath.join(options.managedRuntimeRoot, "packages"),
          runtime.version,
        );
      }
      const versionsRoot = NodePath.join(codexHome, "managed", "argos");
      const marketplaceRoot = NodePath.join(versionsRoot, runtime.version);
      const installedPluginRoot = NodePath.join(marketplaceRoot, "plugins", "argos");
      const markerPath = NodePath.join(marketplaceRoot, ".erebus-managed.json");
      const marketplacePath = NodePath.join(
        marketplaceRoot,
        ".agents",
        "plugins",
        "marketplace.json",
      );
      const manifestPath = NodePath.join(installedPluginRoot, ".codex-plugin", "plugin.json");
      const marker = await NodeFSP.readFile(markerPath, "utf8")
        .then((value) => JSON.parse(value) as ErebusManagedArgosMarker)
        .catch(() => null);
      const markerMatches =
        marker?.owner === "Erebus" &&
        marker.version === runtime.version &&
        marker.sourceRevision === runtime.version &&
        marker.mode === "read-write";
      const managedFilesExist = markerMatches
        ? await Promise.all([
            NodeFSP.access(manifestPath),
            NodeFSP.access(marketplacePath),
            NodeFSP.access(NodePath.join(installedPluginRoot, "skills", "argos", "SKILL.md")),
          ])
            .then(() => true)
            .catch(() => false)
        : false;

      if (!managedFilesExist) {
        if (marker?.owner === "Erebus") {
          await NodeFSP.rm(marketplaceRoot, { recursive: true, force: true });
        }
        await copyFilesystemTree(runtime.pluginRoot, installedPluginRoot);
        await NodeFSP.mkdir(NodePath.dirname(marketplacePath), { recursive: true });
        await NodeFSP.writeFile(marketplacePath, ARGOS_MARKETPLACE_MANIFEST, "utf8");
        await NodeFSP.writeFile(
          markerPath,
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          `${JSON.stringify(
            {
              owner: "Erebus",
              version: runtime.version,
              sourceRevision: runtime.version,
              mode: "read-write",
            },
            null,
            2,
          )}\n`,
          "utf8",
        );
        await NodeFSP.rm(
          NodePath.join(codexHome, "plugins", "cache", MARKETPLACE_NAME, "argos", runtime.version),
          { recursive: true, force: true },
        );
      }

      await writeManagedArgosManifest(manifestPath, runtime.version, runtime.mcpPath, true);
      await writeManagedArgosManifest(
        NodePath.join(
          codexHome,
          "plugins",
          "cache",
          MARKETPLACE_NAME,
          "argos",
          runtime.version,
          ".codex-plugin",
          "plugin.json",
        ),
        runtime.version,
        runtime.mcpPath,
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
      const nextConfig = withManagedArgosConfig(currentConfig, marketplaceRoot);
      if (nextConfig !== currentConfig) {
        await NodeFSP.mkdir(NodePath.dirname(configPath), { recursive: true });
        await NodeFSP.writeFile(configPath, nextConfig, "utf8");
      }
      await pruneOwnedPluginVersions(versionsRoot, runtime.version);
      return { ...runtime, marketplaceRoot, installedPluginRoot };
    },
    catch: (cause) =>
      new ArgosRuntimeError({
        operation: "install",
        detail: "Erebus could not install its managed Argos plugin.",
        cause,
      }),
  });
});
