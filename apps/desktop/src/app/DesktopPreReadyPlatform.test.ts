import { assert, describe, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, beforeEach, vi } from "vite-plus/test";

const {
  appendSwitchMock,
  copyFileSyncMock,
  existsSyncMock,
  getAppPathMock,
  getSwitchValueMock,
  getVersionMock,
  hasSwitchMock,
  homedirMock,
  mkdirSyncMock,
  readFileSyncMock,
  registerSchemesMock,
  setDesktopNameMock,
  writeFileSyncMock,
} = vi.hoisted(() => ({
  appendSwitchMock: vi.fn(),
  copyFileSyncMock: vi.fn(),
  existsSyncMock: vi.fn(),
  getAppPathMock: vi.fn(),
  getSwitchValueMock: vi.fn(),
  getVersionMock: vi.fn(),
  hasSwitchMock: vi.fn(),
  homedirMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
  readFileSyncMock: vi.fn(),
  registerSchemesMock: vi.fn(),
  setDesktopNameMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
}));

vi.mock("node:fs", () => ({
  copyFileSync: copyFileSyncMock,
  existsSync: existsSyncMock,
  mkdirSync: mkdirSyncMock,
  readFileSync: readFileSyncMock,
  writeFileSync: writeFileSyncMock,
}));

vi.mock("node:os", () => ({
  homedir: homedirMock,
}));

vi.mock("electron", () => ({
  app: {
    commandLine: {
      appendSwitch: appendSwitchMock,
      getSwitchValue: getSwitchValueMock,
      hasSwitch: hasSwitchMock,
    },
    getAppPath: getAppPathMock,
    getVersion: getVersionMock,
    setDesktopName: setDesktopNameMock,
  },
  protocol: {
    registerSchemesAsPrivileged: registerSchemesMock,
  },
}));

import * as DesktopPreReadyPlatform from "./DesktopPreReadyPlatform.ts";

