// @effect-diagnostics nodeBuiltinImport:off - account overlays must detach SQLite hardlinks safely.
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import {
  ProviderDriverKind,
  type CodexSettings,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as PlatformError from "effect/PlatformError";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { expandHomePath } from "../../pathExpansion.ts";

export interface CodexHomeLayout {
  readonly mode: "direct" | "authOverlay";
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string | undefined;
  readonly continuationKey: string;
}

export function withAutomaticCodexAccountOverlay(
  config: CodexSettings,
  options: {
    readonly instanceId: ProviderInstanceId;
    readonly defaultInstanceId: ProviderInstanceId;
    readonly accountHomePath: string;
  },
): CodexSettings {
  return options.instanceId !== options.defaultInstanceId &&
    config.shadowHomePath.trim().length === 0
    ? { ...config, shadowHomePath: options.accountHomePath }
    : config;
}

const KNOWN_SHARED_DIRECTORIES = [
  "sessions",
  "archived_sessions",
  "sqlite",
  "shell_snapshots",
  "worktrees",
  "skills",
  "plugins",
  "cache",
  "logs",
  "mcp-oauth-locks",
] as const;

const PRIVATE_ENTRY_NAMES = new Set(["auth.json", "models_cache.json"]);
const SHADOW_LOCAL_ENTRY_NAMES = new Set(["log", "tmp"]);
const REPLACEABLE_SHARED_RUNTIME_DIRECTORIES = new Set(["mcp-oauth-locks"]);
const SQLITE_DATABASE_ENTRY = /^.+\.sqlite$/i;
const SQLITE_SIDECAR_ENTRY = /^.+\.sqlite-(?:shm|wal)$/i;

function isShadowLocalEntry(entryName: string): boolean {
  return (
    SHADOW_LOCAL_ENTRY_NAMES.has(entryName) ||
    SQLITE_DATABASE_ENTRY.test(entryName) ||
    SQLITE_SIDECAR_ENTRY.test(entryName)
  );
}

function resolveHomePath(
  path: Path.Path,
  value: string | undefined,
  defaultHomePath: string | undefined,
): string {
  const configured = value?.trim();
  const fallback = defaultHomePath?.trim();
  const expanded = expandHomePath(configured || fallback || path.join(NodeOS.homedir(), ".codex"));
  return path.resolve(expanded);
}

export const resolveCodexHomeLayout = Effect.fn("resolveCodexHomeLayout")(function* (
  config: CodexSettings,
  options: { readonly defaultHomePath?: string } = {},
): Effect.fn.Return<CodexHomeLayout, never, Path.Path> {
  const path = yield* Path.Path;
  const sharedHomePath = resolveHomePath(path, config.homePath, options.defaultHomePath);
  const shadowHomePath = config.shadowHomePath.trim();
  if (shadowHomePath.length === 0) {
    return {
      mode: "direct",
      sharedHomePath,
      effectiveHomePath:
        config.homePath.trim().length > 0 || options.defaultHomePath?.trim()
          ? sharedHomePath
          : undefined,
      continuationKey: `codex:home:${sharedHomePath}`,
    };
  }

  const effectiveHomePath = path.resolve(expandHomePath(shadowHomePath));
  return {
    mode: "authOverlay",
    sharedHomePath,
    effectiveHomePath,
    continuationKey: `codex:home:${sharedHomePath}`,
  };
});

const CodexShadowHomeContext = {
  sharedHomePath: Schema.String,
  effectiveHomePath: Schema.String,
};

export class CodexShadowHomeFileSystemError extends Schema.TaggedErrorClass<CodexShadowHomeFileSystemError>()(
  "CodexShadowHomeFileSystemError",
  {
    ...CodexShadowHomeContext,
    operation: Schema.Literals([
      "readLink",
      "makeDirectory",
      "readDirectory",
      "remove",
      "stat",
      "symlink",
      "link",
      "copy",
    ]),
    path: Schema.String,
    targetPath: Schema.optional(Schema.String),
    entryName: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const target = this.targetPath === undefined ? "" : ` to '${this.targetPath}'`;
    return `Codex shadow home filesystem operation '${this.operation}' failed for '${this.path}'${target}.`;
  }
}

async function sameFile(left: string, right: string): Promise<boolean> {
  try {
    const [leftStat, rightStat] = await Promise.all([NodeFSP.stat(left), NodeFSP.stat(right)]);
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
  } catch {
    return false;
  }
}

const materializePrivateSqliteDatabases = Effect.fn(
  "CodexHomeLayout.materializePrivateSqliteDatabases",
)(function* (input: {
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string;
  readonly sharedEntryNames: readonly string[];
}) {
  yield* Effect.tryPromise({
    try: async () => {
      const databaseEntries = input.sharedEntryNames.filter((entryName) =>
        SQLITE_DATABASE_ENTRY.test(entryName),
      );
      for (const entryName of databaseEntries) {
        const sourcePath = NodePath.join(input.sharedHomePath, entryName);
        const targetPath = NodePath.join(input.effectiveHomePath, entryName);
        const targetExists = await NodeFSP.stat(targetPath).then(
          () => true,
          () => false,
        );
        if (targetExists && !(await sameFile(sourcePath, targetPath))) continue;

        const temporaryPath = `${targetPath}.erebus-private-${process.pid}`;
        await NodeFSP.rm(temporaryPath, { force: true });
        const source = new NodeSqlite.DatabaseSync(sourcePath, { readOnly: true });
        try {
          await NodeSqlite.backup(source, temporaryPath);
        } finally {
          source.close();
        }
        const copied = new NodeSqlite.DatabaseSync(temporaryPath);
        try {
          copied.exec("REINDEX");
        } finally {
          copied.close();
        }

        for (const suffix of ["-shm", "-wal"] as const) {
          const sourceSidecar = `${sourcePath}${suffix}`;
          const targetSidecar = `${targetPath}${suffix}`;
          if (await sameFile(sourceSidecar, targetSidecar)) {
            await NodeFSP.rm(targetSidecar, { force: true });
          }
        }
        const displacedPath = `${targetPath}.erebus-shared-link`;
        await NodeFSP.rm(displacedPath, { force: true });
        if (targetExists) await NodeFSP.rename(targetPath, displacedPath);
        try {
          await NodeFSP.rename(temporaryPath, targetPath);
          await NodeFSP.rm(displacedPath, { force: true });
        } catch (cause) {
          if (targetExists) await NodeFSP.rename(displacedPath, targetPath);
          throw cause;
        }
      }
    },
    catch: (cause) =>
      new CodexShadowHomeFileSystemError({
        sharedHomePath: input.sharedHomePath,
        effectiveHomePath: input.effectiveHomePath,
        operation: "copy",
        path: input.effectiveHomePath,
        cause,
      }),
  });
});

export class CodexShadowHomePathConflictError extends Schema.TaggedErrorClass<CodexShadowHomePathConflictError>()(
  "CodexShadowHomePathConflictError",
  CodexShadowHomeContext,
) {
  override get message(): string {
    return `Codex shadow home path '${this.effectiveHomePath}' must be different from the shared home path '${this.sharedHomePath}'.`;
  }
}

export class CodexShadowHomeEntryConflictError extends Schema.TaggedErrorClass<CodexShadowHomeEntryConflictError>()(
  "CodexShadowHomeEntryConflictError",
  {
    ...CodexShadowHomeContext,
    entryName: Schema.String,
    linkPath: Schema.String,
    targetPath: Schema.String,
  },
) {
  override get message(): string {
    return `Cannot create Codex shadow home entry '${this.entryName}' because '${this.linkPath}' already exists and is not a symlink.`;
  }
}

export class CodexShadowHomePrivateEntrySymlinkError extends Schema.TaggedErrorClass<CodexShadowHomePrivateEntrySymlinkError>()(
  "CodexShadowHomePrivateEntrySymlinkError",
  {
    ...CodexShadowHomeContext,
    entryName: Schema.String,
    path: Schema.String,
  },
) {
  override get message(): string {
    return `Codex shadow home private entry '${this.entryName}' at '${this.path}' must be a real file, not a symlink.`;
  }
}

export const CodexShadowHomeError = Schema.Union([
  CodexShadowHomeFileSystemError,
  CodexShadowHomePathConflictError,
  CodexShadowHomeEntryConflictError,
  CodexShadowHomePrivateEntrySymlinkError,
]);
export type CodexShadowHomeError = typeof CodexShadowHomeError.Type;

type LinkState =
  | {
      readonly _tag: "Missing";
    }
  | {
      readonly _tag: "NotSymlink";
    }
  | {
      readonly _tag: "Symlink";
      readonly target: string;
    };

function isNotSymlinkError(error: PlatformError.PlatformError): boolean {
  const cause = error.reason.cause;
  return (
    error.reason._tag === "Unknown" &&
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "EINVAL"
  );
}

const readLinkState = Effect.fn("CodexHomeLayout.readLinkState")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string;
  readonly entryName: string;
  readonly linkPath: string;
}): Effect.fn.Return<LinkState, CodexShadowHomeError> {
  return yield* input.fileSystem.readLink(input.linkPath).pipe(
    Effect.map((target): LinkState => ({ _tag: "Symlink", target })),
    Effect.catchTags({
      PlatformError: (cause) => {
        if (cause.reason._tag === "NotFound") {
          return Effect.succeed<LinkState>({ _tag: "Missing" });
        }
        if (isNotSymlinkError(cause)) {
          return Effect.succeed<LinkState>({ _tag: "NotSymlink" });
        }
        return new CodexShadowHomeFileSystemError({
          sharedHomePath: input.sharedHomePath,
          effectiveHomePath: input.effectiveHomePath,
          operation: "readLink",
          path: input.linkPath,
          entryName: input.entryName,
          cause,
        });
      },
    }),
  );
});

