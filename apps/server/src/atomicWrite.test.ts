import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { ThreadSyncError } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  type ExclusiveFileOwnership,
  removeFileIfOwned,
  writeFileBytesAtomically,
  writeFileBytesExclusivelyAtomically,
} from "./atomicWrite.ts";
import {
  confirmThreadSyncImportDispatch,
  withThreadSyncAttachmentRollback,
} from "./threadSync/ThreadSyncService.ts";

const platformLayer = Layer.merge(NodeFileSystem.layer, NodePath.layer);

describe("writeFileBytesAtomically", () => {
  it.effect("publishes complete bytes and can replace a prior complete target", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "atomic-bytes-",
        });
        const target = path.join(directory, "attachment.bin");
        const first = new Uint8Array([1, 2, 3, 4]);
        const second = new Uint8Array([9, 8, 7]);

        yield* writeFileBytesAtomically({ filePath: target, contents: first });
        expect(Array.from(yield* fileSystem.readFile(target))).toEqual(Array.from(first));

        yield* writeFileBytesAtomically({ filePath: target, contents: second });
        expect(Array.from(yield* fileSystem.readFile(target))).toEqual(Array.from(second));
        expect(
          (yield* fileSystem.readDirectory(directory)).filter(
            (entry) => entry !== "attachment.bin",
          ),
        ).toEqual([]);
      }),
    ).pipe(Effect.provide(platformLayer)),
  );

  it.effect("removes every newly published attachment when the import later fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "atomic-attachment-rollback-",
        });
        const first = path.join(directory, "first.bin");
        const second = path.join(directory, "second.bin");
        const ownedFiles: ExclusiveFileOwnership[] = [];

        const result = yield* Effect.result(
          withThreadSyncAttachmentRollback({
            ownedFiles,
            committed: () => false,
            remove: (ownership) =>
              removeFileIfOwned(ownership).pipe(
                Effect.asVoid,
                Effect.catch(() => Effect.void),
              ),
            effect: Effect.gen(function* () {
              const firstResult = yield* writeFileBytesExclusivelyAtomically({
                filePath: first,
                contents: new Uint8Array([1, 2, 3]),
              });
              if (firstResult.created) ownedFiles.push(firstResult.ownership);
              const secondResult = yield* writeFileBytesExclusivelyAtomically({
                filePath: second,
                contents: new Uint8Array([4, 5, 6]),
              });
              if (secondResult.created) ownedFiles.push(secondResult.ownership);
              return yield* new ThreadSyncError({
                operation: "import",
                code: "conflict",
                detail: "Intentional dispatch failure.",
              });
            }),
          }),
        );

        expect(result._tag).toBe("Failure");
        expect(yield* fileSystem.exists(first)).toBe(false);
        expect(yield* fileSystem.exists(second)).toBe(false);
      }),
    ).pipe(Effect.provide(platformLayer)),
  );

  it.effect("publishes one winner under concurrent exclusive creation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "atomic-attachment-race-",
        });
        const target = path.join(directory, "shared.bin");
        const first = new Uint8Array([1, 1, 1]);
        const second = new Uint8Array([2, 2, 2]);

        const results = yield* Effect.all(
          [
            writeFileBytesExclusivelyAtomically({ filePath: target, contents: first }),
            writeFileBytesExclusivelyAtomically({ filePath: target, contents: second }),
          ],
          { concurrency: "unbounded" },
        );

        expect(results.filter((result) => result.created)).toHaveLength(1);
        expect([Array.from(first), Array.from(second)]).toContainEqual(
          Array.from(yield* fileSystem.readFile(target)),
        );
      }),
    ).pipe(Effect.provide(platformLayer)),
  );

  it.effect("does not remove a destination replaced after this attempt published it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "atomic-attachment-ownership-",
        });
        const target = path.join(directory, "shared.bin");
        const publication = yield* writeFileBytesExclusivelyAtomically({
          filePath: target,
          contents: new Uint8Array([1, 2, 3]),
        });
        expect(publication.created).toBe(true);
        if (!publication.created) return;

        yield* fileSystem.remove(target);
        yield* fileSystem.writeFile(target, new Uint8Array([9, 8, 7]), { flag: "wx" });

        expect(yield* removeFileIfOwned(publication.ownership)).toBe(false);
        expect(Array.from(yield* fileSystem.readFile(target))).toEqual([9, 8, 7]);
      }),
    ).pipe(Effect.provide(platformLayer)),
  );

  it.effect("preserves committed attachments when interrupted after durable dispatch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "atomic-attachment-post-commit-",
        });
        const target = path.join(directory, "committed.bin");
        const publication = yield* writeFileBytesExclusivelyAtomically({
          filePath: target,
          contents: new Uint8Array([4, 5, 6]),
        });
        expect(publication.created).toBe(true);
        if (!publication.created) return;

        const ownedFiles = [publication.ownership];
        const dispatchPersisted = yield* Deferred.make<void>();
        const releaseDispatch = yield* Deferred.make<void>();
        let committed = false;
        let dispatchCalls = 0;
        const fiber = yield* withThreadSyncAttachmentRollback({
          ownedFiles,
          committed: () => committed,
          remove: (ownership) =>
            removeFileIfOwned(ownership).pipe(
              Effect.asVoid,
              Effect.catch(() => Effect.void),
            ),
          effect: Effect.uninterruptible(
            Effect.gen(function* () {
              const sequence = yield* confirmThreadSyncImportDispatch(() => {
                dispatchCalls += 1;
                return dispatchCalls === 1
                  ? Deferred.succeed(dispatchPersisted, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseDispatch)),
                      Effect.andThen(Effect.fail("ambiguous post-commit failure")),
                    )
                  : Effect.succeed(41);
              });
              committed = true;
              return sequence;
            }),
          ),
        }).pipe(Effect.forkScoped);

        yield* Deferred.await(dispatchPersisted);
        const interruption = yield* Fiber.interrupt(fiber).pipe(Effect.forkScoped);
        yield* Deferred.succeed(releaseDispatch, undefined);
        yield* Fiber.join(interruption);

        expect(yield* fileSystem.exists(target)).toBe(true);
        expect(Array.from(yield* fileSystem.readFile(target))).toEqual([4, 5, 6]);
        expect(dispatchCalls).toBe(2);
      }),
    ).pipe(Effect.provide(platformLayer)),
  );

  it.effect("rolls back owned attachments when interrupted before dispatch commits", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "atomic-attachment-pre-commit-",
        });
        const target = path.join(directory, "uncommitted.bin");
        const publication = yield* writeFileBytesExclusivelyAtomically({
          filePath: target,
          contents: new Uint8Array([7, 8, 9]),
        });
        expect(publication.created).toBe(true);
        if (!publication.created) return;

        const entered = yield* Deferred.make<void>();
        const fiber = yield* withThreadSyncAttachmentRollback({
          ownedFiles: [publication.ownership],
          committed: () => false,
          remove: (ownership) =>
            removeFileIfOwned(ownership).pipe(
              Effect.asVoid,
              Effect.catch(() => Effect.void),
            ),
          effect: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        }).pipe(Effect.forkScoped);

        yield* Deferred.await(entered);
        yield* Fiber.interrupt(fiber);

        expect(yield* fileSystem.exists(target)).toBe(false);
      }),
    ).pipe(Effect.provide(platformLayer)),
  );
});