describe("DesktopPreReadyPlatform", () => {
  beforeEach(() => {
    appendSwitchMock.mockReset();
    copyFileSyncMock.mockReset();
    existsSyncMock.mockReset();
    getAppPathMock.mockReset();
    getSwitchValueMock.mockReset();
    getVersionMock.mockReset();
    hasSwitchMock.mockReset();
    homedirMock.mockReset();
    mkdirSyncMock.mockReset();
    readFileSyncMock.mockReset();
    registerSchemesMock.mockReset();
    setDesktopNameMock.mockReset();
    writeFileSyncMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads an explicit Electron command-line switch value", () => {
    const value = DesktopPreReadyPlatform.readCommandLineSwitchValue(
      {
        hasSwitch: (switchName) => switchName === "password-store",
        getSwitchValue: (switchName) => {
          assert.equal(switchName, "password-store");
          return "basic";
        },
      },
      "password-store",
    );

    assert.equal(value, "basic");
  });

  it("treats valueless Electron command-line switches as absent", () => {
    const value = DesktopPreReadyPlatform.readCommandLineSwitchValue(
      {
        hasSwitch: () => true,
        getSwitchValue: () => "",
      },
      "password-store",
    );

    assert.isNull(value);
  });

  it("returns null for missing Electron command-line switches", () => {
    const value = DesktopPreReadyPlatform.readCommandLineSwitchValue(
      {
        hasSwitch: () => false,
        getSwitchValue: () => {
          throw new Error("Unexpected switch value read.");
        },
      },
      "password-store",
    );

    assert.isNull(value);
  });

  it.effect(
    "acquires a synchronous pre-ready layer before an asynchronous Clerk-shaped layer",
    () =>
      Effect.gen(function* () {
        class ClerkShaped extends Context.Service<ClerkShaped, { readonly ready: true }>()(
          "@t3tools/desktop/app/DesktopPreReadyPlatform.test/ClerkShaped",
        ) {}

        const events: Array<string> = [];
        registerSchemesMock.mockImplementation(() => {
          events.push("pre-ready");
        });

        const preReadyLayer = DesktopPreReadyPlatform.layer.pipe(
          Layer.provide(Layer.succeed(HostProcessPlatform, "darwin")),
        );

        const clerkShapedLayer = Layer.effect(
          ClerkShaped,
          Effect.promise(() => Promise.resolve()).pipe(
            Effect.map(() => {
              events.push("clerk");
              return { ready: true as const };
            }),
          ),
        );

        const runtimeLayer = clerkShapedLayer.pipe(
          Layer.flatMap((clerkContext) => Layer.succeedContext(clerkContext)),
          Layer.provideMerge(preReadyLayer),
        );

        const result = yield* Effect.all({
          clerk: ClerkShaped,
          preReady: DesktopPreReadyPlatform.DesktopPreReadyElectronOptions,
        }).pipe(Effect.provide(runtimeLayer));

        assert.deepEqual(result, {
          clerk: { ready: true },
          preReady: {
            linux: null,
            linuxPasswordStoreCommandLine: null,
          },
        });
        assert.deepEqual(events, ["pre-ready", "clerk"]);
        assert.equal(registerSchemesMock.mock.calls.length, 1);
        assert.equal(appendSwitchMock.mock.calls.length, 0);
      }),
  );

  it.effect("selects the Linux desktop identity without writing a broken dev handler", () => {
    vi.stubEnv("APPIMAGE", "/home/alice/Applications/Erebus.AppImage");
    vi.stubEnv("T3CODE_HOME", "/home/alice/.erebus-test");
    vi.stubEnv("VITE_DEV_SERVER_URL", "http://127.0.0.1:5173");
    vi.stubEnv("XDG_DATA_HOME", "/home/alice/.local/share");
    homedirMock.mockReturnValue("/home/alice");
    readFileSyncMock.mockReturnValue(JSON.stringify({ linuxPasswordStore: "auto" }));
    getVersionMock.mockReturnValue("1.2.3");
    hasSwitchMock.mockReturnValue(false);

    return Effect.gen(function* () {
      const options = yield* DesktopPreReadyPlatform.DesktopPreReadyElectronOptions;

      assert.deepEqual(options, {
        linux: {
          isDevelopment: true,
          linuxDesktopEntryName: "research.vyntra.erebus.dev.desktop",
          linuxWmClass: "erebus-dev",
          passwordStore: "gnome-libsecret",
        },
        linuxPasswordStoreCommandLine: null,
      });
      assert.deepEqual(mkdirSyncMock.mock.calls, []);
      assert.deepEqual(writeFileSyncMock.mock.calls, []);
      assert.deepEqual(setDesktopNameMock.mock.calls, [["research.vyntra.erebus.dev.desktop"]]);
      assert.deepEqual(appendSwitchMock.mock.calls, [
        ["class", "erebus-dev"],
        ["password-store", "gnome-libsecret"],
      ]);
    }).pipe(
      Effect.provide(
        DesktopPreReadyPlatform.layer.pipe(
          Layer.provide(Layer.succeed(HostProcessPlatform, "linux")),
        ),
      ),
    );
  });

  it.effect("writes the packaged Linux handler before ready", () => {
    vi.stubEnv("APPIMAGE", "/home/alice/Applications/Erebus.AppImage");
    vi.stubEnv("T3CODE_HOME", "/home/alice/.erebus-test");
    vi.stubEnv("XDG_DATA_HOME", "/home/alice/.local/share");
    homedirMock.mockReturnValue("/home/alice");
    readFileSyncMock.mockReturnValue(JSON.stringify({ linuxPasswordStore: "auto" }));
    getVersionMock.mockReturnValue("1.2.3");
    getAppPathMock.mockReturnValue("/tmp/.mount_erebus/resources/app.asar");
    existsSyncMock.mockImplementation((path: string) =>
      path.endsWith("/apps/desktop/prod-resources/icon.png"),
    );
    hasSwitchMock.mockReturnValue(false);

    return Effect.gen(function* () {
      yield* DesktopPreReadyPlatform.DesktopPreReadyElectronOptions;

      assert.deepEqual(mkdirSyncMock.mock.calls, [
        ["/home/alice/.local/share/applications", { recursive: true }],
        ["/home/alice/.local/share/icons", { recursive: true }],
      ]);
      assert.deepEqual(copyFileSyncMock.mock.calls, [
        [
          "/tmp/.mount_erebus/resources/app.asar/apps/desktop/prod-resources/icon.png",
          "/home/alice/.local/share/icons/research.vyntra.erebus.png",
        ],
      ]);
      assert.equal(writeFileSyncMock.mock.calls.length, 2);
      assert.equal(
        writeFileSyncMock.mock.calls[0]?.[0],
        "/home/alice/.local/share/applications/research.vyntra.erebus.launcher.desktop",
      );
      assert.include(writeFileSyncMock.mock.calls[0]?.[1], "Name=Erebus");
      assert.include(
        writeFileSyncMock.mock.calls[0]?.[1],
        "Exec=/home/alice/Applications/Erebus.AppImage %U",
      );
      assert.equal(writeFileSyncMock.mock.calls[0]?.[2], "utf8");
      assert.equal(
        writeFileSyncMock.mock.calls[1]?.[0],
        "/home/alice/.local/share/applications/research.vyntra.erebus.desktop",
      );
      assert.include(
        writeFileSyncMock.mock.calls[1]?.[1],
        "Exec=gtk-launch research.vyntra.erebus.launcher %U",
      );
      assert.include(
        writeFileSyncMock.mock.calls[1]?.[1],
        "Icon=/home/alice/.local/share/icons/research.vyntra.erebus.png",
      );
      assert.include(writeFileSyncMock.mock.calls[1]?.[1], "StartupWMClass=erebus");
      assert.include(writeFileSyncMock.mock.calls[1]?.[1], "MimeType=x-scheme-handler/erebus;");
      assert.notInclude(writeFileSyncMock.mock.calls[1]?.[1], "NoDisplay=true");
      assert.equal(writeFileSyncMock.mock.calls[1]?.[2], "utf8");
      assert.deepEqual(setDesktopNameMock.mock.calls, [["research.vyntra.erebus.desktop"]]);
    }).pipe(
      Effect.provide(
        DesktopPreReadyPlatform.layer.pipe(
          Layer.provide(Layer.succeed(HostProcessPlatform, "linux")),
        ),
      ),
    );
  });
});