const removePrivateSymlink = Effect.fn("CodexHomeLayout.removePrivateSymlink")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string;
  readonly entryName: string;
}): Effect.fn.Return<void, CodexShadowHomeError, Path.Path> {
  const path = yield* Path.Path;
  const privatePath = path.join(input.effectiveHomePath, input.entryName);
  const state = yield* readLinkState({
    ...input,
    linkPath: privatePath,
  });
  if (state._tag === "Symlink") {
    yield* input.fileSystem.remove(privatePath).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          new CodexShadowHomeFileSystemError({
            sharedHomePath: input.sharedHomePath,
            effectiveHomePath: input.effectiveHomePath,
            operation: "remove",
            path: privatePath,
            entryName: input.entryName,
            cause,
          }),
      }),
    );
  }
});

const ensureSymlink = Effect.fn("CodexHomeLayout.ensureSymlink")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string;
  readonly entryName: string;
  readonly replaceDetachedEntry: boolean;
}): Effect.fn.Return<
  void,
  CodexShadowHomeError,
  Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  const path = yield* Path.Path;
  const hostPlatform = yield* HostProcessPlatform;
  const target = path.join(input.sharedHomePath, input.entryName);
  const link = path.join(input.effectiveHomePath, input.entryName);
  const state = yield* readLinkState({
    ...input,
    linkPath: link,
  });

  const wrapFileSystemError = (operation: "stat" | "symlink" | "link", cause: unknown) =>
    new CodexShadowHomeFileSystemError({
      sharedHomePath: input.sharedHomePath,
      effectiveHomePath: input.effectiveHomePath,
      operation,
      path: link,
      targetPath: target,
      entryName: input.entryName,
      cause,
    });
  const createLink = Effect.gen(function* () {
    if (hostPlatform !== "win32") {
      return yield* input.fileSystem.symlink(target, link).pipe(
        Effect.catchTags({
          PlatformError: (cause) => wrapFileSystemError("symlink", cause),
        }),
      );
    }

    const targetInfo = yield* input.fileSystem.stat(target).pipe(
      Effect.catchTags({
        PlatformError: (cause) => wrapFileSystemError("stat", cause),
      }),
    );
    if (targetInfo.type !== "Directory") {
      return yield* input.fileSystem.link(target, link).pipe(
        Effect.catchTags({
          PlatformError: (cause) => wrapFileSystemError("link", cause),
        }),
      );
    }

    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const exitCode = yield* spawner
      .exitCode(ChildProcess.make("cmd.exe", ["/d", "/s", "/c", "mklink", "/J", link, target]))
      .pipe(
        Effect.catchTags({
          PlatformError: (cause) => wrapFileSystemError("link", cause),
        }),
      );
    if (Number(exitCode) !== 0) {
      return yield* wrapFileSystemError(
        "link",
        new Error(`mklink exited with code ${Number(exitCode)}`),
      );
    }
  });

  if (state._tag === "NotSymlink" && hostPlatform === "win32") {
    const [targetInfo, linkInfo] = yield* Effect.all([
      input.fileSystem.stat(target),
      input.fileSystem.stat(link),
    ]).pipe(
      Effect.catchTags({
        PlatformError: (cause) => wrapFileSystemError("stat", cause),
      }),
    );
    const targetInode = Option.getOrUndefined(targetInfo.ino);
    const isExpectedHardLink =
      targetInfo.type === "File" &&
      linkInfo.type === "File" &&
      targetInode !== undefined &&
      targetInfo.dev === linkInfo.dev &&
      targetInode === Option.getOrUndefined(linkInfo.ino);
    if (isExpectedHardLink) return;
  }

  if (state._tag === "NotSymlink") {
    if (
      !input.replaceDetachedEntry &&
      !REPLACEABLE_SHARED_RUNTIME_DIRECTORIES.has(input.entryName)
    ) {
      return yield* new CodexShadowHomeEntryConflictError({
        sharedHomePath: input.sharedHomePath,
        effectiveHomePath: input.effectiveHomePath,
        entryName: input.entryName,
        linkPath: link,
        targetPath: target,
      });
    }

    yield* input.fileSystem.remove(link, { recursive: true }).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          new CodexShadowHomeFileSystemError({
            sharedHomePath: input.sharedHomePath,
            effectiveHomePath: input.effectiveHomePath,
            operation: "remove",
            path: link,
            entryName: input.entryName,
            cause,
          }),
      }),
    );
    return yield* createLink;
  }

  if (state._tag === "Missing") {
    return yield* createLink;
  }

  const resolvedExisting = path.resolve(path.dirname(link), state.target);
  if (resolvedExisting !== target) {
    yield* input.fileSystem.remove(link).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          new CodexShadowHomeFileSystemError({
            sharedHomePath: input.sharedHomePath,
            effectiveHomePath: input.effectiveHomePath,
            operation: "remove",
            path: link,
            entryName: input.entryName,
            cause,
          }),
      }),
    );
    yield* createLink;
  }
});

