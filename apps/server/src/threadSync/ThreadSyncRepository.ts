// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

import {
  IsoDateTime,
  THREAD_SYNC_FORMAT_VERSION,
  ThreadSyncError,
  ThreadSyncProjectSnapshot,
  ThreadSyncThreadSnapshot,
  type ThreadSyncImageAttachment,
  type ThreadSyncProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import {
  canonicalThreadSyncJson,
  emptyThreadSyncRepositoryDocuments,
  THREAD_SYNC_BLOBS_DIRECTORY,
  THREAD_SYNC_MANIFEST_PATH,
  THREAD_SYNC_NAMESPACE,
  THREAD_SYNC_PROJECTS_DIRECTORY,
  THREAD_SYNC_THREADS_DIRECTORY,
  threadSyncBlobFileName,
  threadSyncDocumentFileName,
  type ThreadSyncRepositoryDocuments,
  verifyThreadSyncDocumentFileName,
} from "./ThreadSyncDocuments.ts";
import {
  THREAD_SYNC_MAX_BLOB_BYTES,
  THREAD_SYNC_MAX_TOTAL_BLOB_BYTES,
} from "./ThreadSyncAttachmentIO.ts";

const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
const MAX_DOCUMENT_COUNT = 20_000;
const MAX_TOTAL_DOCUMENT_BYTES = 256 * 1024 * 1024;
const MAX_BLOB_COUNT = 20_000;

const ThreadSyncManifest = Schema.Struct({
  formatVersion: Schema.Literal(THREAD_SYNC_FORMAT_VERSION),
  kind: Schema.Literal("erebus-thread-sync"),
  updatedAt: IsoDateTime,
});
type ThreadSyncManifest = typeof ThreadSyncManifest.Type;

const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(ThreadSyncManifest));
const decodeProject = Schema.decodeUnknownEffect(Schema.fromJsonString(ThreadSyncProjectSnapshot));
const decodeThread = Schema.decodeUnknownEffect(Schema.fromJsonString(ThreadSyncThreadSnapshot));
const isThreadSyncError = Schema.is(ThreadSyncError);

export interface ThreadSyncRepositoryWriteInput {
  readonly mirrorPath: string;
  readonly projects: ReadonlyMap<ThreadSyncProjectId, ThreadSyncProjectSnapshot>;
  readonly threads: ReadonlyMap<string, ThreadSyncThreadSnapshot>;
  readonly blobs: ReadonlyMap<string, Uint8Array>;
  readonly updatedAt: string;
}

function repositoryError(
  operation: "pull" | "push",
  code: "integrity-failed" | "invalid-snapshot" | "io-failed",
  detail: string,
): ThreadSyncError {
  return new ThreadSyncError({ operation, code, detail });
}

function nodeErrorCode(cause: unknown): string | undefined {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) return undefined;
  const code = cause.code;
  return typeof code === "string" ? code : undefined;
}

const lstatPathWithoutFollowing = Effect.fn("ThreadSyncRepository.lstatNoFollow")(function* (
  operation: "pull" | "push",
  filePath: string,
): Effect.fn.Return<NodeFS.Stats | null, ThreadSyncError> {
  return yield* Effect.try({
    try: () => {
      try {
        return NodeFS.lstatSync(filePath);
      } catch (cause) {
        if (nodeErrorCode(cause) === "ENOENT") return null;
        throw cause;
      }
    },
    catch: (cause) =>
      repositoryError(
        operation,
        "io-failed",
        `Could not inspect a sync repository path without following links: ${String(cause)}`,
      ),
  });
});

