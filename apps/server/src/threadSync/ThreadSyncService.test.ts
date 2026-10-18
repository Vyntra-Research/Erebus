import {
  ThreadSyncProjectSnapshot,
  ThreadSyncThreadSnapshot,
  ThreadId,
  type OrchestrationProposedPlanId,
  type ProjectId,
  type OrchestrationEvent,
  type ThreadSyncProjectId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { canonicalThreadSyncPlanId, threadSyncRevision } from "./ThreadSyncDocuments.ts";
import {
  analyzeThreadSyncV2State,
  analyzeThreadSyncState,
  buildThreadSyncImportReferenceMaps,
  deriveKeepBothThreadIds,
  isActivePrimaryThreadForSync,
  portableRepositoryIdentity,
  pruneDanglingPortableCoagents,
  reconcileExportedThreadBindings,
  remapImportedSnapshot,
  replayThreadSyncBindingEvents,
  resolveImportedCoagentParent,
  sanitizeThreadSyncRemoteUrl,
  selectAutoLinkProject,
  selectPortableProjectDescriptor,
  threadSyncImportCommandId,
  validateThreadSyncImportReferences,
} from "./ThreadSyncService.ts";
import { emptyThreadSyncLocalState, type ThreadSyncLocalState } from "./ThreadSyncState.ts";

const decodeProject = Schema.decodeUnknownSync(ThreadSyncProjectSnapshot);
const decodeThread = Schema.decodeUnknownSync(ThreadSyncThreadSnapshot);

function makeProject(input: {
  readonly syncProjectId?: string;
  readonly title?: string;
  readonly canonicalKey?: string;
  readonly relativePath?: string;
}) {
  return decodeProject({
    formatVersion: 1,
    syncProjectId: input.syncProjectId ?? "sync-project",
    title: input.title ?? "Project",
    repositoryIdentity:
      input.canonicalKey === undefined
        ? null
        : {
            canonicalKey: input.canonicalKey,
            locator: {
              source: "git-remote",
              remoteName: "origin",
              remoteUrl: "https://example.test/repository.git",
            },
            displayName: null,
            provider: null,
            owner: null,
            name: null,
          },
    repositoryRelativePath: input.relativePath ?? null,
    createdAt: "2026-10-11T12:00:00.000Z",
    updatedAt: "2026-10-11T12:00:00.000Z",
    deletedAt: null,
  });
}

function makeThread(input: { readonly title: string; readonly deletedAt?: string | null }) {
  return decodeThread({
    formatVersion: 1,
    threadId: "sync-thread",
    syncProjectId: "sync-project",
    title: input.title,
    coagent: null,
    latestTurn: null,
    turns: [],
    lifecycle: {
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      deletedAt: input.deletedAt ?? null,
    },
    createdAt: "2026-10-11T12:00:00.000Z",
    updatedAt: input.deletedAt ?? "2026-10-11T12:00:00.000Z",
    messages: [],
    proposedPlans: [],
    activities: [],
  });
}

function makeState(
  baseRevision: ReturnType<typeof threadSyncRevision> | null,
): ThreadSyncLocalState {
  return {
    ...emptyThreadSyncLocalState(),
    projectBindings: [
      {
        syncProjectId: "sync-project" as ThreadSyncProjectId,
        projectId: "local-project" as ProjectId,
        linkedAt: "2026-10-11T12:00:00.000Z",
      },
    ],
    threadBindings: [
      {
        syncThreadId: "sync-thread" as ThreadId,
        localThreadId: "local-thread" as ThreadId,
        syncProjectId: "sync-project" as ThreadSyncProjectId,
        baseRevision,
      },
    ],
  };
}

function makeLocal(input: {
  readonly thread: ReturnType<typeof makeThread>;
  readonly active?: boolean;
  readonly project?: ReturnType<typeof makeProject>;
  readonly state?: ThreadSyncLocalState;
}) {
  const state = input.state ?? makeState(null);
  const project = input.project ?? makeProject({});
  return {
    projects: new Map([[project.syncProjectId, project]]),
    threads: new Map([[input.thread.threadId, input.thread]]),
    blobs: new Map(),
    activeLocalThreadIds: new Set(input.active ? [state.threadBindings[0]!.localThreadId] : []),
    projectBindings: state.projectBindings,
    threadBindings: state.threadBindings,
  };
}

describe("thread sync eligibility", () => {
  const activePrimary = {
    coagent: null,
    lifecycle: {
      archivedAt: null,
      settledAt: null,
      deletedAt: null,
    },
  };

  it("includes only visible primary threads", () => {
    expect(isActivePrimaryThreadForSync(activePrimary)).toBe(true);
    expect(
      isActivePrimaryThreadForSync({
        ...activePrimary,
        coagent: { status: "ready" },
      }),
    ).toBe(false);
  });

  it.each(["archivedAt", "settledAt", "deletedAt"] as const)(
    "excludes a thread with %s set",
    (field) => {
      expect(
        isActivePrimaryThreadForSync({
          ...activePrimary,
          lifecycle: {
            ...activePrimary.lifecycle,
            [field]: "2026-10-17T23:30:00.000Z",
          },
        }),
      ).toBe(false);
    },
  );
});

describe("ThreadSyncService state analysis", () => {
  it("treats different first-sync copies as a conflict", () => {
    const localThread = makeThread({ title: "Local" });
    const remoteThread = makeThread({ title: "Remote" });
    const project = makeProject({});
    const analysis = analyzeThreadSyncState({
      local: makeLocal({ thread: localThread }),
      remote: {
        projects: new Map([[project.syncProjectId, project]]),
        threads: new Map([[remoteThread.threadId, remoteThread]]),
        blobs: new Map(),
      },
      state: makeState(null),
    });

    expect(analysis.status.conflicts).toHaveLength(1);
    expect(analysis.entries[0]?.decision).toBe("conflict");
  });

  it("does not schedule changes for an active local turn", () => {
    const localThread = makeThread({ title: "Local" });
    const remoteThread = makeThread({ title: "Remote" });
    const project = makeProject({});
    const state = makeState(null);
    const analysis = analyzeThreadSyncState({
      local: makeLocal({ thread: localThread, active: true, state }),
      remote: {
        projects: new Map([[project.syncProjectId, project]]),
        threads: new Map([[remoteThread.threadId, remoteThread]]),
        blobs: new Map(),
      },
      state,
    });

    expect(analysis.status.conflicts).toEqual([]);
    expect(analysis.status.pendingPullCount).toBe(0);
    expect(analysis.status.pendingPushCount).toBe(0);
    expect(analysis.entries[0]?.active).toBe(true);
  });

  it("does not expose remote credentials through status", () => {
    const thread = makeThread({ title: "Thread" });
    const state: ThreadSyncLocalState = {
      ...makeState(null),
      configuration: {
        remoteUrl: "https://user:secret@example.test/owner/repo.git?token=secret#ref",
        branch: "main",
        fetchIntervalSeconds: 60,
      },
    };
    const analysis = analyzeThreadSyncState({
      local: makeLocal({ thread, state }),
      remote: { projects: new Map(), threads: new Map(), blobs: new Map() },
      state,
    });

    expect(analysis.status.configuration?.remoteUrl).toBe("https://example.test/owner/repo.git");
  });

  it("keeps a credential-free local repository path usable in status", () => {
    const thread = makeThread({ title: "Thread" });
    const state: ThreadSyncLocalState = {
      ...makeState(null),
      configuration: {
        remoteUrl: "C:/work/shared-thread-sync.git",
        branch: "main",
        fetchIntervalSeconds: 60,
      },
    };
    const analysis = analyzeThreadSyncState({
      local: makeLocal({ thread, state }),
      remote: { projects: new Map(), threads: new Map(), blobs: new Map() },
      state,
    });

    expect(analysis.status.configuration?.remoteUrl).toBe("C:/work/shared-thread-sync.git");
  });

  it("keeps a normal SSH username usable in status", () => {
    const thread = makeThread({ title: "Thread" });
    const state: ThreadSyncLocalState = {
      ...makeState(null),
      configuration: {
        remoteUrl: "ssh://git@example.test/owner/repo.git",
        branch: "main",
        fetchIntervalSeconds: 60,
      },
    };
    const analysis = analyzeThreadSyncState({
      local: makeLocal({ thread, state }),
      remote: { projects: new Map(), threads: new Map(), blobs: new Map() },
      state,
    });

    expect(analysis.status.configuration?.remoteUrl).toBe("ssh://git@example.test/owner/repo.git");
  });

  it("pushes an explicit tombstone instead of treating absence as deletion", () => {
    const remoteThread = makeThread({ title: "Thread" });
    const localThread = makeThread({
      title: "Thread",
      deletedAt: "2026-10-11T12:01:00.000Z",
    });
    const project = makeProject({});
    const state = makeState(threadSyncRevision(remoteThread));
    const analysis = analyzeThreadSyncState({
      local: makeLocal({ thread: localThread, state }),
      remote: {
        projects: new Map([[project.syncProjectId, project]]),
        threads: new Map([[remoteThread.threadId, remoteThread]]),
        blobs: new Map(),
      },
      state,
    });

    expect(analysis.entries[0]?.decision).toBe("push");
    expect(analysis.status.pendingPushCount).toBe(1);
  });

  it("distinguishes a missing workspace from no repository match", () => {
    const localProject = makeProject({
      syncProjectId: "local-sync-project",
      canonicalKey: "github.com/example/repository",
      relativePath: ".",
    });
    const remoteProject = makeProject({
      syncProjectId: "remote-sync-project",
      canonicalKey: "github.com/example/repository",
      relativePath: "packages/app",
    });
    const thread = makeThread({ title: "Thread" });
    const state: ThreadSyncLocalState = {
      ...emptyThreadSyncLocalState(),
      projectBindings: [
        {
          syncProjectId: localProject.syncProjectId,
          projectId: "local-project" as ProjectId,
          linkedAt: "2026-10-11T12:00:00.000Z",
        },
      ],
    };
    const local = {
      ...makeLocal({ thread, project: localProject, state }),
      threads: new Map(),
      threadBindings: [],
    };
    const analysis = analyzeThreadSyncState({
      local,
      remote: {
        projects: new Map([[remoteProject.syncProjectId, remoteProject]]),
        threads: new Map(),
        blobs: new Map(),
      },
      state,
    });

    expect(analysis.status.unlinkedProjects).toEqual([
      {
        project: remoteProject,
        reason: "workspace-missing",
        suggestedProjectId: "local-project",
      },
    ]);
  });

  it("requests relinking only for projects that still contain active primary threads", () => {
    const staleProject = makeProject({ syncProjectId: "stale-project", title: "Stale" });
    const activeProject = makeProject({ syncProjectId: "active-project", title: "Active" });
    const activeThreadId = ThreadId.make("active-thread");
    const state = emptyThreadSyncLocalState();
    const local = {
      index: { projects: [], threads: [] },
      projects: new Map(),
      descriptors: new Map(),
      revisions: new Map(),
      sources: new Map(),
      blobs: new Map(),
      activeLocalThreadIds: new Set<ThreadId>(),
      projectBindings: [],
      threadBindings: [],
    };
    const remote = {
      manifest: {},
      projects: new Map([
        [staleProject.syncProjectId, staleProject],
        [activeProject.syncProjectId, activeProject],
      ]),
      threads: new Map([
        [
          activeThreadId,
          {
            threadId: activeThreadId,
            syncProjectId: activeProject.syncProjectId,
            title: "Active thread",
            revision: "active-revision",
          },
        ],
      ]),
      threadManifests: new Map([
        [
          activeThreadId,
          {
            header: {
              coagent: null,
              lifecycle: { archivedAt: null, settledAt: null, deletedAt: null },
            },
          },
        ],
      ]),
      blobs: new Map(),
    };
    const analysis = analyzeThreadSyncV2State({
      local,
      remote,
      state,
    } as never);

    expect(analysis.status.unlinkedProjects.map((entry) => entry.project.syncProjectId)).toEqual([
      activeProject.syncProjectId,
    ]);

    const binding = {
      syncProjectId: activeProject.syncProjectId,
      projectId: "local-project" as ProjectId,
      linkedAt: "2026-10-18T00:00:00.000Z",
    };
    const boundAnalysis = analyzeThreadSyncV2State({
      local: { ...local, projectBindings: [binding] },
      remote,
      state: { ...state, projectBindings: [binding] },
    } as never);

    expect(boundAnalysis.status.unlinkedProjects).toEqual([]);
  });
});

describe("threadSyncImportCommandId", () => {
  it("is retry-stable while distinguishing every local import precondition", () => {
    const base = {
      snapshot: makeThread({ title: "Remote" }),
      targetThreadId: "local-thread" as ThreadId,
      projectId: "local-project" as ProjectId,
      mode: "replace" as const,
      expectedLocalUpdatedAt: "2026-10-11T12:00:00.000Z" as const,
      sourceRevision: "remote-revision" as never,
      bindingUpdates: [
        {
          syncThreadId: "sync-thread" as ThreadId,
          localThreadId: "local-thread" as ThreadId,
          syncProjectId: "sync-project",
          localProjectId: "local-project" as ProjectId,
          baseRevision: "base-revision",
        },
      ],
    };
    const id = threadSyncImportCommandId([base]);

    expect(threadSyncImportCommandId([base])).toBe(id);
    expect(threadSyncImportCommandId([{ ...base, mode: "create" }])).not.toBe(id);
    expect(
      threadSyncImportCommandId([{ ...base, projectId: "other-project" as ProjectId }]),
    ).not.toBe(id);
    expect(threadSyncImportCommandId([{ ...base, expectedLocalUpdatedAt: null }])).not.toBe(id);
    expect(
      threadSyncImportCommandId([
        {
          ...base,
          bindingUpdates: [
            {
              ...base.bindingUpdates[0]!,
              localThreadId: "other-local-thread" as ThreadId,
            },
          ],
        },
      ]),
    ).not.toBe(id);
  });

  it("does not depend on the batch selection order", () => {
    const first = {
      snapshot: makeThread({ title: "First" }),
      targetThreadId: "local-first" as ThreadId,
      projectId: "local-project" as ProjectId,
      mode: "create" as const,
      expectedLocalUpdatedAt: null,
      sourceRevision: "remote-revision" as never,
      bindingUpdates: [],
    };
    const second = {
      ...first,
      snapshot: decodeThread({
        ...makeThread({ title: "Second" }),
        threadId: "sync-second",
      }),
      targetThreadId: "local-second" as ThreadId,
    };

    expect(threadSyncImportCommandId([first, second])).toBe(
      threadSyncImportCommandId([second, first]),
    );
  });
});

describe("sanitizeThreadSyncRemoteUrl", () => {
  it("removes HTTPS and SSH URL credentials before serialization", () => {
    expect(
      sanitizeThreadSyncRemoteUrl("https://user:secret-token@example.test/owner/repo.git"),
    ).toBe("https://example.test/owner/repo.git");
    expect(sanitizeThreadSyncRemoteUrl("ssh://git:secret@example.test/owner/repo.git")).toBe(
      "ssh://example.test/owner/repo.git",
    );
  });

  it("does not rewrite a credential-free remote", () => {
    expect(sanitizeThreadSyncRemoteUrl("https://example.test/owner/repo.git")).toBe(
      "https://example.test/owner/repo.git",
    );
  });

  it("removes userinfo from SCP-like remotes", () => {
    expect(sanitizeThreadSyncRemoteUrl("secret-token@example.test:owner/repo.git")).toBe(
      "example.test:owner/repo.git",
    );
  });

  it("drops query credentials and fragments from serialized remotes", () => {
    expect(
      sanitizeThreadSyncRemoteUrl(
        "https://user:secret@example.test/owner/repo.git?access_token=secret#ref",
      ),
    ).toBe("https://example.test/owner/repo.git");
    expect(
      sanitizeThreadSyncRemoteUrl("token@example.test:owner/repo.git?access_token=secret#ref"),
    ).toBe("example.test:owner/repo.git");
  });
});

describe("portableRepositoryIdentity", () => {
  it("serializes no credential-bearing key, query, fragment, or local path", () => {
    const portable = portableRepositoryIdentity({
      canonicalKey: "https://user:secret@example.test/owner/repo.git?token=secret",
      rootPath: "C:/private/work/repo",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://user:secret@example.test/owner/repo.git?token=secret#ref",
      },
    });
    const serialized = JSON.stringify(portable);

    expect(portable?.locator.remoteUrl).toBe("https://example.test/owner/repo.git");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("C:/private");
    expect(
      portableRepositoryIdentity({
        canonicalKey: "C:/private/work/repo",
        rootPath: "C:/private/work/repo",
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "C:/private/work/repo",
        },
      }),
    ).toBeNull();
  });
});

