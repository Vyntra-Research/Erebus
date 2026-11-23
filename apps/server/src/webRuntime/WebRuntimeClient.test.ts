import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Duration from "effect/Duration";
import { FetchHttpClient } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as WebRuntimeBinary from "./WebRuntimeBinary.ts";

import {
  decodeRuntimeHealth,
  make,
  makeRuntimeCommand,
  nextRestart,
  parseReadyLine,
  runtimeEnvironment,
  WEB_WORKSPACE_DATA_SEGMENTS,
} from "./WebRuntimeClient.ts";

describe("WebRuntimeClient readiness", () => {
  it("accepts only loopback HTTP readiness URLs", () => {
    expect(parseReadyLine("EREBUS_WEB_READY http://127.0.0.1:18788")).toBe(
      "http://127.0.0.1:18788",
    );
    expect(parseReadyLine("EREBUS_WEB_READY http://localhost:18788")).toBeUndefined();
    expect(parseReadyLine("EREBUS_WEB_READY https://127.0.0.1:18788")).toBeUndefined();
    expect(parseReadyLine("EREBUS_WEB_READY http://192.168.0.10:18788")).toBeUndefined();
    expect(parseReadyLine("noise")).toBeUndefined();
  });

  it.effect("requires the expected health protocol and a positive schema version", () =>
    Effect.gen(function* () {
      expect(
        yield* decodeRuntimeHealth({ status: "ok", protocolVersion: 1, schemaVersion: 3 }),
      ).toEqual({ status: "ok", protocolVersion: 1, schemaVersion: 3 });
      const wrongProtocol = yield* Effect.exit(
        decodeRuntimeHealth({ status: "ok", protocolVersion: 2, schemaVersion: 3 }),
      );
      const invalidSchema = yield* Effect.exit(
        decodeRuntimeHealth({ status: "ok", protocolVersion: 1, schemaVersion: 0 }),
      );
      expect(Exit.isFailure(wrongProtocol)).toBe(true);
      expect(Exit.isFailure(invalidSchema)).toBe(true);
    }),
  );

  it("builds a loopback-only command with private auth and an open stdin pipe", () => {
    const command = makeRuntimeCommand({
      executablePath: "C:\\Erebus\\erebus-webd.exe",
      dataDir: "C:\\Erebus\\state\\web-runtime",
      cwd: "C:\\Erebus",
      token: "ephemeral-test-token",
    });
    expect(command.command).toBe("C:\\Erebus\\erebus-webd.exe");
    expect(command.args).toEqual([
      "--data-dir",
      "C:\\Erebus\\state\\web-runtime",
      "--bind",
      "127.0.0.1:0",
    ]);
    expect(command.options.env?.EREBUS_WEB_TOKEN).toBe("ephemeral-test-token");
    expect(command.options.extendEnv).toBe(false);
    expect(command.options.stdin).toEqual({ stream: "pipe", endOnDone: false });
    expect(command.options.killSignal).toBe("SIGTERM");
    expect(Duration.toMillis(command.options.forceKillAfter ?? 0)).toBe(20_000);
  });

  it("passes only runtime prerequisites and the ephemeral token to the sidecar", () => {
    const environment = runtimeEnvironment(
      {
        PATH: "C:\\Windows\\System32",
        TEMP: "C:\\Temp",
        LANG: "pt_BR.UTF-8",
        OPENAI_API_KEY: "must-not-leak",
        CODEX_HOME: "must-not-leak-either",
      },
      "ephemeral-test-token",
    );

    expect(environment).toEqual({
      PATH: "C:\\Windows\\System32",
      TEMP: "C:\\Temp",
      LANG: "pt_BR.UTF-8",
      EREBUS_WEB_TOKEN: "ephemeral-test-token",
    });
    expect(environment).not.toHaveProperty("OPENAI_API_KEY");
    expect(environment).not.toHaveProperty("CODEX_HOME");
  });

  it("limits restart storms and resets the backoff outside the failure window", () => {
    let failures: ReadonlyArray<number> = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const restart = nextRestart(failures, attempt * 1_000);
      failures = restart.failures;
      expect(restart.exhausted).toBe(false);
    }
    expect(nextRestart(failures, 4_000).exhausted).toBe(true);
    const recovered = nextRestart(failures, 65_000);
    expect(recovered.failures).toEqual([65_000]);
    expect(recovered.delayMs).toBe(500);
  });

  it("stores the complete web base inside the workspace", () => {
    expect(WEB_WORKSPACE_DATA_SEGMENTS).toEqual([".erebus", "web"]);
  });

  it.effect("keeps the server layer available when the configured runtime binary is missing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* make().pipe(
          Effect.provide(
            Layer.mergeAll(
              FetchHttpClient.layer,
              ServerConfig.ServerConfig.layerTest(process.cwd(), {
                prefix: "erebus-web-runtime-client-test-",
              }),
              Layer.succeed(
                WebRuntimeBinary.WebRuntimeBinary,
                WebRuntimeBinary.WebRuntimeBinary.of({
                  resolve: Effect.fail(
                    new WebRuntimeBinary.WebRuntimeBinaryNotFound({
                      path: "C:\\missing\\erebus-webd.exe",
                    }),
                  ),
                }),
              ),
            ).pipe(Layer.provideMerge(NodeServices.layer)),
          ),
        );

        const health = yield* runtime.health;
        expect(["degraded", "unavailable"]).toContain(health.status);
        expect(yield* Effect.exit(runtime.connection)).toMatchObject({ _tag: "Failure" });
      }),
    ),
  );
});
