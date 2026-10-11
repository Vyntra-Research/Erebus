import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ThreadSyncError,
  ThreadSyncLinkProjectInput,
  ThreadSyncProjectSnapshot,
  ThreadSyncPullInput,
  ThreadSyncPushInput,
  ThreadSyncThreadSnapshot,
} from "./threadSync.ts";

const decodeProject = Schema.decodeUnknownSync(ThreadSyncProjectSnapshot);
const encodeProject = Schema.encodeSync(ThreadSyncProjectSnapshot);
const decodeThread = Schema.decodeUnknownSync(ThreadSyncThreadSnapshot);
const encodeThread = Schema.encodeSync(ThreadSyncThreadSnapshot);
const decodeLinkProjectInput = Schema.decodeUnknownSync(ThreadSyncLinkProjectInput);
const decodePullInput = Schema.decodeUnknownSync(ThreadSyncPullInput);
const decodePushInput = Schema.decodeUnknownSync(ThreadSyncPushInput);
const encodeThreadSyncError = Schema.encodeSync(ThreadSyncError);
const decodeThreadSyncError = Schema.decodeUnknownSync(ThreadSyncError);

const projectFixture = {
  formatVersion: 1,
  syncProjectId: "sync-project-1",
  title: "Next.js",
  repositoryIdentity: {
    canonicalKey: "github.com/vercel/next.js",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "git@github.com:vercel/next.js.git",
    },
    displayName: "vercel/next.js",
    provider: "github",
    owner: "vercel",
    name: "next.js",
  },
  repositoryRelativePath: ".",
  createdAt: "2026-10-11T12:00:00.000Z",
  updatedAt: "2026-10-11T12:05:00.000Z",
  deletedAt: null,
} as const;

const threadFixture = {
  formatVersion: 1,
  threadId: "thread-1",
  syncProjectId: "sync-project-1",
  title: "Trace the request boundary",
  coagent: null,
  latestTurn: {
    turnId: "turn-1",
    pendingMessageId: "message-1",
    sourceProposedPlanThreadId: null,
    sourceProposedPlanId: null,
    state: "completed",
    requestedAt: "2026-10-11T12:01:00.000Z",
    startedAt: "2026-10-11T12:01:01.000Z",
    completedAt: "2026-10-11T12:02:00.000Z",
    assistantMessageId: "message-2",
  },
  turns: [
    {
      turnId: "turn-1",
      pendingMessageId: "message-1",
      sourceProposedPlanThreadId: null,
      sourceProposedPlanId: null,
      state: "completed",
      requestedAt: "2026-10-11T12:01:00.000Z",
      startedAt: "2026-10-11T12:01:01.000Z",
      completedAt: "2026-10-11T12:02:00.000Z",
      assistantMessageId: "message-2",
    },
  ],
  lifecycle: {
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
  },
  createdAt: "2026-10-11T12:00:00.000Z",
  updatedAt: "2026-10-11T12:02:00.000Z",
  messages: [
    {
      id: "message-1",
      role: "user",
      text: "Trace this boundary.",
      attachments: [
        {
          type: "image",
          name: "boundary.png",
          mimeType: "image/png",
          sizeBytes: 128,
          blobHash: "a".repeat(64),
        },
      ],
      turnId: "turn-1",
      streaming: false,
      createdAt: "2026-10-11T12:01:00.000Z",
      updatedAt: "2026-10-11T12:01:00.000Z",
    },
    {
      id: "message-2",
      role: "assistant",
      text: "The boundary is enforced before the write.",
      attachments: [],
      turnId: "turn-1",
      streaming: false,
      createdAt: "2026-10-11T12:02:00.000Z",
      updatedAt: "2026-10-11T12:02:00.000Z",
    },
  ],
  proposedPlans: [
    {
      id: "plan-1",
      turnId: "turn-1",
      planMarkdown: "Inspect the boundary.",
      implementedAt: null,
      implementationThreadId: null,
      createdAt: "2026-10-11T12:01:10.000Z",
      updatedAt: "2026-10-11T12:01:10.000Z",
    },
  ],
  activities: [
    {
      id: "event-1",
      tone: "tool",
      kind: "command.completed",
      summary: "Read the exact source file",
      turnId: "turn-1",
      sequence: 1,
      createdAt: "2026-10-11T12:01:30.000Z",
    },
  ],
} as const;

