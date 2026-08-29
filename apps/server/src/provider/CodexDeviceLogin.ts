import {
  CodexDeviceLoginError,
  CodexSettings,
  type CodexDeviceLoginEvent,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { materializeCodexShadowHome, resolveCodexHomeLayout } from "./Drivers/CodexHomeLayout.ts";
import { makeInitializedCodexClient } from "./Layers/CodexProvider.ts";
import { resolveCodexLaunchArgs } from "./Layers/codexLaunchArgs.ts";
import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";

const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);

function loginError(instanceId: ProviderInstanceId, cause: unknown): CodexDeviceLoginError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new CodexDeviceLoginError({ instanceId, detail });
}

/**
 * Runs Codex's official ChatGPT device-code login against the exact isolated
 * home used by one Erebus provider instance. The scoped app-server stays alive
 * until Codex reports completion or the client cancels the RPC stream.
 */
export function loginCodexWithDeviceCode(instanceId: ProviderInstanceId) {
  return Stream.unwrap(
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig;
      const serverSettings = yield* ServerSettingsService;
      const path = yield* Path.Path;
      const settings = yield* serverSettings.getSettings;
      const instance = settings.providerInstances[instanceId];

      if (!instance) {
        return yield* loginError(instanceId, `Provider instance '${instanceId}' was not found.`);
      }
      if (instance.driver !== "codex") {
        return yield* loginError(instanceId, `Provider instance '${instanceId}' is not Codex.`);
      }

      const config = yield* decodeCodexSettings(instance.config ?? {}).pipe(
        Effect.mapError((cause) => loginError(instanceId, cause)),
      );
      const homeLayout = yield* resolveCodexHomeLayout(config, {
        defaultHomePath: path.join(serverConfig.stateDir, "providers", "codex"),
      });
      yield* materializeCodexShadowHome(homeLayout).pipe(
        Effect.mapError((cause) => loginError(instanceId, cause)),
      );

      const environment = mergeProviderInstanceEnvironment(instance.environment);
      const completionQueue = yield* Queue.unbounded<{
        readonly error?: string | null;
        readonly loginId?: string | null;
        readonly success: boolean;
      }>();
      const { client } = yield* makeInitializedCodexClient({
        binaryPath: config.binaryPath,
        ...(homeLayout.effectiveHomePath ? { homePath: homeLayout.effectiveHomePath } : {}),
        launchArgs: resolveCodexLaunchArgs(config.launchArgs, environment),
        cwd: process.cwd(),
        environment,
      }).pipe(Effect.mapError((cause) => loginError(instanceId, cause)));

      yield* client.handleServerNotification("account/login/completed", (notification) =>
        Queue.offer(completionQueue, notification).pipe(Effect.asVoid),
      );
      const response = yield* client
        .request("account/login/start", { type: "chatgptDeviceCode" })
        .pipe(Effect.mapError((cause) => loginError(instanceId, cause)));

      if (response.type !== "chatgptDeviceCode") {
        return yield* loginError(instanceId, "Codex did not start a device-code login.");
      }

      const completion = Stream.fromQueue(completionQueue).pipe(
        Stream.filter(
          (notification) =>
            notification.loginId === null ||
            notification.loginId === undefined ||
            notification.loginId === response.loginId,
        ),
        Stream.take(1),
        Stream.mapEffect((notification) =>
          notification.success
            ? Effect.succeed<CodexDeviceLoginEvent>({ type: "complete", success: true })
            : Effect.fail(
                loginError(
                  instanceId,
                  notification.error ?? "Codex device login did not complete.",
                ),
              ),
        ),
      );

      return Stream.concat(
        Stream.fromIterable<CodexDeviceLoginEvent>([
          {
            type: "deviceCode",
            loginId: response.loginId,
            userCode: response.userCode,
            verificationUrl: response.verificationUrl,
          },
        ]),
        completion,
      );
    }).pipe(Effect.mapError((cause) => loginError(instanceId, cause))),
  );
}
