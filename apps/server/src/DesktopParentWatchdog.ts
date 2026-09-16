import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

const DEFAULT_POLL_INTERVAL = Duration.millis(250);

export interface DesktopParentWatchdogOptions {
  readonly pollInterval?: Duration.Input;
  readonly readParentPid?: () => number;
  readonly isProcessReachable?: (pid: number) => boolean;
}

function isNoSuchProcessError(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { readonly code?: unknown }).code === "ESRCH"
  );
}

function defaultIsProcessReachable(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // EPERM still proves that the process exists. Only ESRCH means it is gone.
    return !isNoSuchProcessError(cause);
  }
}

export function isDesktopParentAlive(
  expectedParentPid: number,
  options: Pick<DesktopParentWatchdogOptions, "readParentPid" | "isProcessReachable"> = {},
): boolean {
  const readParentPid = options.readParentPid ?? (() => process.ppid);
  if (readParentPid() !== expectedParentPid) return false;

  const isProcessReachable = options.isProcessReachable ?? defaultIsProcessReachable;
  if (!isProcessReachable(expectedParentPid)) return false;

  // The parent may disappear between the two probes and its PID may be reused.
  // The direct parent relationship is authoritative, so confirm it once more.
  return readParentPid() === expectedParentPid;
}

export const awaitDesktopParentExit = Effect.fn("desktop.awaitParentExit")(function (
  expectedParentPid: number,
  options: DesktopParentWatchdogOptions = {},
): Effect.Effect<void> {
  const pollInterval = options.pollInterval ?? DEFAULT_POLL_INTERVAL;
  return Effect.suspend(() =>
    isDesktopParentAlive(expectedParentPid, options)
      ? Effect.sleep(pollInterval).pipe(
          Effect.andThen(awaitDesktopParentExit(expectedParentPid, options)),
        )
      : Effect.void,
  );
});

export function supervise<A, E, R>(
  server: Effect.Effect<A, E, R>,
  expectedParentPid: number | undefined,
  options: DesktopParentWatchdogOptions = {},
): Effect.Effect<A | void, E, R> {
  if (expectedParentPid === undefined) return server;

  return Effect.flatMap(HostProcessPlatform, (platform) =>
    platform !== "linux"
      ? server
      : Effect.raceFirst(
          server,
          awaitDesktopParentExit(expectedParentPid, options).pipe(
            Effect.tap(() =>
              Effect.logInfo("Desktop parent exited; stopping the local backend", {
                desktopParentPid: expectedParentPid,
              }),
            ),
          ),
        ),
  );
}
