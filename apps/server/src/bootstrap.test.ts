// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeStream from "node:stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import {
  BootstrapEnvelopeDecodeError,
  BootstrapFdStatError,
  BootstrapInputStreamOpenError,
  BootstrapEnvelopeMissingError,
  readBootstrapEnvelope,
  readRequiredBootstrapEnvelope,
} from "./bootstrap.ts";
import { assertNone, assertSome } from "@effect/vitest/utils";

const openSyncInterceptor = vi.hoisted(() => ({
  failPath: null as string | null,
  errorCode: "ENXIO",
}));
const fstatSyncInterceptor = vi.hoisted(() => ({ failFd: null as number | null }));
const inputInterceptor = vi.hoisted(() => ({
  fd: null as number | null,
  stream: null as import("node:stream").Readable | null,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    createReadStream: (...args: Parameters<typeof actual.createReadStream>) =>
      typeof args[1] === "object" &&
      args[1]?.fd === inputInterceptor.fd &&
      inputInterceptor.stream !== null
        ? inputInterceptor.stream
        : actual.createReadStream(...args),
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const [filePath, flags] = args;
      if (
        typeof filePath === "string" &&
        filePath === openSyncInterceptor.failPath &&
        flags === "r"
      ) {
        const error = new Error(`open failed with ${openSyncInterceptor.errorCode}`);
        Object.assign(error, { code: openSyncInterceptor.errorCode });
        throw error;
      }
      return (actual.openSync as (...a: typeof args) => number)(...args);
    },
    fstatSync: (...args: Parameters<typeof actual.fstatSync>) => {
      if (args[0] === fstatSyncInterceptor.failFd) {
        const error = new Error("permission denied");
        Object.assign(error, { code: "EACCES" });
        throw error;
      }
      return (actual.fstatSync as (...a: typeof args) => NodeFS.Stats)(...args);
    },
  };
});

const TestEnvelopeSchema = Schema.Struct({ mode: Schema.String });
const encodeTestEnvelopeSchema = Schema.encodeEffect(Schema.fromJsonString(TestEnvelopeSchema));

