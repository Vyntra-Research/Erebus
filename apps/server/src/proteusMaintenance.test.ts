import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { getProteusStatus } from "./proteusMaintenance.ts";
import { resolveManagedProteusRuntime } from "./proteusRuntime.ts";

it.layer(NodeServices.layer)("Proteus maintenance", (it) => {
  it.effect("checks release metadata once per server process and exposes update state", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const stateDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "erebus-proteus-maintenance-",
      });
      const bundled = yield* resolveManagedProteusRuntime();
      const checkedAt = Date.UTC(2026, 8, 7);
      let requests = 0;
      const fetchMock = (async (_input: string | URL | Request) => {
        requests += 1;
        return Response.json({
          tag_name: `v${bundled.version}`,
          draft: false,
          prerelease: false,
          assets: [],
        });
      }) as typeof globalThis.fetch;

      const first = yield* getProteusStatus(stateDir, {
        fetch: fetchMock,
        now: () => checkedAt,
      });
      const second = yield* getProteusStatus(stateDir, {
        fetch: fetchMock,
        now: () => checkedAt,
      });

      expect(first).toEqual({
        version: bundled.version,
        latestVersion: bundled.version,
        updateAvailable: false,
        checkedAt,
        updateCheckError: null,
      });
      expect(second).toEqual(first);
      expect(requests).toBe(1);
    }),
  );

  it.effect("keeps the installed version visible when the release check fails", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const stateDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "erebus-proteus-maintenance-failure-",
      });
      const bundled = yield* resolveManagedProteusRuntime();
      const status = yield* getProteusStatus(stateDir, {
        fetch: (async (_input: string | URL | Request) =>
          new Response(null, { status: 503 })) as typeof globalThis.fetch,
        now: () => Date.UTC(2026, 8, 7),
      });

      expect(status.version).toBe(bundled.version);
      expect(status.latestVersion).toBeNull();
      expect(status.updateAvailable).toBe(false);
      expect(status.checkedAt).toBeNull();
      expect(status.updateCheckError).toBe("Erebus could not check the latest Proteus release.");
    }),
  );
});
