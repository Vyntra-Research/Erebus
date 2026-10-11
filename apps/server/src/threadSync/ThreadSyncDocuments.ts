import * as NodeCrypto from "node:crypto";

import {
  ThreadSyncProjectSnapshot,
  ThreadSyncThreadSnapshot,
  type OrchestrationProposedPlanId,
  type ThreadId,
  type ThreadSyncProjectId,
  type ThreadSyncRevision,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const THREAD_SYNC_NAMESPACE = ".erebus-thread-sync/v1";
export const THREAD_SYNC_MANIFEST_PATH = `${THREAD_SYNC_NAMESPACE}/manifest.json`;
export const THREAD_SYNC_PROJECTS_DIRECTORY = `${THREAD_SYNC_NAMESPACE}/projects`;
export const THREAD_SYNC_THREADS_DIRECTORY = `${THREAD_SYNC_NAMESPACE}/threads`;
export const THREAD_SYNC_BLOBS_DIRECTORY = `${THREAD_SYNC_NAMESPACE}/blobs`;

export interface ThreadSyncRepositoryDocuments {
  readonly projects: ReadonlyMap<ThreadSyncProjectId, ThreadSyncProjectSnapshot>;
  readonly threads: ReadonlyMap<string, ThreadSyncThreadSnapshot>;
  /** Verified content-addressed attachment bytes referenced by `threads`. */
  readonly blobs: ReadonlyMap<string, Uint8Array>;
}

export interface ThreadSyncDocumentState<Document> {
  readonly document: Document | null;
  readonly revision: ThreadSyncRevision | null;
}

export type ThreadSyncThreeWayDecision = "unchanged" | "pull" | "push" | "converged" | "conflict";

const decodeProject = Schema.decodeUnknownSync(ThreadSyncProjectSnapshot);
const decodeThread = Schema.decodeUnknownSync(ThreadSyncThreadSnapshot);

function sortForCanonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortForCanonicalJson);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Readonly<Record<string, unknown>>)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortForCanonicalJson(child)]),
  );
}

export function canonicalThreadSyncJson(value: unknown): string {
  return `${JSON.stringify(sortForCanonicalJson(value), null, 2)}\n`;
}

export function threadSyncRevision(value: unknown): ThreadSyncRevision {
  return NodeCrypto.createHash("sha256")
    .update(canonicalThreadSyncJson(value))
    .digest("hex") as ThreadSyncRevision;
}

export function threadSyncDocumentFileName(id: string): string {
  return `${NodeCrypto.createHash("sha256").update(id, "utf8").digest("hex")}.json`;
}

export function threadSyncBlobFileName(hash: string): string {
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error("Invalid thread sync blob hash.");
  }
  return `${hash}.blob`;
}

function canonicalPortableId(kind: "activity" | "message" | "plan" | "turn", seed: string) {
  const digest = NodeCrypto.createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 32);
  return `${kind}-${digest}`;
}

export function canonicalThreadSyncPlanId(
  threadId: ThreadId,
  index: number,
): OrchestrationProposedPlanId {
  return canonicalPortableId(
    "plan",
    `${threadId}\0plan\0${String(index)}`,
  ) as OrchestrationProposedPlanId;
}

export function orderTurnsForThreadSync<
  T extends {
    readonly requestedAt: string;
    readonly startedAt: string | null;
    readonly completedAt: string | null;
  },
>(turns: ReadonlyArray<T>): ReadonlyArray<T> {
  return turns.toSorted(
    (left, right) =>
      left.requestedAt.localeCompare(right.requestedAt) ||
      (left.startedAt ?? "").localeCompare(right.startedAt ?? "") ||
      (left.completedAt ?? "").localeCompare(right.completedAt ?? ""),
  );
}

/**
 * Local event ids cannot be portable: importing a thread must allocate fresh ids
 * to avoid colliding with existing rows. Normalize those ids by stable array
 * position before hashing or writing a snapshot so an import/export round trip
 * converges instead of creating an endless push between hosts.
 */
