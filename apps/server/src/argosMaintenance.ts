import {
  CodexSettings,
  resolveProviderInstanceEnabled,
  ServerArgosError,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  installManagedArgosForCodex,
  inspectManagedArgosUpdate,
  type ManagedArgosOptions,
  refreshManagedArgosRuntime,
  resolveManagedArgosRuntime,
} from "./argosRuntime.ts";
import { resolveCodexHomeLayout } from "./provider/Drivers/CodexHomeLayout.ts";
import { deriveProviderInstanceConfigMap } from "./provider/Layers/ProviderInstanceRegistryHydration.ts";

const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);
const automaticallyCheckedRuntimeRoots = new Set<string>();

const argosError =
  (operation: "status" | "update", detail: string) =>
  (cause: unknown): ServerArgosError =>
    new ServerArgosError({ operation, detail, cause });

const managedRuntimeRoot = (path: Path.Path, stateDir: string): string =>
  path.join(stateDir, "managed", "argos-runtime");

export const getArgosStatus = Effect.fn("ArgosMaintenance.status")(function* (
  stateDir: string,
  options: ManagedArgosOptions = {},
) {
  const path = yield* Path.Path;
  const runtimeRoot = managedRuntimeRoot(path, stateDir);
  const runtime = yield* resolveManagedArgosRuntime(runtimeRoot).pipe(
    Effect.mapError(argosError("status", "Erebus could not read the managed Argos version.")),
  );
  const shouldForceAutomaticCheck =
    options.forceUpdateCheck === undefined && !automaticallyCheckedRuntimeRoots.has(runtimeRoot);
  automaticallyCheckedRuntimeRoots.add(runtimeRoot);
  const updateStatus = yield* Effect.result(
    inspectManagedArgosUpdate(runtimeRoot, {
      ...options,
      forceUpdateCheck: options.forceUpdateCheck ?? shouldForceAutomaticCheck,
    }),
  );
  if (updateStatus._tag === "Failure") {
    return {
      version: runtime.version,
      latestVersion: null,
      updateAvailable: false,
      checkedAt: null,
      updateCheckError: updateStatus.failure.detail,
    } as const;
  }
  return { ...updateStatus.success, updateCheckError: null } as const;
});

export const updateArgos = Effect.fn("ArgosMaintenance.update")(function* (
  stateDir: string,
  settings: ServerSettings,
) {
  const path = yield* Path.Path;
  const runtimeRoot = managedRuntimeRoot(path, stateDir);
  const previous = yield* resolveManagedArgosRuntime(runtimeRoot).pipe(
    Effect.mapError(argosError("update", "Erebus could not read the current Argos runtime.")),
  );
  const runtime = yield* refreshManagedArgosRuntime(runtimeRoot, {
    forceUpdateCheck: true,
  }).pipe(Effect.mapError(argosError("update", "Erebus could not update Argos.")));

  const instances = deriveProviderInstanceConfigMap(settings);
  for (const instance of Object.values(instances)) {
    if (instance.driver !== "codex" || !resolveProviderInstanceEnabled(instance)) continue;
    const config = yield* decodeCodexSettings(instance.config ?? {}).pipe(
      Effect.mapError(
        argosError("update", "Erebus could not read a Codex instance while updating Argos."),
      ),
    );
    const home = yield* resolveCodexHomeLayout(config, {
      defaultHomePath: path.join(stateDir, "providers", "codex"),
    });
    yield* installManagedArgosForCodex(home.sharedHomePath, {
      managedRuntimeRoot: runtimeRoot,
    }).pipe(
      Effect.mapError(
        argosError("update", "Argos was updated but its Codex plugin could not be installed."),
      ),
    );
  }

  return {
    previousVersion: previous.version,
    version: runtime.version,
    updated: previous.version !== runtime.version,
  } as const;
});