const ensureShadowAuthIsPrivate = Effect.fn("CodexHomeLayout.ensureShadowAuthIsPrivate")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly sharedHomePath: string;
    readonly effectiveHomePath: string;
  }): Effect.fn.Return<void, CodexShadowHomeError, Path.Path> {
    const path = yield* Path.Path;
    const entryName = "auth.json";
    const authPath = path.join(input.effectiveHomePath, entryName);
    const state = yield* readLinkState({
      ...input,
      entryName,
      linkPath: authPath,
    });
    if (state._tag === "Symlink") {
      return yield* new CodexShadowHomePrivateEntrySymlinkError({
        sharedHomePath: input.sharedHomePath,
        effectiveHomePath: input.effectiveHomePath,
        entryName,
        path: authPath,
      });
    }
  },
);

export const materializeCodexShadowHome = Effect.fn("materializeCodexShadowHome")(function* (
  layout: CodexHomeLayout,
) {
  const effectiveHomePath = layout.effectiveHomePath;
  if (!effectiveHomePath) return;
  if (layout.mode === "authOverlay" && layout.sharedHomePath === effectiveHomePath) {
    return yield* new CodexShadowHomePathConflictError({
      sharedHomePath: layout.sharedHomePath,
      effectiveHomePath,
    });
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const makeDirectory = (directoryPath: string) =>
    fileSystem.makeDirectory(directoryPath, { recursive: true }).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          new CodexShadowHomeFileSystemError({
            sharedHomePath: layout.sharedHomePath,
            effectiveHomePath,
            operation: "makeDirectory",
            path: directoryPath,
            cause,
          }),
      }),
    );

  if (layout.mode === "direct") {
    yield* makeDirectory(effectiveHomePath);
    return;
  }

  yield* Effect.all(
    [
      makeDirectory(layout.sharedHomePath),
      makeDirectory(effectiveHomePath),
      ...KNOWN_SHARED_DIRECTORIES.map((directory) =>
        makeDirectory(path.join(layout.sharedHomePath, directory)),
      ),
    ],
    { concurrency: "unbounded" },
  );

  const sharedEntryNames = yield* fileSystem.readDirectory(layout.sharedHomePath).pipe(
    Effect.catchTags({
      PlatformError: (cause) =>
        new CodexShadowHomeFileSystemError({
          sharedHomePath: layout.sharedHomePath,
          effectiveHomePath,
          operation: "readDirectory",
          path: layout.sharedHomePath,
          cause,
        }),
    }),
  );
  const establishedOverlay = yield* fileSystem.exists(path.join(effectiveHomePath, "auth.json"));
  yield* materializePrivateSqliteDatabases({
    sharedHomePath: layout.sharedHomePath,
    effectiveHomePath,
    sharedEntryNames,
  });
  const entries = new Set<string>(KNOWN_SHARED_DIRECTORIES);
  for (const entryName of sharedEntryNames) {
    if (!PRIVATE_ENTRY_NAMES.has(entryName) && !isShadowLocalEntry(entryName)) {
      entries.add(entryName);
    }
  }

  yield* Effect.forEach(
    PRIVATE_ENTRY_NAMES,
    (entryName) =>
      entryName === "auth.json"
        ? Effect.void
        : removePrivateSymlink({
            fileSystem,
            sharedHomePath: layout.sharedHomePath,
            effectiveHomePath,
            entryName,
          }),
    { discard: true },
  );

  yield* Effect.forEach(
    entries,
    (entryName) => {
      if (PRIVATE_ENTRY_NAMES.has(entryName)) {
        return Effect.void;
      }
      return ensureSymlink({
        fileSystem,
        sharedHomePath: layout.sharedHomePath,
        effectiveHomePath,
        entryName,
        replaceDetachedEntry: establishedOverlay,
      });
    },
    { discard: true },
  );

  yield* ensureShadowAuthIsPrivate({
    fileSystem,
    sharedHomePath: layout.sharedHomePath,
    effectiveHomePath,
  });
});

export function codexContinuationIdentity(layout: CodexHomeLayout) {
  return {
    driverKind: ProviderDriverKind.make("codex"),
    continuationKey: layout.continuationKey,
  };
}
