// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  ThreadId,
  ThreadSyncProjectSnapshot,
  ThreadSyncRevision,
  ThreadSyncThreadSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ProjectionTurnRepository,
  type ProjectionTurnRepositoryShape,
} from "../persistence/Services/ProjectionTurns.ts";
import { THREAD_SYNC_NAMESPACE, threadSyncRevision } from "./ThreadSyncDocuments.ts";
import { ThreadSyncGit, type ThreadSyncGitShape } from "./ThreadSyncGit.ts";
import { readThreadSyncRepository, writeThreadSyncRepository } from "./ThreadSyncRepository.ts";
import {
  THREAD_SYNC_V2_MANIFEST_PATH,
  readThreadSyncV2RepositoryIndex,
} from "./ThreadSyncRepositoryV2.ts";
import { make } from "./ThreadSyncService.ts";
import { saveThreadSyncLocalState, type ThreadSyncLocalState } from "./ThreadSyncState.ts";

const decodeProject = Schema.decodeUnknownSync(ThreadSyncProjectSnapshot);
const decodeThread = Schema.decodeUnknownSync(ThreadSyncThreadSnapshot);

describe("ThreadSyncService v1 remote migration", () => {
  it.effect("upgrades the existing remote in place without hydrating the v1 local snapshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "thread-sync-service-v1-migration-",
        });
        const mirrorPath = NodePath.join(directory, "mirror");
        yield* fileSystem.makeDirectory(mirrorPath, { recursive: true });
        const project = decodeProject({
          formatVersion: 1,
          syncProjectId: "sync-project",
          title: "Project",
          repositoryIdentity: null,
          repositoryRelativePath: null,
          createdAt: "2026-10-17T18:00:00.000Z",
          updatedAt: "2026-10-17T18:00:00.000Z",
          deletedAt: null,
        });
        const remoteThread = decodeThread({
          formatVersion: 1,
          threadId: "sync-thread",
          syncProjectId: "sync-project",
          title: "Large local thread",
          coagent: null,
          latestTurn: null,
          turns: [],
          lifecycle: {
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            deletedAt: null,
          },
          createdAt: "2026-10-17T18:00:00.000Z",
          updatedAt: "2026-10-17T18:00:00.000Z",
          messages: [],
          proposedPlans: [],
          activities: [],
        });
        yield* writeThreadSyncRepository({
          mirrorPath,
          projects: new Map([[project.syncProjectId, project]]),
          threads: new Map([[remoteThread.threadId, remoteThread]]),
          blobs: new Map(),
          updatedAt: "2026-10-17T18:00:00.000Z",
        });

        const config = yield* ServerConfig.ServerConfig.pipe(
          Effect.provide(ServerConfig.layerTest(directory, directory)),
        );
        const statePath = NodePath.join(config.stateDir, "thread-sync", "state.json");
        const remoteRevision = "a".repeat(64) as ThreadSyncRevision;
        const nextRevision = "b".repeat(64) as ThreadSyncRevision;
        const state: ThreadSyncLocalState = {
          formatVersion: 2,
          configuration: {
            remoteUrl: "https://example.test/threads.git",
            branch: "main",
            fetchIntervalSeconds: 60,
          },
          remoteRevision,
          lastFetchedAt: "2026-10-17T18:00:00.000Z",
          projectBindings: [
            {
              syncProjectId: project.syncProjectId,
              projectId: ProjectId.make("local-project"),
              linkedAt: "2026-10-17T18:00:00.000Z",
            },
          ],
          threadBindings: [
            {
              syncThreadId: remoteThread.threadId,
              localThreadId: ThreadId.make("local-thread"),
              syncProjectId: project.syncProjectId,
              baseRevision: threadSyncRevision(remoteThread),
            },
          ],
          lastBindingEventSequence: 0,
        };
        yield* saveThreadSyncLocalState(statePath, state);

        let fullSnapshotReads = 0;
        let commitCount = 0;
        let currentRemoteRevision = remoteRevision;
        const git = ThreadSyncGit.of({
          fetch: () => Effect.succeed({ mirrorPath, remoteRevision: currentRemoteRevision }),
          checkoutRemote: () =>
            Effect.succeed({ mirrorPath, remoteRevision: currentRemoteRevision }),
          commitAndPush: () =>
            Effect.gen(function* () {
              expect(
                yield* fileSystem
                  .exists(NodePath.join(mirrorPath, THREAD_SYNC_NAMESPACE))
                  .pipe(Effect.orDie),
              ).toBe(true);
              const legacyRead = yield* Effect.result(
                readThreadSyncRepository(mirrorPath).pipe(Effect.provide(NodeServices.layer)),
              );
              expect(legacyRead._tag).toBe("Failure");
              if (legacyRead._tag === "Failure") {
                expect(legacyRead.failure.code).toBe("invalid-snapshot");
              }
              expect(yield* readThreadSyncV2RepositoryIndex(mirrorPath)).not.toBeNull();
              commitCount += 1;
              currentRemoteRevision = nextRevision;
              return nextRevision;
            }),
          removeMirror: () => Effect.void,
        } satisfies ThreadSyncGitShape);
        const localProjectId = ProjectId.make("local-project");
        const localThreadId = ThreadId.make("local-thread");
        const emptyPage = Effect.succeed({ rows: [], next: null });
        const snapshotQuery = ProjectionSnapshotQuery.ProjectionSnapshotQuery.of({
          getSnapshot: () =>
            Effect.sync(() => {
              fullSnapshotReads += 1;
              throw new Error("The v1 hydration path must not run during migration.");
            }),
          getThreadSyncExportIndex: () =>
            Effect.succeed({
              snapshotSequence: 1,
              updatedAt: remoteThread.updatedAt,
              projects: [
                {
                  id: localProjectId,
                  title: project.title,
                  workspaceRoot: directory,
                  repositoryIdentity: null,
                  defaultModelSelection: null,
                  scripts: [],
                  createdAt: project.createdAt,
                  updatedAt: project.updatedAt,
                  deletedAt: null,
                },
              ],
              threads: [
                {
                  id: localThreadId,
                  projectId: localProjectId,
                  title: remoteThread.title,
                  coagent: null,
                  latestTurnId: null,
                  threadSequence: 1,
                  lifecycle: remoteThread.lifecycle,
                  createdAt: remoteThread.createdAt,
                  updatedAt: remoteThread.updatedAt,
                  active: false,
                },
              ],
            }),
          listThreadSyncExportTurnsPage: () => emptyPage,
          listThreadSyncExportMessagesPage: () => emptyPage,
          listThreadSyncExportPlansPage: () => emptyPage,
          listThreadSyncExportActivitiesPage: () => emptyPage,
          readThreadSyncExportTextChunk: () => Effect.die("no text rows"),
        } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQueryShape);
        const turnRepository = ProjectionTurnRepository.of({
          listByThreadId: () => Effect.succeed([]),
        } as unknown as ProjectionTurnRepositoryShape);
        const engine = OrchestrationEngine.OrchestrationEngineService.of({
          readEvents: () => Stream.empty,
          readLatestAggregateEventType: () => Effect.die("unused"),
          dispatch: () => Effect.die("migration must not import an unchanged remote thread"),
          streamDomainEvents: Stream.empty,
          latestSequence: Effect.succeed(0),
        } satisfies OrchestrationEngine.OrchestrationEngineShape);
        const service = yield* make.pipe(
          Effect.provideService(ServerConfig.ServerConfig, config),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, snapshotQuery),
          Effect.provideService(ProjectionTurnRepository, turnRepository),
          Effect.provideService(OrchestrationEngine.OrchestrationEngineService, engine),
          Effect.provideService(ThreadSyncGit, git),
        );

        const result = yield* service.push({
          expectedRemoteRevision: remoteRevision,
          strategies: [],
        });

        expect(result.remoteRevision).toBe(nextRevision);
        expect(result.pushedThreadIds).toEqual([localThreadId]);
        expect(commitCount).toBe(1);
        expect(fullSnapshotReads).toBe(0);

        const manifestPath = NodePath.join(mirrorPath, ...THREAD_SYNC_V2_MANIFEST_PATH.split("/"));
        const manifestBeforeNoOp = NodeFS.readFileSync(manifestPath, "utf8");
        const noOp = yield* service.push({
          expectedRemoteRevision: nextRevision,
          strategies: [],
        });
        expect(noOp.remoteRevision).toBe(nextRevision);
        expect(noOp.pushedThreadIds).toEqual([]);
        expect(commitCount).toBe(1);
        expect(NodeFS.readFileSync(manifestPath, "utf8")).toBe(manifestBeforeNoOp);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
