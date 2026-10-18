import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import {
  type OrchestrationReadModel,
  ProjectId,
  ThreadSyncError,
  ThreadSyncProjectId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ProjectionTurnRepository,
  type ProjectionTurnRepositoryShape,
} from "../persistence/Services/ProjectionTurns.ts";
import { ThreadSyncGit, type ThreadSyncGitShape } from "./ThreadSyncGit.ts";
import { make } from "./ThreadSyncService.ts";
import { loadThreadSyncLocalState } from "./ThreadSyncState.ts";

const platformLayer = Layer.merge(NodeFileSystem.layer, NodePath.layer);
const corruptState = "{this-is-not-valid-json\n";
const emptySnapshot: OrchestrationReadModel = {
  snapshotSequence: 0,
  projects: [],
  threads: [],
  updatedAt: "2026-10-11T12:00:00.000Z",
};

const buildHarness = Effect.fn("ThreadSyncServiceIntegrityTest.buildHarness")(function* (input: {
  readonly failFetch?: boolean;
  readonly initialState?: "blocking-directory" | "corrupt" | "missing";
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "thread-sync-service-integrity-",
  });
  const config = yield* ServerConfig.ServerConfig.pipe(
    Effect.provide(ServerConfig.layerTest(directory, directory)),
  );
  const statePath = path.join(config.stateDir, "thread-sync", "state.json");
  yield* fileSystem.makeDirectory(path.dirname(statePath), { recursive: true });
  if (input.initialState === "blocking-directory") {
    yield* fileSystem.makeDirectory(statePath);
  } else if (input.initialState !== "missing") {
    yield* fileSystem.writeFileString(statePath, corruptState);
  }

  const gitFailure = new ThreadSyncError({
    operation: "fetch",
    code: "git-failed",
    detail: "Intentional fetch failure.",
  });
  let fetchCount = 0;
  let checkoutWithoutPrefetchCount = 0;
  let removeMirrorCount = 0;
  const git = ThreadSyncGit.of({
    fetch: () =>
      Effect.suspend(() => {
        fetchCount += 1;
        return input.failFetch === true
          ? Effect.fail(gitFailure)
          : Effect.succeed({ mirrorPath: directory, remoteRevision: null });
      }),
    checkoutRemote: (_configuration, _expectedRemoteRevision, prefetched) =>
      Effect.sync(() => {
        if (prefetched === undefined) checkoutWithoutPrefetchCount += 1;
        return prefetched ?? { mirrorPath: directory, remoteRevision: null };
      }),
    commitAndPush: () => Effect.die("commitAndPush must not run in this test"),
    removeMirror: () =>
      Effect.sync(() => {
        removeMirrorCount += 1;
      }),
  } satisfies ThreadSyncGitShape);
  let snapshotReadCount = 0;
  const snapshotQuery = ProjectionSnapshotQuery.ProjectionSnapshotQuery.of({
    getSnapshot: () =>
      Effect.sync(() => {
        snapshotReadCount += 1;
        return emptySnapshot;
      }),
  } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQueryShape);
  const turnRepository = ProjectionTurnRepository.of({
    listByThreadId: () => Effect.succeed([]),
  } as unknown as ProjectionTurnRepositoryShape);
  const engine = OrchestrationEngine.OrchestrationEngineService.of({
    readEvents: () => Stream.empty,
    readLatestAggregateEventType: () => Effect.die("unused"),
    dispatch: () => Effect.die("dispatch must not run in this test"),
    streamDomainEvents: Stream.empty,
    latestSequence: Effect.succeed(7),
  } satisfies OrchestrationEngine.OrchestrationEngineShape);
  const service = yield* make.pipe(
    Effect.provideService(ServerConfig.ServerConfig, config),
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
    Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, snapshotQuery),
    Effect.provideService(ProjectionTurnRepository, turnRepository),
    Effect.provideService(OrchestrationEngine.OrchestrationEngineService, engine),
    Effect.provideService(ThreadSyncGit, git),
  );
  return {
    fileSystem,
    statePath,
    service,
    fetchCount: () => fetchCount,
    checkoutWithoutPrefetchCount: () => checkoutWithoutPrefetchCount,
    removeMirrorCount: () => removeMirrorCount,
    snapshotReadCount: () => snapshotReadCount,
  };
});

const expectCorruptState = Effect.fn("ThreadSyncServiceIntegrityTest.expectCorruptState")(
  function* (harness: { readonly fileSystem: FileSystem.FileSystem; readonly statePath: string }) {
    expect(yield* harness.fileSystem.readFileString(harness.statePath)).toBe(corruptState);
  },
);

