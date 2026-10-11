import { describe, expect, it } from "vite-plus/test";
import { ThreadSyncThreadSnapshot, type ThreadSyncRevision } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  canonicalThreadSyncJson,
  canonicalizeThreadSyncThreadSnapshot,
  decideThreadSyncThreeWay,
  orderTurnsForThreadSync,
  threadSyncDocumentFileName,
  threadSyncRevision,
  verifyThreadSyncDocumentFileName,
} from "./ThreadSyncDocuments.ts";

const decodeThread = Schema.decodeUnknownSync(ThreadSyncThreadSnapshot);

function makeThreadWithIds(ids: {
  readonly turn: string;
  readonly userMessage: string;
  readonly assistantMessage: string;
  readonly plan: string;
  readonly activity: string;
}) {
  return decodeThread({
    formatVersion: 1,
    threadId: "sync-thread",
    syncProjectId: "sync-project",
    title: "Thread",
    coagent: null,
    latestTurn: {
      turnId: ids.turn,
      pendingMessageId: ids.userMessage,
      sourceProposedPlanThreadId: "sync-thread",
      sourceProposedPlanId: ids.plan,
      state: "completed",
      requestedAt: "2026-10-11T12:00:00.000Z",
      startedAt: "2026-10-11T12:00:01.000Z",
      completedAt: "2026-10-11T12:00:02.000Z",
      assistantMessageId: ids.assistantMessage,
    },
    turns: [
      {
        turnId: ids.turn,
        pendingMessageId: ids.userMessage,
        sourceProposedPlanThreadId: "sync-thread",
        sourceProposedPlanId: ids.plan,
        state: "completed",
        requestedAt: "2026-10-11T12:00:00.000Z",
        startedAt: "2026-10-11T12:00:01.000Z",
        completedAt: "2026-10-11T12:00:02.000Z",
        assistantMessageId: ids.assistantMessage,
      },
    ],
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
        id: ids.userMessage,
        role: "user",
        text: "Question",
        attachments: [],
        turnId: ids.turn,
        streaming: false,
        createdAt: "2026-10-11T12:00:00.000Z",
        updatedAt: "2026-10-11T12:00:00.000Z",
      },
      {
        id: ids.assistantMessage,
        role: "assistant",
        text: "Answer",
        attachments: [],
        turnId: ids.turn,
        streaming: false,
        createdAt: "2026-10-11T12:00:01.000Z",
        updatedAt: "2026-10-11T12:00:02.000Z",
      },
    ],
    proposedPlans: [
      {
        id: ids.plan,
        turnId: ids.turn,
        planMarkdown: "Plan",
        implementedAt: null,
        implementationThreadId: "sync-thread",
        createdAt: "2026-10-11T12:00:00.000Z",
        updatedAt: "2026-10-11T12:00:00.000Z",
      },
    ],
    activities: [
      {
        id: ids.activity,
        tone: "info",
        kind: "work",
        summary: "Worked",
        turnId: ids.turn,
        sequence: 1,
        createdAt: "2026-10-11T12:00:01.000Z",
      },
    ],
  });
}

