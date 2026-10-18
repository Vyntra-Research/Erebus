import * as NodeCrypto from "node:crypto";

import {
  EventId,
  MessageId,
  OrchestrationProposedPlanId,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  ThreadSyncError,
  ThreadSyncImportStageId,
  ThreadSyncProjectId,
  ThreadSyncRevision,
  TurnId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import {
  stageThreadSyncV2Import,
  threadSyncV2ImportedMessageId,
  threadSyncV2ImportedPlanId,
  threadSyncV2ImportedTurnId,
  type ThreadSyncV2AttachmentStage,
} from "./ThreadSyncImportV2.ts";
import type { ThreadSyncV2Record, ThreadSyncV2ThreadReader } from "./ThreadSyncRepositoryV2.ts";

const importedAt = "2026-10-17T18:00:00.000Z";
const sourceThreadId = ThreadId.make("portable-v2-child");
const sourceParentId = ThreadId.make("portable-v2-parent");
const targetThreadId = ThreadId.make("local-v2-child");
const targetParentId = ThreadId.make("local-v2-parent");
const projectId = ProjectId.make("project-v2-import");
const sourceTurnId = TurnId.make("portable-turn-v2");
const sourceMessageId = MessageId.make("portable-message-v2");
const sourceRevision = ThreadSyncRevision.make("a".repeat(64));
const syncProjectId = ThreadSyncProjectId.make("portable-project-v2");
const text = "verified streamed text";

const noAttachmentStage = {
  recover: () => Effect.void,
  list: () => Effect.succeed([]),
  write: () => Effect.die(new Error("the fixture has no synchronized attachments")),
  prepareCommit: ({ attachments }) => Effect.succeed(attachments),
  completeCommit: () => Effect.void,
  abort: () => Effect.void,
} satisfies ThreadSyncV2AttachmentStage;

const resumeStage = () => Effect.succeed(null);
const emptyVisibleHistory = {
  latestTurn: null,
  messages: [],
  proposedPlans: [],
  activities: [],
} as const;
const prepareStage = () =>
  Effect.succeed({ stagedHash: "0".repeat(64), visibleHistory: emptyVisibleHistory });

function sha256(value: string): string {
  return NodeCrypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function reader(textHash = sha256(text)): ThreadSyncV2ThreadReader {
  const records: ReadonlyArray<ThreadSyncV2Record> = [
    {
      ordinal: 0,
      kind: "message",
      value: {
        id: sourceMessageId,
        role: "assistant",
        text: {
          sha256: textHash,
          sizeBytes: Buffer.byteLength(text, "utf8"),
          fragmentCount: 1,
        },
        attachments: [],
        turnId: sourceTurnId,
        streaming: false,
        createdAt: importedAt,
        updatedAt: importedAt,
      },
    },
    {
      ordinal: 1,
      kind: "message-text",
      messageId: sourceMessageId,
      fragmentIndex: 0,
      text,
    },
    {
      ordinal: 2,
      kind: "turn",
      value: {
        turnId: sourceTurnId,
        pendingMessageId: null,
        sourceProposedPlanThreadId: null,
        sourceProposedPlanId: null,
        assistantMessageId: sourceMessageId,
        state: "completed",
        requestedAt: importedAt,
        startedAt: importedAt,
        completedAt: importedAt,
      },
    },
  ];
  return {
    manifest: {
      formatVersion: 2,
      kind: "erebus-thread-sync-thread",
      sourceKeyHash: "b".repeat(64),
      revision: sourceRevision,
      header: {
        formatVersion: 2,
        threadId: sourceThreadId,
        syncProjectId,
        title: "Imported child",
        coagent: {
          parentThreadId: sourceParentId,
          creationMode: "fork",
          status: "ready",
        },
        latestTurnId: sourceTurnId,
        lifecycle: {
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          deletedAt: null,
        },
        createdAt: importedAt,
        updatedAt: importedAt,
      },
      recordCount: records.length,
      rowCount: records.length,
      chunks: [],
    },
    records: Stream.fromIterable(records),
    recordsFromOrdinal: (ordinal) => Stream.fromIterable(records.slice(ordinal)),
  };
}

function readerWithRecords(
  records: ReadonlyArray<ThreadSyncV2Record>,
  latestTurnId: TurnId | null = null,
): ThreadSyncV2ThreadReader {
  const base = reader();
  return {
    manifest: {
      ...base.manifest,
      header: { ...base.manifest.header, latestTurnId },
      recordCount: records.length,
      rowCount: records.length,
    },
    records: Stream.fromIterable(records),
    recordsFromOrdinal: (ordinal) => Stream.fromIterable(records.slice(ordinal)),
  };
}

it.effect("streams a remapped v2 import through bounded staged commands", () =>
  Effect.gen(function* () {
    const commands: OrchestrationCommand[] = [];
    let sequence = 0;
    const result = yield* stageThreadSyncV2Import({
      selection: {
        reader: reader(),
        targetThreadId,
        projectId,
        mode: "create",
        expectedLocalUpdatedAt: null,
        localState: {
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex-local"),
            model: "gpt-local",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          linkedPullRequest: null,
        },
        bindingUpdates: [
          {
            syncThreadId: sourceThreadId,
            localThreadId: targetThreadId,
            syncProjectId,
            localProjectId: projectId,
            baseRevision: sourceRevision,
          },
        ],
        references: {
          threadIds: new Map([
            [sourceParentId, { localThreadId: targetParentId, projectId, deletedAt: null }],
          ]),
          selectedImports: new Map(),
          planIds: new Map(),
        },
      },
      importedAt,
      dispatch: (command) =>
        Effect.sync(() => {
          commands.push(command);
          sequence += 1;
          return { sequence };
        }),
      resumeStage,
      prepareStage,
      attachmentStage: noAttachmentStage,
    });

    assert.equal(result.recordCount, 3);
    assert.notEqual(result.stagedHash, sourceRevision);
    assert.deepEqual(
      commands.map((command) => command.type),
      [
        "thread.sync.import-v2.start",
        "thread.sync.import-v2.chunk",
        "thread.sync.import-v2.validate",
        "thread.sync.import-v2.commit",
      ],
    );
    const started = commands[0];
    assert.equal(started?.type, "thread.sync.import-v2.start");
    if (started?.type !== "thread.sync.import-v2.start") return;
    assert.deepEqual(started.descriptor.header.coagent, {
      parentThreadId: targetParentId,
      creationMode: "fork",
      status: "ready",
    });
    assert.equal(started.descriptor.sourceRevision, sourceRevision);
    assert.equal(started.descriptor.stagedHash, undefined);

    const chunk = commands[1];
    assert.equal(chunk?.type, "thread.sync.import-v2.chunk");
    if (chunk?.type !== "thread.sync.import-v2.chunk") return;
    assert.equal(chunk.records.length, 3);
    const message = chunk.records.find((record) => record.kind === "message");
    const turn = chunk.records.find((record) => record.kind === "turn");
    assert.equal(
      message?.kind === "message" ? message.value.id : null,
      threadSyncV2ImportedMessageId({
        sourceThreadId,
        targetThreadId,
        sourceRevision,
        sourceId: sourceMessageId,
      }),
    );
    assert.equal(
      turn?.kind === "turn" ? turn.value.turnId : null,
      threadSyncV2ImportedTurnId({
        sourceThreadId,
        targetThreadId,
        sourceRevision,
        sourceId: sourceTurnId,
      }),
    );

    const committed = commands[3];
    assert.equal(committed?.type, "thread.sync.import-v2.commit");
    if (committed?.type !== "thread.sync.import-v2.commit") return;
    assert.equal(committed.descriptor.stagedHash, result.stagedHash);
    assert.deepEqual(committed.visibleHistory, emptyVisibleHistory);
  }),
);

it.effect("does not emit a final import event when streamed text fails its descriptor hash", () =>
  Effect.gen(function* () {
    const commands: OrchestrationCommand[] = [];
    const failure = yield* Effect.flip(
      stageThreadSyncV2Import({
        selection: {
          reader: reader("f".repeat(64)),
          targetThreadId,
          projectId,
          mode: "create",
          expectedLocalUpdatedAt: null,
          localState: {
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex-local"),
              model: "gpt-local",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            linkedPullRequest: null,
          },
          bindingUpdates: [
            {
              syncThreadId: sourceThreadId,
              localThreadId: targetThreadId,
              syncProjectId,
              localProjectId: projectId,
              baseRevision: sourceRevision,
            },
          ],
          references: { threadIds: new Map(), selectedImports: new Map(), planIds: new Map() },
        },
        importedAt,
        dispatch: (command) =>
          Effect.sync(() => {
            commands.push(command);
            return { sequence: commands.length };
          }),
        resumeStage,
        prepareStage,
        attachmentStage: noAttachmentStage,
      }),
    );
    assert.equal(failure.code, "integrity-failed");
    assert.deepEqual(
      commands.map((command) => command.type),
      ["thread.sync.import-v2.start"],
    );
  }),
);

it.effect("does not dispatch validation or final events when SQL precommit validation fails", () =>
  Effect.gen(function* () {
    const commands: OrchestrationCommand[] = [];
    const failure = yield* Effect.flip(
      stageThreadSyncV2Import({
        selection: {
          reader: reader(),
          targetThreadId,
          projectId,
          mode: "create",
          expectedLocalUpdatedAt: null,
          localState: {
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex-local"),
              model: "gpt-local",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            linkedPullRequest: null,
          },
          bindingUpdates: [
            {
              syncThreadId: sourceThreadId,
              localThreadId: targetThreadId,
              syncProjectId,
              localProjectId: projectId,
              baseRevision: sourceRevision,
            },
          ],
          references: { threadIds: new Map(), selectedImports: new Map(), planIds: new Map() },
        },
        importedAt,
        dispatch: (command) =>
          Effect.sync(() => {
            commands.push(command);
            return { sequence: commands.length };
          }),
        resumeStage,
        prepareStage: () =>
          Effect.fail(
            new ThreadSyncError({
              operation: "import",
              code: "integrity-failed",
              detail: "precommit rejected",
            }),
          ),
        attachmentStage: noAttachmentStage,
      }),
    );
    assert.equal(failure.code, "integrity-failed");
    assert.deepEqual(
      commands.map((command) => command.type),
      ["thread.sync.import-v2.start", "thread.sync.import-v2.chunk"],
    );
  }),
);

it.effect("rejects reconstructed plan text that is empty after trimming", () =>
  Effect.gen(function* () {
    const blank = " \n\t ";
    const planId = OrchestrationProposedPlanId.make("portable-blank-plan");
    const planRecords: ReadonlyArray<ThreadSyncV2Record> = [
      {
        ordinal: 0,
        kind: "plan",
        value: {
          id: planId,
          turnId: null,
          planMarkdown: {
            sha256: sha256(blank),
            sizeBytes: Buffer.byteLength(blank, "utf8"),
            fragmentCount: 1,
          },
          implementedAt: null,
          implementationThreadId: null,
          createdAt: importedAt,
          updatedAt: importedAt,
        },
      },
      { ordinal: 1, kind: "plan-markdown", planId, fragmentIndex: 0, text: blank },
    ];
    const commands: OrchestrationCommand[] = [];
    const failure = yield* Effect.flip(
      stageThreadSyncV2Import({
        selection: {
          reader: readerWithRecords(planRecords),
          targetThreadId,
          projectId,
          mode: "create",
          expectedLocalUpdatedAt: null,
          localState: {
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex-local"),
              model: "gpt-local",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            linkedPullRequest: null,
          },
          bindingUpdates: [
            {
              syncThreadId: sourceThreadId,
              localThreadId: targetThreadId,
              syncProjectId,
              localProjectId: projectId,
              baseRevision: sourceRevision,
            },
          ],
          references: { threadIds: new Map(), selectedImports: new Map(), planIds: new Map() },
        },
        importedAt,
        dispatch: (command) =>
          Effect.sync(() => {
            commands.push(command);
            return { sequence: commands.length };
          }),
        resumeStage,
        prepareStage,
        attachmentStage: noAttachmentStage,
      }),
    );
    assert.equal(failure.code, "integrity-failed");
    assert.match(failure.detail, /reconstructed blank text/);
    assert.deepEqual(
      commands.map((command) => command.type),
      ["thread.sync.import-v2.start"],
    );
  }),
);

it.effect("derives selected peer plan ids without pre-reading the peer stream", () =>
  Effect.gen(function* () {
    const peerSourceThreadId = ThreadId.make("portable-peer-thread");
    const peerTargetThreadId = ThreadId.make("local-peer-thread");
    const peerSourceRevision = ThreadSyncRevision.make("c".repeat(64));
    const peerSourcePlanId = OrchestrationProposedPlanId.make("portable-peer-plan");
    const records: ReadonlyArray<ThreadSyncV2Record> = [
      {
        ordinal: 0,
        kind: "turn",
        value: {
          turnId: sourceTurnId,
          pendingMessageId: null,
          sourceProposedPlanThreadId: peerSourceThreadId,
          sourceProposedPlanId: peerSourcePlanId,
          assistantMessageId: null,
          state: "completed",
          requestedAt: importedAt,
          startedAt: importedAt,
          completedAt: importedAt,
        },
      },
    ];
    const commands: OrchestrationCommand[] = [];
    yield* stageThreadSyncV2Import({
      selection: {
        reader: readerWithRecords(records, sourceTurnId),
        targetThreadId,
        projectId,
        mode: "create",
        expectedLocalUpdatedAt: null,
        localState: {
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex-local"),
            model: "gpt-local",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          linkedPullRequest: null,
        },
        bindingUpdates: [
          {
            syncThreadId: sourceThreadId,
            localThreadId: targetThreadId,
            syncProjectId,
            localProjectId: projectId,
            baseRevision: sourceRevision,
          },
        ],
        references: {
          threadIds: new Map([
            [peerSourceThreadId, { localThreadId: peerTargetThreadId, projectId, deletedAt: null }],
          ]),
          selectedImports: new Map([
            [
              peerSourceThreadId,
              { targetThreadId: peerTargetThreadId, sourceRevision: peerSourceRevision },
            ],
          ]),
          planIds: new Map(),
        },
      },
      importedAt,
      dispatch: (command) =>
        Effect.sync(() => {
          commands.push(command);
          return { sequence: commands.length };
        }),
      resumeStage,
      prepareStage,
      attachmentStage: noAttachmentStage,
    });

    const chunk = commands.find(
      (
        command,
      ): command is Extract<
        OrchestrationCommand,
        { readonly type: "thread.sync.import-v2.chunk" }
      > => command.type === "thread.sync.import-v2.chunk",
    );
    assert.isDefined(chunk);
    const turn = chunk?.records.find((record) => record.kind === "turn");
    assert.equal(
      turn?.kind === "turn" ? turn.value.sourceProposedPlanThreadId : null,
      peerTargetThreadId,
    );
    assert.equal(
      turn?.kind === "turn" ? turn.value.sourceProposedPlanId : null,
      threadSyncV2ImportedPlanId({
        sourceThreadId: peerSourceThreadId,
        targetThreadId: peerTargetThreadId,
        sourceRevision: peerSourceRevision,
        sourceId: peerSourcePlanId,
      }),
    );
  }),
);

it.effect(
  "omits oversized text from the bounded visible tail without losing staged fragments",
  () =>
    Effect.gen(function* () {
      const largeText = "x".repeat(300 * 1024);
      const records: ReadonlyArray<ThreadSyncV2Record> = [
        {
          ordinal: 0,
          kind: "message",
          value: {
            id: sourceMessageId,
            role: "assistant",
            text: {
              sha256: sha256(largeText),
              sizeBytes: Buffer.byteLength(largeText, "utf8"),
              fragmentCount: 2,
            },
            attachments: [],
            turnId: null,
            streaming: false,
            createdAt: importedAt,
            updatedAt: importedAt,
          },
        },
        {
          ordinal: 1,
          kind: "message-text",
          messageId: sourceMessageId,
          fragmentIndex: 0,
          text: largeText.slice(0, 150 * 1024),
        },
        {
          ordinal: 2,
          kind: "message-text",
          messageId: sourceMessageId,
          fragmentIndex: 1,
          text: largeText.slice(150 * 1024),
        },
      ];
      const commands: OrchestrationCommand[] = [];
      yield* stageThreadSyncV2Import({
        selection: {
          reader: readerWithRecords(records),
          targetThreadId,
          projectId,
          mode: "create",
          expectedLocalUpdatedAt: null,
          localState: {
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex-local"),
              model: "gpt-local",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            linkedPullRequest: null,
          },
          bindingUpdates: [
            {
              syncThreadId: sourceThreadId,
              localThreadId: targetThreadId,
              syncProjectId,
              localProjectId: projectId,
              baseRevision: sourceRevision,
            },
          ],
          references: { threadIds: new Map(), selectedImports: new Map(), planIds: new Map() },
        },
        importedAt,
        dispatch: (command) =>
          Effect.sync(() => {
            commands.push(command);
            return { sequence: commands.length };
          }),
        resumeStage,
        prepareStage,
        attachmentStage: noAttachmentStage,
      });

      const committed = commands.find(
        (
          command,
        ): command is Extract<
          OrchestrationCommand,
          { readonly type: "thread.sync.import-v2.commit" }
        > => command.type === "thread.sync.import-v2.commit",
      );
      assert.isDefined(committed);
      assert.deepEqual(committed?.visibleHistory.messages, []);
      const chunkRecords = commands.flatMap((command) =>
        command.type === "thread.sync.import-v2.chunk" ? command.records : [],
      );
      assert.equal(chunkRecords.filter((record) => record.kind === "message-text").length, 2);
    }),
);

it.effect("rejects oversized attachment metadata before writing a file", () =>
  Effect.gen(function* () {
    const records: ReadonlyArray<ThreadSyncV2Record> = [
      {
        ordinal: 0,
        kind: "message",
        value: {
          id: sourceMessageId,
          role: "user",
          text: { sha256: sha256(""), sizeBytes: 0, fragmentCount: 0 },
          attachments: [
            {
              type: "image",
              name: "oversized.png",
              mimeType: "image/png",
              sizeBytes: PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1,
              blobHash: "a".repeat(64),
            },
          ],
          turnId: null,
          streaming: false,
          createdAt: importedAt,
          updatedAt: importedAt,
        },
      },
    ];
    let writes = 0;
    let aborts = 0;
    const attachmentStage: ThreadSyncV2AttachmentStage = {
      recover: () => Effect.void,
      list: () => Effect.succeed([]),
      write: () =>
        Effect.sync(() => {
          writes += 1;
          throw new Error("must not write");
        }),
      prepareCommit: ({ attachments }) => Effect.succeed(attachments),
      completeCommit: () => Effect.void,
      abort: () =>
        Effect.sync(() => {
          aborts += 1;
        }),
    };
    const failure = yield* Effect.flip(
      stageThreadSyncV2Import({
        selection: {
          reader: readerWithRecords(records),
          targetThreadId,
          projectId,
          mode: "create",
          expectedLocalUpdatedAt: null,
          localState: {
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex-local"),
              model: "gpt-local",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            linkedPullRequest: null,
          },
          bindingUpdates: [
            {
              syncThreadId: sourceThreadId,
              localThreadId: targetThreadId,
              syncProjectId,
              localProjectId: projectId,
              baseRevision: sourceRevision,
            },
          ],
          references: { threadIds: new Map(), selectedImports: new Map(), planIds: new Map() },
        },
        importedAt,
        dispatch: () => Effect.succeed({ sequence: 1 }),
        resumeStage,
        prepareStage,
        attachmentStage,
      }),
    );
    assert.equal(failure.code, "integrity-failed");
    assert.equal(writes, 0);
    assert.equal(aborts, 1);
  }),
);

it.effect("bounds repeated attachment references and aborts their stage", () =>
  Effect.gen(function* () {
    const records: ThreadSyncV2Record[] = [];
    for (let index = 0; index < 26; index += 1) {
      records.push({
        ordinal: index,
        kind: "message",
        value: {
          id: MessageId.make(`portable-budget-message-${index}`),
          role: "user",
          text: { sha256: sha256(""), sizeBytes: 0, fragmentCount: 0 },
          attachments: [
            {
              type: "image",
              name: `image-${index}.png`,
              mimeType: "image/png",
              sizeBytes: PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
              blobHash: "b".repeat(64),
            },
          ],
          turnId: null,
          streaming: false,
          createdAt: importedAt,
          updatedAt: importedAt,
        },
      });
    }
    let writes = 0;
    let abortedAttachments = 0;
    const attachmentStage: ThreadSyncV2AttachmentStage = {
      recover: () => Effect.void,
      list: () => Effect.succeed([]),
      write: ({ attachment, sourceMessageId, index }) =>
        Effect.sync(() => {
          writes += 1;
          return {
            attachment: {
              type: "image" as const,
              id: `budget-attachment-${writes}`,
              name: attachment.name,
              mimeType: attachment.mimeType,
              sizeBytes: attachment.sizeBytes,
            },
            blobHash: attachment.blobHash,
            finalRelativePath: `budget/attachment-${index}-${writes}`,
            sourceMessageId,
            index,
          };
        }),
      prepareCommit: ({ attachments }) => Effect.succeed(attachments),
      completeCommit: () => Effect.void,
      abort: ({ attachments }) =>
        Effect.sync(() => {
          abortedAttachments = attachments.length;
        }),
    };
    const failure = yield* Effect.flip(
      stageThreadSyncV2Import({
        selection: {
          reader: readerWithRecords(records),
          targetThreadId,
          projectId,
          mode: "create",
          expectedLocalUpdatedAt: null,
          localState: {
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex-local"),
              model: "gpt-local",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            linkedPullRequest: null,
          },
          bindingUpdates: [
            {
              syncThreadId: sourceThreadId,
              localThreadId: targetThreadId,
              syncProjectId,
              localProjectId: projectId,
              baseRevision: sourceRevision,
            },
          ],
          references: { threadIds: new Map(), selectedImports: new Map(), planIds: new Map() },
        },
        importedAt,
        dispatch: () => Effect.succeed({ sequence: 1 }),
        resumeStage,
        prepareStage,
        attachmentStage,
      }),
    );
    assert.equal(failure.code, "integrity-failed");
    assert.match(failure.detail, /attachment import budget/);
    assert.equal(writes, 25);
    assert.equal(abortedAttachments, 25);
  }),
);

it.effect("resumes at the persisted ordinal without rereading or redispatching prior chunks", () =>
  Effect.gen(function* () {
    const records: ThreadSyncV2Record[] = Array.from({ length: 70 }, (_, index) => ({
      ordinal: index,
      kind: "turn" as const,
      value: {
        turnId: TurnId.make(`portable-resume-turn-${index}`),
        pendingMessageId: null,
        sourceProposedPlanThreadId: null,
        sourceProposedPlanId: null,
        assistantMessageId: null,
        state: "completed" as const,
        requestedAt: importedAt,
        startedAt: importedAt,
        completedAt: importedAt,
      },
    }));
    const baseReader = readerWithRecords(records);
    const readerStarts: number[] = [];
    const trackedReader: ThreadSyncV2ThreadReader = {
      ...baseReader,
      recordsFromOrdinal: (ordinal) => {
        readerStarts.push(ordinal);
        return Stream.fromIterable(records.slice(ordinal));
      },
    };
    let persistedProgress: {
      readonly stageId: ReturnType<typeof ThreadSyncImportStageId.make>;
      readonly nextOrdinal: number;
      readonly nextChunkIndex: number;
    } | null = null;
    let failSecondChunk = true;
    const commands: OrchestrationCommand[] = [];
    const dispatch = (command: OrchestrationCommand) => {
      commands.push(command);
      if (command.type === "thread.sync.import-v2.start" && persistedProgress === null) {
        persistedProgress = {
          stageId: command.descriptor.stageId,
          nextOrdinal: 0,
          nextChunkIndex: 0,
        };
      }
      if (command.type === "thread.sync.import-v2.chunk" && command.chunkIndex === 0) {
        persistedProgress = { stageId: command.stageId, nextOrdinal: 64, nextChunkIndex: 1 };
      }
      if (
        command.type === "thread.sync.import-v2.chunk" &&
        command.chunkIndex === 1 &&
        failSecondChunk
      ) {
        return Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "injected failure after the first durable chunk",
          }),
        );
      }
      return Effect.succeed({ sequence: commands.length });
    };
    const selection = {
      reader: trackedReader,
      targetThreadId,
      projectId,
      mode: "create" as const,
      expectedLocalUpdatedAt: null,
      localState: {
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex-local"),
          model: "gpt-local",
        },
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        linkedPullRequest: null,
      },
      bindingUpdates: [
        {
          syncThreadId: sourceThreadId,
          localThreadId: targetThreadId,
          syncProjectId,
          localProjectId: projectId,
          baseRevision: sourceRevision,
        },
      ],
      references: { threadIds: new Map(), selectedImports: new Map(), planIds: new Map() },
    };

    const firstFailure = yield* Effect.flip(
      stageThreadSyncV2Import({
        selection,
        importedAt,
        dispatch,
        resumeStage: () => Effect.succeed(null),
        prepareStage,
        attachmentStage: noAttachmentStage,
      }),
    );
    assert.equal(firstFailure.code, "conflict");
    assert.deepEqual(readerStarts, [0]);
    assert.isNotNull(persistedProgress);

    failSecondChunk = false;
    const secondStart = commands.length;
    const result = yield* stageThreadSyncV2Import({
      selection,
      importedAt,
      dispatch,
      resumeStage: () => Effect.succeed(persistedProgress),
      prepareStage,
      attachmentStage: noAttachmentStage,
    });
    assert.equal(result.recordCount, records.length);
    assert.deepEqual(readerStarts, [0, 64]);
    const retriedCommands = commands.slice(secondStart);
    assert.isFalse(
      retriedCommands.some(
        (command) => command.type === "thread.sync.import-v2.chunk" && command.chunkIndex === 0,
      ),
    );
    assert.equal(
      retriedCommands.filter(
        (command) => command.type === "thread.sync.import-v2.chunk" && command.chunkIndex === 1,
      ).length,
      1,
    );
  }),
);

