import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  EventId,
  MessageId,
  OrchestrationProposedPlanId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ThreadSyncError,
  ThreadSyncImportStageId,
  TurnId,
  type ChatAttachment,
  type IsoDateTime,
  type OrchestrationCommand,
  type ProjectId,
  type ThreadId,
  type ThreadSyncBindingUpdate,
  type ThreadSyncImageAttachment,
  type ThreadSyncImportLocalState,
  type ThreadSyncImportV2Descriptor,
  type ThreadSyncImportV2Record,
  type ThreadSyncImportV2VisibleHistory,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { OrchestrationDispatchError } from "../orchestration/Errors.ts";
import {
  canonicalThreadSyncImportRecord,
  type ThreadSyncImportStageProgress,
  threadSyncImportDescriptorHash,
} from "../orchestration/ThreadSyncImportProjection.ts";
import type { ThreadSyncV2ThreadReader } from "./ThreadSyncRepositoryV2.ts";

const MAX_RECORDS_PER_EVENT = 64;
const MAX_EVENT_RECORD_BYTES = 1024 * 1024;
const MAX_IMPORT_ATTACHMENTS = 512;
const MAX_IMPORT_ATTACHMENT_BYTES = 256 * 1024 * 1024;
const ATTACHMENT_RECOVERY_LIMIT = 32;

export interface ThreadSyncV2ImportThreadReference {
  readonly localThreadId: ThreadId;
  readonly projectId: ProjectId | null;
  readonly deletedAt: IsoDateTime | null;
}

export interface ThreadSyncV2ImportReferences {
  readonly threadIds: ReadonlyMap<ThreadId, ThreadSyncV2ImportThreadReference>;
  /** Selected imports whose local plan ids can be derived without pre-reading their record streams. */
  readonly selectedImports: ReadonlyMap<
    ThreadId,
    {
      readonly targetThreadId: ThreadId;
      readonly sourceRevision: string;
    }
  >;
  readonly planIds: ReadonlyMap<
    ThreadId,
    ReadonlyMap<OrchestrationProposedPlanId, OrchestrationProposedPlanId>
  >;
}

export interface ThreadSyncV2ImportSelection {
  readonly reader: ThreadSyncV2ThreadReader;
  readonly targetThreadId: ThreadId;
  readonly projectId: ProjectId | null;
  readonly mode: "create" | "replace";
  readonly expectedLocalUpdatedAt: IsoDateTime | null;
  readonly localState?: ThreadSyncImportLocalState;
  readonly bindingUpdates: ReadonlyArray<ThreadSyncBindingUpdate>;
  readonly references: ThreadSyncV2ImportReferences;
}

export interface ThreadSyncV2ImportResult {
  readonly sequence: number;
  readonly stageId: ThreadSyncImportStageId;
  readonly stagedHash: string;
  readonly recordCount: number;
  /** Exact attachment set referenced after commit, for post-commit stale-file pruning. */
  readonly attachments: ReadonlyArray<ChatAttachment>;
}

export interface ThreadSyncV2StagedAttachment {
  readonly attachment: ChatAttachment;
  readonly blobHash: string;
  readonly finalRelativePath: string;
  readonly sourceMessageId: MessageId;
  readonly index: number;
}