describe("selectPortableProjectDescriptor", () => {
  it("keeps the published descriptor stable when two hosts bind different local projects", () => {
    const remote = makeProject({
      syncProjectId: "portable-project",
      title: "Shared project",
      canonicalKey: "repository-stable",
    });
    const firstHost = makeProject({
      syncProjectId: "portable-project",
      title: "First host folder",
      canonicalKey: "repository-first-host",
    });
    const secondHost = makeProject({
      syncProjectId: "portable-project",
      title: "Second host folder",
      canonicalKey: "repository-second-host",
    });

    expect(selectPortableProjectDescriptor({ local: firstHost, remote })).toEqual(remote);
    expect(selectPortableProjectDescriptor({ local: secondHost, remote })).toEqual(remote);
  });
});

describe("selectAutoLinkProject", () => {
  it("ignores deleted local projects while matching a live checkout", () => {
    const remote = makeProject({
      syncProjectId: "remote-project",
      canonicalKey: "repository-stable",
      relativePath: ".",
    });
    const deleted = decodeProject({
      ...makeProject({
        syncProjectId: "deleted-project",
        canonicalKey: "repository-stable",
        relativePath: ".",
      }),
      deletedAt: "2026-10-11T12:30:00.000Z",
    });
    const live = makeProject({
      syncProjectId: "live-project",
      canonicalKey: "repository-stable",
      relativePath: ".",
    });

    expect(selectAutoLinkProject(remote, [deleted, live])?.syncProjectId).toBe("live-project");
    expect(selectAutoLinkProject(remote, [deleted])).toBeNull();
  });
});