it.effect("keeps only the bounded visible tails while staging a large history", () =>
  Effect.gen(function* () {
    const records: ThreadSyncV2Record[] = [];
    let ordinal = 0;
    for (let index = 0; index < 130; index += 1) {
      const id = MessageId.make(`portable-message-${index.toString().padStart(3, "0")}`);
      const value = `message ${index}`;
      records.push(
        {
          ordinal: ordinal++,
          kind: "message",
          value: {
            id,
            role: index % 2 === 0 ? "user" : "assistant",
            text: {
              sha256: sha256(value),
              sizeBytes: Buffer.byteLength(value, "utf8"),
              fragmentCount: 1,
            },
            attachments: [],
            turnId: null,
            streaming: false,
            createdAt: importedAt,
            updatedAt: importedAt,
          },
        },
        { ordinal: ordinal++, kind: "message-text", messageId: id, fragmentIndex: 0, text: value },
      );
    }
    for (let index = 0; index < 202; index += 1) {
      const id = OrchestrationProposedPlanId.make(
        `portable-plan-${index.toString().padStart(3, "0")}`,
      );
      const value = `plan ${index}`;
      records.push(
        {
          ordinal: ordinal++,
          kind: "plan",
          value: {
            id,
            turnId: null,
            planMarkdown: {
              sha256: sha256(value),
              sizeBytes: Buffer.byteLength(value, "utf8"),
              fragmentCount: 1,
            },
            implementedAt: null,
            implementationThreadId: null,
            createdAt: importedAt,
            updatedAt: importedAt,
          },
        },
        { ordinal: ordinal++, kind: "plan-markdown", planId: id, fragmentIndex: 0, text: value },
      );
    }
    for (let index = 0; index < 502; index += 1) {
      const id = EventId.make(`portable-activity-${index.toString().padStart(3, "0")}`);
      const value = `activity ${index}`;
      records.push(
        {
          ordinal: ordinal++,
          kind: "activity",
          value: {
            id,
            tone: "info",
            kind: "tool",
            summary: {
              sha256: sha256(value),
              sizeBytes: Buffer.byteLength(value, "utf8"),
              fragmentCount: 1,
            },
            turnId: null,
            sequence: index,
            createdAt: importedAt,
          },
        },
        {
          ordinal: ordinal++,
          kind: "activity-summary",
          activityId: id,
          fragmentIndex: 0,
          text: value,
        },
      );
    }

    const commands: OrchestrationCommand[] = [];
    const result = yield* stageThreadSyncV2Import({
      selection: {
        reader: readerWithRecords(records),
        targetThreadId,
        projectId,
        mode: "create",
        expectedLocalUpdatedAt: null,
        localState: {
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex-local"),
            model: "gpt-local",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          linkedPullRequest: null,
        },
        bindingUpdates: [
          {
            syncThreadId: sourceThreadId,
            localThreadId: targetThreadId,
            syncProjectId,
            localProjectId: projectId,
            baseRevision: sourceRevision,
          },
        ],
        references: { threadIds: new Map(), selectedImports: new Map(), planIds: new Map() },
      },
      importedAt,
      dispatch: (command) =>
        Effect.sync(() => {
          commands.push(command);
          return { sequence: command.type === "thread.sync.import-v2.commit" ? 3 : 2 };
        }),
      resumeStage,
      prepareStage,
      attachmentStage: noAttachmentStage,
    });

    assert.equal(result.recordCount, records.length);
    assert.deepEqual(result.attachments, []);
    const committed = commands.find(
      (
        command,
      ): command is Extract<
        OrchestrationCommand,
        { readonly type: "thread.sync.import-v2.commit" }
      > => command.type === "thread.sync.import-v2.commit",
    );
    assert.isDefined(committed);
    if (committed === undefined) return;
    assert.deepEqual(committed.visibleHistory, emptyVisibleHistory);
  }),
);
