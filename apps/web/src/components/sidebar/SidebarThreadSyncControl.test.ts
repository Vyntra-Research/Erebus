import type { ThreadSyncConflict, ThreadSyncStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildConflictStrategies,
  buildThreadSyncPushInput,
  canPullThreadSync,
  canPushThreadSync,
  getThreadSyncPresentation,
  updateThreadSyncSelection,
} from "./SidebarThreadSyncControl";

const BASE_STATUS = {
  state: "idle",
  configuration: {
    remoteUrl: "git@example.test:threads.git",
    branch: "main",
    fetchIntervalSeconds: 300,
  },
  baseRevision: "base",
  localRevision: "local",
  remoteRevision: "remote",
  lastFetchedAt: "2026-10-11T12:00:00.000Z",
  pendingPullCount: 0,
  pendingPushCount: 0,
  conflicts: [],
  unlinkedProjects: [],
  lastError: null,
} as unknown as ThreadSyncStatus;

describe("thread sync sidebar presentation", () => {
  it("distinguishes loading, disconnected, busy, pending, healthy, and error states", () => {
    expect(getThreadSyncPresentation(null)).toEqual({
      label: "Loading thread sync",
      tone: "busy",
    });
    expect(getThreadSyncPresentation(null, false)).toEqual({
      label: "Thread sync is unavailable",
      tone: "idle",
    });
    expect(
      getThreadSyncPresentation({
        ...BASE_STATUS,
        state: "disconnected",
        configuration: null,
      }),
    ).toEqual({ label: "Set up thread sync", tone: "idle" });
    expect(getThreadSyncPresentation({ ...BASE_STATUS, state: "fetching" }).tone).toBe("busy");
    expect(getThreadSyncPresentation({ ...BASE_STATUS, pendingPullCount: 1 })).toEqual({
      label: "Thread sync has pending changes",
      tone: "warning",
    });
    expect(getThreadSyncPresentation(BASE_STATUS)).toEqual({
      label: "Thread sync is up to date",
      tone: "success",
    });
    expect(getThreadSyncPresentation({ ...BASE_STATUS, lastError: "Remote unavailable" })).toEqual({
      label: "Thread sync needs attention",
      tone: "error",
    });
  });

  it("builds one explicit resolution per conflict without dropping a thread", () => {
    const conflicts = [
      { threadId: "thread-a", title: "A" },
      { threadId: "thread-b", title: "B" },
    ] as unknown as ReadonlyArray<ThreadSyncConflict>;

    expect(buildConflictStrategies(conflicts, { "thread-b": "keep-both" }, "use-remote")).toEqual([
      { threadId: "thread-a", resolution: "use-remote" },
      { threadId: "thread-b", resolution: "keep-both" },
    ]);
  });

  it("allows the first push before an empty remote has a revision", () => {
    const initialPush = {
      ...BASE_STATUS,
      remoteRevision: null,
      pendingPushCount: 1,
    } as ThreadSyncStatus;

    expect(canPushThreadSync(initialPush, false)).toBe(true);
    expect(buildThreadSyncPushInput(initialPush.remoteRevision, [])).toEqual({
      expectedRemoteRevision: null,
      strategies: [],
    });
    expect(canPushThreadSync(initialPush, true)).toBe(false);
    expect(
      canPushThreadSync(
        { ...initialPush, unlinkedProjects: [{}] } as unknown as ThreadSyncStatus,
        false,
      ),
    ).toBe(false);
  });

  it("keeps both conflict resolution paths available without simple pending changes", () => {
    const conflictStatus = {
      ...BASE_STATUS,
      pendingPullCount: 0,
      pendingPushCount: 0,
      conflicts: [{ threadId: "thread-a", title: "Shared title" }],
    } as unknown as ThreadSyncStatus;

    expect(canPullThreadSync(conflictStatus, false)).toBe(true);
    expect(canPushThreadSync(conflictStatus, false)).toBe(true);
    expect(canPullThreadSync({ ...conflictStatus, remoteRevision: null }, false)).toBe(false);
  });

  it("records a native-select value without retaining its transient event target", () => {
    const previous = { "thread-a": "use-remote" as const };

    expect(updateThreadSyncSelection(previous, "thread-b", "keep-both")).toEqual({
      "thread-a": "use-remote",
      "thread-b": "keep-both",
    });
    expect(previous).toEqual({ "thread-a": "use-remote" });
  });
});
