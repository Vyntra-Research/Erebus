// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import { ThreadSyncError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

export const THREAD_SYNC_MAX_BLOB_BYTES = 64 * 1024 * 1024;
export const THREAD_SYNC_MAX_TOTAL_BLOB_BYTES = 512 * 1024 * 1024;

export interface ThreadSyncAttachmentExportBudget {
  consumedBytes: number;
}

interface ThreadSyncAttachmentExportInput {
  readonly filePath: string;
  readonly name: string;
  readonly declaredSizeBytes: number;
  readonly budget: ThreadSyncAttachmentExportBudget;
}

function exportIntegrityError(detail: string): ThreadSyncError {
  return new ThreadSyncError({ operation: "export", code: "integrity-failed", detail });
}

function inspectLocalAttachment(
  filePath: string,
  name: string,
): Effect.Effect<NodeFS.Stats, ThreadSyncError> {
  return Effect.try({
    try: () => NodeFS.lstatSync(filePath),
    catch: (cause) =>
      exportIntegrityError(`Attachment '${name}' could not be inspected: ${String(cause)}`),
  });
}

function isSameRegularFile(before: NodeFS.Stats, after: NodeFS.Stats): boolean {
  return (
    !after.isSymbolicLink() &&
    after.isFile() &&
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size
  );
}

/**
 * Reads one local attachment only after a no-follow metadata check has bounded it.
 * The second lstat keeps a replaced path from being published after the read.
 */
export function readThreadSyncAttachmentForExport<E, R>(
  input: ThreadSyncAttachmentExportInput,
  readFile: (filePath: string) => Effect.Effect<Uint8Array, E, R>,
): Effect.Effect<Uint8Array, ThreadSyncError, R> {
  return Effect.gen(function* () {
    const before = yield* inspectLocalAttachment(input.filePath, input.name);
    if (before.isSymbolicLink() || !before.isFile()) {
      return yield* exportIntegrityError(
        `Attachment '${input.name}' is a symbolic link, junction, or non-file entry.`,
      );
    }

    const actualSizeBytes = before.size;
    if (
      !Number.isSafeInteger(input.declaredSizeBytes) ||
      input.declaredSizeBytes < 0 ||
      !Number.isSafeInteger(actualSizeBytes) ||
      actualSizeBytes !== input.declaredSizeBytes
    ) {
      return yield* exportIntegrityError(
        `Attachment '${input.name}' is not a regular file of its declared size.`,
      );
    }
    if (actualSizeBytes > THREAD_SYNC_MAX_BLOB_BYTES) {
      return yield* exportIntegrityError(
        `Attachment '${input.name}' exceeds the sync attachment size limit.`,
      );
    }
    if (input.budget.consumedBytes > THREAD_SYNC_MAX_TOTAL_BLOB_BYTES - actualSizeBytes) {
      return yield* exportIntegrityError(
        "The local snapshot exceeds the total sync attachment size limit.",
      );
    }

    const bytes = yield* readFile(input.filePath).pipe(
      Effect.mapError((cause) =>
        exportIntegrityError(`Attachment '${input.name}' could not be read: ${String(cause)}`),
      ),
    );
    const after = yield* inspectLocalAttachment(input.filePath, input.name);
    if (!isSameRegularFile(before, after) || bytes.byteLength !== actualSizeBytes) {
      return yield* exportIntegrityError(
        `Attachment '${input.name}' changed while it was being read.`,
      );
    }

    input.budget.consumedBytes += actualSizeBytes;
    return bytes;
  });
}
