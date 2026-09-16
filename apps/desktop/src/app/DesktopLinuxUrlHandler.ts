import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";

// Linux ships as an AppImage, so the .desktop entry users end up with is
// created by whatever integration tool they use (AppImageLauncher names it
// appimagekit_<hash>-….desktop) and its filename is not under our control.
// Electron's app.setAsDefaultProtocolClient resolves the desktop id from
// setDesktopName, which cannot match those files — so the browser keeps
// prompting "Choose an application" for every OAuth callback. Instead, write
// our own handler entry pointing at the current AppImage and claim the
// scheme default via xdg-mime, exactly what the file manager's "set as
// default" checkbox would record in mimeapps.list.
const { logInfo, logWarning } = makeComponentLogger("desktop-linux-url-handler");

export class DesktopLinuxUrlHandlerRegistrationError extends Schema.TaggedErrorClass<DesktopLinuxUrlHandlerRegistrationError>()(
  "DesktopLinuxUrlHandlerRegistrationError",
  {
    step: Schema.Literals(["write-desktop-entry", "set-default-handler"]),
    scheme: Schema.String,
    desktopEntryPath: Schema.optionalKey(Schema.String),
    exitCode: Schema.optionalKey(Schema.Number),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    const exitCode = this.exitCode === undefined ? "" : `, xdg-mime exit code ${this.exitCode}`;
    return `Failed to register the ${this.scheme}:// URL handler (step: ${this.step}${exitCode}).`;
  }
}

const isRegistrationError = Schema.is(DesktopLinuxUrlHandlerRegistrationError);

const escapeDesktopEntryString = (value: string): string =>
  value
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");

// Exec values are unescaped twice by implementations: first the general
// string-value rules, then the Exec quoting rules — so writing composes the
// layers in reverse. The argument is double-quoted with reserved characters
// backslash-escaped and literal percent signs doubled (field codes), and the
// general string escaping is applied on top: a literal backslash ends up as
// four backslashes in the file, a quote as \\", a dollar sign as \\$.
export function escapeDesktopEntryExecArgument(value: string): string {
  // xdg-utils 1.2.1 fails to resolve a quoted first Exec token even though it
  // is valid freedesktop syntax. Keep ordinary absolute paths unquoted while
  // retaining full quoting for paths that require it.
  if (!/[\s"'\\><~|&;$*?#()`]/u.test(value)) {
    return escapeDesktopEntryString(value.replaceAll("%", () => "%%"));
  }

  const quoted = value
    .replaceAll("\\", () => "\\\\")
    .replaceAll("`", () => "\\`")
    .replaceAll("$", () => "\\$")
    .replaceAll('"', () => '\\"')
    .replaceAll("%", () => "%%");
  return escapeDesktopEntryString(`"${quoted}"`);
}

export function resolveLinuxLauncherDesktopEntryName(desktopEntryName: string): string {
  const suffix = ".desktop";
  return desktopEntryName.endsWith(suffix)
    ? `${desktopEntryName.slice(0, -suffix.length)}.launcher${suffix}`
    : `${desktopEntryName}.launcher${suffix}`;
}

export const desktopEntryApplicationId = (desktopEntryName: string): string =>
  desktopEntryName.endsWith(".desktop")
    ? desktopEntryName.slice(0, -".desktop".length)
    : desktopEntryName;

// xdg-utils 1.2.1 does not parse a quoted first Exec token. Keep the scheme
// handler's command and arguments space-free, then let GTK parse the actual
// AppImage path from a second desktop entry according to the freedesktop spec.
// The canonical entry also carries stable icon and window metadata for
// Wayland shells. Both entries remain hidden from application menus.
export function renderUrlHandlerDesktopEntry(input: {
  readonly displayName: string;
  readonly iconPath: string;
  readonly launcherDesktopEntryName: string;
  readonly scheme: string;
  readonly startupWmClass: string;
}): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${escapeDesktopEntryString(input.displayName)}`,
    `Exec=gtk-launch ${desktopEntryApplicationId(input.launcherDesktopEntryName)} %U`,
    "Terminal=false",
    "Categories=Development;",
    "StartupNotify=false",
    `Icon=${escapeDesktopEntryString(input.iconPath)}`,
    `StartupWMClass=${escapeDesktopEntryString(input.startupWmClass)}`,
    `MimeType=x-scheme-handler/${input.scheme};`,
    "",
  ].join("\n");
}

export function renderAppLauncherDesktopEntry(input: {
  readonly displayName: string;
  readonly execTarget: string;
}): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${escapeDesktopEntryString(input.displayName)}`,
    `Exec=${escapeDesktopEntryExecArgument(input.execTarget)} %U`,
    "Terminal=false",
    "NoDisplay=true",
    "StartupNotify=false",
    "",
  ].join("\n");
}

