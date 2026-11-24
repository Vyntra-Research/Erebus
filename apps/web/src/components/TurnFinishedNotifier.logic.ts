import type { OrchestrationLatestTurnState } from "@t3tools/contracts";

export type TurnFinishedOutcome = "success" | "error";

export type ThreadTurnSnapshot = {
  readonly turnId: string;
  readonly state: OrchestrationLatestTurnState;
};

export interface ThreadTurnSource {
  readonly key: string;
  readonly latestTurn: ThreadTurnSnapshot | null;
}

export interface TurnFinishedScan {
  readonly next: ReadonlyMap<string, ThreadTurnSnapshot | null>;
  readonly outcome: TurnFinishedOutcome | null;
}

/**
 * Finds turns that reached a terminal state since the previous shell snapshot.
 * The first snapshot only establishes a baseline: rehydrating old finished
 * turns must never light up the taskbar after a restart or reload.
 *
 * User-aborted turns stay quiet, and several turns finishing in one snapshot
 * collapse into a single report with errors winning.
 */
export function scanFinishedTurns(
  previous: ReadonlyMap<string, ThreadTurnSnapshot | null> | null,
  threads: ReadonlyArray<ThreadTurnSource>,
): TurnFinishedScan {
  const next = new Map<string, ThreadTurnSnapshot | null>();
  let sawSuccess = false;
  let sawError = false;

  for (const thread of threads) {
    const turn = thread.latestTurn;
    next.set(thread.key, turn);
    if (turn === null || previous === null) continue;

    const prior = previous.get(thread.key);
    if (prior === undefined) continue;

    const isNewTurn = prior === null || prior.turnId !== turn.turnId;
    const justFinished =
      prior !== null && prior.turnId === turn.turnId && prior.state === "running";
    if (!isNewTurn && !justFinished) continue;

    if (turn.state === "completed") {
      sawSuccess = true;
    } else if (turn.state === "error") {
      sawError = true;
    }
  }

  return {
    next,
    outcome: sawError ? "error" : sawSuccess ? "success" : null,
  };
}
