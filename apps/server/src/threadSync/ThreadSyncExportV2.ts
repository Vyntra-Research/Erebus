// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  ThreadSyncError,
  type ThreadId,
  type ThreadSyncImageAttachment,
  type ThreadSyncProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type {
  ProjectionSnapshotQueryShape,
  ProjectionThreadSyncActivityCursor,
  ProjectionThreadSyncEntityCursor,
  ProjectionThreadSyncExportActivityRow,
  ProjectionThreadSyncExportIndex,
  ProjectionThreadSyncExportMessageRow,
  ProjectionThreadSyncExportPlanRow,
  ProjectionThreadSyncExportThread,
  ProjectionThreadSyncExportTurnRow,
  ProjectionThreadSyncMessageMetadata,
  ProjectionThreadSyncTurnCursor,
} from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { canonicalThreadSyncJson } from "./ThreadSyncDocuments.ts";
import {
  THREAD_SYNC_V2_TEXT_FRAGMENT_BYTES,
  ThreadSyncV2ThreadHeader,
  type ThreadSyncV2Record,
  type ThreadSyncV2SourceRecord,
  type ThreadSyncV2ThreadSource,
} from "./ThreadSyncRepositoryV2.ts";

const EXPORT_PAGE_SIZE = 128;
const decodeHeader = Schema.decodeUnknownSync(ThreadSyncV2ThreadHeader);
const isThreadSyncError = Schema.is(ThreadSyncError);

type ExportStage = "turn" | "message" | "plan" | "activity" | "done";
type ExportCursor =
  | ProjectionThreadSyncTurnCursor
  | ProjectionThreadSyncEntityCursor
  | ProjectionThreadSyncActivityCursor;

interface ExportResumeState {
  readonly v: 1;
  readonly stage: ExportStage;
  /** Last fully emitted entity. The current text owner is deliberately not advanced yet. */
  readonly after: ExportCursor | null;
  readonly currentLocalId: string | null;
  readonly phase: "metadata" | "text";
  readonly fragmentIndex: number;
  readonly byteOffset: number;
  readonly ordinal: number;
}

interface TextDescriptor {
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly fragmentCount: number;
}

function updateResumeState(
  state: ExportResumeState,
  update: Partial<ExportResumeState>,
): ExportResumeState {
  return Object.assign({}, state, update);
}

export interface ProjectionThreadSyncV2ExportPreparation {
  readonly index: ProjectionThreadSyncExportIndex;
  readonly sources: ReadonlyArray<ThreadSyncV2ThreadSource<ThreadSyncError>>;
  readonly activeLocalThreadIds: ReadonlySet<ThreadId>;
}

function exportError(detail: string): ThreadSyncError {
  return new ThreadSyncError({ operation: "export", code: "integrity-failed", detail });
}

function requireQueryMethod<K extends keyof ProjectionSnapshotQueryShape>(
  query: ProjectionSnapshotQueryShape,
  key: K,
): NonNullable<ProjectionSnapshotQueryShape[K]> {
  const method = query[key];
  if (method === undefined) {
    throw exportError(`The projection query does not support bounded v2 export (${String(key)}).`);
  }
  return method as NonNullable<ProjectionSnapshotQueryShape[K]>;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isCursor(value: unknown): value is ExportCursor {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id === "string" && typeof candidate.createdAt === "string") {
    return (
      candidate.sequence === undefined ||
      candidate.sequence === null ||
      isNonNegativeSafeInteger(candidate.sequence)
    );
  }
  return (
    typeof candidate.requestedAt === "string" &&
    typeof candidate.startedAt === "string" &&
    typeof candidate.completedAt === "string" &&
    typeof candidate.turnId === "string"
  );
}