export class DesktopLinuxUrlHandler extends Context.Service<
  DesktopLinuxUrlHandler,
  {
    readonly register: Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopLinuxUrlHandler") {}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const scheme = ElectronProtocol.getDesktopScheme(environment.isDevelopment);
  const desktopEntryPath = environment.path.join(
    environment.linuxApplicationsDir,
    environment.linuxDesktopEntryName,
  );
  const launcherDesktopEntryName = resolveLinuxLauncherDesktopEntryName(
    environment.linuxDesktopEntryName,
  );
  const launcherDesktopEntryPath = environment.path.join(
    environment.linuxApplicationsDir,
    launcherDesktopEntryName,
  );
  const desktopEntryId = desktopEntryApplicationId(environment.linuxDesktopEntryName);
  const iconPath = environment.path.join(
    environment.path.dirname(environment.linuxApplicationsDir),
    "icons",
    `${desktopEntryId}.png`,
  );

  const writeDesktopEntry = (path: string, content: string) =>
    Effect.gen(function* () {
      const existing = yield* fileSystem
        .readFileString(path)
        .pipe(Effect.orElseSucceed(() => null));
      if (existing === content) return;
      yield* fileSystem.writeFileString(path, content);
    }).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopLinuxUrlHandlerRegistrationError({
            step: "write-desktop-entry",
            scheme,
            desktopEntryPath: path,
            cause,
          }),
      ),
    );

  const writeDesktopEntries = Effect.gen(function* () {
    // Inside the mounted AppImage, process.execPath points at a transient
    // /tmp/.mount_* path — the handler must launch the AppImage itself.
    const execTarget = Option.getOrElse(environment.appImagePath, () => process.execPath);
    const handlerContent = renderUrlHandlerDesktopEntry({
      displayName: environment.displayName,
      iconPath,
      launcherDesktopEntryName,
      scheme,
      startupWmClass: environment.linuxWmClass,
    });
    const launcherContent = renderAppLauncherDesktopEntry({
      displayName: `${environment.displayName} launcher`,
      execTarget,
    });
    yield* fileSystem.makeDirectory(environment.linuxApplicationsDir, { recursive: true });
    // Publish the target before the handler so an existing MIME association
    // never observes a handler whose launcher has not been refreshed yet.
    yield* writeDesktopEntry(launcherDesktopEntryPath, launcherContent);
    yield* writeDesktopEntry(desktopEntryPath, handlerContent);
  }).pipe(
    Effect.mapError((error) =>
      isRegistrationError(error)
        ? error
        : new DesktopLinuxUrlHandlerRegistrationError({
            step: "write-desktop-entry",
            scheme,
            desktopEntryPath,
            cause: error,
          }),
    ),
  );

  const installDesktopIcon = Effect.gen(function* () {
    let sourceIconPath: string | undefined;
    for (const candidate of environment.resolveResourcePathCandidates("icon.png")) {
      if (yield* fileSystem.exists(candidate)) {
        sourceIconPath = candidate;
        break;
      }
    }
    if (sourceIconPath === undefined) return;
    yield* fileSystem.makeDirectory(environment.path.dirname(iconPath), { recursive: true });
    yield* fileSystem.copyFile(sourceIconPath, iconPath);
  }).pipe(
    Effect.catch((cause) =>
      logWarning("Linux desktop icon installation failed", {
        iconPath,
        message: String(cause),
      }),
    ),
  );

  const setDefaultHandler = Effect.scoped(
    Effect.gen(function* () {
      const command = ChildProcess.make(
        "xdg-mime",
        ["default", environment.linuxDesktopEntryName, `x-scheme-handler/${scheme}`],
        {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      const handle = yield* spawner.spawn(command);
      const exitCode = yield* handle.exitCode;
      if ((exitCode as unknown as number) !== 0) {
        return yield* new DesktopLinuxUrlHandlerRegistrationError({
          step: "set-default-handler",
          scheme,
          exitCode: Number(exitCode),
        });
      }
    }),
  ).pipe(
    Effect.mapError((error) =>
      isRegistrationError(error)
        ? error
        : new DesktopLinuxUrlHandlerRegistrationError({
            step: "set-default-handler",
            scheme,
            cause: error,
          }),
    ),
  );

  const register = Effect.gen(function* () {
    if (environment.platform !== "linux" || !environment.isPackaged) {
      return;
    }
    yield* installDesktopIcon;
    yield* writeDesktopEntries;
    yield* setDefaultHandler;
    yield* logInfo("registered URL scheme handler", { scheme });
  }).pipe(
    // Registration is best-effort: a missing xdg-mime or read-only home must
    // never block startup — the OS chooser remains as fallback.
    Effect.catch((error) =>
      logWarning("URL scheme handler registration failed", {
        scheme,
        step: error.step,
        message: error.message,
        ...(error.desktopEntryPath === undefined
          ? {}
          : { desktopEntryPath: error.desktopEntryPath }),
        ...(error.exitCode === undefined ? {} : { exitCode: error.exitCode }),
      }),
    ),
    Effect.withSpan("desktop.linuxUrlHandler.register"),
  );

  return DesktopLinuxUrlHandler.of({ register });
});

export const layer = Layer.effect(DesktopLinuxUrlHandler, make);