describe("remapImportedSnapshot", () => {
  it("keeps portable order when equal timestamps are sorted by remapped ids", () => {
    const snapshot = decodeThread({
      ...makeThread({ title: "Ordered" }),
      messages: [
        {
          id: "message-z",
          role: "user",
          text: "first",
          attachments: [],
          turnId: null,
          streaming: false,
          createdAt: "2026-10-11T12:00:00.000Z",
          updatedAt: "2026-10-11T12:00:00.000Z",
        },
        {
          id: "message-a",
          role: "assistant",
          text: "second",
          attachments: [],
          turnId: null,
          streaming: false,
          createdAt: "2026-10-11T12:00:00.000Z",
          updatedAt: "2026-10-11T12:00:00.000Z",
        },
      ],
    });
    const remapped = remapImportedSnapshot({
      snapshot,
      targetThreadId: "local-thread" as ThreadId,
      sourceRevision: "source-revision" as never,
      attachment: () => {
        throw new Error("No attachment expected.");
      },
    });

    expect(
      remapped.messages
        .toSorted((left, right) =>
          left.createdAt === right.createdAt
            ? left.id.localeCompare(right.id)
            : left.createdAt.localeCompare(right.createdAt),
        )
        .map((message) => message.text),
    ).toEqual(["first", "second"]);
  });

  it("remaps cross-thread source plans and implementation threads imported in one batch", () => {
    const sourceThreadId = "sync-source" as ThreadId;
    const consumerThreadId = "sync-consumer" as ThreadId;
    const sourcePlanId = canonicalThreadSyncPlanId(sourceThreadId, 0);
    const source = decodeThread({
      ...makeThread({ title: "Source" }),
      threadId: sourceThreadId,
      proposedPlans: [
        {
          id: sourcePlanId,
          turnId: null,
          planMarkdown: "Source plan",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-10-11T12:00:00.000Z",
          updatedAt: "2026-10-11T12:00:00.000Z",
        },
      ],
    });
    const crossTurn = {
      turnId: "consumer-turn",
      pendingMessageId: null,
      sourceProposedPlanThreadId: sourceThreadId,
      sourceProposedPlanId: sourcePlanId,
      state: "completed" as const,
      requestedAt: "2026-10-11T12:01:00.000Z",
      startedAt: "2026-10-11T12:01:01.000Z",
      completedAt: "2026-10-11T12:01:02.000Z",
      assistantMessageId: null,
    };
    const consumer = decodeThread({
      ...makeThread({ title: "Consumer" }),
      threadId: consumerThreadId,
      latestTurn: crossTurn,
      turns: [crossTurn],
      proposedPlans: [
        {
          id: canonicalThreadSyncPlanId(consumerThreadId, 0),
          turnId: "consumer-turn",
          planMarkdown: "Implementation plan",
          implementedAt: "2026-10-11T12:01:02.000Z",
          implementationThreadId: sourceThreadId,
          createdAt: "2026-10-11T12:01:00.000Z",
          updatedAt: "2026-10-11T12:01:02.000Z",
        },
      ],
    });
    const selections = [
      {
        snapshot: source,
        targetThreadId: "local-source" as ThreadId,
        projectId: "local-project" as ProjectId,
        sourceRevision: "revision-source" as never,
      },
      {
        snapshot: consumer,
        targetThreadId: "local-consumer" as ThreadId,
        projectId: "local-project" as ProjectId,
        sourceRevision: "revision-consumer" as never,
      },
    ];
    const references = buildThreadSyncImportReferenceMaps({
      selections,
      threadBindings: [],
      localThreads: [],
      convergentSyncThreadIds: new Set(),
    });
    const revisedReferences = buildThreadSyncImportReferenceMaps({
      selections: selections.map((selection) => ({
        ...selection,
        sourceRevision: "revision-next" as never,
      })),
      threadBindings: [],
      localThreads: [],
      convergentSyncThreadIds: new Set(),
    });

    expect(validateThreadSyncImportReferences({ selections, references })).toBeNull();
    expect(revisedReferences.planIds.get(sourceThreadId)?.get(sourcePlanId)).toBe(
      references.planIds.get(sourceThreadId)?.get(sourcePlanId),
    );
    const remapped = remapImportedSnapshot({
      ...selections[1]!,
      references,
      attachment: () => {
        throw new Error("No attachment expected.");
      },
    });
    const localSourcePlanId = references.planIds.get(sourceThreadId)?.get(sourcePlanId);
    expect(localSourcePlanId).toBeDefined();
    expect(remapped.turns[0]).toMatchObject({
      sourceProposedPlanThreadId: "local-source",
      sourceProposedPlanId: localSourcePlanId,
    });
    expect(remapped.proposedPlans[0]?.implementationThreadId).toBe("local-source");
  });

  it("resolves a cross-thread source plan through an existing local binding", () => {
    const sourceThreadId = "sync-source" as ThreadId;
    const consumerThreadId = "sync-consumer" as ThreadId;
    const sourcePlanId = canonicalThreadSyncPlanId(sourceThreadId, 0);
    const crossTurn = {
      turnId: "consumer-turn",
      pendingMessageId: null,
      sourceProposedPlanThreadId: sourceThreadId,
      sourceProposedPlanId: sourcePlanId,
      state: "completed" as const,
      requestedAt: "2026-10-11T12:01:00.000Z",
      startedAt: "2026-10-11T12:01:01.000Z",
      completedAt: "2026-10-11T12:01:02.000Z",
      assistantMessageId: null,
    };
    const consumer = decodeThread({
      ...makeThread({ title: "Consumer" }),
      threadId: consumerThreadId,
      latestTurn: crossTurn,
      turns: [crossTurn],
      proposedPlans: [],
    });
    const selections = [
      {
        snapshot: consumer,
        targetThreadId: "local-consumer" as ThreadId,
        projectId: "local-project" as ProjectId,
        sourceRevision: "revision-consumer" as never,
      },
    ];
    const localPlanId = "local-source-plan" as OrchestrationProposedPlanId;
    const references = buildThreadSyncImportReferenceMaps({
      selections,
      threadBindings: [
        {
          syncThreadId: sourceThreadId,
          localThreadId: "local-source" as ThreadId,
          syncProjectId: "sync-project" as ThreadSyncProjectId,
          baseRevision: null,
        },
      ],
      localThreads: [
        {
          id: "local-source" as ThreadId,
          projectId: "local-project" as ProjectId,
          proposedPlans: [
            {
              id: localPlanId,
              turnId: null,
              planMarkdown: "Existing source plan",
              implementedAt: null,
              implementationThreadId: null,
              createdAt: "2026-10-11T12:00:00.000Z",
              updatedAt: "2026-10-11T12:00:00.000Z",
            },
          ],
        },
      ],
      convergentSyncThreadIds: new Set([sourceThreadId]),
    });

    expect(validateThreadSyncImportReferences({ selections, references })).toBeNull();
    const remapped = remapImportedSnapshot({
      ...selections[0]!,
      references,
      attachment: () => {
        throw new Error("No attachment expected.");
      },
    });
    expect(remapped.turns[0]).toMatchObject({
      sourceProposedPlanThreadId: "local-source",
      sourceProposedPlanId: localPlanId,
    });
  });

  it("rejects a dependent import when its divergent bound source was skipped", () => {
    const sourceThreadId = "sync-source" as ThreadId;
    const sourcePlanId = canonicalThreadSyncPlanId(sourceThreadId, 0);
    const crossTurn = {
      turnId: "consumer-turn",
      pendingMessageId: null,
      sourceProposedPlanThreadId: sourceThreadId,
      sourceProposedPlanId: sourcePlanId,
      state: "completed" as const,
      requestedAt: "2026-10-11T12:01:00.000Z",
      startedAt: "2026-10-11T12:01:01.000Z",
      completedAt: "2026-10-11T12:01:02.000Z",
      assistantMessageId: null,
    };
    const consumer = decodeThread({
      ...makeThread({ title: "Consumer" }),
      threadId: "sync-consumer",
      latestTurn: crossTurn,
      turns: [crossTurn],
    });
    const selections = [
      {
        snapshot: consumer,
        targetThreadId: "local-consumer" as ThreadId,
        projectId: "local-project" as ProjectId,
        sourceRevision: "revision-consumer" as never,
      },
    ];
    const references = buildThreadSyncImportReferenceMaps({
      selections,
      threadBindings: [
        {
          syncThreadId: sourceThreadId,
          localThreadId: "local-source" as ThreadId,
          syncProjectId: "sync-project" as ThreadSyncProjectId,
          baseRevision: "old-source-revision" as never,
        },
      ],
      localThreads: [
        {
          id: "local-source" as ThreadId,
          projectId: "local-project" as ProjectId,
          proposedPlans: [
            {
              id: "stale-local-plan" as OrchestrationProposedPlanId,
              turnId: null,
              planMarkdown: "Stale local plan",
              implementedAt: null,
              implementationThreadId: null,
              createdAt: "2026-10-11T12:00:00.000Z",
              updatedAt: "2026-10-11T12:00:00.000Z",
            },
          ],
        },
      ],
      // The source was active and divergent, so applyRemoteChanges skipped it.
      convergentSyncThreadIds: new Set(),
    });

    expect(validateThreadSyncImportReferences({ selections, references })).toContain(
      "not available locally",
    );
  });

  it("rejects cross-project source and implementation relations", () => {
    const sourceThreadId = "sync-source" as ThreadId;
    const consumerThreadId = "sync-consumer" as ThreadId;
    const sourcePlanId = canonicalThreadSyncPlanId(sourceThreadId, 0);
    const source = decodeThread({
      ...makeThread({ title: "Source" }),
      threadId: sourceThreadId,
      proposedPlans: [
        {
          id: sourcePlanId,
          turnId: null,
          planMarkdown: "Source plan",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-10-11T12:00:00.000Z",
          updatedAt: "2026-10-11T12:00:00.000Z",
        },
      ],
    });
    const crossTurn = {
      turnId: "consumer-turn",
      pendingMessageId: null,
      sourceProposedPlanThreadId: sourceThreadId,
      sourceProposedPlanId: sourcePlanId,
      state: "completed" as const,
      requestedAt: "2026-10-11T12:01:00.000Z",
      startedAt: "2026-10-11T12:01:01.000Z",
      completedAt: "2026-10-11T12:01:02.000Z",
      assistantMessageId: null,
    };
    const consumer = decodeThread({
      ...makeThread({ title: "Consumer" }),
      threadId: consumerThreadId,
      latestTurn: crossTurn,
      turns: [crossTurn],
      proposedPlans: [
        {
          id: canonicalThreadSyncPlanId(consumerThreadId, 0),
          turnId: "consumer-turn",
          planMarkdown: "Cross-project implementation",
          implementedAt: "2026-10-11T12:01:02.000Z",
          implementationThreadId: sourceThreadId,
          createdAt: "2026-10-11T12:01:00.000Z",
          updatedAt: "2026-10-11T12:01:02.000Z",
        },
      ],
    });
    const selections = [
      {
        snapshot: source,
        targetThreadId: "local-source" as ThreadId,
        projectId: "source-project" as ProjectId,
        sourceRevision: "revision-source" as never,
      },
      {
        snapshot: consumer,
        targetThreadId: "local-consumer" as ThreadId,
        projectId: "consumer-project" as ProjectId,
        sourceRevision: "revision-consumer" as never,
      },
    ];
    const references = buildThreadSyncImportReferenceMaps({
      selections,
      threadBindings: [],
      localThreads: [],
      convergentSyncThreadIds: new Set(),
    });

    expect(validateThreadSyncImportReferences({ selections, references })).toContain(
      "source thread 'sync-source' outside its local project",
    );
    const implementationOnly = [
      {
        ...selections[1]!,
        snapshot: decodeThread({
          ...consumer,
          latestTurn: null,
          turns: [],
          proposedPlans: consumer.proposedPlans.map((plan) => ({ ...plan, turnId: null })),
        }),
      },
    ];
    expect(
      validateThreadSyncImportReferences({ selections: implementationOnly, references }),
    ).toContain("implementation thread 'sync-source' outside its local project");
  });

  it("rejects a cross-thread reference that cannot be materialized", () => {
    const sourceThreadId = "sync-missing" as ThreadId;
    const consumerThreadId = "sync-consumer" as ThreadId;
    const crossTurn = {
      turnId: "consumer-turn",
      pendingMessageId: null,
      sourceProposedPlanThreadId: sourceThreadId,
      sourceProposedPlanId: canonicalThreadSyncPlanId(sourceThreadId, 0),
      state: "completed" as const,
      requestedAt: "2026-10-11T12:01:00.000Z",
      startedAt: "2026-10-11T12:01:01.000Z",
      completedAt: "2026-10-11T12:01:02.000Z",
      assistantMessageId: null,
    };
    const consumer = decodeThread({
      ...makeThread({ title: "Consumer" }),
      threadId: consumerThreadId,
      latestTurn: crossTurn,
      turns: [crossTurn],
    });
    const selections = [
      {
        snapshot: consumer,
        targetThreadId: "local-consumer" as ThreadId,
        projectId: "local-project" as ProjectId,
        sourceRevision: "revision-consumer" as never,
      },
    ];
    const references = buildThreadSyncImportReferenceMaps({
      selections,
      threadBindings: [],
      localThreads: [],
      convergentSyncThreadIds: new Set(),
    });

    expect(validateThreadSyncImportReferences({ selections, references })).toContain(
      "not available locally",
    );
  });

  it("remaps a co-agent parent through the final keep-both binding", () => {
    const portableParentId = "sync-parent" as ThreadId;
    const clonedParentId = "local-parent-clone" as ThreadId;
    const clonedChildId = "local-child-clone" as ThreadId;
    const projectId = "local-project" as ProjectId;
    const snapshot = decodeThread({
      ...makeThread({ title: "Child" }),
      threadId: "sync-child",
      coagent: {
        parentThreadId: portableParentId,
        creationMode: "fork",
        status: "ready",
      },
    });
    const importedTargets = new Map([
      [
        portableParentId,
        {
          threadId: clonedParentId,
          projectId,
          deletedAt: null,
        },
      ],
    ]);
    const coagentParentThreadId = resolveImportedCoagentParent({
      snapshot,
      targetThreadId: clonedChildId,
      projectId,
      importedTargets,
      threadBindings: [
        {
          syncThreadId: portableParentId,
          localThreadId: clonedParentId,
          syncProjectId: "sync-project" as ThreadSyncProjectId,
          baseRevision: null,
        },
      ],
      localThreads: [],
    });
    const remapped = remapImportedSnapshot({
      snapshot,
      targetThreadId: clonedChildId,
      sourceRevision: "source-revision" as never,
      coagentParentThreadId,
      attachment: () => {
        throw new Error("No attachment expected.");
      },
    });

    expect(remapped.coagent).toEqual({
      parentThreadId: clonedParentId,
      creationMode: "fork",
      status: "ready",
    });
  });

  it("drops a co-agent relation when the mapped parent is unavailable", () => {
    const snapshot = decodeThread({
      ...makeThread({ title: "Child" }),
      coagent: {
        parentThreadId: "missing-parent",
        creationMode: "blank",
        status: "ready",
      },
    });

    expect(
      resolveImportedCoagentParent({
        snapshot,
        targetThreadId: "local-child" as ThreadId,
        projectId: "local-project" as ProjectId,
        importedTargets: new Map(),
        threadBindings: [],
        localThreads: [],
      }),
    ).toBeNull();
  });
});

