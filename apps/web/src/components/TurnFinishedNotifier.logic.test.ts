import { describe, expect, it } from "vite-plus/test";

import { scanFinishedTurns, type ThreadTurnSource } from "./TurnFinishedNotifier.logic";

function thread(
  key: string,
  turnId: string | null,
  state: "running" | "completed" | "interrupted" | "error" | null,
): ThreadTurnSource {
  return {
    key,
    latestTurn: turnId === null || state === null ? null : { turnId, state },
  };
}

describe("scanFinishedTurns", () => {
  it("uses the first snapshot as a baseline instead of replaying old turns", () => {
    const scan = scanFinishedTurns(null, [
      thread("env:thread-a", "turn-1", "completed"),
      thread("env:thread-b", "turn-2", "error"),
    ]);

    expect(scan.outcome).toBeNull();
    expect(scan.next.size).toBe(2);
  });

  it("reports a first completed turn after a thread had no turn", () => {
    const idle = scanFinishedTurns(null, [thread("env:thread-a", null, null)]);

    expect(
      scanFinishedTurns(idle.next, [thread("env:thread-a", "turn-1", "completed")]).outcome,
    ).toBe("success");
  });

  it("reports a turn that finishes while the app stays open", () => {
    const running = scanFinishedTurns(null, [thread("env:thread-a", "turn-1", "running")]);

    expect(
      scanFinishedTurns(running.next, [thread("env:thread-a", "turn-1", "completed")]).outcome,
    ).toBe("success");
    expect(
      scanFinishedTurns(running.next, [thread("env:thread-a", "turn-1", "error")]).outcome,
    ).toBe("error");
  });

  it("keeps interrupted turns quiet", () => {
    const running = scanFinishedTurns(null, [thread("env:thread-a", "turn-1", "running")]);

    expect(
      scanFinishedTurns(running.next, [thread("env:thread-a", "turn-1", "interrupted")]).outcome,
    ).toBeNull();
  });

  it("does not report the same terminal turn twice", () => {
    const running = scanFinishedTurns(null, [thread("env:thread-a", "turn-1", "running")]);
    const completed = scanFinishedTurns(running.next, [
      thread("env:thread-a", "turn-1", "completed"),
    ]);

    expect(
      scanFinishedTurns(completed.next, [thread("env:thread-a", "turn-1", "completed")]).outcome,
    ).toBeNull();
  });

  it("reports a new turn that completed between snapshots", () => {
    const completed = scanFinishedTurns(null, [thread("env:thread-a", "turn-1", "completed")]);

    expect(
      scanFinishedTurns(completed.next, [thread("env:thread-a", "turn-2", "completed")]).outcome,
    ).toBe("success");
  });

  it("aggregates concurrent completions with errors winning", () => {
    const running = scanFinishedTurns(null, [
      thread("env:thread-a", "turn-1", "running"),
      thread("env:thread-b", "turn-2", "running"),
    ]);

    expect(
      scanFinishedTurns(running.next, [
        thread("env:thread-a", "turn-1", "completed"),
        thread("env:thread-b", "turn-2", "error"),
      ]).outcome,
    ).toBe("error");
  });

  it("prunes threads that disappeared from the shell", () => {
    const running = scanFinishedTurns(null, [
      thread("env:thread-a", "turn-1", "running"),
      thread("env:thread-b", "turn-2", "running"),
    ]);

    const scan = scanFinishedTurns(running.next, [thread("env:thread-a", "turn-1", "running")]);

    expect([...scan.next.keys()]).toEqual(["env:thread-a"]);
    expect(scan.outcome).toBeNull();
  });
});
