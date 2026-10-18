import { ConnectionTransientError } from "@t3tools/client-runtime/connection";
import { ConnectionCatalogDocument } from "@t3tools/client-runtime/platform";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { afterEach, vi } from "vite-plus/test";

import { makeCatalogBackend, makeCatalogStore, openDatabase } from "./storage";

const emptyCatalog = {
  schemaVersion: 1,
  targets: [],
  profiles: [],
  credentials: [],
  remoteDpopTokens: [],
} as const;
const decodeCatalog = Schema.decodeUnknownSync(Schema.fromJsonString(ConnectionCatalogDocument));

function makeDatabaseOpenHarness() {
  const clearThreadStore = vi.fn();
  const close = vi.fn();
  const database = Object.assign(new EventTarget(), {
    close,
    objectStoreNames: {
      contains: vi.fn(() => true),
    },
    createObjectStore: vi.fn(),
  }) as unknown as IDBDatabase;
  const transaction = {
    objectStore: vi.fn(() => ({ clear: clearThreadStore })),
  } as unknown as IDBTransaction;
  const request = Object.assign(new EventTarget(), {
    error: null,
    result: database,
    transaction,
  }) as unknown as IDBOpenDBRequest;
  const open = vi.fn(() => request);
  vi.stubGlobal("indexedDB", { open });
  return { clearThreadStore, close, database, open, request };
}

function versionChangeEvent(oldVersion: number): IDBVersionChangeEvent {
  const event = new Event("upgradeneeded");
  Object.defineProperty(event, "oldVersion", { value: oldVersion });
  return event as IDBVersionChangeEvent;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("makeCatalogStore", () => {
  it.effect("quarantines malformed catalogs and starts from an empty document", () =>
    Effect.gen(function* () {
      const writes: string[] = [];
      const quarantined: string[] = [];
      const store = yield* makeCatalogStore({
        read: Effect.succeed("{not-json"),
        write: (raw) => Effect.sync(() => writes.push(raw)),
        quarantine: (raw) => Effect.sync(() => quarantined.push(raw)),
      });

      expect(yield* store.read).toEqual(emptyCatalog);
      expect(quarantined).toEqual(["{not-json"]);
      expect(writes).toHaveLength(1);
      expect(decodeCatalog(writes[0]!)).toEqual(emptyCatalog);
    }),
  );

  it.effect("does not hide catalog read failures", () =>
    Effect.gen(function* () {
      const failure = new ConnectionTransientError({
        reason: "remote-unavailable",
        detail: "permission denied",
      });
      const store = yield* makeCatalogStore({
        read: Effect.fail(failure),
        write: () => Effect.void,
      });

      expect(yield* Effect.flip(store.read)).toBe(failure);
    }),
  );
});

describe("makeCatalogBackend", () => {
  it.effect("fails writes when desktop secure storage declines the catalog", () =>
    Effect.gen(function* () {
      const setConnectionCatalog = vi.fn().mockResolvedValue(false);
      vi.stubGlobal("window", {
        desktopBridge: {
          getConnectionCatalog: vi.fn().mockResolvedValue(null),
          setConnectionCatalog,
        },
      });
      const backend = makeCatalogBackend({} as IDBDatabase);

      const error = yield* backend.write("{}").pipe(Effect.flip);

      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error.message).toContain("Desktop secure storage is unavailable");
      expect(setConnectionCatalog).toHaveBeenCalledWith("{}");
    }),
  );
});

describe("openDatabase", () => {
  it.effect("clears legacy thread snapshots during the version 5 upgrade", () =>
    Effect.gen(function* () {
      const harness = makeDatabaseOpenHarness();
      const fiber = yield* Effect.forkChild(openDatabase());
      yield* Effect.yieldNow;

      yield* Effect.sync(() => {
        harness.request.dispatchEvent(versionChangeEvent(4));
        harness.request.dispatchEvent(new Event("success"));
      });
      expect(yield* Fiber.join(fiber)).toBe(harness.database);
      expect(harness.clearThreadStore).toHaveBeenCalledOnce();
    }),
  );

  it.effect("fails a blocked upgrade clearly and closes a late database handle", () =>
    Effect.gen(function* () {
      const harness = makeDatabaseOpenHarness();
      const fiber = yield* Effect.forkChild(openDatabase());
      yield* Effect.yieldNow;

      yield* Effect.sync(() => harness.request.dispatchEvent(new Event("blocked")));
      const error = yield* Fiber.join(fiber).pipe(Effect.flip);
      expect(error.message).toContain("Another Erebus window");

      yield* Effect.sync(() => harness.request.dispatchEvent(new Event("success")));
      expect(harness.close).toHaveBeenCalledOnce();
    }),
  );

  it.effect("times out an IndexedDB open that emits no terminal event", () =>
    Effect.gen(function* () {
      makeDatabaseOpenHarness();
      const fiber = yield* Effect.forkChild(openDatabase());
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 seconds");

      const error = yield* Fiber.join(fiber).pipe(Effect.flip);
      expect(error.message).toContain("Timed out while opening the local cache");
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
