import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { DEFAULT_DESKTOP_PREVIEW_BROWSER_PROFILE_ID } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as BrowserProfileRegistry from "./BrowserProfileRegistry.ts";

function makeLayer(baseDir: string) {
  const environmentLayer = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "linux",
    processArch: "x64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir })),
    ),
  );
  return BrowserProfileRegistry.layer.pipe(
    Layer.provideMerge(environmentLayer),
    Layer.provideMerge(NodeServices.layer),
  );
}

const withTempRegistry = <A, E, R>(
  use: (baseDir: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, FileSystem.FileSystem>> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "erebus-browser-profile-registry-test-",
    });
    return yield* use(baseDir);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped) as never;

describe("BrowserProfileRegistry", () => {
  it.effect("keeps a non-removable default and persists normalized named profiles", () =>
    withTempRegistry((baseDir) =>
      Effect.gen(function* () {
        const first = yield* Effect.gen(function* () {
          const registry = yield* BrowserProfileRegistry.BrowserProfileRegistry;
          assert.deepEqual(yield* registry.list, [BrowserProfileRegistry.DEFAULT_BROWSER_PROFILE]);
          const created = yield* registry.create("  Account   A  ");
          assert.equal(created.name, "Account A");
          assert.isFalse(created.isDefault);
          assert.notEqual(created.id, created.name);
          yield* registry.recordPartition(
            created.id,
            "persist:t3code-preview-0123456789abcdefabcd",
            "environment-a",
          );
          yield* registry.recordPartition(
            DEFAULT_DESKTOP_PREVIEW_BROWSER_PROFILE_ID,
            "persist:t3code-preview-fedcba9876543210abcd",
            "environment-a",
          );
          return created;
        }).pipe(Effect.provide(makeLayer(baseDir)));

        yield* Effect.gen(function* () {
          const registry = yield* BrowserProfileRegistry.BrowserProfileRegistry;
          const profiles = yield* registry.list;
          assert.equal(profiles.length, 2);
          assert.equal(profiles[0]!.id, DEFAULT_DESKTOP_PREVIEW_BROWSER_PROFILE_ID);
          assert.equal(profiles[1]!.id, first.id);
          assert.equal(profiles[1]!.name, "Account A");
          assert.deepEqual(yield* registry.partitions(first.id), [
            "persist:t3code-preview-0123456789abcdefabcd",
          ]);
          assert.deepEqual(yield* registry.partitions(DEFAULT_DESKTOP_PREVIEW_BROWSER_PROFILE_ID), [
            "persist:t3code-preview-fedcba9876543210abcd",
          ]);
        }).pipe(Effect.provide(makeLayer(baseDir)));
      }),
    ),
  );

  it.effect("removes only partitions owned by the removed environment", () =>
    withTempRegistry((baseDir) =>
      Effect.gen(function* () {
        const registry = yield* BrowserProfileRegistry.BrowserProfileRegistry;
        const profile = yield* registry.create("Account A");
        const defaultA = "persist:t3code-preview-aaaaaaaaaaaaaaaaaaaa";
        const defaultB = "persist:t3code-preview-bbbbbbbbbbbbbbbbbbbb";
        const profileA = "persist:t3code-preview-cccccccccccccccccccc";
        const profileB = "persist:t3code-preview-dddddddddddddddddddd";
        yield* registry.recordPartition(
          DEFAULT_DESKTOP_PREVIEW_BROWSER_PROFILE_ID,
          defaultA,
          "environment-a",
        );
        yield* registry.recordPartition(
          DEFAULT_DESKTOP_PREVIEW_BROWSER_PROFILE_ID,
          defaultB,
          "environment-b",
        );
        yield* registry.recordPartition(profile.id, profileA, "environment-a");
        yield* registry.recordPartition(profile.id, profileB, "environment-b");

        assert.deepEqual(yield* registry.environmentPartitions("environment-a"), [
          {
            profileId: DEFAULT_DESKTOP_PREVIEW_BROWSER_PROFILE_ID,
            partition: defaultA,
            environmentId: "environment-a",
          },
          { profileId: profile.id, partition: profileA, environmentId: "environment-a" },
        ]);

        yield* registry.removeEnvironment("environment-a");
        assert.deepEqual(yield* registry.partitions(DEFAULT_DESKTOP_PREVIEW_BROWSER_PROFILE_ID), [
          defaultB,
        ]);
        assert.deepEqual(yield* registry.partitions(profile.id), [profileB]);
        assert.deepEqual(yield* registry.environmentPartitions("environment-a"), []);
        assert.equal((yield* registry.environmentPartitions("environment-b")).length, 2);
      }).pipe(Effect.provide(makeLayer(baseDir))),
    ),
  );

  it.effect("rejects blank, duplicate, missing, and default mutations", () =>
    withTempRegistry((baseDir) =>
      Effect.gen(function* () {
        const registry = yield* BrowserProfileRegistry.BrowserProfileRegistry;
        const profile = yield* registry.create("Primary");

        assert.instanceOf(
          yield* registry.create("   ").pipe(Effect.flip),
          BrowserProfileRegistry.BrowserProfileNameInvalidError,
        );
        assert.instanceOf(
          yield* registry.create("primary").pipe(Effect.flip),
          BrowserProfileRegistry.BrowserProfileNameConflictError,
        );
        assert.instanceOf(
          yield* registry
            .rename(DEFAULT_DESKTOP_PREVIEW_BROWSER_PROFILE_ID, "Other")
            .pipe(Effect.flip),
          BrowserProfileRegistry.DefaultBrowserProfileImmutableError,
        );
        assert.instanceOf(
          yield* registry.remove(DEFAULT_DESKTOP_PREVIEW_BROWSER_PROFILE_ID).pipe(Effect.flip),
          BrowserProfileRegistry.DefaultBrowserProfileImmutableError,
        );
        assert.instanceOf(
          yield* registry.rename("missing", "Other").pipe(Effect.flip),
          BrowserProfileRegistry.BrowserProfileNotFoundError,
        );

        yield* registry.rename(profile.id, "Secondary");
        assert.equal((yield* registry.list)[1]!.name, "Secondary");
        yield* registry.remove(profile.id);
        assert.deepEqual(yield* registry.list, [BrowserProfileRegistry.DEFAULT_BROWSER_PROFILE]);
      }).pipe(Effect.provide(makeLayer(baseDir))),
    ),
  );

  it.effect("ignores a malformed local registry instead of exposing partial profiles", () =>
    withTempRegistry((baseDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const registryPath = `${baseDir}/userdata/browser-profiles.json`;
        yield* fileSystem.makeDirectory(`${baseDir}/userdata`, { recursive: true });
        yield* fileSystem.writeFileString(registryPath, "{not-json");

        const profiles = yield* Effect.flatMap(
          BrowserProfileRegistry.BrowserProfileRegistry,
          (registry) => registry.list,
        ).pipe(Effect.provide(makeLayer(baseDir)));
        assert.deepEqual(profiles, [BrowserProfileRegistry.DEFAULT_BROWSER_PROFILE]);
      }),
    ),
  );

  it.effect("loads registries written before partition ownership was recorded", () =>
    withTempRegistry((baseDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const registryPath = `${baseDir}/userdata/browser-profiles.json`;
        const partition = "persist:t3code-preview-eeeeeeeeeeeeeeeeeeee";
        yield* fileSystem.makeDirectory(`${baseDir}/userdata`, { recursive: true });
        yield* fileSystem.writeFileString(
          registryPath,
          `{"version":1,"defaultPartitions":["${partition}"],"profiles":[]}`,
        );

        yield* Effect.gen(function* () {
          const registry = yield* BrowserProfileRegistry.BrowserProfileRegistry;
          assert.deepEqual(yield* registry.partitions(DEFAULT_DESKTOP_PREVIEW_BROWSER_PROFILE_ID), [
            partition,
          ]);
          assert.deepEqual(yield* registry.environmentPartitions("environment-a"), []);
        }).pipe(Effect.provide(makeLayer(baseDir)));
      }),
    ),
  );
});