function parseResumeToken(value: string | null): ExportResumeState {
  if (value === null) {
    return {
      v: 1,
      stage: "turn",
      after: null,
      currentLocalId: null,
      phase: "metadata",
      fragmentIndex: 0,
      byteOffset: 0,
      ordinal: 0,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw exportError("A v2 export resume token is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw exportError("A v2 export resume token is invalid.");
  }
  const candidate = parsed as Record<string, unknown>;
  if (
    candidate.v !== 1 ||
    !["turn", "message", "plan", "activity", "done"].includes(String(candidate.stage)) ||
    (candidate.after !== null && !isCursor(candidate.after)) ||
    (candidate.currentLocalId !== null && typeof candidate.currentLocalId !== "string") ||
    !["metadata", "text"].includes(String(candidate.phase)) ||
    !isNonNegativeSafeInteger(candidate.fragmentIndex) ||
    !isNonNegativeSafeInteger(candidate.byteOffset) ||
    !isNonNegativeSafeInteger(candidate.ordinal)
  ) {
    throw exportError("A v2 export resume token is invalid.");
  }
  const state = candidate as unknown as ExportResumeState;
  if (
    (state.stage === "turn" && (state.phase !== "metadata" || state.currentLocalId !== null)) ||
    (state.stage === "done" && state.currentLocalId !== null) ||
    (state.phase === "metadata" &&
      (state.currentLocalId !== null || state.fragmentIndex !== 0 || state.byteOffset !== 0)) ||
    (state.phase === "text" && (state.currentLocalId === null || state.stage === "done"))
  ) {
    throw exportError("A v2 export resume token contains an inconsistent position.");
  }
  return state;
}

function encodeResumeToken(value: ExportResumeState): string {
  return JSON.stringify(value);
}

function nextStage(stage: Exclude<ExportStage, "done">): ExportStage {
  switch (stage) {
    case "turn":
      return "message";
    case "message":
      return "plan";
    case "plan":
      return "activity";
    case "activity":
      return "done";
  }
}

async function describeText(input: {
  readonly query: ProjectionSnapshotQueryShape;
  readonly threadSequence: number;
  readonly threadId: ThreadId;
  readonly field: "message-text" | "plan-markdown" | "activity-summary";
  readonly ownerId: string;
}): Promise<TextDescriptor> {
  const read = requireQueryMethod(input.query, "readThreadSyncExportTextChunk");
  const hash = NodeCrypto.createHash("sha256");
  let offset = 0;
  let sizeBytes = 0;
  let fragmentCount = 0;
  while (true) {
    const result = await Effect.runPromise(
      read({
        threadSequence: input.threadSequence,
        threadId: input.threadId,
        field: input.field,
        ownerId: input.ownerId,
        offset,
        maxBytes: THREAD_SYNC_V2_TEXT_FRAGMENT_BYTES,
      }),
    );
    if (Option.isNone(result)) {
      throw exportError(`A v2 ${input.field} owner disappeared during export.`);
    }
    const chunk = result.value;
    if (chunk.bytes.byteLength > 0) {
      hash.update(chunk.bytes);
      sizeBytes += chunk.bytes.byteLength;
      fragmentCount += 1;
    }
    if (chunk.done) break;
    if (chunk.bytes.byteLength === 0 || chunk.nextOffset <= offset) {
      throw exportError(`A v2 ${input.field} read made no progress.`);
    }
    offset = chunk.nextOffset;
  }
  return { sha256: hash.digest("hex"), sizeBytes, fragmentCount };
}

export function projectionThreadSyncV2Header(input: {
  readonly local: ProjectionThreadSyncExportThread;
  readonly syncProjectId: ThreadSyncProjectId | null;
  readonly syncThreadId: ThreadId;
  readonly syncThreadByLocal: ReadonlyMap<ThreadId, ThreadId>;
}) {
  const { local } = input;
  const localCoagent = local.coagent ?? null;
  let coagent: ThreadSyncV2ThreadHeader["coagent"] = null;
  if (localCoagent !== null && localCoagent.status !== "preparing") {
    const parentThreadId = input.syncThreadByLocal.get(localCoagent.parentThreadId);
    if (parentThreadId === undefined) {
      throw exportError(`Thread '${local.id}' has a co-agent parent without a sync binding.`);
    }
    coagent = {
      parentThreadId,
      creationMode: localCoagent.creationMode,
      status: localCoagent.status,
    };
  }
  return decodeHeader({
    formatVersion: 2,
    threadId: input.syncThreadId,
    syncProjectId: input.syncProjectId,
    title: local.title,
    coagent,
    latestTurnId: local.latestTurnId,
    lifecycle: local.lifecycle,
    createdAt: local.createdAt,
    updatedAt: local.updatedAt,
  });
}

function remapTurn(
  row: ProjectionThreadSyncExportTurnRow,
  syncThreadByLocal: ReadonlyMap<ThreadId, ThreadId>,
): Extract<ThreadSyncV2Record, { readonly kind: "turn" }>["value"] {
  const value = row.value;
  if ((value.sourceProposedPlanThreadId === null) !== (value.sourceProposedPlanId === null)) {
    throw exportError(`Turn '${value.turnId}' contains an incomplete plan reference.`);
  }
  if (value.sourceProposedPlanThreadId === null) return value;
  const sourceThreadId = syncThreadByLocal.get(value.sourceProposedPlanThreadId);
  if (sourceThreadId === undefined) {
    throw exportError(`Turn '${value.turnId}' references a thread without a sync binding.`);
  }
  return { ...value, sourceProposedPlanThreadId: sourceThreadId };
}

function remapPlan(
  row: ProjectionThreadSyncExportPlanRow,
  descriptor: TextDescriptor,
  syncThreadByLocal: ReadonlyMap<ThreadId, ThreadId>,
): Extract<ThreadSyncV2Record, { readonly kind: "plan" }>["value"] {
  const implementationThreadId =
    row.value.implementationThreadId === null
      ? null
      : syncThreadByLocal.get(row.value.implementationThreadId);
  if (implementationThreadId === undefined) {
    throw exportError(`Plan '${row.value.id}' references a thread without a sync binding.`);
  }
  return { ...row.value, planMarkdown: descriptor, implementationThreadId };
}

export function projectionThreadSyncV2SourceKey(input: {
  readonly header: ThreadSyncV2ThreadHeader;
  readonly threadSequence: number;
}): string {
  return NodeCrypto.createHash("sha256")
    .update(
      canonicalThreadSyncJson({
        formatVersion: 2,
        header: input.header,
        threadSequence: input.threadSequence,
      }),
      "utf8",
    )
    .digest("hex");
}

export function prepareProjectionThreadSyncV2Export(input: {
  readonly query: ProjectionSnapshotQueryShape;
  readonly index: ProjectionThreadSyncExportIndex;
  readonly syncProjectByLocalThread: ReadonlyMap<ThreadId, ThreadSyncProjectId | null>;
  readonly syncThreadByLocal: ReadonlyMap<ThreadId, ThreadId>;
  /** When present, only these local threads receive record sources. */
  readonly localThreadIds?: ReadonlySet<ThreadId>;
  /** Resolves and registers blobs before the repository freezes its source iterables. */
  readonly mapAttachments: (input: {
    readonly threadId: ThreadId;
    readonly message: ProjectionThreadSyncMessageMetadata;
  }) => Effect.Effect<ReadonlyArray<ThreadSyncImageAttachment>, ThreadSyncError>;
}): Effect.Effect<ProjectionThreadSyncV2ExportPreparation, ThreadSyncError> {
  return Effect.tryPromise({
    try: async () => {
      const turnsPage = requireQueryMethod(input.query, "listThreadSyncExportTurnsPage");
      const messagesPage = requireQueryMethod(input.query, "listThreadSyncExportMessagesPage");
      const plansPage = requireQueryMethod(input.query, "listThreadSyncExportPlansPage");
      const activitiesPage = requireQueryMethod(input.query, "listThreadSyncExportActivitiesPage");
      const readText = requireQueryMethod(input.query, "readThreadSyncExportTextChunk");
      const activeLocalThreadIds = new Set<ThreadId>();

      // This bounded scan registers blob sources before repository writing
      // begins. Attachment metadata is resolved again from the bounded message
      // page during emission instead of retaining it for the whole thread.
      for (const local of input.index.threads) {
        if (local.active) {
          activeLocalThreadIds.add(local.id);
          continue;
        }
        if (input.localThreadIds !== undefined && !input.localThreadIds.has(local.id)) continue;
        if (
          input.syncProjectByLocalThread.get(local.id) === undefined ||
          input.syncThreadByLocal.get(local.id) === undefined
        ) {
          continue;
        }
        let after: ProjectionThreadSyncEntityCursor | null = null;
        while (true) {
          const page: {
            readonly rows: ReadonlyArray<ProjectionThreadSyncExportMessageRow>;
            readonly next: ProjectionThreadSyncEntityCursor | null;
          } = await Effect.runPromise(
            messagesPage({
              threadSequence: local.threadSequence,
              threadId: local.id,
              after,
              limit: EXPORT_PAGE_SIZE,
              attachmentsOnly: true,
            }),
          );
          for (const row of page.rows) {
            if ((row.value.attachments?.length ?? 0) === 0) continue;
            await Effect.runPromise(
              input.mapAttachments({ threadId: local.id, message: row.value }),
            );
          }
          if (page.next === null) break;
          after = page.next;
        }
      }

      const sources: ThreadSyncV2ThreadSource<ThreadSyncError>[] = [];
      for (const local of input.index.threads) {
        if (local.active) continue;
        if (input.localThreadIds !== undefined && !input.localThreadIds.has(local.id)) continue;
        const syncProjectId = input.syncProjectByLocalThread.get(local.id);
        const syncThreadId = input.syncThreadByLocal.get(local.id);
        if (syncProjectId === undefined || syncThreadId === undefined) continue;
        const header = projectionThreadSyncV2Header({
          local,
          syncProjectId,
          syncThreadId,
          syncThreadByLocal: input.syncThreadByLocal,
        });
        const source: ThreadSyncV2ThreadSource<ThreadSyncError> = {
          sourceKey: projectionThreadSyncV2SourceKey({
            header,
            threadSequence: local.threadSequence,
          }),
          header,
          records: (resumeToken) => {
            async function* iterate(): AsyncGenerator<ThreadSyncV2SourceRecord> {
              let state = parseResumeToken(resumeToken);
              let cachedStage: Exclude<ExportStage, "done"> | null = null;
              let cachedRows: Array<
                | ProjectionThreadSyncExportTurnRow
                | ProjectionThreadSyncExportMessageRow
                | ProjectionThreadSyncExportPlanRow
                | ProjectionThreadSyncExportActivityRow
              > = [];
              while (state.stage !== "done") {
                if (state.stage === "turn") {
                  if (cachedStage !== "turn") {
                    cachedStage = "turn";
                    cachedRows = [];
                  }
                  if (cachedRows.length === 0) {
                    const page = await Effect.runPromise(
                      turnsPage({
                        threadSequence: local.threadSequence,
                        threadId: local.id,
                        after: state.after as ProjectionThreadSyncTurnCursor | null,
                        limit: EXPORT_PAGE_SIZE,
                      }),
                    );
                    cachedRows = [...page.rows];
                  }
                  const row = cachedRows[0] as ProjectionThreadSyncExportTurnRow | undefined;
                  if (row === undefined) {
                    state = updateResumeState(state, {
                      stage: nextStage(state.stage),
                      after: null,
                    });
                    cachedStage = null;
                    continue;
                  }
                  const next = updateResumeState(state, {
                    after: row.cursor,
                    ordinal: state.ordinal + 1,
                  });
                  yield {
                    record: {
                      ordinal: state.ordinal,
                      kind: "turn",
                      value: remapTurn(row, input.syncThreadByLocal),
                    },
                    nextResumeToken: encodeResumeToken(next),
                  };
                  state = next;
                  cachedRows.shift();
                  continue;
                }

                let row:
                  | ProjectionThreadSyncExportMessageRow
                  | ProjectionThreadSyncExportPlanRow
                  | ProjectionThreadSyncExportActivityRow
                  | undefined;
                if (cachedStage !== state.stage) {
                  cachedStage = state.stage;
                  cachedRows = [];
                }
                if (cachedRows.length === 0) {
                  if (state.stage === "message") {
                    cachedRows = [
                      ...(
                        await Effect.runPromise(
                          messagesPage({
                            threadSequence: local.threadSequence,
                            threadId: local.id,
                            after: state.after as ProjectionThreadSyncEntityCursor | null,
                            limit: EXPORT_PAGE_SIZE,
                          }),
                        )
                      ).rows,
                    ];
                  } else if (state.stage === "plan") {
                    cachedRows = [
                      ...(
                        await Effect.runPromise(
                          plansPage({
                            threadSequence: local.threadSequence,
                            threadId: local.id,
                            after: state.after as ProjectionThreadSyncEntityCursor | null,
                            limit: EXPORT_PAGE_SIZE,
                          }),
                        )
                      ).rows,
                    ];
                  } else {
                    cachedRows = [
                      ...(
                        await Effect.runPromise(
                          activitiesPage({
                            threadSequence: local.threadSequence,
                            threadId: local.id,
                            after: state.after as ProjectionThreadSyncActivityCursor | null,
                            limit: EXPORT_PAGE_SIZE,
                          }),
                        )
                      ).rows,
                    ];
                  }
                }
                row = cachedRows[0] as
                  | ProjectionThreadSyncExportMessageRow
                  | ProjectionThreadSyncExportPlanRow
                  | ProjectionThreadSyncExportActivityRow
                  | undefined;
                if (row === undefined) {
                  state = updateResumeState(state, {
                    stage: nextStage(state.stage),
                    after: null,
                    currentLocalId: null,
                    phase: "metadata",
                    fragmentIndex: 0,
                    byteOffset: 0,
                  });
                  cachedStage = null;
                  continue;
                }
                if (state.currentLocalId !== null && row.localId !== state.currentLocalId) {
                  throw exportError(
                    "A v2 export resume token no longer identifies its text owner.",
                  );
                }

                const field =
                  state.stage === "message"
                    ? "message-text"
                    : state.stage === "plan"
                      ? "plan-markdown"
                      : "activity-summary";
                const descriptor = await describeText({
                  query: input.query,
                  threadSequence: local.threadSequence,
                  threadId: local.id,
                  field,
                  ownerId: row.localId,
                });

                if (state.phase === "metadata") {
                  let record: ThreadSyncV2Record;
                  if (state.stage === "message") {
                    const message = row as ProjectionThreadSyncExportMessageRow;
                    record = {
                      ordinal: state.ordinal,
                      kind: "message",
                      value: {
                        ...message.value,
                        text: descriptor,
                        attachments: await Effect.runPromise(
                          input.mapAttachments({ threadId: local.id, message: message.value }),
                        ),
                        streaming: false,
                      },
                    };
                  } else if (state.stage === "plan") {
                    record = {
                      ordinal: state.ordinal,
                      kind: "plan",
                      value: remapPlan(
                        row as ProjectionThreadSyncExportPlanRow,
                        descriptor,
                        input.syncThreadByLocal,
                      ),
                    };
                  } else {
                    const activity = row as ProjectionThreadSyncExportActivityRow;
                    record = {
                      ordinal: state.ordinal,
                      kind: "activity",
                      value: {
                        ...activity.value,
                        summary: descriptor,
                        sequence: activity.value.sequence ?? null,
                      },
                    };
                  }
                  const next: ExportResumeState =
                    descriptor.fragmentCount === 0
                      ? updateResumeState(state, {
                          after: row.cursor,
                          ordinal: state.ordinal + 1,
                        })
                      : updateResumeState(state, {
                          currentLocalId: row.localId,
                          phase: "text",
                          ordinal: state.ordinal + 1,
                        });
                  yield { record, nextResumeToken: encodeResumeToken(next) };
                  state = next;
                  if (descriptor.fragmentCount === 0) {
                    cachedRows.shift();
                    continue;
                  }
                }

                // The descriptor pass and this emission pass are the only two
                // full reads of a large text field. Keep draining the current
                // owner here so fragment count does not turn into O(n²) I/O.
                while (state.phase === "text") {
                  if (state.fragmentIndex >= descriptor.fragmentCount) {
                    throw exportError(`A v2 ${field} resume token exceeds its fragment count.`);
                  }
                  const result = await Effect.runPromise(
                    readText({
                      threadSequence: local.threadSequence,
                      threadId: local.id,
                      field,
                      ownerId: row.localId,
                      offset: state.byteOffset,
                      maxBytes: THREAD_SYNC_V2_TEXT_FRAGMENT_BYTES,
                    }),
                  );
                  if (Option.isNone(result) || result.value.bytes.byteLength === 0) {
                    throw exportError(`A v2 ${field} owner disappeared or ended early.`);
                  }
                  const chunk = result.value;
                  const text = new TextDecoder("utf-8", { fatal: true }).decode(chunk.bytes);
                  const finalFragment = state.fragmentIndex + 1 === descriptor.fragmentCount;
                  if (finalFragment !== chunk.done || chunk.nextOffset <= state.byteOffset) {
                    throw exportError(`A v2 ${field} descriptor changed during export.`);
                  }
                  const next: ExportResumeState = finalFragment
                    ? updateResumeState(state, {
                        after: row.cursor,
                        currentLocalId: null,
                        phase: "metadata",
                        fragmentIndex: 0,
                        byteOffset: 0,
                        ordinal: state.ordinal + 1,
                      })
                    : updateResumeState(state, {
                        fragmentIndex: state.fragmentIndex + 1,
                        byteOffset: chunk.nextOffset,
                        ordinal: state.ordinal + 1,
                      });
                  const record: ThreadSyncV2Record =
                    state.stage === "message"
                      ? {
                          ordinal: state.ordinal,
                          kind: "message-text",
                          messageId: (row as ProjectionThreadSyncExportMessageRow).value.id,
                          fragmentIndex: state.fragmentIndex,
                          text,
                        }
                      : state.stage === "plan"
                        ? {
                            ordinal: state.ordinal,
                            kind: "plan-markdown",
                            planId: (row as ProjectionThreadSyncExportPlanRow).value.id,
                            fragmentIndex: state.fragmentIndex,
                            text,
                          }
                        : {
                            ordinal: state.ordinal,
                            kind: "activity-summary",
                            activityId: (row as ProjectionThreadSyncExportActivityRow).value.id,
                            fragmentIndex: state.fragmentIndex,
                            text,
                          };
                  yield { record, nextResumeToken: encodeResumeToken(next) };
                  state = next;
                  if (finalFragment) cachedRows.shift();
                }
              }
            }
            return Stream.fromAsyncIterable(iterate(), (cause) =>
              isThreadSyncError(cause)
                ? cause
                : exportError(cause instanceof Error ? cause.message : String(cause)),
            );
          },
        };
        sources.push(source);
      }

      return { index: input.index, sources, activeLocalThreadIds };
    },
    catch: (cause) =>
      isThreadSyncError(cause)
        ? cause
        : exportError(cause instanceof Error ? cause.message : String(cause)),
  });
}