export function canonicalizeThreadSyncThreadSnapshot(
  snapshot: ThreadSyncThreadSnapshot,
): ThreadSyncThreadSnapshot {
  const seed = snapshot.threadId;
  const orderedTurns = orderTurnsForThreadSync(snapshot.turns);
  const turnIds = new Map(
    orderedTurns.map(
      (turn, index) =>
        [
          turn.turnId,
          canonicalPortableId("turn", `${seed}\0turn\0${String(index)}`) as typeof turn.turnId,
        ] as const,
    ),
  );
  const messageIds = new Map(
    snapshot.messages.map(
      (message, index) =>
        [
          message.id,
          canonicalPortableId("message", `${seed}\0message\0${String(index)}`) as typeof message.id,
        ] as const,
    ),
  );
  const planIds = new Map(
    snapshot.proposedPlans.map(
      (plan, index) => [plan.id, canonicalThreadSyncPlanId(snapshot.threadId, index)] as const,
    ),
  );

  const turns = orderedTurns.map((turn) => {
    const sourcePlanId =
      turn.sourceProposedPlanId === null
        ? null
        : turn.sourceProposedPlanThreadId === snapshot.threadId
          ? (planIds.get(turn.sourceProposedPlanId) ?? null)
          : turn.sourceProposedPlanId;
    return {
      ...turn,
      turnId: turnIds.get(turn.turnId)!,
      pendingMessageId:
        turn.pendingMessageId === null ? null : (messageIds.get(turn.pendingMessageId) ?? null),
      sourceProposedPlanThreadId: sourcePlanId === null ? null : turn.sourceProposedPlanThreadId,
      sourceProposedPlanId: sourcePlanId,
      assistantMessageId:
        turn.assistantMessageId === null ? null : (messageIds.get(turn.assistantMessageId) ?? null),
    };
  });
  const latestTurnId =
    snapshot.latestTurn === null ? null : (turnIds.get(snapshot.latestTurn.turnId) ?? null);

  return {
    ...snapshot,
    latestTurn:
      latestTurnId === null ? null : (turns.find((turn) => turn.turnId === latestTurnId) ?? null),
    turns,
    messages: snapshot.messages.map((message) => ({
      ...message,
      id: messageIds.get(message.id)!,
      turnId: message.turnId === null ? null : (turnIds.get(message.turnId) ?? null),
    })),
    proposedPlans: snapshot.proposedPlans.map((plan) => ({
      ...plan,
      id: planIds.get(plan.id)!,
      turnId: plan.turnId === null ? null : (turnIds.get(plan.turnId) ?? null),
      implementationThreadId: plan.implementationThreadId,
    })),
    activities: snapshot.activities.map((activity, index) => ({
      ...activity,
      id: canonicalPortableId(
        "activity",
        `${seed}\0activity\0${String(index)}`,
      ) as typeof activity.id,
      turnId: activity.turnId === null ? null : (turnIds.get(activity.turnId) ?? null),
    })),
  };
}

export function decodeThreadSyncProjectJson(contents: string): ThreadSyncProjectSnapshot {
  return decodeProject(JSON.parse(contents));
}

export function decodeThreadSyncThreadJson(contents: string): ThreadSyncThreadSnapshot {
  return decodeThread(JSON.parse(contents));
}

export function verifyThreadSyncDocumentFileName(id: string, fileName: string): boolean {
  return threadSyncDocumentFileName(id) === fileName;
}

/**
 * Compare one portable thread against the last synchronized digest. A missing
 * document is a real state, so a first sync with different content conflicts
 * rather than silently picking one side.
 */
export function decideThreadSyncThreeWay(input: {
  readonly baseRevision: ThreadSyncRevision | null;
  readonly localRevision: ThreadSyncRevision | null;
  readonly remoteRevision: ThreadSyncRevision | null;
}): ThreadSyncThreeWayDecision {
  const { baseRevision, localRevision, remoteRevision } = input;

  if (localRevision === remoteRevision) {
    return baseRevision === localRevision ? "unchanged" : "converged";
  }
  // Physical absence is not deletion. Deletion travels as a tombstone document,
  // so a sole remaining copy always repairs the missing replica.
  if (localRevision === null) {
    return "pull";
  }
  if (remoteRevision === null) {
    return "push";
  }
  if (localRevision === baseRevision) {
    return "pull";
  }
  if (remoteRevision === baseRevision) {
    return "push";
  }
  return "conflict";
}

export function emptyThreadSyncRepositoryDocuments(): ThreadSyncRepositoryDocuments {
  return { projects: new Map(), threads: new Map(), blobs: new Map() };
}
