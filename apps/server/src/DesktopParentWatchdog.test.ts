import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as DesktopParentWatchdog from "./DesktopParentWatchdog.ts";

const makeScopedServer = (finalized: Deferred.Deferred<void>) =>
  Effect.acquireRelease(Effect.void, () =>
    Deferred.succeed(finalized, undefined).pipe(Effect.asVoid),
  ).pipe(Effect.andThen(Effect.never), Effect.scoped);

describe("DesktopParentWatchdog", () => {
  it("treats the direct parent relationship as authoritative", () => {
    let reachabilityChecks = 0;
    const alive = DesktopParentWatchdog.isDesktopParentAlive(42, {
      readParentPid: () => 7,
      isProcessReachable: () => {
        reachabilityChecks += 1;
        return true;
      },
    });

    assert.isFalse(alive);
    assert.equal(reachabilityChecks, 0);
  });

  it.effect("finalizes the server scope when the Linux desktop parent exits", () =>
    Effect.gen(function* () {
      let parentPid = 42;
      const finalized = yield* Deferred.make<void>();
      const fiber = yield* DesktopParentWatchdog.supervise(makeScopedServer(finalized), 42, {
        pollInterval: "100 millis",
        readParentPid: () => parentPid,
        isProcessReachable: () => true,
      }).pipe(Effect.provideService(HostProcessPlatform, "linux"), Effect.forkChild);

      yield* Effect.yieldNow;
      assert.isFalse(yield* Deferred.isDone(finalized));

      parentPid = 1;
      yield* TestClock.adjust("100 millis");
      yield* Fiber.join(fiber);

      assert.isTrue(yield* Deferred.isDone(finalized));
    }),
  );

  it.effect("leaves servers without a desktop parent PID under their existing lifetime", () =>
    Effect.gen(function* () {
      let reachabilityChecks = 0;
      const finalized = yield* Deferred.make<void>();
      const fiber = yield* DesktopParentWatchdog.supervise(makeScopedServer(finalized), undefined, {
        pollInterval: "100 millis",
        readParentPid: () => 42,
        isProcessReachable: () => {
          reachabilityChecks += 1;
          return false;
        },
      }).pipe(Effect.provideService(HostProcessPlatform, "linux"), Effect.forkChild);

      yield* Effect.yieldNow;
      yield* TestClock.adjust("1 second");

      assert.equal(reachabilityChecks, 0);
      assert.isFalse(yield* Deferred.isDone(finalized));

      yield* Fiber.interrupt(fiber);
      assert.isTrue(yield* Deferred.isDone(finalized));
    }),
  );
});
