import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { resolvePath } from "./WebRuntimeBinary.ts";

it.layer(NodeServices.layer)("WebRuntimeBinary", (it) => {
  it.effect("stays disabled when no runtime path is configured", () =>
    Effect.gen(function* () {
      expect(Option.isNone(yield* resolvePath(undefined))).toBe(true);
    }),
  );

  it.effect("fails clearly for a configured missing path or directory", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "erebus-web-runtime-binary-",
        });
        const missingPath = path.join(directory, "missing-runtime");
        const missing = yield* resolvePath(missingPath).pipe(Effect.flip);
        const notFile = yield* resolvePath(directory).pipe(Effect.flip);
        expect(missing._tag).toBe("WebRuntimeBinaryNotFound");
        expect(notFile._tag).toBe("WebRuntimeBinaryNotFile");
      }),
    ),
  );

  it.effect("accepts a configured runtime executable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "erebus-web-runtime-binary-",
        });
        const binaryPath = path.join(directory, "erebus-webd");
        yield* fileSystem.writeFileString(binaryPath, "fixture");
        yield* fileSystem.chmod(binaryPath, 0o755);
        expect(yield* resolvePath(binaryPath)).toEqual(Option.some(binaryPath));
      }),
    ),
  );
});
