// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ThreadSyncProjectSnapshot,
  ThreadSyncThreadSnapshot,
  type ThreadSyncProjectId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  THREAD_SYNC_V2_BLOBS_DIRECTORY,
  THREAD_SYNC_V2_CHUNKS_DIRECTORY,
  THREAD_SYNC_V2_WORK_DIRECTORY,
  ThreadSyncV2Record,
  ThreadSyncV2ThreadHeader,
  describeThreadSyncV2Text,
  readThreadSyncV2Blob,
  readThreadSyncV2RepositoryIndex,
  readThreadSyncV2Thread,
  threadSyncV2ThreadDirectory,
  threadSyncV2Sha256,
  threadSyncV2SourceFromV1Snapshot,
  threadSyncV2TextFragments,
  type ThreadSyncV2Record as ThreadSyncV2RecordType,
  type ThreadSyncV2RepositorySource,
  type ThreadSyncV2ThreadSource,
  writeThreadSyncV2Repository,
  writeThreadSyncV2Blob,
  writeThreadSyncV2Thread,
} from "./ThreadSyncRepositoryV2.ts";

const decodeProject = Schema.decodeUnknownSync(ThreadSyncProjectSnapshot);
const decodeV1Thread = Schema.decodeUnknownSync(ThreadSyncThreadSnapshot);
const decodeHeader = Schema.decodeUnknownSync(ThreadSyncV2ThreadHeader);
const decodeRecord = Schema.decodeUnknownSync(ThreadSyncV2Record);

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

const header = decodeHeader({
  formatVersion: 2,
  threadId: "sync-thread",
  syncProjectId: "sync-project",
  title: "Thread",
  coagent: null,
  latestTurnId: null,
  lifecycle: {
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
  },
  createdAt: "2026-10-11T12:00:00.000Z",
  updatedAt: "2026-10-11T12:00:00.000Z",
});

function sourceFromRecords(
  records: ReadonlyArray<ThreadSyncV2RecordType>,
  sourceKey = "projection:sync-thread:1",
  sourceHeader = header,
): ThreadSyncV2ThreadSource {
  return {
    sourceKey,
    header: sourceHeader,
    records: (resumeToken) => {
      const offset = resumeToken === null ? 0 : Number(resumeToken);
      return Stream.fromIterable(
        records.slice(offset).map((record, index) => ({
          record,
          nextResumeToken: String(offset + index + 1),
        })),
      );
    },
  };
}

function fragmentedRecords(attachment?: {
  readonly blobHash: string;
  readonly sizeBytes: number;
}): ReadonlyArray<ThreadSyncV2RecordType> {
  const messageText = "message🙂".repeat(80_000);
  const planMarkdown = "plan🙂".repeat(90_000);
  const activitySummary = "activity🙂".repeat(70_000);
  const records: ThreadSyncV2RecordType[] = [];
  const append = (value: unknown) => records.push(decodeRecord(value));

  append({
    ordinal: records.length,
    kind: "message",
    value: {
      id: "message-1",
      role: "assistant",
      text: describeThreadSyncV2Text(messageText),
      attachments:
        attachment === undefined
          ? []
          : [
              {
                type: "image",
                name: "fixture.png",
                mimeType: "image/png",
                sizeBytes: attachment.sizeBytes,
                blobHash: attachment.blobHash,
              },
            ],
      turnId: null,
      streaming: false,
      createdAt: "2026-10-11T12:00:01.000Z",
      updatedAt: "2026-10-11T12:00:01.000Z",
    },
  });
  for (const [fragmentIndex, text] of [...threadSyncV2TextFragments(messageText)].entries()) {
    append({
      ordinal: records.length,
      kind: "message-text",
      messageId: "message-1",
      fragmentIndex,
      text,
    });
  }

  append({
    ordinal: records.length,
    kind: "plan",
    value: {
      id: "plan-1",
      turnId: null,
      planMarkdown: describeThreadSyncV2Text(planMarkdown),
      implementedAt: null,
      implementationThreadId: null,
      createdAt: "2026-10-11T12:00:02.000Z",
      updatedAt: "2026-10-11T12:00:02.000Z",
    },
  });
  for (const [fragmentIndex, text] of [...threadSyncV2TextFragments(planMarkdown)].entries()) {
    append({
      ordinal: records.length,
      kind: "plan-markdown",
      planId: "plan-1",
      fragmentIndex,
      text,
    });
  }

  append({
    ordinal: records.length,
    kind: "activity",
    value: {
      id: "activity-1",
      tone: "info",
      kind: "generic." + "x".repeat(600_000),
      summary: describeThreadSyncV2Text(activitySummary),
      turnId: null,
      sequence: 1,
      createdAt: "2026-10-11T12:00:03.000Z",
    },
  });
  for (const [fragmentIndex, text] of [...threadSyncV2TextFragments(activitySummary)].entries()) {
    append({
      ordinal: records.length,
      kind: "activity-summary",
      activityId: "activity-1",
      fragmentIndex,
      text,
    });
  }
  return records;
}