it.layer(NodeServices.layer)("readBootstrapEnvelope", (it) => {
  const openEnvelopeFile = Effect.fn(function* (filePath: string) {
    if ((yield* HostProcessPlatform) === "win32") return NodeFS.openSync(filePath, "r");
    return yield* Effect.acquireRelease(
      Effect.sync(() => NodeFS.openSync(filePath, "r")),
      (fd) => Effect.sync(() => NodeFS.closeSync(fd)),
    );
  });

  it.effect("reads a bootstrap envelope from a provided fd", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const filePath = yield* fs.makeTempFileScoped({ prefix: "t3-bootstrap-", suffix: ".ndjson" });

      yield* fs.writeFileString(
        filePath,
        `${yield* encodeTestEnvelopeSchema({ mode: "desktop" })}\n`,
      );

      const fd = yield* openEnvelopeFile(filePath);

      const payload = yield* readBootstrapEnvelope(TestEnvelopeSchema, fd, { timeoutMs: 100 });
      assertSome(payload, {
        mode: "desktop",
      });
    }),
  );

  it.effect("falls back to reading the inherited fd when path duplication fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const filePath = yield* fs.makeTempFileScoped({ prefix: "t3-bootstrap-", suffix: ".ndjson" });

      yield* fs.writeFileString(
        filePath,
        `${yield* encodeTestEnvelopeSchema({ mode: "desktop" })}\n`,
      );

      // The direct fallback owns this descriptor on every platform.
      const fd = NodeFS.openSync(filePath, "r");

      openSyncInterceptor.failPath = `/proc/self/fd/${fd}`;
      try {
        const payload = yield* readBootstrapEnvelope(TestEnvelopeSchema, fd, {
          timeoutMs: 100,
        }).pipe(Effect.provideService(HostProcessPlatform, "linux"));
        assertSome(payload, {
          mode: "desktop",
        });
      } finally {
        openSyncInterceptor.failPath = null;
      }
    }),
  );

  it.effect("preserves fd path, platform, and cause when opening the input stream fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const filePath = yield* fs.makeTempFileScoped({ prefix: "t3-bootstrap-", suffix: ".ndjson" });
      const fd = yield* Effect.acquireRelease(
        Effect.sync(() => NodeFS.openSync(filePath, "r")),
        (fd) => Effect.sync(() => NodeFS.closeSync(fd)),
      );
      const fdPath = `/proc/self/fd/${fd}`;

      openSyncInterceptor.failPath = fdPath;
      openSyncInterceptor.errorCode = "EIO";
      try {
        const error = yield* readBootstrapEnvelope(TestEnvelopeSchema, fd, {
          timeoutMs: 100,
        }).pipe(Effect.provideService(HostProcessPlatform, "linux"), Effect.flip);

        assert.instanceOf(error, BootstrapInputStreamOpenError);
        assert.equal(error.fd, fd);
        assert.equal(error.platform, "linux");
        assert.equal(error.fdPath, fdPath);
        assert.equal((error.cause as NodeJS.ErrnoException).code, "EIO");
        assert.equal(
          error.message,
          `Failed to open bootstrap input stream for file descriptor ${fd} via '${fdPath}' on 'linux'.`,
        );
      } finally {
        openSyncInterceptor.failPath = null;
        openSyncInterceptor.errorCode = "ENXIO";
      }
    }),
  );

  it.effect("returns none when the fd is unavailable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const filePath = yield* fs.makeTempFileScoped({ prefix: "t3-bootstrap-" });
      const fd = NodeFS.openSync(filePath, "r");
      NodeFS.closeSync(fd);

      const payload = yield* readBootstrapEnvelope(TestEnvelopeSchema, fd, { timeoutMs: 100 });
      assertNone(payload);
    }),
  );

  it.effect("preserves fd and cause when stat fails for a non-availability reason", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const filePath = yield* fs.makeTempFileScoped({ prefix: "t3-bootstrap-" });
      const fd = yield* Effect.acquireRelease(
        Effect.sync(() => NodeFS.openSync(filePath, "r")),
        (fd) => Effect.sync(() => NodeFS.closeSync(fd)),
      );

      fstatSyncInterceptor.failFd = fd;
      try {
        const error = yield* readBootstrapEnvelope(TestEnvelopeSchema, fd, {
          timeoutMs: 100,
        }).pipe(Effect.flip);

        assert.instanceOf(error, BootstrapFdStatError);
        assert.equal(error.fd, fd);
        assert.equal((error.cause as NodeJS.ErrnoException).code, "EACCES");
        assert.equal(error.message, `Failed to stat bootstrap file descriptor ${fd}.`);
      } finally {
        fstatSyncInterceptor.failFd = null;
      }
    }),
  );

  it.effect("preserves fd and schema cause when decoding the envelope fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const filePath = yield* fs.makeTempFileScoped({ prefix: "t3-bootstrap-", suffix: ".ndjson" });
      yield* fs.writeFileString(filePath, '{"mode":42}\n');

      const fd = yield* openEnvelopeFile(filePath);
      const error = yield* readBootstrapEnvelope(TestEnvelopeSchema, fd, {
        timeoutMs: 100,
      }).pipe(Effect.flip);

      assert.instanceOf(error, BootstrapEnvelopeDecodeError);
      assert.equal(error.fd, fd);
      assert.isDefined(error.cause);
      assert.equal(
        error.message,
        `Failed to decode bootstrap envelope from file descriptor ${fd}.`,
      );
    }),
  );

  it.effect("returns none when the bootstrap read times out before any value arrives", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const filePath = yield* fs.makeTempFileScoped({ prefix: "t3-bootstrap-" });
      const fd = yield* Effect.acquireRelease(
        Effect.sync(() => NodeFS.openSync(filePath, "r")),
        (fd) => Effect.sync(() => NodeFS.closeSync(fd)),
      );
      inputInterceptor.fd = fd;
      inputInterceptor.stream = new NodeStream.PassThrough();
      try {
        const fiber = yield* readBootstrapEnvelope(TestEnvelopeSchema, fd, {
          timeoutMs: 100,
        }).pipe(Effect.provideService(HostProcessPlatform, "win32"), Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.millis(100));
        assertNone(yield* Fiber.join(fiber));
      } finally {
        inputInterceptor.fd = null;
        inputInterceptor.stream = null;
      }
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("allows a required bootstrap to arrive after the old one-second budget", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const filePath = yield* fs.makeTempFileScoped({ prefix: "t3-bootstrap-" });
      const fd = yield* Effect.acquireRelease(
        Effect.sync(() => NodeFS.openSync(filePath, "r")),
        (fd) => Effect.sync(() => NodeFS.closeSync(fd)),
      );
      const stream = new NodeStream.PassThrough();
      inputInterceptor.fd = fd;
      inputInterceptor.stream = stream;
      try {
        const fiber = yield* readRequiredBootstrapEnvelope(TestEnvelopeSchema, fd).pipe(
          Effect.provideService(HostProcessPlatform, "win32"),
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.seconds(2));
        stream.end('{"mode":"desktop"}\n');
        assert.deepEqual(yield* Fiber.join(fiber), { mode: "desktop" });
      } finally {
        inputInterceptor.fd = null;
        inputInterceptor.stream = null;
      }
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("fails a required bootstrap when the input closes without an envelope", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const filePath = yield* fs.makeTempFileScoped({ prefix: "t3-bootstrap-" });
      const fd = yield* openEnvelopeFile(filePath);
      const error = yield* readRequiredBootstrapEnvelope(TestEnvelopeSchema, fd).pipe(Effect.flip);
      assert.instanceOf(error, BootstrapEnvelopeMissingError);
      assert.equal(error.fd, fd);
    }),
  );
});