describe("ThreadSyncService corrupt local state", () => {
  it.effect("preserves invalid bytes at startup and blocks every implicit mutating operation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* buildHarness({});
        yield* harness.service.start;
        expect((yield* harness.service.getStatus).state).toBe("error");
        yield* expectCorruptState(harness);

        const operations: ReadonlyArray<Effect.Effect<unknown, ThreadSyncError>> = [
          harness.service.fetch({ expectedRemoteRevision: null }),
          harness.service.linkProject({
            syncProjectId: ThreadSyncProjectId.make("remote-project"),
            projectId: ProjectId.make("local-project"),
          }),
          harness.service.pull({ expectedRemoteRevision: null, strategies: [] }),
          harness.service.push({ expectedRemoteRevision: null, strategies: [] }),
        ];
        for (const operation of operations) {
          const result = yield* Effect.result(operation);
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure") expect(result.failure.code).toBe("integrity-failed");
          yield* expectCorruptState(harness);
        }
      }),
    ).pipe(Effect.provide(platformLayer)),
  );

  it.effect("keeps corrupt bytes when an explicit reconfiguration fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* buildHarness({ failFetch: true });
        const error = yield* Effect.flip(
          harness.service.configure({
            remoteUrl: "https://example.test/threads.git",
            branch: "main",
            fetchIntervalSeconds: 60,
          }),
        );

        expect(error.code).toBe("git-failed");
        yield* expectCorruptState(harness);
      }),
    ).pipe(Effect.provide(platformLayer)),
  );

  it.effect("resets corrupt state only after a successful explicit configuration", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* buildHarness({});
        yield* harness.service.configure({
          remoteUrl: "https://example.test/threads.git",
          branch: "main",
          fetchIntervalSeconds: 60,
        });

        const persisted = yield* loadThreadSyncLocalState(harness.statePath);
        expect(persisted.configuration?.remoteUrl).toBe("https://example.test/threads.git");
        expect(persisted.lastBindingEventSequence).toBe(7);
        expect(harness.snapshotReadCount()).toBe(0);
      }),
    ).pipe(Effect.provide(platformLayer)),
  );

  it.effect("polls a configured remote without hydrating the local snapshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* buildHarness({ initialState: "missing" });
        const configuration = {
          remoteUrl: "https://example.test/threads.git",
          branch: "main",
          fetchIntervalSeconds: 60,
        } as const;
        yield* harness.service.configure(configuration);
        const result = yield* harness.service.fetch({ expectedRemoteRevision: null });

        expect(result.discoveredThreadCount).toBe(0);
        expect(harness.fetchCount()).toBe(2);
        expect(harness.checkoutWithoutPrefetchCount()).toBe(0);
        expect(harness.snapshotReadCount()).toBe(0);

        yield* harness.service.start;
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        expect(harness.fetchCount()).toBeGreaterThanOrEqual(3);
        expect(harness.snapshotReadCount()).toBe(0);
      }),
    ).pipe(Effect.provide(platformLayer)),
  );

  it.effect("retries after mirror validation succeeds but state persistence fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* buildHarness({ initialState: "blocking-directory" });
        const configuration = {
          remoteUrl: "https://example.test/threads.git",
          branch: "main",
          fetchIntervalSeconds: 60,
        } as const;

        const first = yield* Effect.result(harness.service.configure(configuration));
        expect(first._tag).toBe("Failure");
        if (first._tag === "Failure") expect(first.failure.code).toBe("io-failed");
        expect(harness.fetchCount()).toBe(1);
        expect(harness.removeMirrorCount()).toBe(0);
        expect(harness.snapshotReadCount()).toBe(0);

        yield* harness.fileSystem.remove(harness.statePath, { recursive: true });
        yield* harness.service.configure(configuration);

        const persisted = yield* loadThreadSyncLocalState(harness.statePath);
        expect(persisted.configuration?.remoteUrl).toBe(configuration.remoteUrl);
        expect(harness.fetchCount()).toBe(2);
        expect(harness.removeMirrorCount()).toBe(0);
        expect(harness.snapshotReadCount()).toBe(0);
      }),
    ).pipe(Effect.provide(platformLayer)),
  );

  it.effect("allows an explicit disconnect to replace corrupt state atomically", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* buildHarness({});
        yield* harness.service.disconnect({ removeLocalMirror: false });

        const persisted = yield* loadThreadSyncLocalState(harness.statePath);
        expect(persisted.configuration).toBeNull();
        expect(persisted.lastBindingEventSequence).toBe(7);
      }),
    ).pipe(Effect.provide(platformLayer)),
  );
});
