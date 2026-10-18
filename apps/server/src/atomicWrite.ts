import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";

export interface ExclusiveFileOwnership {
  readonly filePath: string;
  readonly device: number;
  readonly inode: number | null;
}

export type ExclusiveAtomicWriteResult =
  | { readonly created: false }
  | { readonly created: true; readonly ownership: ExclusiveFileOwnership };

const isAlreadyExists = (error: PlatformError.PlatformError): boolean =>
  error.reason._tag === "AlreadyExists";

export const writeFileStringAtomically = (input: {
  readonly filePath: string;
  readonly contents: string;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const targetDirectory = path.dirname(input.filePath);

      yield* fs.makeDirectory(targetDirectory, { recursive: true });
      const tempDirectory = yield* fs.makeTempDirectoryScoped({
        directory: targetDirectory,
        prefix: `${path.basename(input.filePath)}.`,
      });
      const tempPath = path.join(tempDirectory, "contents.tmp");

      yield* fs.writeFileString(tempPath, input.contents);
      yield* fs.rename(tempPath, input.filePath);
    }),
  );

export const writeFileBytesAtomically = (input: {
  readonly filePath: string;
  readonly contents: Uint8Array;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const targetDirectory = path.dirname(input.filePath);

      yield* fs.makeDirectory(targetDirectory, { recursive: true });
      const tempDirectory = yield* fs.makeTempDirectoryScoped({
        directory: targetDirectory,
        prefix: `${path.basename(input.filePath)}.`,
      });
      const tempPath = path.join(tempDirectory, "contents.tmp");

      yield* fs.writeFile(tempPath, input.contents);
      yield* fs.rename(tempPath, input.filePath);
    }),
  );

/**
 * Publishes a complete file without replacing an existing destination.
 *
 * The hard-link operation is the ownership boundary: it creates the final
 * directory entry atomically, or reports that another writer already owns it.
 */
export const writeFileBytesExclusivelyAtomically = (input: {
  readonly filePath: string;
  readonly contents: Uint8Array;
}): Effect.Effect<
  ExclusiveAtomicWriteResult,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const targetDirectory = path.dirname(input.filePath);

      yield* fs.makeDirectory(targetDirectory, { recursive: true });
      const tempDirectory = yield* fs.makeTempDirectoryScoped({
        directory: targetDirectory,
        prefix: `${path.basename(input.filePath)}.`,
      });
      const tempPath = path.join(tempDirectory, "contents.tmp");

      const file = yield* fs.open(tempPath, { flag: "wx" });
      yield* file.writeAll(input.contents);
      yield* file.sync;
      const sourceInfo = yield* file.stat;
      const created = yield* fs.link(tempPath, input.filePath).pipe(
        Effect.as(true),
        Effect.catchIf(isAlreadyExists, () => Effect.succeed(false)),
      );
      if (!created) return { created: false } as const;

      return {
        created: true,
        ownership: {
          filePath: input.filePath,
          device: sourceInfo.dev,
          inode: Option.getOrNull(sourceInfo.ino),
        },
      } as const;
    }),
  );

/**
 * Publishes a fully drained byte stream without exposing its temporary file.
 * The destination appears only after the producer reaches its verified end.
 */
export const writeFileStreamExclusivelyAtomically = <E, R>(input: {
  readonly filePath: string;
  readonly contents: Stream.Stream<Uint8Array, E, R>;
}): Effect.Effect<
  ExclusiveAtomicWriteResult,
  E | PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path | R
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const targetDirectory = path.dirname(input.filePath);

      yield* fs.makeDirectory(targetDirectory, { recursive: true });
      const tempDirectory = yield* fs.makeTempDirectoryScoped({
        directory: targetDirectory,
        prefix: `${path.basename(input.filePath)}.`,
      });
      const tempPath = path.join(tempDirectory, "contents.tmp");
      const file = yield* fs.open(tempPath, { flag: "wx" });
      yield* Stream.runForEach(input.contents, (chunk) => file.writeAll(chunk));
      yield* file.sync;
      const sourceInfo = yield* file.stat;
      const created = yield* fs.link(tempPath, input.filePath).pipe(
        Effect.as(true),
        Effect.catchIf(isAlreadyExists, () => Effect.succeed(false)),
      );
      if (!created) return { created: false } as const;

      return {
        created: true,
        ownership: {
          filePath: input.filePath,
          device: sourceInfo.dev,
          inode: Option.getOrNull(sourceInfo.ino),
        },
      } as const;
    }),
  );

/** Removes a published file only while it still names the inode we created. */
export const removeFileIfOwned = (
  ownership: ExclusiveFileOwnership,
): Effect.Effect<boolean, PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const current = yield* fs.stat(ownership.filePath).pipe(
      Effect.map(Option.some),
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed(Option.none()),
      ),
    );
    if (Option.isNone(current)) return false;
    const inode = Option.getOrNull(current.value.ino);
    if (
      current.value.type !== "File" ||
      ownership.inode === null ||
      inode === null ||
      current.value.dev !== ownership.device ||
      inode !== ownership.inode
    ) {
      return false;
    }
    yield* fs.remove(ownership.filePath);
    return true;
  });