const inspectManagedDocumentPath = Effect.fn("ThreadSyncRepository.inspectManagedDocumentPath")(
  function* (
    operation: "pull" | "push",
    mirrorPath: string,
    documentPath: string,
    allowMissing: boolean,
    documentKind: "manifest" | "project" | "thread",
  ): Effect.fn.Return<NodeFS.Stats | null, ThreadSyncError, FileSystem.FileSystem | Path.Path> {
    const path = yield* Path.Path;
    const resolvedMirror = path.resolve(mirrorPath);
    const resolvedDocument = path.resolve(documentPath);
    if (!isInside(resolvedMirror, resolvedDocument, path)) {
      return yield* repositoryError(
        operation,
        "integrity-failed",
        `The sync ${documentKind} path escapes its managed mirror.`,
      );
    }

    yield* assertRealPathContained(mirrorPath, path.dirname(documentPath)).pipe(
      Effect.mapError((cause) => new ThreadSyncError({ ...cause, operation })),
    );
    const entry = yield* lstatPathWithoutFollowing(operation, documentPath);
    if (entry === null) {
      if (allowMissing) return null;
      return yield* repositoryError(
        operation,
        "integrity-failed",
        `The sync ${documentKind} document is missing.`,
      );
    }
    if (entry.isSymbolicLink()) {
      return yield* repositoryError(
        operation,
        "integrity-failed",
        `The sync ${documentKind} document is a symbolic link, junction, or reparse point.`,
      );
    }
    if (!entry.isFile()) {
      return yield* repositoryError(
        operation,
        "integrity-failed",
        `The sync ${documentKind} document is not a regular file.`,
      );
    }
    yield* assertRealPathContained(mirrorPath, documentPath).pipe(
      Effect.mapError((cause) => new ThreadSyncError({ ...cause, operation })),
    );
    return entry;
  },
);

function isInside(root: string, candidate: string, path: Path.Path): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function comparableRelative(value: string, path: Path.Path, hostPlatform: NodeJS.Platform): string {
  const normalized = path.normalize(value);
  return hostPlatform === "win32" ? normalized.toLowerCase() : normalized;
}

const assertRealPathContained = Effect.fn("ThreadSyncRepository.assertContained")(function* (
  mirrorPath: string,
  targetPath: string,
): Effect.fn.Return<void, ThreadSyncError, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hostPlatform = yield* HostProcessPlatform;
  const [realMirror, realTarget] = yield* Effect.all([
    fileSystem.realPath(mirrorPath),
    fileSystem.realPath(targetPath),
  ]).pipe(
    Effect.mapError((cause) =>
      repositoryError(
        "pull",
        "io-failed",
        `Could not resolve a sync repository path: ${String(cause)}`,
      ),
    ),
  );
  if (!isInside(realMirror, realTarget, path)) {
    return yield* repositoryError(
      "pull",
      "integrity-failed",
      "The sync repository contains a link outside its managed mirror.",
    );
  }
  const lexicalRelative = comparableRelative(
    path.relative(mirrorPath, targetPath),
    path,
    hostPlatform,
  );
  const realRelative = comparableRelative(
    path.relative(realMirror, realTarget),
    path,
    hostPlatform,
  );
  if (lexicalRelative !== realRelative) {
    return yield* repositoryError(
      "pull",
      "integrity-failed",
      "The sync repository contains a redirected path in its managed namespace.",
    );
  }
});

const readBoundedText = Effect.fn("ThreadSyncRepository.readBoundedText")(function* (
  operation: "pull" | "push",
  filePath: string,
  budget?: { consumed: number; readonly maximum: number },
): Effect.fn.Return<string, ThreadSyncError, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  const info = yield* fileSystem
    .stat(filePath)
    .pipe(
      Effect.mapError((cause) =>
        repositoryError(
          operation,
          "io-failed",
          `Could not inspect a sync document: ${String(cause)}`,
        ),
      ),
    );
  if (info.type !== "File" || Number(info.size) > MAX_DOCUMENT_BYTES) {
    return yield* repositoryError(
      operation,
      "integrity-failed",
      "A sync document is not a regular bounded file.",
    );
  }
  if (budget !== undefined) {
    budget.consumed += Number(info.size);
    if (budget.consumed > budget.maximum) {
      return yield* repositoryError(
        operation,
        "integrity-failed",
        "The sync repository exceeds the total document size limit.",
      );
    }
  }
  return yield* fileSystem
    .readFileString(filePath)
    .pipe(
      Effect.mapError((cause) =>
        repositoryError(operation, "io-failed", `Could not read a sync document: ${String(cause)}`),
      ),
    );
});

