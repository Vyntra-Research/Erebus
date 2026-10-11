// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ThreadSyncProjectSnapshot,
  ThreadSyncThreadSnapshot,
  type ThreadSyncProjectId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import {
  THREAD_SYNC_BLOBS_DIRECTORY,
  THREAD_SYNC_PROJECTS_DIRECTORY,
  THREAD_SYNC_THREADS_DIRECTORY,
  canonicalThreadSyncJson,
  threadSyncDocumentFileName,
} from "./ThreadSyncDocuments.ts";
import { readThreadSyncRepository, writeThreadSyncRepository } from "./ThreadSyncRepository.ts";

const decodeProject = Schema.decodeUnknownSync(ThreadSyncProjectSnapshot);
const decodeThread = Schema.decodeUnknownSync(ThreadSyncThreadSnapshot);

const project = decodeProject({
  formatVersion: 1,
  syncProjectId: "sync-project",
  title: "Project",
  repositoryIdentity: null,
  repositoryRelativePath: null,
  createdAt: "2026-10-11T12:00:00.000Z",
  updatedAt: "2026-10-11T12:00:00.000Z",
  deletedAt: null,
});

function makeThread(blob: Uint8Array) {
  const blobHash = NodeCrypto.createHash("sha256").update(blob).digest("hex");
  return {
    blobHash,
    thread: decodeThread({
      formatVersion: 1,
      threadId: "sync-thread",
      syncProjectId: "sync-project",
      title: "Thread",
      coagent: null,
      latestTurn: null,
      turns: [],
      lifecycle: {
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        deletedAt: null,
      },
      createdAt: "2026-10-11T12:00:00.000Z",
      updatedAt: "2026-10-11T12:00:00.000Z",
      messages: [
        {
          id: "message-1",
          role: "user",
          text: "See the image.",
          attachments: [
            {
              type: "image",
              name: "image.png",
              mimeType: "image/png",
              sizeBytes: blob.byteLength,
              blobHash,
            },
          ],
          turnId: null,
          streaming: false,
          createdAt: "2026-10-11T12:00:00.000Z",
          updatedAt: "2026-10-11T12:00:00.000Z",
        },
      ],
      proposedPlans: [],
      activities: [],
    }),
  };
}

