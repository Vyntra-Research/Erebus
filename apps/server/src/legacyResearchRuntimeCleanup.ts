// @effect-diagnostics nodeBuiltinImport:off - migration removes files owned by older Erebus builds.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const PROTEUS_MARKETPLACE_TABLE = "[marketplaces.proteus-marketplace]";
const PROTEUS_PLUGIN_TABLE = '[plugins."proteus@proteus-marketplace"]';

export class LegacyResearchRuntimeCleanupError extends Schema.TaggedErrorClass<LegacyResearchRuntimeCleanupError>()(
  "LegacyResearchRuntimeCleanupError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

function isMissingFile(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";
}

function removeTomlTable(source: string, table: string): string {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const output: string[] = [];
  let found = false;
  let skipping = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === table) {
      found = true;
      skipping = true;
      continue;
    }
    if (skipping && /^\[{1,2}[^\]]+\]{1,2}$/.test(trimmed)) skipping = false;
    if (!skipping) output.push(line);
  }

  return found ? output.join(newline) : source;
}

async function writeFileAtomically(path: string, source: string): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    await NodeFSP.writeFile(temporaryPath, source, "utf8");
    await NodeFSP.rename(temporaryPath, path);
  } finally {
    await NodeFSP.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function removeLegacyManagedProteusRuntimeInternal(
  codexHome: string,
  stateDir: string,
): Promise<void> {
  const configPath = NodePath.join(codexHome, "config.toml");
  const currentConfig = await NodeFSP.readFile(configPath, "utf8").catch((cause: unknown) => {
    if (isMissingFile(cause)) return null;
    throw cause;
  });

  if (currentConfig !== null) {
    const withoutMarketplace = removeTomlTable(currentConfig, PROTEUS_MARKETPLACE_TABLE);
    const nextConfig = removeTomlTable(withoutMarketplace, PROTEUS_PLUGIN_TABLE);
    if (nextConfig !== currentConfig) await writeFileAtomically(configPath, nextConfig);
  }

  await Promise.all([
    NodeFSP.rm(NodePath.join(stateDir, "managed", "proteus-runtime"), {
      recursive: true,
      force: true,
    }),
    NodeFSP.rm(NodePath.join(codexHome, "managed", "proteus"), {
      recursive: true,
      force: true,
    }),
    NodeFSP.rm(NodePath.join(codexHome, "plugins", "cache", "proteus-marketplace", "proteus"), {
      recursive: true,
      force: true,
    }),
  ]);
}

export const removeLegacyManagedProteusRuntime = Effect.fn(
  "LegacyResearchRuntimeCleanup.removeManagedProteusRuntime",
)(function* (codexHome: string, stateDir: string) {
  return yield* Effect.tryPromise({
    try: () => removeLegacyManagedProteusRuntimeInternal(codexHome, stateDir),
    catch: (cause) =>
      new LegacyResearchRuntimeCleanupError({
        detail: "Erebus could not remove its legacy managed research runtime.",
        cause,
      }),
  });
});
