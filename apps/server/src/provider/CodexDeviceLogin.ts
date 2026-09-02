import {
  CodexLoginError,
  CodexSettings,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type CodexLoginEvent,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  materializeCodexShadowHome,
  resolveCodexHomeLayout,
  withAutomaticCodexAccountOverlay,
} from "./Drivers/CodexHomeLayout.ts";
import { makeInitializedCodexClient } from "./Layers/CodexProvider.ts";
import { resolveCodexLaunchArgs } from "./Layers/codexLaunchArgs.ts";
import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";

const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);

function loginError(instanceId: ProviderInstanceId, cause: unknown): CodexLoginError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new CodexLoginError({ instanceId, detail });
}

/**
 * Runs Codex's official ChatGPT browser login against the exact isolated
 * home used by one Erebus provider instance. The scoped app-server stays alive
 * until Codex reports completion or the client cancels the RPC stream.
 */
export function loginCodexWithChatGpt(instanceId: ProviderInstanceId) {
  return Stream.unwrap(
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig;
      const serverSettings = yield* ServerSettingsService;
      const path = yield* Path.Path;
      const settings = yield* serverSettings.getSettings;
      const codexDriver = ProviderDriverKind.make("codex");
      const defaultInstanceId = defaultInstanceIdForDriver(codexDriver);
      const explicitInstance = settings.providerInstances[instanceId];
      const instance: ProviderInstanceConfig | undefined =
        explicitInstance ??
        (instanceId === defaultInstanceId
          ? { driver: codexDriver, config: settings.providers.codex }
          : undefined);

      if (!instance) {
        return yield* loginError(instanceId, `Provider instance '${instanceId}' was not found.`);
      }
      if (instance.driver !== "codex") {
        return yield* loginError(instanceId, `Provider instance '${instanceId}' is not Codex.`);
      }

      const decodedConfig = yield* decodeCodexSettings(instance.config ?? {}).pipe(
        Effect.mapError((cause) => loginError(instanceId, cause)),
      );
      const config = withAutomaticCodexAccountOverlay(decodedConfig, {
        instanceId,
        defaultInstanceId,
        accountHomePath: path.join(
          serverConfig.stateDir,
          "providers",
          "codex",
          "accounts",
          instanceId,
        ),
      });
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
        .request("account/login/start", { type: "chatgpt" })
        .pipe(Effect.mapError((cause) => loginError(instanceId, cause)));

      if (response.type !== "chatgpt") {
        return yield* loginError(instanceId, "Codex did not start a ChatGPT browser login.");
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
            ? Effect.succeed<CodexLoginEvent>({ type: "complete", success: true })
            : Effect.fail(
                loginError(
                  instanceId,
                  notification.error ?? "Codex browser login did not complete.",
                ),
              ),
        ),
      );

      return Stream.concat(
        Stream.fromIterable<CodexLoginEvent>([
          {
            type: "browserAuth",
            loginId: response.loginId,
            authUrl: response.authUrl,
          },
        ]),
        completion,
      );
    }).pipe(Effect.mapError((cause) => loginError(instanceId, cause))),
  );
}