describe("ThreadSyncDocuments", () => {
  it("orders turns by chronology instead of checkpoint presence", () => {
    const checkpointFirst = [
      {
        turnId: "turn-later-with-checkpoint",
        requestedAt: "2026-10-11T12:02:00.000Z",
        startedAt: "2026-10-11T12:02:01.000Z",
        completedAt: "2026-10-11T12:02:02.000Z",
        checkpointTurnCount: 1,
      },
      {
        turnId: "turn-earlier-without-checkpoint",
        requestedAt: "2026-10-11T12:01:00.000Z",
        startedAt: "2026-10-11T12:01:01.000Z",
        completedAt: "2026-10-11T12:01:02.000Z",
        checkpointTurnCount: null,
      },
    ];

    const ordered = orderTurnsForThreadSync(checkpointFirst);
    expect(ordered.map((turn) => turn.turnId)).toEqual([
      "turn-earlier-without-checkpoint",
      "turn-later-with-checkpoint",
    ]);
    expect(
      orderTurnsForThreadSync(ordered.map((turn) => ({ ...turn, checkpointTurnCount: null }))).map(
        (turn) => turn.turnId,
      ),
    ).toEqual(ordered.map((turn) => turn.turnId));
  });

  it("hashes semantically identical objects identically", () => {
    const left = { title: "Thread", nested: { z: 1, a: true }, messages: ["a", "b"] };
    const right = { messages: ["a", "b"], nested: { a: true, z: 1 }, title: "Thread" };

    expect(canonicalThreadSyncJson(left)).toBe(canonicalThreadSyncJson(right));
    expect(threadSyncRevision(left)).toBe(threadSyncRevision(right));
  });

  it("derives opaque file names and verifies the content identifier", () => {
    const fileName = threadSyncDocumentFileName("../../not-a-path");

    expect(fileName).toMatch(/^[a-f0-9]{64}\.json$/);
    expect(verifyThreadSyncDocumentFileName("../../not-a-path", fileName)).toBe(true);
    expect(verifyThreadSyncDocumentFileName("other", fileName)).toBe(false);
  });

  it("converges after imported local ids are remapped", () => {
    const original = makeThreadWithIds({
      turn: "turn-origin",
      userMessage: "message-user-origin",
      assistantMessage: "message-assistant-origin",
      plan: "plan-origin",
      activity: "activity-origin",
    });
    const imported = makeThreadWithIds({
      turn: "turn-local-remap",
      userMessage: "message-user-local-remap",
      assistantMessage: "message-assistant-local-remap",
      plan: "plan-local-remap",
      activity: "activity-local-remap",
    });

    const canonical = canonicalizeThreadSyncThreadSnapshot(original);
    expect(canonicalizeThreadSyncThreadSnapshot(imported)).toEqual(canonical);
    expect(canonicalizeThreadSyncThreadSnapshot(canonical)).toEqual(canonical);
    expect(threadSyncRevision(canonicalizeThreadSyncThreadSnapshot(imported))).toBe(
      threadSyncRevision(canonical),
    );
  });

  it("preserves portable cross-thread plan and implementation relations across round trips", () => {
    const source = canonicalizeThreadSyncThreadSnapshot(
      decodeThread({
        ...makeThreadWithIds({
          turn: "source-turn",
          userMessage: "source-user",
          assistantMessage: "source-assistant",
          plan: "source-plan-local",
          activity: "source-activity",
        }),
        threadId: "sync-source",
        proposedPlans: [
          {
            id: "source-plan-local",
            turnId: null,
            planMarkdown: "Source plan",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-10-11T12:00:00.000Z",
            updatedAt: "2026-10-11T12:00:00.000Z",
          },
        ],
        latestTurn: null,
        turns: [],
        messages: [],
        activities: [],
      }),
    );
    const portableSourcePlanId = source.proposedPlans[0]!.id;
    const crossTurn = {
      turnId: "consumer-turn",
      pendingMessageId: null,
      sourceProposedPlanThreadId: "sync-source",
      sourceProposedPlanId: portableSourcePlanId,
      state: "completed" as const,
      requestedAt: "2026-10-11T12:01:00.000Z",
      startedAt: "2026-10-11T12:01:01.000Z",
      completedAt: "2026-10-11T12:01:02.000Z",
      assistantMessageId: null,
    };
    const consumer = decodeThread({
      ...makeThreadWithIds({
        turn: "consumer-turn",
        userMessage: "consumer-user",
        assistantMessage: "consumer-assistant",
        plan: "consumer-plan",
        activity: "consumer-activity",
      }),
      threadId: "sync-consumer",
      latestTurn: crossTurn,
      turns: [crossTurn],
      messages: [],
      proposedPlans: [
        {
          id: "consumer-plan",
          turnId: "consumer-turn",
          planMarkdown: "Implement in source thread",
          implementedAt: "2026-10-11T12:01:02.000Z",
          implementationThreadId: "sync-source",
          createdAt: "2026-10-11T12:01:00.000Z",
          updatedAt: "2026-10-11T12:01:02.000Z",
        },
      ],
      activities: [],
    });

    const canonical = canonicalizeThreadSyncThreadSnapshot(consumer);
    expect(canonical.turns[0]).toMatchObject({
      sourceProposedPlanThreadId: "sync-source",
      sourceProposedPlanId: portableSourcePlanId,
    });
    expect(canonical.proposedPlans[0]?.implementationThreadId).toBe("sync-source");
    expect(canonicalizeThreadSyncThreadSnapshot(canonical)).toEqual(canonical);
  });

  it.each([
    [null, null, null, "unchanged"],
    ["base", "base", "remote", "pull"],
    ["base", "local", "base", "push"],
    ["base", "same", "same", "converged"],
    ["base", "local", "remote", "conflict"],
    [null, "local", "remote", "conflict"],
    [null, "local", null, "push"],
    [null, null, "remote", "pull"],
    ["base", "base", null, "push"],
    ["base", null, "base", "pull"],
  ] as const)(
    "classifies base=%s local=%s remote=%s as %s",
    (baseRevision, localRevision, remoteRevision, expected) => {
      expect(
        decideThreadSyncThreeWay({
          baseRevision: baseRevision as ThreadSyncRevision | null,
          localRevision: localRevision as ThreadSyncRevision | null,
          remoteRevision: remoteRevision as ThreadSyncRevision | null,
        }),
      ).toBe(expected);
    },
  );
});