function uniqueAttachments(
  threads: ReadonlyMap<string, ThreadSyncThreadSnapshot>,
): ReadonlyMap<string, ThreadSyncImageAttachment> {
  const attachments = new Map<string, ThreadSyncImageAttachment>();
  for (const thread of threads.values()) {
    for (const message of thread.messages) {
      for (const attachment of message.attachments) {
        const previous = attachments.get(attachment.blobHash);
        if (previous && previous.sizeBytes !== attachment.sizeBytes) {
          throw new Error(`Blob ${attachment.blobHash} has conflicting metadata.`);
        }
        attachments.set(attachment.blobHash, attachment);
      }
    }
  }
  return attachments;
}

function assertUniqueIds(threadId: string, kind: string, values: ReadonlyArray<string>): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`Thread ${threadId} contains duplicate ${kind} id '${value}'.`);
    }
    seen.add(value);
  }
}

function validateThreadSnapshots(threads: ReadonlyMap<string, ThreadSyncThreadSnapshot>): void {
  for (const thread of threads.values()) {
    assertUniqueIds(
      thread.threadId,
      "turn",
      thread.turns.map((turn) => turn.turnId),
    );
    assertUniqueIds(
      thread.threadId,
      "message",
      thread.messages.map((message) => message.id),
    );
    assertUniqueIds(
      thread.threadId,
      "proposed plan",
      thread.proposedPlans.map((plan) => plan.id),
    );
    assertUniqueIds(
      thread.threadId,
      "activity",
      thread.activities.map((activity) => activity.id),
    );

    const turnsById = new Map(thread.turns.map((turn) => [turn.turnId, turn] as const));
    const messagesById = new Map(thread.messages.map((message) => [message.id, message] as const));
    if (thread.latestTurn !== null) {
      const matchingTurn = turnsById.get(thread.latestTurn.turnId);
      if (
        matchingTurn === undefined ||
        canonicalThreadSyncJson(matchingTurn) !== canonicalThreadSyncJson(thread.latestTurn)
      ) {
        throw new Error(`Thread ${thread.threadId} has an inconsistent latest turn reference.`);
      }
    }

    for (const turn of thread.turns) {
      if (turn.pendingMessageId !== null && !messagesById.has(turn.pendingMessageId)) {
        throw new Error(
          `Turn ${turn.turnId} in thread ${thread.threadId} references a missing pending message.`,
        );
      }
      if (turn.assistantMessageId !== null && !messagesById.has(turn.assistantMessageId)) {
        throw new Error(
          `Turn ${turn.turnId} in thread ${thread.threadId} references a missing assistant message.`,
        );
      }
      const hasSourceThread = turn.sourceProposedPlanThreadId !== null;
      const hasSourcePlan = turn.sourceProposedPlanId !== null;
      if (hasSourceThread !== hasSourcePlan) {
        throw new Error(
          `Turn ${turn.turnId} in thread ${thread.threadId} has an incomplete source plan reference.`,
        );
      }
      if (turn.sourceProposedPlanThreadId !== null && turn.sourceProposedPlanId !== null) {
        const sourceThread = threads.get(turn.sourceProposedPlanThreadId);
        if (
          sourceThread === undefined ||
          !sourceThread.proposedPlans.some((plan) => plan.id === turn.sourceProposedPlanId)
        ) {
          throw new Error(
            `Turn ${turn.turnId} in thread ${thread.threadId} references a missing source plan.`,
          );
        }
      }
    }

    for (const message of thread.messages) {
      if (message.turnId !== null && !turnsById.has(message.turnId)) {
        throw new Error(
          `Message ${message.id} in thread ${thread.threadId} references a missing turn.`,
        );
      }
    }
    for (const plan of thread.proposedPlans) {
      if (plan.turnId !== null && !turnsById.has(plan.turnId)) {
        throw new Error(
          `Proposed plan ${plan.id} in thread ${thread.threadId} references a missing turn.`,
        );
      }
      if (plan.implementationThreadId !== null && !threads.has(plan.implementationThreadId)) {
        throw new Error(
          `Proposed plan ${plan.id} in thread ${thread.threadId} references a missing implementation thread.`,
        );
      }
    }
    for (const activity of thread.activities) {
      if (activity.turnId !== null && !turnsById.has(activity.turnId)) {
        throw new Error(
          `Activity ${activity.id} in thread ${thread.threadId} references a missing turn.`,
        );
      }
    }

    if (thread.coagent !== null) {
      const parent = threads.get(thread.coagent.parentThreadId);
      if (
        parent === undefined ||
        parent.threadId === thread.threadId ||
        parent.syncProjectId !== thread.syncProjectId
      ) {
        throw new Error(`Thread ${thread.threadId} has an invalid co-agent parent reference.`);
      }
    }
  }

  for (const thread of threads.values()) {
    const visited = new Set<string>([thread.threadId]);
    let parentId = thread.coagent?.parentThreadId ?? null;
    while (parentId !== null) {
      if (visited.has(parentId)) {
        throw new Error(`Thread ${thread.threadId} belongs to a cyclic co-agent relation.`);
      }
      visited.add(parentId);
      parentId = threads.get(parentId)?.coagent?.parentThreadId ?? null;
    }
  }
}

