import type { ThreadId } from "@t3tools/contracts";

/**
 * Opaque, exclusive cursor for windowed thread detail reads. Encodes the thread
 * id and the keyset boundary of an already-delivered page: the boundary turn's
 * anchor timestamp (`COALESCE(requested_at, started_at, '')`) and turn id.
 * Passing it back requests the adjacent disjoint slice of strictly older turns
 * under `(anchor, turn_id)` ordering.
 *
 * The boundary is deliberately NOT a `projection_turns.row_id`: row ids are
 * rewritten by the revert projector (delete + re-upsert) and by projection
 * rebuilds, which would silently invalidate every persisted cursor with no
 * event emitted. The (anchor, turnId) pair is derived from event content, so
 * cursors survive both and no client-side refresh machinery is needed. The
 * anchor doubles as the time bound for rows with no turn linkage (straggler
 * user messages, turnless activities). The thread id is embedded so a cursor
 * can never be replayed against a different thread. Clients must treat the
 * string as opaque.
 */
export interface ThreadDetailPageCursor {
  readonly threadId: ThreadId;
  readonly beforeAnchorAt: string;
  /** Boundary turn id; "" for the rare turn row with a null turn_id. */
  readonly beforeTurnId: string;
  readonly mode?: "turn" | "turnless" | "turn-spill";
  /**
   * Whether a turnless walk still needs actionable plans. A normal turn page
   * pins those plans once before entering turnless history; a plan-only legacy
   * thread instead carries them through its turnless keyset.
   */
  readonly includeTurnlessPinnedPlans?: boolean;
  readonly spill?: {
    readonly minAnchorAt: string;
    readonly minTurnKey: string;
    readonly rangeBeforeAnchorAt: string;
    readonly rangeBeforeTurnKey: string;
    readonly includePinnedPlans: boolean;
    readonly messageDone: boolean;
    readonly messageBefore?: {
      readonly createdAt: string;
      readonly id: string;
    };
    readonly activityDone: boolean;
    readonly activityBefore?: {
      readonly sequence: number;
      readonly createdAt: string;
      readonly id: string;
    };
    readonly planDone: boolean;
    readonly planBefore?: {
      readonly pinned: number;
      readonly createdAt: string;
      readonly id: string;
    };
  };
}

export function encodeThreadDetailPageCursor(cursor: ThreadDetailPageCursor): string {
  return Buffer.from(
    JSON.stringify({
      v: 2,
      t: cursor.threadId,
      a: cursor.beforeAnchorAt,
      i: cursor.beforeTurnId,
      ...(cursor.mode === undefined ? {} : { m: cursor.mode }),
      ...(cursor.includeTurnlessPinnedPlans === undefined
        ? {}
        : { p: cursor.includeTurnlessPinnedPlans }),
      ...(cursor.spill === undefined ? {} : { s: cursor.spill }),
    }),
  ).toString("base64url");
}

/**
 * Returns null for anything that is not a well-formed cursor. Callers degrade
 * a malformed or foreign-thread cursor to a first-page request.
 */
export function decodeThreadDetailPageCursor(encoded: string): ThreadDetailPageCursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.t !== "string" || record.t.length === 0) {
    return null;
  }
  // Empty strings are valid boundary values, not malformed input: the anchor
  // is COALESCE(requested_at, started_at, ''), so a boundary turn with no
  // timestamps encodes a: "" (and sorts before every real anchor, correctly
  // ending the walk); the turn key is "" for a null turn_id.
  if (typeof record.a !== "string") {
    return null;
  }
  if (typeof record.i !== "string") {
    return null;
  }
  const mode = record.m;
  if (mode !== undefined && mode !== "turn" && mode !== "turnless" && mode !== "turn-spill") {
    return null;
  }
  if (record.p !== undefined && (mode !== "turnless" || typeof record.p !== "boolean")) {
    return null;
  }
  const spillRecord = record.s;
  let spill: ThreadDetailPageCursor["spill"];
  if (mode === "turn-spill") {
    if (spillRecord === null || typeof spillRecord !== "object") {
      return null;
    }
    const value = spillRecord as Record<string, unknown>;
    if (
      typeof value.minAnchorAt !== "string" ||
      typeof value.minTurnKey !== "string" ||
      typeof value.rangeBeforeAnchorAt !== "string" ||
      typeof value.rangeBeforeTurnKey !== "string" ||
      (value.includePinnedPlans !== undefined && typeof value.includePinnedPlans !== "boolean") ||
      (value.messageDone !== undefined && typeof value.messageDone !== "boolean") ||
      typeof value.activityDone !== "boolean" ||
      typeof value.planDone !== "boolean"
    ) {
      return null;
    }
    const decodeActivityBefore = () => {
      if (value.activityBefore === undefined) return undefined;
      if (value.activityBefore === null || typeof value.activityBefore !== "object") return null;
      const before = value.activityBefore as Record<string, unknown>;
      return typeof before.sequence === "number" &&
        Number.isFinite(before.sequence) &&
        typeof before.createdAt === "string" &&
        typeof before.id === "string"
        ? { sequence: before.sequence, createdAt: before.createdAt, id: before.id }
        : null;
    };
    const decodeMessageBefore = () => {
      if (value.messageBefore === undefined) return undefined;
      if (value.messageBefore === null || typeof value.messageBefore !== "object") return null;
      const before = value.messageBefore as Record<string, unknown>;
      return typeof before.createdAt === "string" && typeof before.id === "string"
        ? { createdAt: before.createdAt, id: before.id }
        : null;
    };
    const decodePlanBefore = () => {
      if (value.planBefore === undefined) return undefined;
      if (value.planBefore === null || typeof value.planBefore !== "object") return null;
      const before = value.planBefore as Record<string, unknown>;
      return typeof before.pinned === "number" &&
        Number.isFinite(before.pinned) &&
        typeof before.createdAt === "string" &&
        typeof before.id === "string"
        ? { pinned: before.pinned, createdAt: before.createdAt, id: before.id }
        : null;
    };
    const messageBefore = decodeMessageBefore();
    const activityBefore = decodeActivityBefore();
    const planBefore = decodePlanBefore();
    if (messageBefore === null || activityBefore === null || planBefore === null) {
      return null;
    }
    spill = {
      minAnchorAt: value.minAnchorAt,
      minTurnKey: value.minTurnKey,
      rangeBeforeAnchorAt: value.rangeBeforeAnchorAt,
      rangeBeforeTurnKey: value.rangeBeforeTurnKey,
      includePinnedPlans: value.includePinnedPlans === undefined ? true : value.includePinnedPlans,
      // Cursors produced before message spill support already carried the full
      // message range on the first slice. Treat those messages as complete.
      messageDone: value.messageDone === undefined ? true : value.messageDone,
      ...(messageBefore === undefined ? {} : { messageBefore }),
      activityDone: value.activityDone,
      ...(activityBefore === undefined ? {} : { activityBefore }),
      planDone: value.planDone,
      ...(planBefore === undefined ? {} : { planBefore }),
    };
  } else if (spillRecord !== undefined) {
    return null;
  }
  return {
    threadId: record.t as ThreadId,
    beforeAnchorAt: record.a,
    beforeTurnId: record.i,
    ...(mode === undefined ? {} : { mode }),
    ...(record.p === undefined ? {} : { includeTurnlessPinnedPlans: record.p as boolean }),
    ...(spill === undefined ? {} : { spill }),
  };
}