describe("thread sync snapshots", () => {
  it("round-trips a portable project snapshot without a local root", () => {
    const decoded = decodeProject({
      ...projectFixture,
      workspaceRoot: "C:/private/checkout",
      repositoryIdentity: {
        ...projectFixture.repositoryIdentity,
        rootPath: "C:/private/checkout",
      },
    });
    const encoded = encodeProject(decoded);

    expect(encoded).toEqual(projectFixture);
    expect("workspaceRoot" in encoded).toBe(false);
    expect("rootPath" in (encoded.repositoryIdentity ?? {})).toBe(false);
  });

  it("round-trips terminal thread history and strips runtime-only state", () => {
    const decoded = decodeThread({
      ...threadFixture,
      messages: [
        {
          ...threadFixture.messages[0],
          attachments: [{ ...threadFixture.messages[0].attachments[0], id: "local-attachment" }],
        },
        threadFixture.messages[1],
      ],
      modelSelection: { provider: "codex", model: "gpt-6.1" },
      providerInstanceId: "codex-2",
      session: { status: "ready" },
      workspaceRoot: "C:/private/checkout",
      worktreePath: "C:/private/worktree",
    });
    const encoded = encodeThread(decoded);

    expect(encoded).toEqual(threadFixture);
    expect(encoded.messages).toHaveLength(2);
    expect(encoded.messages[0]?.attachments[0]).not.toHaveProperty("id");
    expect(encoded.activities[0]).not.toHaveProperty("payload");
    expect(encoded).not.toHaveProperty("modelSelection");
    expect(encoded).not.toHaveProperty("providerInstanceId");
    expect(encoded).not.toHaveProperty("session");
    expect(encoded).not.toHaveProperty("workspaceRoot");
    expect(encoded).not.toHaveProperty("worktreePath");
  });

  it("rejects snapshots captured before the turn reaches a durable boundary", () => {
    expect(() =>
      decodeThread({
        ...threadFixture,
        latestTurn: { ...threadFixture.latestTurn, state: "running", completedAt: null },
      }),
    ).toThrow();
    expect(() =>
      decodeThread({
        ...threadFixture,
        messages: [{ ...threadFixture.messages[1], streaming: true }],
      }),
    ).toThrow();
  });

  it("rejects unsupported formats and non-portable paths", () => {
    expect(() => decodeProject({ ...projectFixture, formatVersion: 2 })).toThrow();
    expect(() => decodeProject({ ...projectFixture, repositoryRelativePath: "C:/repo" })).toThrow();
    expect(() =>
      decodeProject({ ...projectFixture, repositoryRelativePath: "../outside" }),
    ).toThrow();
    expect(() =>
      decodeThread({
        ...threadFixture,
        messages: [
          {
            ...threadFixture.messages[0],
            attachments: [{ ...threadFixture.messages[0].attachments[0], blobHash: "not-a-hash" }],
          },
        ],
      }),
    ).toThrow();
  });
});

describe("thread sync conflict contracts", () => {
  it("links projects by IDs while keeping the workspace server-owned", () => {
    const decoded = decodeLinkProjectInput({
      syncProjectId: "sync-project-1",
      projectId: "project-1",
      workspaceRoot: "C:/untrusted/path",
    });

    expect(decoded).toEqual({ syncProjectId: "sync-project-1", projectId: "project-1" });
    expect(decoded).not.toHaveProperty("workspaceRoot");
  });

  it("decodes every pull and push resolution with an expected remote revision", () => {
    const pull = decodePullInput({
      expectedRemoteRevision: "remote-2",
      strategies: [
        { threadId: "thread-1", resolution: "use-remote" },
        { threadId: "thread-2", resolution: "keep-both" },
      ],
    });
    const push = decodePushInput({
      expectedRemoteRevision: "remote-2",
      strategies: [
        { threadId: "thread-1", resolution: "pull-remote" },
        { threadId: "thread-2", resolution: "keep-both" },
        { threadId: "thread-3", resolution: "replace-remote" },
      ],
    });

    expect(pull.strategies.map((strategy) => strategy.resolution)).toEqual([
      "use-remote",
      "keep-both",
    ]);
    expect(push.strategies.map((strategy) => strategy.resolution)).toEqual([
      "pull-remote",
      "keep-both",
      "replace-remote",
    ]);
  });

  it("round-trips a tagged error with operation, code, and detail", () => {
    const error = new ThreadSyncError({
      operation: "pull",
      code: "remote-changed",
      detail: "The remote revision changed after the last fetch.",
    });
    const encoded = encodeThreadSyncError(error);
    const decoded = decodeThreadSyncError(encoded);

    expect(decoded._tag).toBe("ThreadSyncError");
    expect(decoded.operation).toBe("pull");
    expect(decoded.code).toBe("remote-changed");
    expect(decoded.message).toContain("remote-changed");
  });
});