export interface ThreadSyncV2AttachmentStage {
  readonly recover: (input: {
    readonly now: IsoDateTime;
    readonly limit: number;
  }) => Effect.Effect<void, ThreadSyncError>;
  readonly list: (input: {
    readonly stageId: ThreadSyncImportStageId;
  }) => Effect.Effect<ReadonlyArray<ThreadSyncV2StagedAttachment>, ThreadSyncError>;
  readonly write: (input: {
    readonly stageId: ThreadSyncImportStageId;
    readonly sourceThreadId: ThreadId;
    readonly targetThreadId: ThreadId;
    readonly sourceRevision: string;
    readonly sourceMessageId: MessageId;
    readonly targetMessageId: MessageId;
    readonly index: number;
    readonly attachment: ThreadSyncImageAttachment;
  }) => Effect.Effect<ThreadSyncV2StagedAttachment, ThreadSyncError>;
  readonly prepareCommit: (input: {
    readonly stageId: ThreadSyncImportStageId;
    readonly attachments: ReadonlyArray<ThreadSyncV2StagedAttachment>;
  }) => Effect.Effect<ReadonlyArray<ThreadSyncV2StagedAttachment>, ThreadSyncError>;
  readonly completeCommit: (input: {
    readonly stageId: ThreadSyncImportStageId;
    readonly attachments: ReadonlyArray<ThreadSyncV2StagedAttachment>;
  }) => Effect.Effect<void, ThreadSyncError>;
  readonly abort: (input: {
    readonly stageId: ThreadSyncImportStageId;
    readonly attachments: ReadonlyArray<ThreadSyncV2StagedAttachment>;
    readonly prepared: boolean;
  }) => Effect.Effect<void>;
}

type Dispatch = (
  command: OrchestrationCommand,
) => Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchError>;

type TextValidation = {
  readonly ownerKind: "message" | "plan" | "activity";
  readonly ownerId: string;
  readonly descriptor: {
    readonly sha256: string;
    readonly sizeBytes: number;
    readonly fragmentCount: number;
  };
  readonly hash: ReturnType<typeof NodeCrypto.createHash>;
  nextFragmentIndex: number;
  sizeBytes: number;
  hasNonWhitespace: boolean;
};

function syncImportError(code: ThreadSyncError["code"], detail: string): ThreadSyncError {
  return new ThreadSyncError({ operation: "import", code, detail });
}

