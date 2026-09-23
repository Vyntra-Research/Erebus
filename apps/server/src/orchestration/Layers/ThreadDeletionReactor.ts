import type { OrchestrationEvent, ThreadId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { CoagentRegistry } from "../../coagents/Services/CoagentRegistry.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ThreadDeletionReactor,
  type ThreadDeletionReactorShape,
} from "../Services/ThreadDeletionReactor.ts";
import { forkParked } from "../../serverActivation.ts";

type ThreadDeletedEvent = Extract<OrchestrationEvent, { type: "thread.deleted" }>;

export const logCleanupCauseUnlessInterrupted = <R, E>({
  effect,
  message,
  threadId,
}: {
  readonly effect: Effect.Effect<void, E, R>;
  readonly message: string;
  readonly threadId: ThreadDeletedEvent["payload"]["threadId"];
}): Effect.Effect<void, E, R> =>
  effect.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.failCause(cause);
      }
      return Effect.logDebug(message, {
        threadId,
        cause: Cause.pretty(cause),
      });
    }),
  );

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const coagents = yield* CoagentRegistry;
  const terminalManager = yield* TerminalManager.TerminalManager;

  const stopProviderSession = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    logCleanupCauseUnlessInterrupted({
      effect: providerService.stopSession({ threadId }),
      message: "thread deletion cleanup skipped provider session stop",
      threadId,
    });

  const closeThreadTerminals = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    logCleanupCauseUnlessInterrupted({
      effect: terminalManager.close({ threadId, deleteHistory: true }),
      message: "thread deletion cleanup skipped terminal close",
      threadId,
    });

  const processThreadDeleted = Effect.fn("processThreadDeleted")(function* (threadId: ThreadId) {
    const coagent = yield* coagents.getByChild(threadId);
    const pending = Option.isSome(coagent)
      ? yield* coagents.isDeletedPendingHistoryCleanup(threadId)
      : false;
    if (!pending) {
      yield* stopProviderSession(threadId);
      yield* closeThreadTerminals(threadId);
      return;
    }
    yield* Effect.gen(function* () {
      const deleted = yield* providerService.deletePersistedThreadHistory(threadId);
      if (!deleted) {
        yield* Effect.logWarning("co-agent provider does not support permanent history deletion", {
          threadId,
        });
        return;
      }
      yield* coagents.markProviderHistoryDeleted(threadId, DateTime.formatIso(yield* DateTime.now));
    }).pipe(Effect.ensuring(Effect.ignore(closeThreadTerminals(threadId))));
  });

  const processThreadDeletedSafely = (threadId: ThreadId) =>
    processThreadDeleted(threadId).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("thread deletion reactor failed to process event", {
          threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processThreadDeletedSafely);

  const start: ThreadDeletionReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "thread.deleted") {
          return Effect.void;
        }
        return worker.enqueue(event.payload.threadId);
      }),
    );
    const pending = yield* coagents.listDeletedPendingHistoryCleanup().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("could not list deleted co-agents awaiting provider cleanup", {
          cause: Cause.pretty(cause),
        }).pipe(Effect.as([] as ReadonlyArray<ThreadId>)),
      ),
    );
    yield* Effect.forEach(pending, worker.enqueue, { discard: true });
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ThreadDeletionReactorShape;
});

export const ThreadDeletionReactorLive = Layer.effect(ThreadDeletionReactor, make);
