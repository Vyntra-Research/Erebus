// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  readThreadSyncAttachmentForExport,
  THREAD_SYNC_MAX_BLOB_BYTES,
  THREAD_SYNC_MAX_TOTAL_BLOB_BYTES,
} from "./ThreadSyncAttachmentIO.ts";

const tempDirectory = Effect.acquireRelease(
  Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "thread-sync-attachment-"))),
  (directory) =>
    Effect.sync(() => {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }),
);

describe("readThreadSyncAttachmentForExport", () => {
  it.effect("rejects a symbolic link or junction without reading through it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* tempDirectory;
        const outsideDirectory = NodePath.join(directory, "outside");
        const attachmentPath = NodePath.join(directory, "linked-attachment.png");
        NodeFS.mkdirSync(outsideDirectory);
        NodeFS.symlinkSync(outsideDirectory, attachmentPath, "junction");
        let readCalls = 0;

        const result = yield* Effect.result(
          readThreadSyncAttachmentForExport(
            {
              filePath: attachmentPath,
              name: "linked-attachment.png",
              declaredSizeBytes: 0,
              budget: { consumedBytes: 0 },
            },
            () =>
              Effect.sync(() => {
                readCalls += 1;
                return new Uint8Array();
              }),
          ),
        );

        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure.code).toBe("integrity-failed");
          expect(result.failure.detail).toContain("symbolic link, junction, or non-file");
        }
        expect(readCalls).toBe(0);
      }),
    ),
  );

  it.effect("rejects an oversized sparse file without reading its contents", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* tempDirectory;
        const attachmentPath = NodePath.join(directory, "oversized.png");
        const oversizedBytes = THREAD_SYNC_MAX_BLOB_BYTES + 1;
        NodeFS.writeFileSync(attachmentPath, "");
        NodeFS.truncateSync(attachmentPath, oversizedBytes);
        let readCalls = 0;

        const result = yield* Effect.result(
          readThreadSyncAttachmentForExport(
            {
              filePath: attachmentPath,
              name: "oversized.png",
              declaredSizeBytes: oversizedBytes,
              budget: { consumedBytes: 0 },
            },
            () =>
              Effect.sync(() => {
                readCalls += 1;
                return new Uint8Array();
              }),
          ),
        );

        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure.code).toBe("integrity-failed");
          expect(result.failure.detail).toContain("exceeds the sync attachment size limit");
        }
        expect(readCalls).toBe(0);
      }),
    ),
  );

  it.effect("enforces the total export budget before reading the next file", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* tempDirectory;
        const attachmentPath = NodePath.join(directory, "one-byte.png");
        NodeFS.writeFileSync(attachmentPath, new Uint8Array([1]));
        let readCalls = 0;

        const result = yield* Effect.result(
          readThreadSyncAttachmentForExport(
            {
              filePath: attachmentPath,
              name: "one-byte.png",
              declaredSizeBytes: 1,
              budget: { consumedBytes: THREAD_SYNC_MAX_TOTAL_BLOB_BYTES },
            },
            () =>
              Effect.sync(() => {
                readCalls += 1;
                return new Uint8Array([1]);
              }),
          ),
        );

        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure.code).toBe("integrity-failed");
          expect(result.failure.detail).toContain("total sync attachment size limit");
        }
        expect(readCalls).toBe(0);
      }),
    ),
  );
});