describe("pruneDanglingPortableCoagents", () => {
  it("drops the child relation when its active parent was omitted from export", () => {
    const child = decodeThread({
      ...makeThread({ title: "Child" }),
      threadId: "sync-child",
      coagent: {
        parentThreadId: "sync-active-parent",
        creationMode: "fork",
        status: "ready",
      },
    });

    const exported = pruneDanglingPortableCoagents(new Map([[child.threadId, child]]));

    expect(exported.get(child.threadId)?.coagent).toBeNull();
  });

  it("preserves the child relation when both snapshots are exported", () => {
    const parent = decodeThread({
      ...makeThread({ title: "Parent" }),
      threadId: "sync-parent",
    });
    const child = decodeThread({
      ...makeThread({ title: "Child" }),
      threadId: "sync-child",
      coagent: {
        parentThreadId: parent.threadId,
        creationMode: "blank",
        status: "released",
      },
    });

    const exported = pruneDanglingPortableCoagents(
      new Map([
        [parent.threadId, parent],
        [child.threadId, child],
      ]),
    );

    expect(exported.get(child.threadId)?.coagent?.parentThreadId).toBe(parent.threadId);
  });

  it("preserves the child relation when the active parent remains in the remote snapshot", () => {
    const child = decodeThread({
      ...makeThread({ title: "Child" }),
      threadId: "sync-child",
      coagent: {
        parentThreadId: "sync-active-parent",
        creationMode: "fork",
        status: "ready",
      },
    });

    const exported = pruneDanglingPortableCoagents(new Map([[child.threadId, child]]), [
      "sync-active-parent",
    ]);

    expect(exported.get(child.threadId)?.coagent?.parentThreadId).toBe("sync-active-parent");
  });
});