describe("ThreadSyncRepository", () => {
  it.effect("round-trips validated documents and content-addressed blobs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const mirrorPath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "thread-sync-repo-",
        });
        const blob = new Uint8Array([1, 2, 3, 4]);
        const { blobHash, thread } = makeThread(blob);
        yield* writeThreadSyncRepository({
          mirrorPath,
          projects: new Map([[project.syncProjectId, project]]),
          threads: new Map([[thread.threadId, thread]]),
          blobs: new Map([[blobHash, blob]]),
          updatedAt: "2026-10-11T12:00:00.000Z",
        });

        const restored = yield* readThreadSyncRepository(mirrorPath);
        expect(restored.projects.get(project.syncProjectId)).toEqual(project);
        expect(restored.threads.get(thread.threadId)).toEqual(thread);
        expect([...restored.blobs.get(blobHash)!]).toEqual([...blob]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a corrupted attachment before returning any documents", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const mirrorPath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "thread-sync-repo-",
        });
        const blob = new Uint8Array([1, 2, 3, 4]);
        const { blobHash, thread } = makeThread(blob);
        yield* writeThreadSyncRepository({
          mirrorPath,
          projects: new Map([[project.syncProjectId, project]]),
          threads: new Map([[thread.threadId, thread]]),
          blobs: new Map([[blobHash, blob]]),
          updatedAt: "2026-10-11T12:00:00.000Z",
        });
        yield* fileSystem.writeFile(
          path.join(mirrorPath, THREAD_SYNC_BLOBS_DIRECTORY, `${blobHash}.blob`),
          new Uint8Array([9, 9, 9, 9]),
        );

        const error = yield* Effect.flip(readThreadSyncRepository(mirrorPath));
        expect(error.code).toBe("integrity-failed");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a corrupted existing blob instead of reusing it on write", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const mirrorPath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "thread-sync-repo-",
        });
        const blob = new Uint8Array([1, 2, 3, 4]);
        const corrupted = new Uint8Array([9, 9, 9, 9]);
        const { blobHash, thread } = makeThread(blob);
        const blobPath = path.join(mirrorPath, THREAD_SYNC_BLOBS_DIRECTORY, `${blobHash}.blob`);
        yield* writeThreadSyncRepository({
          mirrorPath,
          projects: new Map([[project.syncProjectId, project]]),
          threads: new Map([[thread.threadId, thread]]),
          blobs: new Map([[blobHash, blob]]),
          updatedAt: "2026-10-11T12:00:00.000Z",
        });
        yield* fileSystem.writeFile(blobPath, corrupted);

        const error = yield* Effect.flip(
          writeThreadSyncRepository({
            mirrorPath,
            projects: new Map([[project.syncProjectId, project]]),
            threads: new Map([[thread.threadId, thread]]),
            blobs: new Map([[blobHash, blob]]),
            updatedAt: "2026-10-11T12:01:00.000Z",
          }),
        );

        expect(error.code).toBe("integrity-failed");
        expect(error.detail).toContain("SHA-256");
        expect([...(yield* fileSystem.readFile(blobPath))]).toEqual([...corrupted]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a redirected existing blob on write", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const hostPlatform = yield* HostProcessPlatform;
        const mirrorPath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "thread-sync-repo-",
        });
        const blob = new Uint8Array([1, 2, 3, 4]);
        const { blobHash, thread } = makeThread(blob);
        const blobPath = path.join(mirrorPath, THREAD_SYNC_BLOBS_DIRECTORY, `${blobHash}.blob`);
        yield* writeThreadSyncRepository({
          mirrorPath,
          projects: new Map([[project.syncProjectId, project]]),
          threads: new Map([[thread.threadId, thread]]),
          blobs: new Map([[blobHash, blob]]),
          updatedAt: "2026-10-11T12:00:00.000Z",
        });
        const redirectedPath = path.join(mirrorPath, "redirected-blob");
        const sentinelPath = path.join(redirectedPath, "sentinel.txt");
        yield* fileSystem.remove(blobPath);
        yield* fileSystem.makeDirectory(redirectedPath);
        yield* fileSystem.writeFileString(sentinelPath, "preserve\n");
        NodeFS.symlinkSync(redirectedPath, blobPath, hostPlatform === "win32" ? "junction" : "dir");

        const error = yield* Effect.flip(
          writeThreadSyncRepository({
            mirrorPath,
            projects: new Map([[project.syncProjectId, project]]),
            threads: new Map([[thread.threadId, thread]]),
            blobs: new Map([[blobHash, blob]]),
            updatedAt: "2026-10-11T12:01:00.000Z",
          }),
        );

        expect(error.code).toBe("integrity-failed");
        expect(yield* fileSystem.readFileString(sentinelPath)).toBe("preserve\n");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a broken blob link without creating its external target", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const hostPlatform = yield* HostProcessPlatform;
        const mirrorPath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "thread-sync-repo-",
        });
        const outsidePath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "thread-sync-outside-",
        });
        const blob = new Uint8Array([1, 2, 3, 4]);
        const { blobHash, thread } = makeThread(blob);
        const blobPath = path.join(mirrorPath, THREAD_SYNC_BLOBS_DIRECTORY, `${blobHash}.blob`);
        const externalTarget = path.join(
          outsidePath,
          hostPlatform === "win32" ? "missing-directory" : "missing.blob",
        );
        yield* writeThreadSyncRepository({
          mirrorPath,
          projects: new Map([[project.syncProjectId, project]]),
          threads: new Map([[thread.threadId, thread]]),
          blobs: new Map([[blobHash, blob]]),
          updatedAt: "2026-10-11T12:00:00.000Z",
        });
        yield* fileSystem.remove(blobPath);
        if (hostPlatform === "win32") {
          yield* fileSystem.makeDirectory(externalTarget);
        }
        NodeFS.symlinkSync(
          externalTarget,
          blobPath,
          hostPlatform === "win32" ? "junction" : "file",
        );
        if (hostPlatform === "win32") {
          yield* fileSystem.remove(externalTarget, { recursive: true });
        }

        const error = yield* Effect.flip(
          writeThreadSyncRepository({
            mirrorPath,
            projects: new Map([[project.syncProjectId, project]]),
            threads: new Map([[thread.threadId, thread]]),
            blobs: new Map([[blobHash, blob]]),
            updatedAt: "2026-10-11T12:01:00.000Z",
          }),
        );

        expect(error.code).toBe("integrity-failed");
        expect(error.detail).toContain("symbolic link or junction");
        expect(NodeFS.existsSync(externalTarget)).toBe(false);
        expect(NodeFS.lstatSync(blobPath).isSymbolicLink()).toBe(true);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a document whose opaque file name does not match its id", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const mirrorPath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "thread-sync-repo-",
        });
        yield* writeThreadSyncRepository({
          mirrorPath,
          projects: new Map([[project.syncProjectId, project]]),
          threads: new Map(),
          blobs: new Map(),
          updatedAt: "2026-10-11T12:00:00.000Z",
        });
        const source = path.join(
          mirrorPath,
          THREAD_SYNC_PROJECTS_DIRECTORY,
          threadSyncDocumentFileName(project.syncProjectId),
        );
        const wrongId = "different-project" as ThreadSyncProjectId;
        yield* fileSystem.rename(
          source,
          path.join(
            mirrorPath,
            THREAD_SYNC_PROJECTS_DIRECTORY,
            threadSyncDocumentFileName(wrongId),
          ),
        );

        const error = yield* Effect.flip(readThreadSyncRepository(mirrorPath));
        expect(error.code).toBe("integrity-failed");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects semantically inconsistent remote thread snapshots", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const mirrorPath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "thread-sync-repo-",
        });
        const blob = new Uint8Array([1, 2, 3, 4]);
        const { blobHash, thread } = makeThread(blob);
        const validTurn = {
          turnId: "turn-1",
          pendingMessageId: "message-1",
          sourceProposedPlanThreadId: null,
          sourceProposedPlanId: null,
          state: "completed" as const,
          requestedAt: "2026-10-11T12:00:00.000Z",
          startedAt: "2026-10-11T12:00:01.000Z",
          completedAt: "2026-10-11T12:00:02.000Z",
          assistantMessageId: null,
        };
        const withTurn = decodeThread({
          ...thread,
          latestTurn: validTurn,
          turns: [validTurn],
          messages: thread.messages.map((message) => ({ ...message, turnId: "turn-1" })),
        });
        const cases = [
          {
            expected: "duplicate message",
            snapshot: decodeThread({
              ...thread,
              messages: [...thread.messages, thread.messages[0]],
            }),
          },
          {
            expected: "inconsistent latest turn",
            snapshot: decodeThread({ ...thread, latestTurn: validTurn }),
          },
          {
            expected: "missing pending message",
            snapshot: decodeThread({
              ...withTurn,
              latestTurn: null,
              turns: [{ ...validTurn, pendingMessageId: "missing-message" }],
            }),
          },
          {
            expected: "missing assistant message",
            snapshot: decodeThread({
              ...withTurn,
              latestTurn: null,
              turns: [{ ...validTurn, assistantMessageId: "missing-message" }],
            }),
          },
          {
            expected: "incomplete source plan",
            snapshot: decodeThread({
              ...withTurn,
              latestTurn: null,
              turns: [{ ...validTurn, sourceProposedPlanId: "missing-plan" }],
            }),
          },
          {
            expected: "missing source plan",
            snapshot: decodeThread({
              ...withTurn,
              latestTurn: null,
              turns: [
                {
                  ...validTurn,
                  sourceProposedPlanThreadId: thread.threadId,
                  sourceProposedPlanId: "missing-plan",
                },
              ],
            }),
          },
          {
            expected: "Message message-1",
            snapshot: decodeThread({
              ...thread,
              messages: thread.messages.map((message) => ({ ...message, turnId: "missing-turn" })),
            }),
          },
          {
            expected: "Proposed plan plan-1",
            snapshot: decodeThread({
              ...thread,
              proposedPlans: [
                {
                  id: "plan-1",
                  turnId: "missing-turn",
                  planMarkdown: "Plan",
                  implementedAt: null,
                  implementationThreadId: null,
                  createdAt: "2026-10-11T12:00:00.000Z",
                  updatedAt: "2026-10-11T12:00:00.000Z",
                },
              ],
            }),
          },
          {
            expected: "Activity activity-1",
            snapshot: decodeThread({
              ...thread,
              activities: [
                {
                  id: "activity-1",
                  tone: "info",
                  kind: "tool.completed",
                  summary: "Completed",
                  turnId: "missing-turn",
                  sequence: null,
                  createdAt: "2026-10-11T12:00:00.000Z",
                },
              ],
            }),
          },
          {
            expected: "missing implementation thread",
            snapshot: decodeThread({
              ...thread,
              proposedPlans: [
                {
                  id: "plan-1",
                  turnId: null,
                  planMarkdown: "Plan",
                  implementedAt: "2026-10-11T12:00:00.000Z",
                  implementationThreadId: "missing-thread",
                  createdAt: "2026-10-11T12:00:00.000Z",
                  updatedAt: "2026-10-11T12:00:00.000Z",
                },
              ],
            }),
          },
          {
            expected: "invalid co-agent parent",
            snapshot: decodeThread({
              ...thread,
              coagent: {
                parentThreadId: "missing-thread",
                creationMode: "fork",
                status: "ready",
              },
            }),
          },
        ];

        for (const testCase of cases) {
          yield* writeThreadSyncRepository({
            mirrorPath,
            projects: new Map([[project.syncProjectId, project]]),
            threads: new Map([[thread.threadId, thread]]),
            blobs: new Map([[blobHash, blob]]),
            updatedAt: "2026-10-11T12:00:00.000Z",
          });
          yield* fileSystem.writeFileString(
            path.join(
              mirrorPath,
              THREAD_SYNC_THREADS_DIRECTORY,
              threadSyncDocumentFileName(thread.threadId),
            ),
            canonicalThreadSyncJson(testCase.snapshot),
          );

          const error = yield* Effect.flip(readThreadSyncRepository(mirrorPath));
          expect(error.code).toBe("integrity-failed");
          expect(error.detail).toContain(testCase.expected);
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("removes stale managed documents and blobs without touching repository files", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const mirrorPath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "thread-sync-repo-",
        });
        const blob = new Uint8Array([1, 2, 3, 4]);
        const { blobHash, thread } = makeThread(blob);
        yield* fileSystem.writeFileString(path.join(mirrorPath, "preserve.txt"), "keep me\n");
        yield* writeThreadSyncRepository({
          mirrorPath,
          projects: new Map([[project.syncProjectId, project]]),
          threads: new Map([[thread.threadId, thread]]),
          blobs: new Map([[blobHash, blob]]),
          updatedAt: "2026-10-11T12:00:00.000Z",
        });

        yield* writeThreadSyncRepository({
          mirrorPath,
          projects: new Map(),
          threads: new Map(),
          // Supplying a formerly referenced blob must not keep it alive.
          blobs: new Map([[blobHash, blob]]),
          updatedAt: "2026-10-11T12:01:00.000Z",
        });

        expect(
          yield* fileSystem.exists(
            path.join(
              mirrorPath,
              THREAD_SYNC_PROJECTS_DIRECTORY,
              threadSyncDocumentFileName(project.syncProjectId),
            ),
          ),
        ).toBe(false);
        expect(
          yield* fileSystem.exists(
            path.join(
              mirrorPath,
              THREAD_SYNC_THREADS_DIRECTORY,
              threadSyncDocumentFileName(thread.threadId),
            ),
          ),
        ).toBe(false);
        expect(
          yield* fileSystem.exists(
            path.join(mirrorPath, THREAD_SYNC_BLOBS_DIRECTORY, `${blobHash}.blob`),
          ),
        ).toBe(false);
        expect(yield* fileSystem.readFileString(path.join(mirrorPath, "preserve.txt"))).toBe(
          "keep me\n",
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects unexpected files in managed blob storage", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const mirrorPath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "thread-sync-repo-",
        });
        yield* writeThreadSyncRepository({
          mirrorPath,
          projects: new Map([[project.syncProjectId, project]]),
          threads: new Map(),
          blobs: new Map(),
          updatedAt: "2026-10-11T12:00:00.000Z",
        });
        yield* fileSystem.writeFileString(
          path.join(mirrorPath, THREAD_SYNC_BLOBS_DIRECTORY, "unexpected.txt"),
          "not a blob",
        );

        const error = yield* Effect.flip(readThreadSyncRepository(mirrorPath));
        expect(error.code).toBe("integrity-failed");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects an oversized declared blob before reading it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const mirrorPath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "thread-sync-repo-",
        });
        const blob = new Uint8Array([1, 2, 3, 4]);
        const { blobHash, thread } = makeThread(blob);
        yield* writeThreadSyncRepository({
          mirrorPath,
          projects: new Map([[project.syncProjectId, project]]),
          threads: new Map([[thread.threadId, thread]]),
          blobs: new Map([[blobHash, blob]]),
          updatedAt: "2026-10-11T12:00:00.000Z",
        });
        const hostile = decodeThread({
          ...thread,
          messages: thread.messages.map((message) => ({
            ...message,
            attachments: message.attachments.map((attachment) => ({
              ...attachment,
              sizeBytes: 64 * 1024 * 1024 + 1,
            })),
          })),
        });
        yield* fileSystem.writeFileString(
          path.join(
            mirrorPath,
            THREAD_SYNC_THREADS_DIRECTORY,
            threadSyncDocumentFileName(hostile.threadId),
          ),
          canonicalThreadSyncJson(hostile),
        );

        const error = yield* Effect.flip(readThreadSyncRepository(mirrorPath));
        expect(error.code).toBe("integrity-failed");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects excessive cumulative blob size before reading files", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const mirrorPath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "thread-sync-repo-",
        });
        const blob = new Uint8Array([1, 2, 3, 4]);
        const { thread } = makeThread(blob);
        yield* writeThreadSyncRepository({
          mirrorPath,
          projects: new Map([[project.syncProjectId, project]]),
          threads: new Map(),
          blobs: new Map(),
          updatedAt: "2026-10-11T12:00:00.000Z",
        });
        const hostile = decodeThread({
          ...thread,
          messages: thread.messages.map((message) => ({
            ...message,
            attachments: Array.from({ length: 9 }, (_, index) => ({
              type: "image",
              name: `image-${String(index)}.png`,
              mimeType: "image/png",
              sizeBytes: 64 * 1024 * 1024,
              blobHash: (index + 1).toString(16).padStart(64, "0"),
            })),
          })),
        });
        yield* fileSystem.writeFileString(
          path.join(
            mirrorPath,
            THREAD_SYNC_THREADS_DIRECTORY,
            threadSyncDocumentFileName(hostile.threadId),
          ),
          canonicalThreadSyncJson(hostile),
        );

        const error = yield* Effect.flip(readThreadSyncRepository(mirrorPath));
        expect(error.code).toBe("integrity-failed");
        expect(error.detail).toContain("total attachment size");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects incomplete or mismatched write sets", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const mirrorPath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "thread-sync-repo-",
        });
        const blob = new Uint8Array([1, 2, 3, 4]);
        const { thread } = makeThread(blob);
        const missingBlob = yield* Effect.flip(
          writeThreadSyncRepository({
            mirrorPath,
            projects: new Map([[project.syncProjectId, project]]),
            threads: new Map([[thread.threadId, thread]]),
            blobs: new Map(),
            updatedAt: "2026-10-11T12:00:00.000Z",
          }),
        );
        expect(missingBlob.code).toBe("integrity-failed");

        const wrongKey = yield* Effect.flip(
          writeThreadSyncRepository({
            mirrorPath,
            projects: new Map([["wrong-project" as ThreadSyncProjectId, project]]),
            threads: new Map(),
            blobs: new Map(),
            updatedAt: "2026-10-11T12:00:00.000Z",
          }),
        );
        expect(wrongKey.code).toBe("integrity-failed");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a namespace directory redirected inside the mirror", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const hostPlatform = yield* HostProcessPlatform;
        const mirrorPath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "thread-sync-repo-",
        });
        yield* writeThreadSyncRepository({
          mirrorPath,
          projects: new Map([[project.syncProjectId, project]]),
          threads: new Map(),
          blobs: new Map(),
          updatedAt: "2026-10-11T12:00:00.000Z",
        });
        const outsidePath = path.join(mirrorPath, "outside-namespace");
        const sentinelPath = path.join(outsidePath, "sentinel.txt");
        const threadsPath = path.join(mirrorPath, THREAD_SYNC_THREADS_DIRECTORY);
        yield* fileSystem.makeDirectory(outsidePath);
        yield* fileSystem.writeFileString(sentinelPath, "preserve\n");
        yield* fileSystem.remove(threadsPath, { recursive: true });
        NodeFS.symlinkSync(outsidePath, threadsPath, hostPlatform === "win32" ? "junction" : "dir");
        const blob = new Uint8Array([1, 2, 3, 4]);
        const { blobHash, thread } = makeThread(blob);

        const error = yield* Effect.flip(
          writeThreadSyncRepository({
            mirrorPath,
            projects: new Map([[project.syncProjectId, project]]),
            threads: new Map([[thread.threadId, thread]]),
            blobs: new Map([[blobHash, blob]]),
            updatedAt: "2026-10-11T12:01:00.000Z",
          }),
        );
        expect(error.code).toBe("integrity-failed");
        expect(yield* fileSystem.readFileString(sentinelPath)).toBe("preserve\n");
        expect(
          yield* fileSystem.exists(
            path.join(outsidePath, threadSyncDocumentFileName(thread.threadId)),
          ),
        ).toBe(false);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