describe("ThreadSyncRepositoryV2", () => {
  it.effect("collects obsolete sparse chunks while preserving retained remote-only chunks", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const mirrorPath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "thread-sync-v2-chunk-gc-",
        });
        const retainedHeader = decodeHeader({
          ...header,
          threadId: "sync-thread-retained",
          title: "Retained thread",
        });
        const record = (id: string) =>
          decodeRecord({
            ordinal: 0,
            kind: "message",
            value: {
              id,
              role: "assistant",
              text: describeThreadSyncV2Text(id),
              attachments: [],
              turnId: null,
              streaming: false,
              createdAt: "2026-10-11T12:00:01.000Z",
              updatedAt: "2026-10-11T12:00:01.000Z",
            },
          });
        const projects = new Map<ThreadSyncProjectId, typeof project>([
          [project.syncProjectId, project],
        ]);
        const first = yield* writeThreadSyncV2Repository({
          mirrorPath,
          source: {
            projects,
            threads: [
              sourceFromRecords([record("old")], "projection:old"),
              sourceFromRecords([record("retained")], "projection:retained", retainedHeader),
            ],
            blobs: [],
            updatedAt: "2026-10-11T12:00:02.000Z",
          },
          targetChunkBytes: 1,
        });
        const oldEntry = first.manifest.threads.find(
          (entry) => entry.threadId === header.threadId,
        )!;
        const retainedEntry = first.manifest.threads.find(
          (entry) => entry.threadId === retainedHeader.threadId,
        )!;
        const oldChunkNames = first.threadResults
          .get(header.threadId)!
          .manifest.chunks.map((chunk) => chunk.fileName);
        const retainedChunkNames = first.threadResults
          .get(retainedHeader.threadId)!
          .manifest.chunks.map((chunk) => chunk.fileName);
        for (const fileName of [...oldChunkNames, ...retainedChunkNames]) {
          NodeFS.unlinkSync(NodePath.join(mirrorPath, THREAD_SYNC_V2_CHUNKS_DIRECTORY, fileName));
        }

        const next = yield* writeThreadSyncV2Repository({
          mirrorPath,
          source: {
            projects,
            threads: [sourceFromRecords([record("new")], "projection:new")],
            blobs: [],
            retainedThreads: [retainedEntry],
            previousThreads: [oldEntry, retainedEntry],
            updatedAt: "2026-10-11T12:00:03.000Z",
          },
          targetChunkBytes: 1,
        });

        expect(next.removedPayloadPaths).toEqual(
          oldChunkNames
            .map((fileName) => `${THREAD_SYNC_V2_CHUNKS_DIRECTORY}/${fileName}`)
            .toSorted(),
        );
        for (const fileName of retainedChunkNames) {
          expect(next.removedPayloadPaths).not.toContain(
            `${THREAD_SYNC_V2_CHUNKS_DIRECTORY}/${fileName}`,
          );
          expect(
            NodeFS.existsSync(NodePath.join(mirrorPath, THREAD_SYNC_V2_CHUNKS_DIRECTORY, fileName)),
          ).toBe(false);
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("adapts a v1 thread to resumable v2 records without repository hydration", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const snapshot = decodeV1Thread({
          formatVersion: 1,
          threadId: "sync-thread",
          syncProjectId: "sync-project",
          title: "Migrated thread",
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
          updatedAt: "2026-10-11T12:00:02.000Z",
          messages: [
            {
              id: "message-v1",
              role: "assistant",
              text: "legacy🙂".repeat(40_000),
              attachments: [],
              turnId: null,
              streaming: false,
              createdAt: "2026-10-11T12:00:01.000Z",
              updatedAt: "2026-10-11T12:00:01.000Z",
            },
          ],
          proposedPlans: [],
          activities: [],
        });
        const source = threadSyncV2SourceFromV1Snapshot(snapshot);
        const records = Array.from(yield* Stream.runCollect(source.records(null)));
        expect(records.map((entry) => entry.record.ordinal)).toEqual(
          records.map((_, index) => index),
        );
        expect(
          records
            .filter((entry) => entry.record.kind === "message-text")
            .map((entry) => (entry.record.kind === "message-text" ? entry.record.text : ""))
            .join(""),
        ).toBe(snapshot.messages[0]!.text);

        const resumed = Array.from(yield* Stream.runCollect(source.records("1")));
        expect(resumed).toEqual(records.slice(1));
        expect((yield* Effect.result(Stream.runDrain(source.records("not-an-ordinal"))))._tag).toBe(
          "Failure",
        );

        const fileSystem = yield* FileSystem.FileSystem;
        const mirrorPath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "thread-sync-v1-upgrade-",
        });
        yield* writeThreadSyncV2Repository({
          mirrorPath,
          source: {
            projects: new Map([[project.syncProjectId, project]]),
            threads: [source],
            blobs: [],
            updatedAt: "2026-10-11T12:00:03.000Z",
          },
        });
        const index = yield* readThreadSyncV2RepositoryIndex(mirrorPath);
        const reader = yield* readThreadSyncV2Thread({
          mirrorPath,
          entry: index!.threads.get(snapshot.threadId)!,
        });
        expect(Array.from(yield* Stream.runCollect(reader.records))).toEqual(
          records.map((entry) => entry.record),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("round-trips bounded fragments, reuses chunks, and detects body tampering", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const mirrorPath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "thread-sync-v2-",
        });
        const blob = new Uint8Array([1, 2, 3, 4, 5]);
        const blobHash = threadSyncV2Sha256(blob);
        const records = fragmentedRecords({ blobHash, sizeBytes: blob.byteLength });
        const source = {
          projects: new Map<ThreadSyncProjectId, typeof project>([
            [project.syncProjectId, project],
          ]),
          threads: [sourceFromRecords(records)],
          blobs: [
            {
              sha256: blobHash,
              sizeBytes: blob.byteLength,
              bytes: (offset: number) => Stream.make(blob.slice(offset)),
            },
          ],
          updatedAt: "2026-10-11T12:00:04.000Z",
        };

        const first = yield* writeThreadSyncV2Repository({
          mirrorPath,
          source,
          targetChunkBytes: 70_000,
        });
        const firstChunks = first.threadResults
          .get(header.threadId)!
          .manifest.chunks.map((chunk) => chunk.fileName);
        expect(first.threadResults.get(header.threadId)!.manifest.rowCount).toBeGreaterThan(
          records.length,
        );

        const second = yield* writeThreadSyncV2Repository({
          mirrorPath,
          source,
          targetChunkBytes: 70_000,
        });
        expect(
          second.threadResults.get(header.threadId)!.manifest.chunks.map((chunk) => chunk.fileName),
        ).toEqual(firstChunks);
        expect(second.threadResults.get(header.threadId)!.resumedAtOrdinal).toBe(records.length);

        const index = yield* readThreadSyncV2RepositoryIndex(mirrorPath);
        expect(index).not.toBeNull();
        expect(index!.threadManifests.get(header.threadId)?.header).toEqual(header);
        const entry = index!.threads.get(header.threadId)!;
        const reader = yield* readThreadSyncV2Thread({ mirrorPath, entry });
        const restored = Array.from(yield* Stream.runCollect(reader.records));
        expect(restored).toEqual(records);
        const resumeOrdinal = Math.floor(records.length / 2);
        const resumedRecords = Array.from(
          yield* Stream.runCollect(reader.recordsFromOrdinal(resumeOrdinal)),
        );
        expect(resumedRecords).toEqual(records.slice(resumeOrdinal));
        expect(
          Array.from(yield* Stream.runCollect(reader.recordsFromOrdinal(records.length))),
        ).toEqual([]);
        expect(
          (yield* Effect.result(Stream.runCollect(reader.recordsFromOrdinal(records.length + 1))))
            ._tag,
        ).toBe("Failure");

        const blobReader = yield* readThreadSyncV2Blob({
          mirrorPath,
          entry: index!.blobs.get(blobHash)!,
        });
        const restoredBlob = Array.from(yield* Stream.runCollect(blobReader.bytes)).flatMap(
          (bytes) => [...bytes],
        );
        expect(restoredBlob).toEqual([...blob]);

        NodeFS.appendFileSync(
          NodePath.join(mirrorPath, THREAD_SYNC_V2_CHUNKS_DIRECTORY, firstChunks[0]!),
          "tampered\n",
        );
        expect(yield* readThreadSyncV2RepositoryIndex(mirrorPath)).not.toBeNull();
        const tamperedReader = yield* readThreadSyncV2Thread({ mirrorPath, entry });
        expect((yield* Effect.result(Stream.runHead(tamperedReader.records)))._tag).toBe("Failure");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("resumes a failed thread export from its last complete record", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const mirrorPath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "thread-sync-v2-resume-",
        });
        const records = Array.from({ length: 5 }, (_, ordinal) =>
          decodeRecord({
            ordinal,
            kind: "turn",
            value: {
              turnId: `turn-${ordinal}`,
              pendingMessageId: null,
              sourceProposedPlanThreadId: null,
              sourceProposedPlanId: null,
              state: "completed",
              requestedAt: "2026-10-11T12:00:00.000Z",
              startedAt: "2026-10-11T12:00:00.000Z",
              completedAt: "2026-10-11T12:00:01.000Z",
              assistantMessageId: null,
            },
          }),
        );
        const interrupted: ThreadSyncV2ThreadSource<string> = {
          sourceKey: "projection:sync-thread:resume",
          header,
          records: (resumeToken) => {
            const offset = resumeToken === null ? 0 : Number(resumeToken);
            const remaining = Stream.fromIterable(
              records.slice(offset).map((record, index) => ({
                record,
                nextResumeToken: String(offset + index + 1),
              })),
            );
            return resumeToken === null
              ? Stream.concat(Stream.take(remaining, 2), Stream.fail("interrupted"))
              : remaining;
          },
        };

        expect(
          (yield* Effect.result(
            writeThreadSyncV2Thread({ mirrorPath, source: interrupted, targetChunkBytes: 1 }),
          ))._tag,
        ).toBe("Failure");
        const resumed = yield* writeThreadSyncV2Thread({
          mirrorPath,
          source: interrupted,
          targetChunkBytes: 1,
        });
        expect(resumed.resumedAtOrdinal).toBe(2);
        expect(resumed.manifest.recordCount).toBe(5);

        const reader = yield* readThreadSyncV2Thread({
          mirrorPath,
          entry: {
            threadId: header.threadId,
            syncProjectId: header.syncProjectId,
            title: header.title,
            manifestPath: resumed.manifestPath,
            manifestSha256: resumed.manifestSha256,
            revision: resumed.manifest.revision,
          },
        });
        expect(Array.from(yield* Stream.runCollect(reader.records))).toEqual(records);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("re-exports a checkpoint whose unpublished chunks were removed by a Git race", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const mirrorPath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "thread-sync-v2-race-retry-",
        });
        const records = Array.from({ length: 4 }, (_, ordinal) =>
          decodeRecord({
            ordinal,
            kind: "turn",
            portableId: `portable-turn-race-${ordinal}`,
            value: {
              turnId: `turn-race-${ordinal}`,
              pendingMessageId: null,
              sourceProposedPlanThreadId: null,
              sourceProposedPlanId: null,
              state: "completed",
              requestedAt: "2026-10-11T12:00:00.000Z",
              startedAt: "2026-10-11T12:00:00.000Z",
              completedAt: "2026-10-11T12:00:01.000Z",
              assistantMessageId: null,
            },
          }),
        );
        const source = sourceFromRecords(records, "projection:sync-thread:race-retry");
        const first = yield* writeThreadSyncV2Thread({
          mirrorPath,
          source,
          targetChunkBytes: 1,
        });
        expect(first.resumedAtOrdinal).toBe(0);

        const chunksPath = NodePath.join(mirrorPath, THREAD_SYNC_V2_CHUNKS_DIRECTORY);
        for (const chunk of first.manifest.chunks) {
          NodeFS.unlinkSync(NodePath.join(chunksPath, chunk.fileName));
        }

        const retried = yield* writeThreadSyncV2Thread({
          mirrorPath,
          source,
          targetChunkBytes: 1,
        });
        expect(retried.resumedAtOrdinal).toBe(0);
        expect(retried.manifest.revision).toBe(first.manifest.revision);
        const reader = yield* readThreadSyncV2Thread({
          mirrorPath,
          entry: {
            threadId: header.threadId,
            syncProjectId: header.syncProjectId,
            title: header.title,
            manifestPath: retried.manifestPath,
            manifestSha256: retried.manifestSha256,
            revision: retried.manifest.revision,
          },
        });
        expect(Array.from(yield* Stream.runCollect(reader.records))).toEqual(records);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps referenced lazy blobs and collects replaced or removed attachments", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const mirrorPath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "thread-sync-v2-blob-gc-",
        });
        const outsidePath = NodePath.join(mirrorPath, "outside.keep");
        NodeFS.writeFileSync(outsidePath, "outside\n");
        const oldBlob = new Uint8Array([1, 3, 3, 7]);
        const nextBlob = new Uint8Array([2, 4, 6, 8]);
        const oldHash = threadSyncV2Sha256(oldBlob);
        const nextHash = threadSyncV2Sha256(nextBlob);
        const recordsWithAttachment = (blobHash: string | null, sizeBytes = 0) => [
          decodeRecord({
            ordinal: 0,
            kind: "message",
            value: {
              id: "message-blob-gc",
              role: "assistant",
              text: describeThreadSyncV2Text("attachment"),
              attachments:
                blobHash === null
                  ? []
                  : [
                      {
                        type: "image",
                        name: "fixture.png",
                        mimeType: "image/png",
                        sizeBytes,
                        blobHash,
                      },
                    ],
              turnId: null,
              streaming: false,
              createdAt: "2026-10-11T12:00:01.000Z",
              updatedAt: "2026-10-11T12:00:01.000Z",
            },
          }),
        ];
        const projects = new Map<ThreadSyncProjectId, typeof project>([
          [project.syncProjectId, project],
        ]);
        const firstSource: ThreadSyncV2RepositorySource = {
          projects,
          threads: [
            sourceFromRecords(
              recordsWithAttachment(oldHash, oldBlob.byteLength),
              "projection:sync-thread:blob-gc:old",
            ),
          ],
          blobs: [
            {
              sha256: oldHash,
              sizeBytes: oldBlob.byteLength,
              bytes: (offset: number) => Stream.make(oldBlob.slice(offset)),
            },
          ],
          updatedAt: "2026-10-11T12:00:02.000Z",
        };
        const first = yield* writeThreadSyncV2Repository({
          mirrorPath,
          source: firstSource,
        });
        const oldEntry = first.manifest.blobs[0]!;
        const oldBlobPath = NodePath.join(
          mirrorPath,
          THREAD_SYNC_V2_BLOBS_DIRECTORY,
          `${oldHash}.blob`,
        );
        NodeFS.unlinkSync(oldBlobPath);

        const retainedSource: ThreadSyncV2RepositorySource = {
          projects,
          threads: [],
          blobs: [],
          retainedThreads: [first.manifest.threads[0]!],
          retainedBlobs: [oldEntry],
          updatedAt: "2026-10-11T12:00:03.000Z",
        };
        const retained = yield* writeThreadSyncV2Repository({
          mirrorPath,
          source: retainedSource,
        });
        expect(retained.manifest.blobs).toEqual([oldEntry]);
        expect(retained.removedPayloadPaths).toEqual([]);
        expect(NodeFS.existsSync(oldBlobPath)).toBe(false);

        const replacedSource: ThreadSyncV2RepositorySource = {
          projects,
          threads: [
            sourceFromRecords(
              recordsWithAttachment(nextHash, nextBlob.byteLength),
              "projection:sync-thread:blob-gc:next",
            ),
          ],
          blobs: [
            {
              sha256: nextHash,
              sizeBytes: nextBlob.byteLength,
              bytes: (offset: number) => Stream.make(nextBlob.slice(offset)),
            },
          ],
          retainedBlobs: [oldEntry],
          updatedAt: "2026-10-11T12:00:04.000Z",
        };
        const replaced = yield* writeThreadSyncV2Repository({
          mirrorPath,
          source: replacedSource,
        });
        expect(replaced.manifest.blobs.map((entry) => entry.sha256)).toEqual([nextHash]);
        expect(replaced.removedPayloadPaths).toEqual([
          `${THREAD_SYNC_V2_BLOBS_DIRECTORY}/${oldHash}.blob`,
        ]);

        const removedSource: ThreadSyncV2RepositorySource = {
          projects,
          threads: [
            sourceFromRecords(
              recordsWithAttachment(null),
              "projection:sync-thread:blob-gc:removed",
            ),
          ],
          blobs: [],
          retainedBlobs: [replaced.manifest.blobs[0]!],
          updatedAt: "2026-10-11T12:00:05.000Z",
        };
        const removed = yield* writeThreadSyncV2Repository({
          mirrorPath,
          source: removedSource,
        });
        expect(removed.manifest.blobs).toEqual([]);
        expect(removed.removedPayloadPaths).toEqual([
          `${THREAD_SYNC_V2_BLOBS_DIRECTORY}/${nextHash}.blob`,
        ]);
        expect(
          NodeFS.existsSync(
            NodePath.join(mirrorPath, THREAD_SYNC_V2_BLOBS_DIRECTORY, `${nextHash}.blob`),
          ),
        ).toBe(false);
        expect(NodeFS.readFileSync(outsidePath, "utf8")).toBe("outside\n");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves already hydrated chunks and blobs for retained threads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const mirrorPath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "thread-sync-v2-retained-",
        });
        const blob = new Uint8Array([7, 8, 9]);
        const blobHash = threadSyncV2Sha256(blob);
        const records = [
          decodeRecord({
            ordinal: 0,
            kind: "turn",
            value: {
              turnId: "turn-retained",
              pendingMessageId: null,
              sourceProposedPlanThreadId: null,
              sourceProposedPlanId: null,
              state: "completed",
              requestedAt: "2026-10-11T12:00:00.000Z",
              startedAt: "2026-10-11T12:00:00.000Z",
              completedAt: "2026-10-11T12:00:01.000Z",
              assistantMessageId: null,
            },
          }),
          decodeRecord({
            ordinal: 1,
            kind: "message",
            value: {
              id: "message-retained",
              role: "assistant",
              text: describeThreadSyncV2Text(""),
              attachments: [
                {
                  type: "image",
                  name: "retained.png",
                  mimeType: "image/png",
                  sizeBytes: blob.byteLength,
                  blobHash,
                },
              ],
              turnId: null,
              streaming: false,
              createdAt: "2026-10-11T12:00:01.000Z",
              updatedAt: "2026-10-11T12:00:01.000Z",
            },
          }),
        ];
        const initialSource: ThreadSyncV2RepositorySource = {
          projects: new Map<ThreadSyncProjectId, typeof project>([
            [project.syncProjectId, project],
          ]),
          threads: [sourceFromRecords(records, "projection:sync-thread:retained")],
          blobs: [
            {
              sha256: blobHash,
              sizeBytes: blob.byteLength,
              bytes: (offset: number) => Stream.make(blob.slice(offset)),
            },
          ],
          updatedAt: "2026-10-11T12:00:02.000Z",
        };
        const first = yield* writeThreadSyncV2Repository({
          mirrorPath,
          source: initialSource,
          targetChunkBytes: 1,
        });
        const retainedThread = first.manifest.threads[0]!;
        const retainedBlob = first.manifest.blobs[0]!;
        const chunkNames = first.threadResults
          .get(header.threadId)!
          .manifest.chunks.map((chunk) => chunk.fileName);

        const retainedSource: ThreadSyncV2RepositorySource = {
          projects: new Map<ThreadSyncProjectId, typeof project>([
            [project.syncProjectId, project],
          ]),
          threads: [],
          blobs: [],
          retainedThreads: [retainedThread],
          retainedBlobs: [retainedBlob],
          updatedAt: "2026-10-11T12:00:03.000Z",
        };
        yield* writeThreadSyncV2Repository({
          mirrorPath,
          source: retainedSource,
          targetChunkBytes: 1,
        });

        for (const chunkName of chunkNames) {
          expect(
            NodeFS.existsSync(
              NodePath.join(mirrorPath, THREAD_SYNC_V2_CHUNKS_DIRECTORY, chunkName),
            ),
          ).toBe(true);
        }
        const index = yield* readThreadSyncV2RepositoryIndex(mirrorPath);
        const reader = yield* readThreadSyncV2Thread({
          mirrorPath,
          entry: index!.threads.get(header.threadId)!,
        });
        expect(Array.from(yield* Stream.runCollect(reader.records))).toEqual(records);

        const retainedChunkPath = NodePath.join(
          mirrorPath,
          THREAD_SYNC_V2_CHUNKS_DIRECTORY,
          chunkNames[0]!,
        );
        const retainedChunkBytes = NodeFS.readFileSync(retainedChunkPath);
        NodeFS.appendFileSync(retainedChunkPath, "tampered");
        expect(
          (yield* Effect.result(
            writeThreadSyncV2Repository({
              mirrorPath,
              source: retainedSource,
              targetChunkBytes: 1,
            }),
          ))._tag,
        ).toBe("Failure");
        NodeFS.writeFileSync(retainedChunkPath, retainedChunkBytes);

        const retainedBlobPath = NodePath.join(
          mirrorPath,
          THREAD_SYNC_V2_BLOBS_DIRECTORY,
          `${blobHash}.blob`,
        );
        NodeFS.writeFileSync(retainedBlobPath, new Uint8Array([9, 9, 9]));
        expect(
          (yield* Effect.result(
            writeThreadSyncV2Repository({
              mirrorPath,
              source: retainedSource,
              targetChunkBytes: 1,
            }),
          ))._tag,
        ).toBe("Failure");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps only the current export checkpoint and prunes failed blob partials", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const mirrorPath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "thread-sync-v2-work-gc-",
        });
        const records = [
          decodeRecord({
            ordinal: 0,
            kind: "turn",
            value: {
              turnId: "turn-work-gc",
              pendingMessageId: null,
              sourceProposedPlanThreadId: null,
              sourceProposedPlanId: null,
              state: "completed",
              requestedAt: "2026-10-11T12:00:00.000Z",
              startedAt: "2026-10-11T12:00:00.000Z",
              completedAt: "2026-10-11T12:00:01.000Z",
              assistantMessageId: null,
            },
          }),
        ];
        const projects = new Map<ThreadSyncProjectId, typeof project>([
          [project.syncProjectId, project],
        ]);
        const firstSourceKey = "projection:sync-thread:sequence-1";
        const secondSourceKey = "projection:sync-thread:sequence-2";
        yield* writeThreadSyncV2Repository({
          mirrorPath,
          source: {
            projects,
            threads: [sourceFromRecords(records, firstSourceKey)],
            blobs: [],
            updatedAt: "2026-10-11T12:00:02.000Z",
          },
          targetChunkBytes: 1,
        });
        yield* writeThreadSyncV2Repository({
          mirrorPath,
          source: {
            projects,
            threads: [sourceFromRecords(records, secondSourceKey)],
            blobs: [],
            updatedAt: "2026-10-11T12:00:03.000Z",
          },
          targetChunkBytes: 1,
        });

        const threadWorkPath = NodePath.join(
          mirrorPath,
          THREAD_SYNC_V2_WORK_DIRECTORY,
          threadSyncV2ThreadDirectory(header.threadId),
        );
        expect(NodeFS.readdirSync(threadWorkPath)).toEqual([threadSyncV2Sha256(secondSourceKey)]);
        const orphanChunkPartial = NodePath.join(
          threadWorkPath,
          threadSyncV2Sha256(secondSourceKey),
          "chunk-99999999.partial",
        );
        NodeFS.writeFileSync(orphanChunkPartial, "orphaned partial");

        const intendedBlob = new Uint8Array([1, 2, 3]);
        const blobHash = threadSyncV2Sha256(intendedBlob);
        const interruptedBlob = yield* Effect.result(
          writeThreadSyncV2Blob({
            mirrorPath,
            source: {
              sha256: blobHash,
              sizeBytes: intendedBlob.byteLength,
              bytes: () =>
                Stream.concat(Stream.make(intendedBlob.slice(0, 2)), Stream.fail("interrupted")),
            },
          }),
        );
        expect(interruptedBlob._tag).toBe("Failure");
        const partialPath = NodePath.join(
          mirrorPath,
          THREAD_SYNC_V2_WORK_DIRECTORY,
          "blobs",
          `${blobHash}.partial`,
        );
        expect(NodeFS.existsSync(partialPath)).toBe(true);

        yield* writeThreadSyncV2Repository({
          mirrorPath,
          source: {
            projects,
            threads: [sourceFromRecords(records, secondSourceKey)],
            blobs: [],
            updatedAt: "2026-10-11T12:00:04.000Z",
          },
          targetChunkBytes: 1,
        });
        expect(NodeFS.existsSync(partialPath)).toBe(false);
        expect(NodeFS.existsSync(orphanChunkPartial)).toBe(false);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
