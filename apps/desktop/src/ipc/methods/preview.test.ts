import { it as effectIt } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_DESKTOP_PREVIEW_BROWSER_PROFILE_ID, EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as PreviewManager from "../../preview/Manager.ts";
import * as BrowserProfileRegistry from "../../preview/BrowserProfileRegistry.ts";
import * as BrowserSession from "../../preview/BrowserSession.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronShell from "../../electron/ElectronShell.ts";
import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as PreviewIpc from "./preview.ts";

const { fromPartition } = vi.hoisted(() => ({
  fromPartition: vi.fn(() => {
    throw new Error("Session can only be received when app is ready");
  }),
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
  session: {
    fromPartition,
  },
  webContents: {
    fromId: vi.fn(() => null),
  },
}));

describe("preview IPC methods", () => {
  beforeEach(() => {
    fromPartition.mockClear();
  });

  it("does not access the Electron session while the module loads", async () => {
    await expect(import("./preview.ts")).resolves.toBeDefined();
    expect(fromPartition).not.toHaveBeenCalled();
  });

  effectIt.effect("rejects invalid webContents ids before resolving the preview service", () =>
    Effect.map(
      PreviewIpc.registerWebview
        .handler({ tabId: "tab-1", webContentsId: 0 })
        .pipe(Effect.provideService(PreviewManager.PreviewManager, null as never), Effect.exit),
      (exit) => {
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) return;
        const error = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(error) && Schema.isSchemaError(error.value)).toBe(true);
        expect(fromPartition).not.toHaveBeenCalled();
      },
    ),
  );

  effectIt.effect("selects the named browser profile for preview config", () =>
    Effect.gen(function* () {
      const getBrowserSession = vi.fn(() => Effect.succeed(null));
      const getBrowserPartition = vi.fn(() => Effect.succeed("persist:profile-a"));
      const assertExists = vi.fn(() => Effect.void);
      const recordPartition = vi.fn(() => Effect.void);
      const manager = {
        getBrowserSession,
        getBrowserPartition,
      } as never;
      const registry = { assertExists, recordPartition } as never;

      const result = yield* PreviewIpc.getPreviewConfig
        .handler({
          environmentId: EnvironmentId.make("environment-a"),
          browserProfileId: "profile-a",
        })
        .pipe(
          Effect.provideService(PreviewManager.PreviewManager, manager),
          Effect.provideService(BrowserProfileRegistry.BrowserProfileRegistry, registry),
        );

      expect(assertExists).toHaveBeenCalledWith("profile-a");
      expect(getBrowserSession).toHaveBeenCalledWith("environment-a", "profile-a");
      expect(getBrowserPartition).toHaveBeenCalledWith("environment-a", "profile-a");
      expect(recordPartition).toHaveBeenCalledWith(
        "profile-a",
        "persist:profile-a",
        "environment-a",
      );
      expect(result).toMatchObject({ partition: "persist:profile-a" });
    }),
  );

  effectIt.effect("maps the visible default profile to the historical browser partition", () =>
    Effect.gen(function* () {
      const getBrowserSession = vi.fn(() => Effect.succeed(null));
      const getBrowserPartition = vi.fn(() => Effect.succeed("persist:historical"));
      const assertExists = vi.fn(() => Effect.void);
      const recordPartition = vi.fn(() => Effect.void);

      yield* PreviewIpc.getPreviewConfig
        .handler({
          environmentId: EnvironmentId.make("environment-a"),
          browserProfileId: DEFAULT_DESKTOP_PREVIEW_BROWSER_PROFILE_ID,
        })
        .pipe(
          Effect.provideService(PreviewManager.PreviewManager, {
            getBrowserSession,
            getBrowserPartition,
          } as never),
          Effect.provideService(BrowserProfileRegistry.BrowserProfileRegistry, {
            assertExists,
            recordPartition,
          } as never),
        );

      expect(getBrowserSession).toHaveBeenCalledWith("environment-a", undefined);
      expect(getBrowserPartition).toHaveBeenCalledWith("environment-a", undefined);
      expect(recordPartition).toHaveBeenCalledWith(
        DEFAULT_DESKTOP_PREVIEW_BROWSER_PROFILE_ID,
        "persist:historical",
        "environment-a",
      );
    }),
  );

  effectIt.effect("configures and disables the proxy for the selected profile", () =>
    Effect.gen(function* () {
      const configureBrowserProxy = vi.fn(() => Effect.void);
      const getBrowserPartition = vi.fn(() => Effect.succeed("persist:profile-a"));
      const manager = { configureBrowserProxy, getBrowserPartition } as never;
      const assertExists = vi.fn(() => Effect.void);
      const recordPartition = vi.fn(() => Effect.void);
      const registry = { assertExists, recordPartition } as never;
      const environmentId = EnvironmentId.make("environment-a");
      const proxy = {
        proxyUrl: "http://127.0.0.1:8080",
        caFingerprint: "AA".repeat(32),
      };

      yield* PreviewIpc.configureProxy
        .handler({ environmentId, browserProfileId: "profile-a", proxy })
        .pipe(
          Effect.provideService(PreviewManager.PreviewManager, manager),
          Effect.provideService(BrowserProfileRegistry.BrowserProfileRegistry, registry),
        );
      yield* PreviewIpc.configureProxy
        .handler({ environmentId, browserProfileId: "profile-a", proxy: null })
        .pipe(
          Effect.provideService(PreviewManager.PreviewManager, manager),
          Effect.provideService(BrowserProfileRegistry.BrowserProfileRegistry, registry),
        );

      expect(configureBrowserProxy).toHaveBeenNthCalledWith(1, "environment-a", "profile-a", proxy);
      expect(configureBrowserProxy).toHaveBeenNthCalledWith(2, "environment-a", "profile-a", null);
      expect(recordPartition).toHaveBeenCalledTimes(2);
      expect(recordPartition).toHaveBeenNthCalledWith(
        1,
        "profile-a",
        "persist:profile-a",
        "environment-a",
      );
    }),
  );

  effectIt.effect("clears only partitions registered to a removed environment", () =>
    Effect.gen(function* () {
      const order: string[] = [];
      const environmentPartitions = vi.fn(() =>
        Effect.succeed([
          {
            profileId: DEFAULT_DESKTOP_PREVIEW_BROWSER_PROFILE_ID,
            partition: "persist:t3code-preview-aaaaaaaaaaaaaaaaaaaa",
            environmentId: "environment-a",
          },
          {
            profileId: "profile-a",
            partition: "persist:t3code-preview-bbbbbbbbbbbbbbbbbbbb",
            environmentId: "environment-a",
          },
        ]),
      );
      const clearBrowserProfile = vi.fn((_profileId: string, _partitions: readonly string[]) =>
        Effect.sync(() => order.push("clear")),
      );
      const removeEnvironment = vi.fn(() => Effect.sync(() => order.push("remove")));

      yield* PreviewIpc.clearBrowserProfileEnvironment
        .handler({ environmentId: EnvironmentId.make("environment-a") })
        .pipe(
          Effect.provideService(PreviewManager.PreviewManager, { clearBrowserProfile } as never),
          Effect.provideService(BrowserProfileRegistry.BrowserProfileRegistry, {
            environmentPartitions,
            unownedPartitions: Effect.succeed([]),
            removeEnvironment,
          } as never),
        );

      expect(clearBrowserProfile).toHaveBeenCalledTimes(2);
      expect(clearBrowserProfile).toHaveBeenCalledWith(DEFAULT_DESKTOP_PREVIEW_BROWSER_PROFILE_ID, [
        "persist:t3code-preview-aaaaaaaaaaaaaaaaaaaa",
      ]);
      expect(clearBrowserProfile).toHaveBeenCalledWith("profile-a", [
        "persist:t3code-preview-bbbbbbbbbbbbbbbbbbbb",
      ]);
      expect(removeEnvironment).toHaveBeenCalledWith("environment-a");
      expect(order).toEqual(["clear", "clear", "remove"]);
    }),
  );

  effectIt.effect("adopts matching legacy partitions before clearing a removed environment", () =>
    Effect.gen(function* () {
      const legacyPartition = "persist:t3code-preview-cccccccccccccccccccc";
      const recordPartition = vi.fn(() => Effect.void);
      const clearBrowserProfile = vi.fn(() => Effect.void);
      const removeEnvironment = vi.fn(() => Effect.void);
      const getBrowserPartition = vi.fn((_environmentId: string, profileId: string | undefined) =>
        Effect.succeed(
          profileId === undefined ? legacyPartition : "persist:t3code-preview-dddddddddddddddddddd",
        ),
      );

      yield* PreviewIpc.clearBrowserProfileEnvironment
        .handler({ environmentId: EnvironmentId.make("environment-a") })
        .pipe(
          Effect.provideService(PreviewManager.PreviewManager, {
            clearBrowserProfile,
            getBrowserPartition,
          } as never),
          Effect.provideService(BrowserProfileRegistry.BrowserProfileRegistry, {
            environmentPartitions: () => Effect.succeed([]),
            unownedPartitions: Effect.succeed([
              {
                profileId: DEFAULT_DESKTOP_PREVIEW_BROWSER_PROFILE_ID,
                partition: legacyPartition,
              },
              {
                profileId: "profile-a",
                partition: "persist:t3code-preview-eeeeeeeeeeeeeeeeeeee",
              },
            ]),
            recordPartition,
            removeEnvironment,
          } as never),
        );

      expect(recordPartition).toHaveBeenCalledExactlyOnceWith(
        DEFAULT_DESKTOP_PREVIEW_BROWSER_PROFILE_ID,
        legacyPartition,
        "environment-a",
      );
      expect(clearBrowserProfile).toHaveBeenCalledExactlyOnceWith(
        DEFAULT_DESKTOP_PREVIEW_BROWSER_PROFILE_ID,
        [legacyPartition],
      );
      expect(removeEnvironment).toHaveBeenCalledWith("environment-a");
    }),
  );

  effectIt.effect("clears profile partitions before removing its metadata", () =>
    Effect.gen(function* () {
      const order: string[] = [];
      const partitions = vi.fn(() => Effect.succeed(["persist:t3code-preview-a"]));
      const remove = vi.fn(() => Effect.sync(() => order.push("remove")));
      const clearBrowserProfile = vi.fn(() => Effect.sync(() => order.push("clear")));

      yield* PreviewIpc.deleteBrowserProfile.handler({ profileId: "profile-a" }).pipe(
        Effect.provideService(PreviewManager.PreviewManager, { clearBrowserProfile } as never),
        Effect.provideService(BrowserProfileRegistry.BrowserProfileRegistry, {
          partitions,
          remove,
        } as never),
      );

      expect(clearBrowserProfile).toHaveBeenCalledWith("profile-a", ["persist:t3code-preview-a"]);
      expect(order).toEqual(["clear", "remove"]);
    }),
  );

  effectIt.effect("reports an in-use profile without removing its metadata", () =>
    Effect.gen(function* () {
      const remove = vi.fn(() => Effect.void);
      const clearFailure = new BrowserSession.BrowserProfileInUseError({
        profileId: "profile-a",
        activeTabCount: 2,
      });

      const result = yield* PreviewIpc.deleteBrowserProfile
        .handler({ profileId: "profile-a" })
        .pipe(
          Effect.provideService(PreviewManager.PreviewManager, {
            clearBrowserProfile: () => Effect.fail(clearFailure),
          } as never),
          Effect.provideService(BrowserProfileRegistry.BrowserProfileRegistry, {
            partitions: () => Effect.succeed(["persist:t3code-preview-a"]),
            remove,
          } as never),
        );

      expect(result).toEqual({ status: "in-use", activeTabCount: 2 });
      expect(remove).not.toHaveBeenCalled();
    }),
  );

  effectIt.effect("opens the development extension output without exposing runtime secrets", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const rootDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "erebus-web-extension-dev-",
        });
        const extensionDirectory = path.join(rootDir, "native", "erebus-web", "extension", "dist");
        yield* fileSystem.makeDirectory(extensionDirectory, { recursive: true });
        const openPath = vi.fn(() => Effect.succeed(true));

        const result = yield* PreviewIpc.openCaptureExtensionFolder.handler(undefined).pipe(
          Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
            path,
            rootDir,
            resourcesPath: path.join(rootDir, "resources"),
            isDevelopment: true,
            isPackaged: false,
            resolveResourcePathCandidates: () => [],
          } as never),
          Effect.provideService(ElectronShell.ElectronShell, { openPath } as never),
        );

        expect(result).toBe(true);
        expect(openPath).toHaveBeenCalledWith(extensionDirectory);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  effectIt.effect("copies each browser extension package to Downloads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const rootDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "erebus-web-extension-download-",
        });
        const extensionDirectory = path.join(rootDir, "native", "erebus-web", "extension", "dist");
        const downloadsDirectory = path.join(rootDir, "Downloads");
        yield* fileSystem.makeDirectory(extensionDirectory, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(extensionDirectory, "erebus-chromium-extension.zip"),
          "chromium-package",
        );
        yield* fileSystem.writeFileString(
          path.join(extensionDirectory, "erebus-firefox-extension.xpi"),
          "firefox-package",
        );

        const environment = {
          path,
          rootDir,
          resourcesPath: path.join(rootDir, "resources"),
          homeDirectory: rootDir,
          isDevelopment: true,
          isPackaged: false,
          resolveResourcePathCandidates: () => [],
        } as never;
        const electronApp = {
          getPath: () => Effect.succeed(downloadsDirectory),
        } as never;

        const chromium = yield* PreviewIpc.downloadCaptureExtension
          .handler({ browser: "chromium" })
          .pipe(
            Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
            Effect.provideService(ElectronApp.ElectronApp, electronApp),
          );
        const firefox = yield* PreviewIpc.downloadCaptureExtension
          .handler({ browser: "firefox" })
          .pipe(
            Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
            Effect.provideService(ElectronApp.ElectronApp, electronApp),
          );

        const chromiumPath = path.join(downloadsDirectory, "erebus-chromium-extension.zip");
        const firefoxPath = path.join(downloadsDirectory, "erebus-firefox-extension.xpi");
        expect(chromium).toBe(chromiumPath);
        expect(firefox).toBe(firefoxPath);
        expect(yield* fileSystem.readFileString(chromiumPath)).toBe("chromium-package");
        expect(yield* fileSystem.readFileString(firefoxPath)).toBe("firefox-package");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  effectIt.effect("resolves the packaged extension beside the web runtime", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const resourcesPath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "erebus-web-extension-packaged-",
        });
        const extensionDirectory = path.join(resourcesPath, "erebus-web", "extension");
        yield* fileSystem.makeDirectory(extensionDirectory, { recursive: true });

        const resolved = yield* PreviewIpc.resolveWebCaptureExtensionDirectory().pipe(
          Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
            path,
            rootDir: path.dirname(resourcesPath),
            resourcesPath,
            isDevelopment: false,
            isPackaged: true,
            resolveResourcePathCandidates: () => [],
          } as never),
        );

        expect(Option.getOrUndefined(resolved)).toBe(extensionDirectory);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  effectIt.effect("copies the AppImage extension to stable user state before opening it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "erebus-web-extension-appimage-",
        });
        const resourcesPath = path.join(root, ".mount_erebus", "resources");
        const source = path.join(resourcesPath, "erebus-web", "extension");
        const stateDir = path.join(root, "state");
        yield* fileSystem.makeDirectory(source, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(source, "manifest.json"),
          '{"manifest_version":3,"name":"Erebus Web Capture","version":"1.0.0"}',
        );

        const resolved = yield* PreviewIpc.resolveWebCaptureExtensionDirectory().pipe(
          Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
            path,
            rootDir: root,
            resourcesPath,
            stateDir,
            platform: "linux",
            isDevelopment: false,
            isPackaged: true,
            resolveResourcePathCandidates: () => [],
          } as never),
        );

        const stableDirectory = path.join(stateDir, "web-capture-extension");
        expect(Option.getOrUndefined(resolved)).toBe(stableDirectory);
        expect(
          yield* fileSystem.readFileString(path.join(stableDirectory, "manifest.json")),
        ).toContain("Erebus Web Capture");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
