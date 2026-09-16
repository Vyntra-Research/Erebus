// @effect-diagnostics nodeBuiltinImport:off - pre-ready Electron setup reads persisted settings synchronously before app services are available.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Electron from "electron";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as DesktopEarlyElectronStartup from "./DesktopEarlyElectronStartup.ts";
import { resolveDesktopAppBranding } from "./DesktopEnvironment.ts";
import {
  desktopEntryApplicationId,
  renderAppLauncherDesktopEntry,
  renderUrlHandlerDesktopEntry,
  resolveLinuxLauncherDesktopEntryName,
} from "./DesktopLinuxUrlHandler.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";

export interface DesktopPreReadyCommandLineReader {
  readonly hasSwitch: (switchName: string) => boolean;
  readonly getSwitchValue: (switchName: string) => string;
}

export function readCommandLineSwitchValue(
  commandLine: DesktopPreReadyCommandLineReader,
  switchName: string,
): string | null {
  if (!commandLine.hasSwitch(switchName)) {
    return null;
  }

  const value = commandLine.getSwitchValue(switchName).trim();
  return value.length > 0 ? value : null;
}

export const resolveEarlyLinuxElectronOptionsFromProcess =
  (): DesktopEarlyElectronStartup.EarlyLinuxElectronOptions =>
    DesktopEarlyElectronStartup.resolveEarlyLinuxElectronOptions({
      env: process.env,
      homeDirectory: NodeOS.homedir(),
      joinPath: NodePath.posix.join,
      readFileString: (path) => NodeFS.readFileSync(path, "utf8"),
    });

export class DesktopPreReadyElectronOptions extends Context.Service<
  DesktopPreReadyElectronOptions,
  {
    readonly linux: DesktopEarlyElectronStartup.EarlyLinuxElectronOptions | null;
    readonly linuxPasswordStoreCommandLine: string | null;
  }
>()("@t3tools/desktop/app/DesktopPreReadyPlatform/DesktopPreReadyElectronOptions") {}

export const make = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;
  return yield* Effect.sync((): DesktopPreReadyElectronOptions["Service"] => {
    const linuxPasswordStoreCommandLine =
      platform === "linux"
        ? readCommandLineSwitchValue(Electron.app.commandLine, "password-store")
        : null;
    const linux = platform === "linux" ? resolveEarlyLinuxElectronOptionsFromProcess() : null;

    if (linux !== null) {
      // Chromium and xdg-desktop-portal cache the desktop identity during
      // startup. Prepare the canonical entry and select it before any
      // asynchronous service can initialize the portal with Electron's
      // default identity. The regular URL-handler layer retries this work and
      // records failures after startup.
      if (!linux.isDevelopment) {
        try {
          const dataHome =
            process.env.XDG_DATA_HOME?.trim() ||
            NodePath.posix.join(NodeOS.homedir(), ".local", "share");
          const applicationsDir = NodePath.posix.join(dataHome, "applications");
          NodeFS.mkdirSync(applicationsDir, { recursive: true });
          const desktopEntryId = desktopEntryApplicationId(linux.linuxDesktopEntryName);
          const iconPath = NodePath.posix.join(dataHome, "icons", `${desktopEntryId}.png`);
          try {
            const sourceIconCandidates = [
              NodePath.posix.join(
                Electron.app.getAppPath(),
                "apps",
                "desktop",
                "prod-resources",
                "icon.png",
              ),
            ];
            if (typeof process.resourcesPath === "string") {
              sourceIconCandidates.push(
                NodePath.posix.join(process.resourcesPath, "resources", "icon.png"),
                NodePath.posix.join(process.resourcesPath, "icon.png"),
              );
            }
            const sourceIconPath = sourceIconCandidates.find((candidate) =>
              NodeFS.existsSync(candidate),
            );
            if (sourceIconPath !== undefined) {
              NodeFS.mkdirSync(NodePath.posix.dirname(iconPath), { recursive: true });
              NodeFS.copyFileSync(sourceIconPath, iconPath);
            }
          } catch {
            // The URL handler remains usable if the shell icon cannot be installed.
          }
          const launcherDesktopEntryName = resolveLinuxLauncherDesktopEntryName(
            linux.linuxDesktopEntryName,
          );
          const displayName = resolveDesktopAppBranding({
            isDevelopment: linux.isDevelopment,
            appVersion: Electron.app.getVersion(),
          }).displayName;
          const execTarget = process.env.APPIMAGE?.trim() || process.execPath;
          NodeFS.writeFileSync(
            NodePath.posix.join(applicationsDir, launcherDesktopEntryName),
            renderAppLauncherDesktopEntry({
              displayName: `${displayName} launcher`,
              execTarget,
            }),
            "utf8",
          );
          NodeFS.writeFileSync(
            NodePath.posix.join(applicationsDir, linux.linuxDesktopEntryName),
            renderUrlHandlerDesktopEntry({
              displayName,
              iconPath,
              launcherDesktopEntryName,
              scheme: ElectronProtocol.getDesktopScheme(linux.isDevelopment),
              startupWmClass: linux.linuxWmClass,
            }),
            "utf8",
          );
        } catch {
          // Startup must remain available when the desktop database is read-only.
        }
      }
      const linuxApp = Electron.app as Electron.App & {
        readonly setDesktopName?: (desktopName: string) => void;
      };
      linuxApp.setDesktopName?.(linux.linuxDesktopEntryName);
      Electron.app.commandLine.appendSwitch("class", linux.linuxWmClass);
      if (linux.passwordStore !== null && linuxPasswordStoreCommandLine === null) {
        Electron.app.commandLine.appendSwitch("password-store", linux.passwordStore);
      }
    }

    return { linux, linuxPasswordStoreCommandLine };
  });
}).pipe(Effect.withSpan("desktop.electron.configureBeforeReady"));

// Keep Electron's strict pre-ready setup isolated so later runtime layers cannot
// observe app readiness before scheme privileges and command-line switches exist.
export const layer = Layer.mergeAll(
  ElectronProtocol.layerSchemePrivileges,
  Layer.effect(DesktopPreReadyElectronOptions, make),
);