export const readThreadSyncRepository = Effect.fn("ThreadSyncRepository.read")(function* (
  mirrorPath: string,
): Effect.fn.Return<
  ThreadSyncRepositoryDocuments,
  ThreadSyncError,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const namespacePath = path.join(mirrorPath, THREAD_SYNC_NAMESPACE);
  if (!(yield* fileSystem.exists(namespacePath).pipe(Effect.orElseSucceed(() => false)))) {
    return emptyThreadSyncRepositoryDocuments();
  }
  yield* assertRealPathContained(mirrorPath, namespacePath);

  const documentBudget = { consumed: 0, maximum: MAX_TOTAL_DOCUMENT_BYTES };
  const manifestPath = path.join(mirrorPath, THREAD_SYNC_MANIFEST_PATH);
  yield* inspectManagedDocumentPath("pull", mirrorPath, manifestPath, false, "manifest");
  const manifestContents = yield* readBoundedText("pull", manifestPath, documentBudget);
  yield* decodeManifest(manifestContents).pipe(
    Effect.mapError((cause) =>
      repositoryError("pull", "invalid-snapshot", `The sync manifest is invalid: ${String(cause)}`),
    ),
  );

  const readDocuments = <Document, DecodeError>(input: {
    readonly directory: string;
    readonly decode: (contents: string) => Effect.Effect<Document, DecodeError>;
    readonly id: (document: Document) => string;
  }) =>
    Effect.gen(function* () {
      const directoryPath = path.join(mirrorPath, input.directory);
      if (!(yield* fileSystem.exists(directoryPath).pipe(Effect.orElseSucceed(() => false)))) {
        return new Map<string, Document>();
      }
      yield* assertRealPathContained(mirrorPath, directoryPath);
      const fileNames = yield* fileSystem
        .readDirectory(directoryPath)
        .pipe(
          Effect.mapError((cause) =>
            repositoryError("pull", "io-failed", `Could not list sync documents: ${String(cause)}`),
          ),
        );
      if (fileNames.length > MAX_DOCUMENT_COUNT) {
        return yield* repositoryError(
          "pull",
          "integrity-failed",
          "The sync repository contains too many documents.",
        );
      }

      const documents = new Map<string, Document>();
      for (const fileName of fileNames.toSorted()) {
        if (!/^[a-f0-9]{64}\.json$/.test(fileName)) {
          return yield* repositoryError(
            "pull",
            "integrity-failed",
            `Unexpected file in the sync document directory: ${fileName}`,
          );
        }
        const filePath = path.join(directoryPath, fileName);
        yield* inspectManagedDocumentPath(
          "pull",
          mirrorPath,
          filePath,
          false,
          input.directory === THREAD_SYNC_PROJECTS_DIRECTORY ? "project" : "thread",
        );
        const contents = yield* readBoundedText("pull", filePath, documentBudget);
        const document = yield* input
          .decode(contents)
          .pipe(
            Effect.mapError((cause) =>
              repositoryError(
                "pull",
                "invalid-snapshot",
                `A sync document is invalid: ${String(cause)}`,
              ),
            ),
          );
        const id = input.id(document);
        if (!verifyThreadSyncDocumentFileName(id, fileName) || documents.has(id)) {
          return yield* repositoryError(
            "pull",
            "integrity-failed",
            "A sync document name does not match its identifier or is duplicated.",
          );
        }
        documents.set(id, document);
      }
      return documents;
    });

  const projectsById = yield* readDocuments({
    directory: THREAD_SYNC_PROJECTS_DIRECTORY,
    decode: decodeProject,
    id: (project) => project.syncProjectId,
  });
  const threadsById = yield* readDocuments({
    directory: THREAD_SYNC_THREADS_DIRECTORY,
    decode: decodeThread,
    id: (thread) => thread.threadId,
  });
  if (projectsById.size + threadsById.size > MAX_DOCUMENT_COUNT) {
    return yield* repositoryError(
      "pull",
      "integrity-failed",
      "The sync repository contains too many documents.",
    );
  }
  const projects = new Map<ThreadSyncProjectId, ThreadSyncProjectSnapshot>();
  for (const project of projectsById.values()) {
    projects.set(project.syncProjectId, project);
  }
  const threads = new Map<string, ThreadSyncThreadSnapshot>();
  for (const thread of threadsById.values()) {
    threads.set(thread.threadId, thread);
  }

  for (const thread of threads.values()) {
    if (!projects.has(thread.syncProjectId)) {
      return yield* repositoryError(
        "pull",
        "integrity-failed",
        `Thread ${thread.threadId} references a missing project.`,
      );
    }
  }
  yield* Effect.try({
    try: () => validateThreadSnapshots(threads),
    catch: (cause) => repositoryError("pull", "integrity-failed", String(cause)),
  });

  const attachments = yield* Effect.try({
    try: () => uniqueAttachments(threads),
    catch: (cause) => repositoryError("pull", "integrity-failed", String(cause)),
  });
  if (attachments.size > MAX_BLOB_COUNT) {
    return yield* repositoryError(
      "pull",
      "integrity-failed",
      "The sync repository references too many attachment blobs.",
    );
  }
  let totalBlobBytes = 0;
  for (const attachment of attachments.values()) {
    totalBlobBytes += attachment.sizeBytes;
    if (totalBlobBytes > THREAD_SYNC_MAX_TOTAL_BLOB_BYTES) {
      return yield* repositoryError(
        "pull",
        "integrity-failed",
        "The sync repository exceeds the total attachment size limit.",
      );
    }
  }
  const blobsDirectoryPath = path.join(mirrorPath, THREAD_SYNC_BLOBS_DIRECTORY);
  if (yield* fileSystem.exists(blobsDirectoryPath).pipe(Effect.orElseSucceed(() => false))) {
    yield* assertRealPathContained(mirrorPath, blobsDirectoryPath);
    const blobNames = yield* fileSystem
      .readDirectory(blobsDirectoryPath)
      .pipe(
        Effect.mapError((cause) =>
          repositoryError("pull", "io-failed", `Could not list sync blobs: ${String(cause)}`),
        ),
      );
    if (blobNames.length > MAX_BLOB_COUNT) {
      return yield* repositoryError(
        "pull",
        "integrity-failed",
        "The sync repository contains too many attachment blobs.",
      );
    }
    for (const blobName of blobNames) {
      if (!/^[a-f0-9]{64}\.blob$/.test(blobName)) {
        return yield* repositoryError(
          "pull",
          "integrity-failed",
          `Unexpected file in the sync blob directory: ${blobName}`,
        );
      }
    }
  }
  const blobs = new Map<string, Uint8Array>();
  for (const attachment of attachments.values()) {
    if (attachment.sizeBytes > THREAD_SYNC_MAX_BLOB_BYTES) {
      return yield* repositoryError(
        "pull",
        "integrity-failed",
        `Blob ${attachment.blobHash} exceeds the sync attachment size limit.`,
      );
    }
    const blobPath = path.join(
      mirrorPath,
      THREAD_SYNC_BLOBS_DIRECTORY,
      threadSyncBlobFileName(attachment.blobHash),
    );
    yield* assertRealPathContained(mirrorPath, blobPath);
    const blobInfo = yield* fileSystem
      .stat(blobPath)
      .pipe(
        Effect.mapError((cause) =>
          repositoryError(
            "pull",
            "integrity-failed",
            `A required sync blob is missing: ${String(cause)}`,
          ),
        ),
      );
    if (
      blobInfo.type !== "File" ||
      Number(blobInfo.size) !== attachment.sizeBytes ||
      Number(blobInfo.size) > THREAD_SYNC_MAX_BLOB_BYTES
    ) {
      return yield* repositoryError(
        "pull",
        "integrity-failed",
        `Blob ${attachment.blobHash} is not a regular bounded file of the declared size.`,
      );
    }
    const bytes = yield* fileSystem
      .readFile(blobPath)
      .pipe(
        Effect.mapError((cause) =>
          repositoryError(
            "pull",
            "integrity-failed",
            `A required sync blob is missing: ${String(cause)}`,
          ),
        ),
      );
    const digest = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== attachment.sizeBytes || digest !== attachment.blobHash) {
      return yield* repositoryError(
        "pull",
        "integrity-failed",
        `Blob ${attachment.blobHash} failed size or SHA-256 verification.`,
      );
    }
    blobs.set(attachment.blobHash, bytes);
  }

  return { projects, threads, blobs };
});