function stableUuid(seed: string): string {
  const bytes = NodeCrypto.createHash("sha256").update(seed, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function importedId(
  prefix: string,
  sourceThreadId: ThreadId,
  targetThreadId: ThreadId,
  sourceRevision: string,
  sourceId: string,
): string {
  return `${prefix}-${stableUuid(
    [sourceThreadId, targetThreadId, sourceRevision, prefix, sourceId].join("\0"),
  )}`;
}

export function threadSyncV2ImportedTurnId(input: {
  readonly sourceThreadId: ThreadId;
  readonly targetThreadId: ThreadId;
  readonly sourceRevision: string;
  readonly sourceId: TurnId;
}): TurnId {
  return TurnId.make(
    importedId(
      "turn",
      input.sourceThreadId,
      input.targetThreadId,
      input.sourceRevision,
      input.sourceId,
    ),
  );
}

export function threadSyncV2ImportedMessageId(input: {
  readonly sourceThreadId: ThreadId;
  readonly targetThreadId: ThreadId;
  readonly sourceRevision: string;
  readonly sourceId: MessageId;
}): MessageId {
  return MessageId.make(
    importedId(
      "message",
      input.sourceThreadId,
      input.targetThreadId,
      input.sourceRevision,
      input.sourceId,
    ),
  );
}

export function threadSyncV2ImportedPlanId(input: {
  readonly sourceThreadId: ThreadId;
  readonly targetThreadId: ThreadId;
  readonly sourceRevision: string;
  readonly sourceId: OrchestrationProposedPlanId;
}): OrchestrationProposedPlanId {
  return OrchestrationProposedPlanId.make(
    importedId(
      "plan",
      input.sourceThreadId,
      input.targetThreadId,
      input.sourceRevision,
      input.sourceId,
    ),
  );
}

export function threadSyncV2ImportedAttachmentId(input: {
  readonly threadSegment: string;
  readonly sourceThreadId: ThreadId;
  readonly targetThreadId: ThreadId;
  readonly sourceRevision: string;
  readonly sourceMessageId: MessageId;
  readonly index: number;
  readonly blobHash: string;
}): string {
  return `${input.threadSegment}-${stableUuid(
    [
      input.sourceThreadId,
      input.targetThreadId,
      input.sourceRevision,
      input.sourceMessageId,
      input.index,
      input.blobHash,
    ].join("\0"),
  )}`;
}

function validateCompletedText(state: TextValidation): ThreadSyncError | null {
  if (state.nextFragmentIndex !== state.descriptor.fragmentCount) {
    return syncImportError(
      "integrity-failed",
      `Synchronized ${state.ownerKind} '${state.ownerId}' ended before all text fragments arrived.`,
    );
  }
  const digest = state.hash.digest("hex");
  if (state.sizeBytes !== state.descriptor.sizeBytes || digest !== state.descriptor.sha256) {
    return syncImportError(
      "integrity-failed",
      `Synchronized ${state.ownerKind} '${state.ownerId}' failed text size or SHA-256 validation.`,
    );
  }
  if (state.ownerKind !== "message" && !state.hasNonWhitespace) {
    return syncImportError(
      "integrity-failed",
      `Synchronized ${state.ownerKind} '${state.ownerId}' reconstructed blank text.`,
    );
  }
  return null;
}

function confirmDispatch(dispatch: Dispatch, command: OrchestrationCommand) {
  return Effect.gen(function* () {
    const first = yield* Effect.result(dispatch(command));
    if (first._tag === "Success") return first.success;
    return yield* dispatch(command);
  }).pipe(
    Effect.mapError((cause) =>
      syncImportError("conflict", `Could not persist a staged v2 import event: ${String(cause)}`),
    ),
  );
}

export function stageThreadSyncV2Import(input: {
  readonly selection: ThreadSyncV2ImportSelection;
  readonly importedAt: IsoDateTime;
  readonly dispatch: Dispatch;
  readonly resumeStage: (input: {
    readonly descriptor: ThreadSyncImportV2Descriptor;
    readonly now: IsoDateTime;
  }) => Effect.Effect<ThreadSyncImportStageProgress | null, ThreadSyncError>;
  readonly prepareStage: (input: {
    readonly descriptor: ThreadSyncImportV2Descriptor;
  }) => Effect.Effect<
    {
      readonly stagedHash: string;
      readonly visibleHistory: ThreadSyncImportV2VisibleHistory;
    },
    ThreadSyncError
  >;
  readonly attachmentStage: ThreadSyncV2AttachmentStage;
}): Effect.Effect<ThreadSyncV2ImportResult, ThreadSyncError> {
  return Effect.suspend(() => {
    let stageId = ThreadSyncImportStageId.make(`thread-sync-v2-stage-${NodeCrypto.randomUUID()}`);
    let stagedAttachments: ReadonlyArray<ThreadSyncV2StagedAttachment> = [];
    let preparedAttachments = false;
    return Effect.gen(function* () {
      const { selection } = input;
      const { manifest } = selection.reader;
      const sourceThreadId = manifest.header.threadId;
      const sourceRevision = manifest.revision;
      const idInput = { sourceThreadId, targetThreadId: selection.targetThreadId, sourceRevision };
      const resolveThread = (
        portableThreadId: ThreadId,
      ): ThreadSyncV2ImportThreadReference | null =>
        portableThreadId === sourceThreadId
          ? {
              localThreadId: selection.targetThreadId,
              projectId: selection.projectId,
              deletedAt: manifest.header.lifecycle.deletedAt,
            }
          : (selection.references.threadIds.get(portableThreadId) ?? null);
      const resolvePlan = (
        portableThreadId: ThreadId,
        portablePlanId: OrchestrationProposedPlanId,
      ): OrchestrationProposedPlanId | null => {
        const selectedImport =
          portableThreadId === sourceThreadId
            ? { targetThreadId: selection.targetThreadId, sourceRevision }
            : selection.references.selectedImports.get(portableThreadId);
        return selectedImport === undefined
          ? (selection.references.planIds.get(portableThreadId)?.get(portablePlanId) ?? null)
          : threadSyncV2ImportedPlanId({
              sourceThreadId: portableThreadId,
              targetThreadId: selectedImport.targetThreadId,
              sourceRevision: selectedImport.sourceRevision,
              sourceId: portablePlanId,
            });
      };
      const parentReference =
        manifest.header.coagent === null
          ? null
          : resolveThread(manifest.header.coagent.parentThreadId);
      const coagent =
        manifest.header.coagent !== null &&
        parentReference !== null &&
        parentReference.localThreadId !== selection.targetThreadId &&
        parentReference.projectId === selection.projectId &&
        parentReference.deletedAt === null
          ? {
              parentThreadId: parentReference.localThreadId,
              creationMode: manifest.header.coagent.creationMode,
              status: manifest.header.coagent.status,
            }
          : null;
      const latestTurnId =
        manifest.header.latestTurnId === null
          ? null
          : threadSyncV2ImportedTurnId({ ...idInput, sourceId: manifest.header.latestTurnId });
      const candidateDescriptor: ThreadSyncImportV2Descriptor = {
        stageId,
        mode: selection.mode,
        threadId: selection.targetThreadId,
        projectId: selection.projectId,
        expectedLocalUpdatedAt: selection.expectedLocalUpdatedAt,
        ...(selection.localState === undefined ? {} : { localState: selection.localState }),
        header: {
          title: manifest.header.title,
          coagent,
          latestTurnId,
          lifecycle: manifest.header.lifecycle,
          createdAt: manifest.header.createdAt,
          updatedAt: manifest.header.updatedAt,
        },
        sourceRevision,
        // V2 provenance is the verified logical manifest revision. The final
        // remapped stream has its own stagedHash and never reuses this value.
        sourceHash: sourceRevision,
        recordCount: manifest.recordCount,
        bindingUpdates: selection.bindingUpdates,
      };

      yield* input.attachmentStage.recover({
        now: input.importedAt,
        limit: ATTACHMENT_RECOVERY_LIMIT,
      });
      const resume = yield* input.resumeStage({
        descriptor: candidateDescriptor,
        now: input.importedAt,
      });
      if (resume !== null) stageId = resume.stageId;
      const descriptor: ThreadSyncImportV2Descriptor = {
        ...candidateDescriptor,
        stageId,
      };
      yield* confirmDispatch(input.dispatch, {
        type: "thread.sync.import-v2.start",
        commandId: CommandId.make(`thread-sync-v2-start-${stableUuid(stageId)}`),
        descriptor,
        startedAt: input.importedAt,
      });

      let batch: ThreadSyncImportV2Record[] = [];
      let batchBytes = 0;
      let chunkIndex = resume?.nextChunkIndex ?? 0;
      let nextOrdinal = resume?.nextOrdinal ?? 0;
      let textState: TextValidation | null = null;
      let skippingResumedTextPrefix = resume !== null && resume.nextOrdinal > 0;
      const recoveredAttachments = yield* input.attachmentStage.list({ stageId });
      const importedAttachments = new Map(
        recoveredAttachments.map((attachment) => [attachment.attachment.id, attachment] as const),
      );
      const attachmentsBySource = new Map<string, ThreadSyncV2StagedAttachment>(
        recoveredAttachments.map(
          (attachment) =>
            [`${attachment.sourceMessageId}\0${attachment.index}`, attachment] as const,
        ),
      );
      stagedAttachments = [...importedAttachments.values()];
      let attachmentCount = stagedAttachments.length;
      let attachmentBytes = stagedAttachments.reduce(
        (total, attachment) => total + attachment.attachment.sizeBytes,
        0,
      );
      if (
        attachmentCount > MAX_IMPORT_ATTACHMENTS ||
        attachmentBytes > MAX_IMPORT_ATTACHMENT_BYTES
      ) {
        return yield* syncImportError(
          "integrity-failed",
          "The resumed synchronized thread exceeds the expanded attachment import budget.",
        );
      }

      const flush = Effect.fn("ThreadSyncImportV2.flush")(function* () {
        if (batch.length === 0) return;
        const records = batch;
        const chunkHash = NodeCrypto.createHash("sha256")
          .update(records.map(canonicalThreadSyncImportRecord).join(""), "utf8")
          .digest("hex");
        yield* confirmDispatch(input.dispatch, {
          type: "thread.sync.import-v2.chunk",
          commandId: CommandId.make(
            `thread-sync-v2-chunk-${stableUuid(`${stageId}\0${chunkIndex}\0${chunkHash}`)}`,
          ),
          stageId,
          threadId: selection.targetThreadId,
          chunkIndex,
          chunkHash,
          records,
          appendedAt: input.importedAt,
        });
        chunkIndex += 1;
        batch = [];
        batchBytes = 0;
      });

      const beginText = (
        ownerKind: TextValidation["ownerKind"],
        ownerId: string,
        descriptor: TextValidation["descriptor"],
      ): ThreadSyncError | null => {
        if (textState !== null) {
          return syncImportError(
            "integrity-failed",
            `Synchronized ${textState.ownerKind} '${textState.ownerId}' has interleaved text fragments.`,
          );
        }
        textState = {
          ownerKind,
          ownerId,
          descriptor,
          hash: NodeCrypto.createHash("sha256"),
          nextFragmentIndex: 0,
          sizeBytes: 0,
          hasNonWhitespace: false,
        };
        if (descriptor.fragmentCount === 0) {
          const error = validateCompletedText(textState);
          textState = null;
          return error;
        }
        return null;
      };

      const acceptFragment = (
        ownerKind: TextValidation["ownerKind"],
        ownerId: string,
        fragmentIndex: number,
        text: string,
      ): ThreadSyncError | null => {
        if (
          textState === null ||
          textState.ownerKind !== ownerKind ||
          textState.ownerId !== ownerId ||
          textState.nextFragmentIndex !== fragmentIndex
        ) {
          return syncImportError(
            "integrity-failed",
            `Synchronized ${ownerKind} '${ownerId}' has an invalid text fragment sequence.`,
          );
        }
        const bytes = Buffer.from(text, "utf8");
        textState.hash.update(bytes);
        textState.sizeBytes += bytes.byteLength;
        if (!textState.hasNonWhitespace && text.trim().length !== 0) {
          textState.hasNonWhitespace = true;
        }
        textState.nextFragmentIndex += 1;
        if (textState.nextFragmentIndex === textState.descriptor.fragmentCount) {
          const error = validateCompletedText(textState);
          textState = null;
          return error;
        }
        return null;
      };

      yield* Stream.runForEach(selection.reader.recordsFromOrdinal(nextOrdinal), (sourceRecord) =>
        Effect.gen(function* () {
          if (sourceRecord.ordinal !== nextOrdinal) {
            return yield* syncImportError(
              "integrity-failed",
              `The v2 thread stream skipped ordinal ${nextOrdinal}.`,
            );
          }
          const isTextFragment =
            sourceRecord.kind === "message-text" ||
            sourceRecord.kind === "plan-markdown" ||
            sourceRecord.kind === "activity-summary";
          if (skippingResumedTextPrefix && !isTextFragment) {
            skippingResumedTextPrefix = false;
          }
          if (textState !== null && !isTextFragment) {
            return yield* syncImportError(
              "integrity-failed",
              `Synchronized ${textState.ownerKind} '${textState.ownerId}' ended before its text fragments.`,
            );
          }

          let record: ThreadSyncImportV2Record;
          switch (sourceRecord.kind) {
            case "turn": {
              const sourceThread = sourceRecord.value.sourceProposedPlanThreadId;
              const sourcePlan = sourceRecord.value.sourceProposedPlanId;
              if ((sourceThread === null) !== (sourcePlan === null)) {
                return yield* syncImportError(
                  "integrity-failed",
                  `Turn '${sourceRecord.value.turnId}' has an incomplete synchronized plan reference.`,
                );
              }
              const resolvedThread = sourceThread === null ? null : resolveThread(sourceThread);
              const resolvedPlan =
                sourceThread === null || sourcePlan === null
                  ? null
                  : resolvePlan(sourceThread, sourcePlan);
              if (
                sourceThread !== null &&
                (resolvedThread === null ||
                  resolvedThread.deletedAt !== null ||
                  resolvedThread.projectId !== selection.projectId ||
                  resolvedPlan === null)
              ) {
                return yield* syncImportError(
                  "integrity-failed",
                  `Turn '${sourceRecord.value.turnId}' has an unavailable synchronized plan reference.`,
                );
              }
              record = {
                ordinal: sourceRecord.ordinal,
                kind: "turn",
                portableId: sourceRecord.value.turnId,
                value: {
                  ...sourceRecord.value,
                  turnId: threadSyncV2ImportedTurnId({
                    ...idInput,
                    sourceId: sourceRecord.value.turnId,
                  }),
                  pendingMessageId:
                    sourceRecord.value.pendingMessageId === null
                      ? null
                      : threadSyncV2ImportedMessageId({
                          ...idInput,
                          sourceId: sourceRecord.value.pendingMessageId,
                        }),
                  assistantMessageId:
                    sourceRecord.value.assistantMessageId === null
                      ? null
                      : threadSyncV2ImportedMessageId({
                          ...idInput,
                          sourceId: sourceRecord.value.assistantMessageId,
                        }),
                  sourceProposedPlanThreadId: resolvedThread?.localThreadId ?? null,
                  sourceProposedPlanId: resolvedPlan,
                },
              };
              break;
            }
            case "message": {
              const targetMessageId = threadSyncV2ImportedMessageId({
                ...idInput,
                sourceId: sourceRecord.value.id,
              });
              const sourceAttachments = sourceRecord.value.attachments;
              let newAttachmentCount = 0;
              let newAttachmentBytes = 0;
              if (sourceAttachments.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
                return yield* syncImportError(
                  "integrity-failed",
                  `Synchronized message '${sourceRecord.value.id}' has too many attachments.`,
                );
              }
              for (const [index, attachment] of sourceAttachments.entries()) {
                if (
                  !Number.isSafeInteger(attachment.sizeBytes) ||
                  attachment.sizeBytes < 0 ||
                  attachment.sizeBytes > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
                ) {
                  return yield* syncImportError(
                    "integrity-failed",
                    `Synchronized attachment '${attachment.name}' exceeds the local attachment limit.`,
                  );
                }
                const recovered = attachmentsBySource.get(`${sourceRecord.value.id}\0${index}`);
                if (recovered !== undefined) {
                  if (
                    recovered.blobHash !== attachment.blobHash ||
                    recovered.attachment.sizeBytes !== attachment.sizeBytes
                  ) {
                    return yield* syncImportError(
                      "integrity-failed",
                      `Synchronized attachment '${attachment.name}' conflicts with its resumed journal entry.`,
                    );
                  }
                  continue;
                }
                newAttachmentCount += 1;
                newAttachmentBytes += attachment.sizeBytes;
              }
              if (
                attachmentCount + newAttachmentCount > MAX_IMPORT_ATTACHMENTS ||
                attachmentBytes + newAttachmentBytes > MAX_IMPORT_ATTACHMENT_BYTES
              ) {
                return yield* syncImportError(
                  "integrity-failed",
                  "The synchronized thread exceeds the expanded attachment import budget.",
                );
              }
              attachmentCount += newAttachmentCount;
              attachmentBytes += newAttachmentBytes;
              const messageStagedAttachments = yield* Effect.forEach(
                sourceRecord.value.attachments,
                (attachment, index) => {
                  const sourceKey = `${sourceRecord.value.id}\0${index}`;
                  const recovered = attachmentsBySource.get(sourceKey);
                  if (recovered !== undefined) return Effect.succeed(recovered);
                  return input.attachmentStage
                    .write({
                      stageId,
                      sourceThreadId,
                      targetThreadId: selection.targetThreadId,
                      sourceRevision,
                      sourceMessageId: sourceRecord.value.id,
                      targetMessageId,
                      index,
                      attachment,
                    })
                    .pipe(
                      Effect.tap((written) =>
                        Effect.sync(() => attachmentsBySource.set(sourceKey, written)),
                      ),
                    );
                },
                { concurrency: 1 },
              );
              for (const attachment of messageStagedAttachments) {
                importedAttachments.set(attachment.attachment.id, attachment);
              }
              stagedAttachments = [...importedAttachments.values()];
              const messageValue = {
                ...sourceRecord.value,
                id: targetMessageId,
                attachments: messageStagedAttachments.map(({ attachment }) => attachment),
                turnId:
                  sourceRecord.value.turnId === null
                    ? null
                    : threadSyncV2ImportedTurnId({
                        ...idInput,
                        sourceId: sourceRecord.value.turnId,
                      }),
              };
              const error = beginText("message", sourceRecord.value.id, sourceRecord.value.text);
              if (error !== null) return yield* error;
              record = {
                ordinal: sourceRecord.ordinal,
                kind: "message",
                portableId: sourceRecord.value.id,
                value: messageValue,
              };
              break;
            }
            case "message-text": {
              if (!skippingResumedTextPrefix) {
                const error = acceptFragment(
                  "message",
                  sourceRecord.messageId,
                  sourceRecord.fragmentIndex,
                  sourceRecord.text,
                );
                if (error !== null) return yield* error;
              }
              record = {
                ...sourceRecord,
                messageId: threadSyncV2ImportedMessageId({
                  ...idInput,
                  sourceId: sourceRecord.messageId,
                }),
              };
              break;
            }
            case "plan": {
              const implementation =
                sourceRecord.value.implementationThreadId === null
                  ? null
                  : resolveThread(sourceRecord.value.implementationThreadId);
              if (
                sourceRecord.value.implementationThreadId !== null &&
                (implementation === null ||
                  implementation.deletedAt !== null ||
                  implementation.projectId !== selection.projectId)
              ) {
                return yield* syncImportError(
                  "integrity-failed",
                  `Plan '${sourceRecord.value.id}' has an unavailable implementation thread.`,
                );
              }
              const planValue = {
                ...sourceRecord.value,
                id: threadSyncV2ImportedPlanId({
                  ...idInput,
                  sourceId: sourceRecord.value.id,
                }),
                turnId:
                  sourceRecord.value.turnId === null
                    ? null
                    : threadSyncV2ImportedTurnId({
                        ...idInput,
                        sourceId: sourceRecord.value.turnId,
                      }),
                implementationThreadId: implementation?.localThreadId ?? null,
              };
              const error = beginText(
                "plan",
                sourceRecord.value.id,
                sourceRecord.value.planMarkdown,
              );
              if (error !== null) return yield* error;
              record = {
                ordinal: sourceRecord.ordinal,
                kind: "plan",
                portableId: sourceRecord.value.id,
                value: planValue,
              };
              break;
            }
            case "plan-markdown": {
              if (!skippingResumedTextPrefix) {
                const error = acceptFragment(
                  "plan",
                  sourceRecord.planId,
                  sourceRecord.fragmentIndex,
                  sourceRecord.text,
                );
                if (error !== null) return yield* error;
              }
              record = {
                ...sourceRecord,
                planId: threadSyncV2ImportedPlanId({
                  ...idInput,
                  sourceId: sourceRecord.planId,
                }),
              };
              break;
            }
            case "activity": {
              const activityValue = {
                ...sourceRecord.value,
                id: EventId.make(
                  importedId(
                    "activity",
                    sourceThreadId,
                    selection.targetThreadId,
                    sourceRevision,
                    sourceRecord.value.id,
                  ),
                ),
                turnId:
                  sourceRecord.value.turnId === null
                    ? null
                    : threadSyncV2ImportedTurnId({
                        ...idInput,
                        sourceId: sourceRecord.value.turnId,
                      }),
              };
              const error = beginText(
                "activity",
                sourceRecord.value.id,
                sourceRecord.value.summary,
              );
              if (error !== null) return yield* error;
              record = {
                ordinal: sourceRecord.ordinal,
                kind: "activity",
                portableId: sourceRecord.value.id,
                value: activityValue,
              };
              break;
            }
            case "activity-summary": {
              if (!skippingResumedTextPrefix) {
                const error = acceptFragment(
                  "activity",
                  sourceRecord.activityId,
                  sourceRecord.fragmentIndex,
                  sourceRecord.text,
                );
                if (error !== null) return yield* error;
              }
              record = {
                ...sourceRecord,
                activityId: EventId.make(
                  importedId(
                    "activity",
                    sourceThreadId,
                    selection.targetThreadId,
                    sourceRevision,
                    sourceRecord.activityId,
                  ),
                ),
              };
              break;
            }
          }

          const canonical = canonicalThreadSyncImportRecord(record);
          const recordBytes = Buffer.byteLength(canonical, "utf8");
          if (recordBytes > MAX_EVENT_RECORD_BYTES) {
            return yield* syncImportError(
              "integrity-failed",
              `Synchronized ${record.kind} record ${record.ordinal} exceeds the staged event limit.`,
            );
          }
          if (batch.length > 0 && batchBytes + recordBytes > MAX_EVENT_RECORD_BYTES) {
            yield* flush();
          }
          batch.push(record);
          batchBytes += recordBytes;
          nextOrdinal += 1;
          if (batch.length === MAX_RECORDS_PER_EVENT) yield* flush();
        }),
      );
      if (textState !== null) return yield* validateCompletedText(textState)!;
      if (nextOrdinal !== manifest.recordCount) {
        return yield* syncImportError(
          "integrity-failed",
          `The v2 thread declared ${manifest.recordCount} records but streamed ${nextOrdinal}.`,
        );
      }
      yield* flush();
      const preparedStage = yield* input.prepareStage({ descriptor });
      const finalStagedHash = preparedStage.stagedHash;
      const finalDescriptor = { ...descriptor, stagedHash: finalStagedHash };
      yield* confirmDispatch(input.dispatch, {
        type: "thread.sync.import-v2.validate",
        commandId: CommandId.make(
          `thread-sync-v2-validate-${stableUuid(`${stageId}\0${finalStagedHash}`)}`,
        ),
        descriptor: finalDescriptor,
        descriptorHash: threadSyncImportDescriptorHash(finalDescriptor),
        stagedHash: finalStagedHash,
        validatedAt: input.importedAt,
      });
      stagedAttachments = yield* input.attachmentStage.prepareCommit({
        stageId,
        attachments: stagedAttachments,
      });
      preparedAttachments = true;
      const committed = yield* confirmDispatch(input.dispatch, {
        type: "thread.sync.import-v2.commit",
        commandId: CommandId.make(
          `thread-sync-v2-commit-${stableUuid(`${stageId}\0${finalStagedHash}`)}`,
        ),
        descriptor: finalDescriptor,
        visibleHistory: preparedStage.visibleHistory,
        importedAt: input.importedAt,
      });
      yield* input.attachmentStage.completeCommit({
        stageId,
        attachments: stagedAttachments,
      });
      return {
        sequence: committed.sequence,
        stageId,
        stagedHash: finalStagedHash,
        recordCount: nextOrdinal,
        attachments: stagedAttachments.map(({ attachment }) => attachment),
      };
    }).pipe(
      Effect.tapError(() =>
        input.attachmentStage.abort({
          stageId,
          attachments: stagedAttachments,
          prepared: preparedAttachments,
        }),
      ),
    );
  });
}
