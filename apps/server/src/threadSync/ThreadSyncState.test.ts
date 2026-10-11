import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as Path from "effect/Path";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";

import {
  applyThreadSyncBindingUpdates,
  emptyThreadSyncLocalState,
  loadThreadSyncLocalState,
  resetThreadSyncLocalStateAt,
  saveThreadSyncLocalState,
  ThreadSyncLocalState,
} from "./ThreadSyncState.ts";

const platformLayer = Layer.merge(NodeFileSystem.layer, NodePath.layer);
const decodeLocalState = Schema.decodeUnknownEffect(ThreadSyncLocalState);

describe("ThreadSyncState", () => {
  it.effect("persists and restores state atomically", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "thread-sync-state-",
        });
        const statePath = path.join(directory, "state.json");
        const state = yield* decodeLocalState({
          ...emptyThreadSyncLocalState(),
          configuration: {
            remoteUrl: "https://example.test/threads.git",
            branch: "main",
            fetchIntervalSeconds: 60,
          },
          projectBindings: [
            {
              syncProjectId: "project-sync",
              projectId: "project-local",
              linkedAt: "2026-10-11T12:00:00.000Z",
            },
          ],
          lastBindingEventSequence: 42,
        });

        yield* saveThreadSyncLocalState(statePath, state);
        expect(yield* loadThreadSyncLocalState(statePath)).toEqual(state);
      }),
    ).pipe(Effect.provide(platformLayer)),
  );

  it.effect("loads version 1 state written before the binding cursor existed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "thread-sync-state-",
        });
        const statePath = path.join(directory, "state.json");
        yield* fileSystem.writeFileString(
          statePath,
          '{"formatVersion":1,"configuration":null,"remoteRevision":null,"lastFetchedAt":null,"projectBindings":[],"threadBindings":[]}',
        );

        expect(yield* loadThreadSyncLocalState(statePath)).toMatchObject({
          formatVersion: 2,
          lastBindingEventSequence: null,
        });
      }),
    ).pipe(Effect.provide(platformLayer)),
  );

  it("replays binding updates idempotently and resets them at a new connection boundary", () => {
    const update = {
      syncThreadId: ThreadId.make("sync-thread"),
      localThreadId: ThreadId.make("local-thread"),
      syncProjectId: "sync-project",
      localProjectId: ProjectId.make("local-project"),
      baseRevision: "revision-1",
    } as const;
    const once = applyThreadSyncBindingUpdates([], [update]);
    const twice = applyThreadSyncBindingUpdates(once, [update]);
    const collision = applyThreadSyncBindingUpdates(
      [
        once[0]!,
        {
          ...once[0]!,
          syncThreadId: ThreadId.make("other-sync"),
          localThreadId: ThreadId.make("other-local"),
        },
      ],
      [
        {
          ...update,
          localThreadId: ThreadId.make("other-local"),
        },
      ],
    );

    expect(twice).toEqual(once);
    expect(collision).toHaveLength(1);
    expect(collision[0]).toMatchObject({
      syncThreadId: "sync-thread",
      localThreadId: "other-local",
    });
    expect(resetThreadSyncLocalStateAt(91)).toMatchObject({
      projectBindings: [],
      threadBindings: [],
      lastBindingEventSequence: 91,
    });
  });

  it.effect("does not silently reset corrupt state", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "thread-sync-state-",
        });
        const statePath = path.join(directory, "state.json");
        yield* fileSystem.writeFileString(statePath, "{not-json");

        const error = yield* Effect.flip(loadThreadSyncLocalState(statePath));
        expect(error.code).toBe("integrity-failed");
      }),
    ).pipe(Effect.provide(platformLayer)),
  );
});