export const writeThreadSyncRepository = Effect.fn("ThreadSyncRepository.write")(function* (
  input: ThreadSyncRepositoryWriteInput,
): Effect.fn.Return<void, ThreadSyncError, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const namespacePath = path.join(input.mirrorPath, THREAD_SYNC_NAMESPACE);
  const projectsPath = path.join(input.mirrorPath, THREAD_SYNC_PROJECTS_DIRECTORY);
  const threadsPath = path.join(input.mirrorPath, THREAD_SYNC_THREADS_DIRECTORY);
  const blobsPath = path.join(input.mirrorPath, THREAD_SYNC_BLOBS_DIRECTORY);
  const attachments = yield* Effect.try({
    try: () => {
      if (input.projects.size + input.threads.size > MAX_DOCUMENT_COUNT) {
        throw new Error("The snapshot contains too many documents.");
      }
      for (const [id, project] of input.projects) {
        if (id !== project.syncProjectId) {
          throw new Error("A project map key does not match its portable identifier.");
        }
      }
      for (const [id, thread] of input.threads) {
        if (id !== thread.threadId) {
          throw new Error("A thread map key does not match its portable identifier.");
        }
        if (!input.projects.has(thread.syncProjectId)) {
          throw new Error(`Thread ${thread.threadId} references a missing project.`);
        }
      }
      validateThreadSnapshots(input.threads);
      const referenced = uniqueAttachments(input.threads);
      if (referenced.size > MAX_BLOB_COUNT) {
        throw new Error("The snapshot references too many attachment blobs.");
      }
      let totalBlobBytes = 0;
      for (const attachment of referenced.values()) {
        totalBlobBytes += attachment.sizeBytes;
        if (totalBlobBytes > THREAD_SYNC_MAX_TOTAL_BLOB_BYTES) {
          throw new Error("The snapshot exceeds the total attachment size limit.");
        }
        if (attachment.sizeBytes > THREAD_SYNC_MAX_BLOB_BYTES) {
          throw new Error(`Blob ${attachment.blobHash} exceeds the attachment size limit.`);
        }
        const bytes = input.blobs.get(attachment.blobHash);
        if (bytes === undefined) {
          throw new Error(`Blob ${attachment.blobHash} is required but was not supplied.`);
        }
        const digest = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
        if (bytes.byteLength !== attachment.sizeBytes || digest !== attachment.blobHash) {
          throw new Error(`Blob ${attachment.blobHash} failed size or SHA-256 verification.`);
        }
      }
      return referenced;
    },
    catch: (cause) => repositoryError("push", "integrity-failed", String(cause)),
  });
  yield* fileSystem
    .makeDirectory(namespacePath, { recursive: true })
    .pipe(Effect.mapError((cause) => repositoryError("push", "io-failed", String(cause))));
  yield* assertRealPathContained(input.mirrorPath, namespacePath).pipe(
    Effect.mapError((cause) => new ThreadSyncError({ ...cause, operation: "push" })),
  );
  yield* Effect.forEach(
    [projectsPath, threadsPath, blobsPath],
    (directory) =>
      fileSystem.makeDirectory(directory, { recursive: true }).pipe(
        Effect.andThen(assertRealPathContained(input.mirrorPath, directory)),
        Effect.mapError((cause) =>
          isThreadSyncError(cause)
            ? new ThreadSyncError({ ...cause, operation: "push" })
            : repositoryError("push", "io-failed", String(cause)),
        ),
      ),
    { discard: true },
  );
  const manifestPath = path.join(input.mirrorPath, THREAD_SYNC_MANIFEST_PATH);
  yield* inspectManagedDocumentPath("push", input.mirrorPath, manifestPath, true, "manifest");

  let totalDocumentBytes = 0;
  const writeText = Effect.fn("ThreadSyncRepository.writeText")(function* (
    filePath: string,
    value: unknown,
    documentKind: "manifest" | "project" | "thread",
  ) {
    const contents = canonicalThreadSyncJson(value);
    const size = Buffer.byteLength(contents, "utf8");
    if (size > MAX_DOCUMENT_BYTES || totalDocumentBytes + size > MAX_TOTAL_DOCUMENT_BYTES) {
      return yield* repositoryError(
        "push",
        "integrity-failed",
        "The snapshot exceeds document size limits.",
      );
    }
    totalDocumentBytes += size;

    // The preflight rejects existing links and non-files. The helper writes a
    // complete sibling temporary file and renames that directory entry over
    // the destination, so a concurrent final-entry link swap is replaced
    // rather than followed to its external target.
    yield* inspectManagedDocumentPath("push", input.mirrorPath, filePath, true, documentKind);
    yield* writeFileStringAtomically({ filePath, contents }).pipe(
      Effect.mapError((cause) =>
        repositoryError("push", "io-failed", `Could not write a sync document: ${String(cause)}`),
      ),
    );
    yield* inspectManagedDocumentPath("push", input.mirrorPath, filePath, false, documentKind);
  });
  for (const [id, project] of [...input.projects.entries()].toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    yield* writeText(path.join(projectsPath, threadSyncDocumentFileName(id)), project, "project");
  }
  for (const [id, thread] of [...input.threads.entries()].toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    yield* writeText(path.join(threadsPath, threadSyncDocumentFileName(id)), thread, "thread");
  }
  for (const [hash] of [...attachments.entries()].toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const bytes = input.blobs.get(hash)!;
    const blobPath = path.join(blobsPath, threadSyncBlobFileName(hash));
    const existingEntry = yield* lstatPathWithoutFollowing("push", blobPath);
    if (existingEntry !== null) {
      if (existingEntry.isSymbolicLink()) {
        return yield* repositoryError(
          "push",
          "integrity-failed",
          `Existing blob ${hash} is a symbolic link or junction.`,
        );
      }
      if (!existingEntry.isFile()) {
        return yield* repositoryError(
          "push",
          "integrity-failed",
          `Existing blob ${hash} is not a regular file.`,
        );
      }
      yield* assertRealPathContained(input.mirrorPath, blobPath).pipe(
        Effect.mapError((cause) => new ThreadSyncError({ ...cause, operation: "push" })),
      );
      const existingInfo = yield* fileSystem
        .stat(blobPath)
        .pipe(
          Effect.mapError((cause) =>
            repositoryError(
              "push",
              "integrity-failed",
              `Could not inspect existing blob ${hash}: ${String(cause)}`,
            ),
          ),
        );
      if (
        existingInfo.type !== "File" ||
        Number(existingInfo.size) !== bytes.byteLength ||
        Number(existingInfo.size) > THREAD_SYNC_MAX_BLOB_BYTES
      ) {
        return yield* repositoryError(
          "push",
          "integrity-failed",
          `Existing blob ${hash} is not a regular bounded file of the expected size.`,
        );
      }
      const existingBytes = yield* fileSystem
        .readFile(blobPath)
        .pipe(
          Effect.mapError((cause) =>
            repositoryError(
              "push",
              "integrity-failed",
              `Could not verify existing blob ${hash}: ${String(cause)}`,
            ),
          ),
        );
      const existingHash = NodeCrypto.createHash("sha256").update(existingBytes).digest("hex");
      if (existingBytes.byteLength !== bytes.byteLength || existingHash !== hash) {
        return yield* repositoryError(
          "push",
          "integrity-failed",
          `Existing blob ${hash} failed size or SHA-256 verification.`,
        );
      }
    } else {
      yield* Effect.scoped(
        fileSystem.open(blobPath, { flag: "wx" }).pipe(
          Effect.flatMap((file) => file.writeAll(bytes)),
          Effect.mapError((cause) =>
            repositoryError(
              "push",
              "integrity-failed",
              `Could not exclusively create blob ${hash}: ${String(cause)}`,
            ),
          ),
        ),
      );
    }
  }

  const reconcileDirectory = Effect.fn("ThreadSyncRepository.reconcileDirectory")(function* (
    directoryPath: string,
    desiredNames: ReadonlySet<string>,
    filePattern: RegExp,
  ) {
    const names = yield* fileSystem
      .readDirectory(directoryPath)
      .pipe(Effect.mapError((cause) => repositoryError("push", "io-failed", String(cause))));
    if (names.length > MAX_DOCUMENT_COUNT + MAX_BLOB_COUNT) {
      return yield* repositoryError(
        "push",
        "integrity-failed",
        "The sync repository contains too many managed files.",
      );
    }
    for (const name of names) {
      if (!filePattern.test(name)) {
        return yield* repositoryError(
          "push",
          "integrity-failed",
          `Unexpected file in a managed sync directory: ${name}`,
        );
      }
      if (desiredNames.has(name)) continue;
      const stalePath = path.join(directoryPath, name);
      yield* assertRealPathContained(input.mirrorPath, stalePath).pipe(
        Effect.mapError((cause) => new ThreadSyncError({ ...cause, operation: "push" })),
      );
      yield* fileSystem
        .remove(stalePath)
        .pipe(Effect.mapError((cause) => repositoryError("push", "io-failed", String(cause))));
    }
  });
  yield* reconcileDirectory(
    projectsPath,
    new Set([...input.projects.keys()].map(threadSyncDocumentFileName)),
    /^[a-f0-9]{64}\.json$/,
  );
  yield* reconcileDirectory(
    threadsPath,
    new Set([...input.threads.keys()].map(threadSyncDocumentFileName)),
    /^[a-f0-9]{64}\.json$/,
  );
  yield* reconcileDirectory(
    blobsPath,
    new Set([...attachments.keys()].map(threadSyncBlobFileName)),
    /^[a-f0-9]{64}\.blob$/,
  );

  const manifest: ThreadSyncManifest = {
    formatVersion: THREAD_SYNC_FORMAT_VERSION,
    kind: "erebus-thread-sync",
    updatedAt: input.updatedAt,
  };
  yield* writeText(manifestPath, manifest, "manifest");
});
