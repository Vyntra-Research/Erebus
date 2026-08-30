import {
  CodexSettings,
  resolveProviderInstanceEnabled,
  ServerProteusError,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  installManagedProteusForCodex,
  refreshManagedProteusRuntime,
  resolveManagedProteusRuntime,
} from "./proteusRuntime.ts";
import { resolveCodexHomeLayout } from "./provider/Drivers/CodexHomeLayout.ts";
import { deriveProviderInstanceConfigMap } from "./provider/Layers/ProviderInstanceRegistryHydration.ts";

const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);

const proteusError =
  (operation: "status" | "update", detail: string) =>
  (cause: unknown): ServerProteusError =>
    new ServerProteusError({ operation, detail, cause });

const managedRuntimeRoot = (path: Path.Path, stateDir: string): string =>
  path.join(stateDir, "managed", "proteus-runtime");

export const getProteusStatus = Effect.fn("ProteusMaintenance.status")(function* (
  stateDir: string,
) {
  const path = yield* Path.Path;
  const runtime = yield* resolveManagedProteusRuntime(managedRuntimeRoot(path, stateDir)).pipe(
    Effect.mapError(proteusError("status", "Erebus could not read the managed Proteus version.")),
  );
  return { version: runtime.version } as const;
});

export const updateProteus = Effect.fn("ProteusMaintenance.update")(function* (
  stateDir: string,
  settings: ServerSettings,
) {
  const path = yield* Path.Path;
  const runtimeRoot = managedRuntimeRoot(path, stateDir);
  const previous = yield* resolveManagedProteusRuntime(runtimeRoot).pipe(
    Effect.mapError(proteusError("update", "Erebus could not read the current Proteus runtime.")),
  );
  const runtime = yield* refreshManagedProteusRuntime(runtimeRoot, {
    forceUpdateCheck: true,
  }).pipe(Effect.mapError(proteusError("update", "Erebus could not update Proteus.")));

  const instances = deriveProviderInstanceConfigMap(settings);
  for (const instance of Object.values(instances)) {
    if (instance.driver !== "codex" || !resolveProviderInstanceEnabled(instance)) continue;
    const config = yield* decodeCodexSettings(instance.config ?? {}).pipe(
      Effect.mapError(
        proteusError("update", "Erebus could not read a Codex instance while updating Proteus."),
      ),
    );
    const home = yield* resolveCodexHomeLayout(config, {
      defaultHomePath: path.join(stateDir, "providers", "codex"),
    });
    if (!home.effectiveHomePath) continue;
    yield* installManagedProteusForCodex(home.effectiveHomePath, {
      managedRuntimeRoot: runtimeRoot,
    }).pipe(
      Effect.mapError(
        proteusError("update", "Proteus was updated but its Codex plugin could not be installed."),
      ),
    );
  }

  return {
    previousVersion: previous.version,
    version: runtime.version,
    updated: previous.version !== runtime.version,
  } as const;
});