describe("reconcileExportedThreadBindings", () => {
  it("recovers the write-ahead binding map on either side of an import crash", () => {
    const projectId = "local-project" as ProjectId;
    const syncProjectId = "sync-project" as ThreadSyncProjectId;
    const preservedThreadId = "local-preserved" as ThreadId;
    const clonedThreadId = "local-clone" as ThreadId;
    const writeAheadBindings = [
      {
        syncThreadId: "sync-preserved" as ThreadId,
        localThreadId: preservedThreadId,
        syncProjectId,
        baseRevision: null,
      },
      {
        syncThreadId: "sync-remote" as ThreadId,
        localThreadId: clonedThreadId,
        syncProjectId,
        baseRevision: threadSyncRevision({ remote: true }),
      },
    ];
    const syncProjectByLocal = new Map([[projectId, syncProjectId]]);

    const beforeSqlCommit = reconcileExportedThreadBindings({
      existing: writeAheadBindings,
      threads: [{ id: preservedThreadId, projectId }],
      syncProjectByLocal,
    });
    expect(beforeSqlCommit).toEqual([writeAheadBindings[0]]);

    const afterSqlCommit = reconcileExportedThreadBindings({
      existing: writeAheadBindings,
      threads: [
        { id: preservedThreadId, projectId },
        { id: clonedThreadId, projectId },
      ],
      syncProjectByLocal,
    });
    expect(afterSqlCommit).toEqual(writeAheadBindings);
    expect(
      reconcileExportedThreadBindings({
        existing: afterSqlCommit,
        threads: [
          { id: preservedThreadId, projectId },
          { id: clonedThreadId, projectId },
        ],
        syncProjectByLocal,
      }),
    ).toEqual(afterSqlCommit);
  });

  it("recovers committed bindings after a state write failure and replays them once", () => {
    const oldBase = threadSyncRevision({ version: "old" });
    const remoteBase = threadSyncRevision({ version: "remote" });
    const beforeDispatch = { ...makeState(oldBase), lastBindingEventSequence: 40 };
    const importedEvent = {
      sequence: 41,
      type: "thread.sync-imported",
      payload: {
        bindingUpdates: [
          {
            syncThreadId: "sync-thread",
            localThreadId: "local-thread",
            syncProjectId: "sync-project",
            baseRevision: remoteBase,
          },
        ],
      },
    } as unknown as OrchestrationEvent;

    const recovered = replayThreadSyncBindingEvents(beforeDispatch, [importedEvent]);
    const retried = replayThreadSyncBindingEvents(recovered, [importedEvent]);

    expect(recovered.threadBindings[0]?.baseRevision).toBe(remoteBase);
    expect(recovered.lastBindingEventSequence).toBe(41);
    expect(retried).toEqual(recovered);
  });
});

describe("deriveKeepBothThreadIds", () => {
  it("is retry-safe for the same conflict and changes with either revision", () => {
    const input = {
      syncThreadId: "sync-thread" as ThreadId,
      localThreadId: "local-thread" as ThreadId,
      localRevision: threadSyncRevision({ side: "local" }),
      remoteRevision: threadSyncRevision({ side: "remote" }),
    };
    const first = deriveKeepBothThreadIds(input);

    expect(deriveKeepBothThreadIds(input)).toEqual(first);
    expect(
      deriveKeepBothThreadIds({
        ...input,
        remoteRevision: threadSyncRevision({ side: "remote-updated" }),
      }),
    ).not.toEqual(first);
    expect(first.preservedSyncThreadId).not.toBe(first.clonedThreadId);
  });
});
