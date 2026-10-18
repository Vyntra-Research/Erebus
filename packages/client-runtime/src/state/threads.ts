import {
  ORCHESTRATION_WS_METHODS,
  type EnvironmentId as EnvironmentIdType,
  type OrchestrationThread,
  type OrchestrationThreadDetailPage,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadStreamItem,
  type ThreadId as ThreadIdType,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom } from "effect/unstable/reactivity";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { connectionProjectionPhase, type PreparedConnection } from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import { subscribeDynamic } from "../rpc/client.ts";
import { ThreadSnapshotLoader, type ThreadSnapshotWindow } from "./threadSnapshotHttp.ts";
import { parseThreadKey, threadKey } from "./entities.ts";
import { applyThreadDetailEvent } from "./threadReducer.ts";
import { THREAD_STATE_IDLE_TTL_MS } from "./threadRetention.ts";
import { followStreamInEnvironment } from "./runtime.ts";
import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadPageState,
  type EnvironmentThreadState,
  type EnvironmentThreadStatus,
} from "./threadState.ts";

type ThreadEventStreamItem = Extract<OrchestrationThreadStreamItem, { readonly kind: "event" }>;

function statusWithoutLiveData(data: Option.Option<OrchestrationThread>): EnvironmentThreadStatus {
  return Option.isSome(data) ? "cached" : "empty";
}

/**
 * Turn window sizes for paginated thread loads: the initial page covers the
 * last 10 user-anchored turns (subagent/fan-out turns ride along), each
 * "load earlier" tap fetches 20 more. Sized so first paint on the heaviest
 * observed threads stays around 100K gzipped while median threads load fully.
 */
export const INITIAL_THREAD_USER_TURN_LIMIT = 10;
export const OLDER_THREAD_PAGE_USER_TURN_LIMIT = 20;

// The server caps one recent detail page at 500 activities and 200 rows for
// each other timeline collection. A running turn may outgrow those limits via
// live events, so refresh only after 50% headroom has been consumed. After a
// failed refresh, the per-collection thresholds advance by the same headroom;
// this avoids an HTTP read on every following event while the projection is
// catching up.
const ACTIVE_WINDOW_ACTIVITY_HIGH_WATER = 750;
const ACTIVE_WINDOW_ROW_HIGH_WATER = 300;
const ACTIVE_WINDOW_ACTIVITY_HYSTERESIS = 250;
const ACTIVE_WINDOW_ROW_HYSTERESIS = 100;

interface ActiveWindowRefreshThresholds {
  readonly activities: number;
  readonly messages: number;
  readonly proposedPlans: number;
  readonly checkpoints: number;
}

const INITIAL_ACTIVE_WINDOW_REFRESH_THRESHOLDS: ActiveWindowRefreshThresholds = {
  activities: ACTIVE_WINDOW_ACTIVITY_HIGH_WATER,
  messages: ACTIVE_WINDOW_ROW_HIGH_WATER,
  proposedPlans: ACTIVE_WINDOW_ROW_HIGH_WATER,
  checkpoints: ACTIVE_WINDOW_ROW_HIGH_WATER,
};

function activeWindowRefreshThresholdsAfter(
  thread: OrchestrationThread,
): ActiveWindowRefreshThresholds {
  return {
    activities: Math.max(
      ACTIVE_WINDOW_ACTIVITY_HIGH_WATER,
      thread.activities.length + ACTIVE_WINDOW_ACTIVITY_HYSTERESIS,
    ),
    messages: Math.max(
      ACTIVE_WINDOW_ROW_HIGH_WATER,
      thread.messages.length + ACTIVE_WINDOW_ROW_HYSTERESIS,
    ),
    proposedPlans: Math.max(
      ACTIVE_WINDOW_ROW_HIGH_WATER,
      thread.proposedPlans.length + ACTIVE_WINDOW_ROW_HYSTERESIS,
    ),
    checkpoints: Math.max(
      ACTIVE_WINDOW_ROW_HIGH_WATER,
      thread.checkpoints.length + ACTIVE_WINDOW_ROW_HYSTERESIS,
    ),
  };
}

function exceedsActiveWindowRefreshThreshold(
  thread: OrchestrationThread,
  thresholds: ActiveWindowRefreshThresholds,
): boolean {
  return (
    thread.activities.length > thresholds.activities ||
    thread.messages.length > thresholds.messages ||
    thread.proposedPlans.length > thresholds.proposedPlans ||
    thread.checkpoints.length > thresholds.checkpoints
  );
}

function pageStateFromSnapshot(
  page: OrchestrationThreadDetailPage | undefined,
): Option.Option<EnvironmentThreadPageState> {
  return page === undefined
    ? Option.none()
    : Option.some({
        beforeCursor: page.beforeCursor,
        hasMore: page.hasMore,
        loadingOlder: false,
      });
}

interface ThreadOlderTurnRequestRegistry {
  /**
   * Registers the live state machine for a thread. Returns the deregistration
   * cleanup; registration lives exactly as long as the machine's scope, and a
   * successor machine for the same thread simply replaces the entry.
   */
  readonly register: (key: string, handler: () => boolean) => () => void;
  readonly request: (key: string) => boolean;
}

function makeThreadOlderTurnRequestRegistry(): ThreadOlderTurnRequestRegistry {
  const handlers = new Map<string, () => boolean>();
  return {
    register: (key, handler) => {
      handlers.set(key, handler);
      return () => {
        if (handlers.get(key) === handler) {
          handlers.delete(key);
        }
      };
    },
    request: (key) => {
      const handler = handlers.get(key);
      if (handler === undefined) {
        return false;
      }
      return handler();
    },
  };
}

const defaultOlderTurnRequestRegistry = makeThreadOlderTurnRequestRegistry();

/**
 * Channel from UI actions to the live per-thread state machines. The machines
 * resolve it from the Effect environment (overridable in tests); the default
 * instance is shared with the sync `requestOlderThreadTurns` entry point so
 * the apps get working wiring without providing anything.
 */
export class ThreadOlderTurnRequests extends Context.Reference<ThreadOlderTurnRequestRegistry>(
  "@t3tools/client-runtime/state/threads/ThreadOlderTurnRequests",
  { defaultValue: () => defaultOlderTurnRequestRegistry },
) {}

/**
 * Asks the live state machine for `threadId` to fetch the next older page.
 * Returns false when no machine is live or the connected server has not
 * advertised pagination. Callers use `EnvironmentThreadState.page` to decide
 * whether another page is currently available.
 */
export function requestOlderThreadTurns(
  environmentId: EnvironmentIdType,
  threadId: ThreadIdType,
): boolean {
  return defaultOlderTurnRequestRegistry.request(threadKey({ environmentId, threadId }));
}

function formatThreadError(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Could not synchronize the thread.";
}

function shouldPersistThread(thread: OrchestrationThread): boolean {
  const status = thread.session?.status;
  return status !== "starting" && status !== "running";
}

export const makeEnvironmentThreadState = Effect.fn("EnvironmentThreadState.make")(function* (
  threadId: ThreadIdType,
) {
  const supervisor = yield* EnvironmentSupervisor;
  const cache = yield* EnvironmentCacheStore;
  const snapshotLoader = yield* ThreadSnapshotLoader;
  const wakeups = yield* Effect.serviceOption(ConnectionWakeups.ConnectionWakeups);
  const environmentId = supervisor.target.environmentId;
  const cached = yield* cache.loadThread(environmentId, threadId).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not load cached thread.").pipe(
        Effect.annotateLogs({
          environmentId,
          threadId,
          error: error.message,
        }),
        Effect.as(Option.none<OrchestrationThreadDetailSnapshot>()),
      ),
    ),
  );
  const cachedThread = Option.map(cached, (snapshot) => snapshot.thread);
  const state = yield* SubscriptionRef.make<EnvironmentThreadState>({
    data: cachedThread,
    status: statusWithoutLiveData(cachedThread),
    error: Option.none(),
    // A cached windowed snapshot restores its page cursor so "load earlier"
    // works while rendering from cache; a cached full snapshot has no page.
    page: Option.flatMap(cached, (snapshot) => pageStateFromSnapshot(snapshot.page)),
  });
  // Seed the resume cursor from the cached snapshot so a warm cache can catch up
  // via `afterSequence` instead of re-downloading the full thread body.
  const lastSequence = yield* SubscriptionRef.make(
    Option.match(cached, { onNone: () => 0, onSome: (snapshot) => snapshot.snapshotSequence }),
  );
  const awaitingCompletion = yield* Ref.make(false);
  // Bumped whenever loaded history may have been rewritten out from under an
  // in-flight older-page fetch (snapshot replacement, revert, deletion). A
  // page response captured under an older epoch is discarded, not merged.
  const historyEpoch = yield* Ref.make(0);
  // Serializes stream-item application against older-page staleness checks +
  // merges. Without it, a revert or snapshot processed between loadOlderTurns'
  // epoch check and its merge could still slip resurrected history in.
  const applyLock = yield* Semaphore.make(1);
  // Whether the connected server accepts windowed reads; set per subscription
  // from the session config. Gates loadOlderTurns so a reconnect to a
  // pre-pagination server never sends unsupported window parameters.
  const paginationSupported = yield* Ref.make(false);
  // The UI request entry point is synchronous. Mirror only the negotiated
  // capability here so it can reject unsupported requests without enqueuing
  // work that is guaranteed to no-op. The Effect Ref remains authoritative
  // inside the state machine.
  let paginationRequestsEnabled = false;
  // Sticky across disconnects so teardown never mistakes an expanded window
  // for a legacy full snapshot and writes it to cache. A later connected
  // session explicitly resets this when it advertises no pagination support.
  const windowedCacheMode = yield* Ref.make(
    Option.match(cached, {
      onNone: () => false,
      onSome: (snapshot) => snapshot.page !== undefined,
    }),
  );
  // The UI model may grow when older pages are loaded. Keep a separate copy
  // of only the server's recent window and apply live events to it so cache
  // resumes advance without ever serializing user-expanded history.
  const recentWindowSnapshot = yield* Ref.make(
    Option.filter(cached, (snapshot) => snapshot.page !== undefined),
  );
  // A long active turn can append more rows than a server page permits. Once
  // it settles, replace the cache shadow with a fresh bounded server page
  // before persisting it. While this is true, the live shadow is never saved.
  const recentWindowRequiresRefresh = yield* Ref.make(false);
  const activeWindowRefreshThresholds = yield* Ref.make(INITIAL_ACTIVE_WINDOW_REFRESH_THRESHOLDS);
  // An older page whose thread watermark is ahead of the live state, parked
  // until the subscription catches up (see mergeOlderPage's caller). At most
  // one can exist because loadOlderTurns no-ops while loadingOlder is true.
  const pendingOlderPage = yield* Ref.make<{
    readonly snapshot: OrchestrationThreadDetailSnapshot;
    readonly epoch: number;
  } | null>(null);
  const persistence = yield* Queue.sliding<OrchestrationThreadDetailSnapshot>(1);

  const persist = Effect.fn("EnvironmentThreadState.persist")(function* (
    snapshot: OrchestrationThreadDetailSnapshot,
  ) {
    yield* cache.saveThread(environmentId, snapshot).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not persist the thread cache.").pipe(
          Effect.annotateLogs({
            environmentId,
            threadId,
            error: error.message,
          }),
        ),
      ),
    );
  });

  yield* Stream.fromQueue(persistence).pipe(
    Stream.debounce("500 millis"),
    Stream.runForEach(persist),
    Effect.forkScoped,
  );

  const setSynchronizing = SubscriptionRef.update(state, (current) =>
    current.status === "deleted"
      ? current
      : {
          ...current,
          status: "synchronizing" as const,
          error: Option.none(),
        },
  );
  const setReady = SubscriptionRef.update(state, (current) =>
    current.status === "live" || current.status === "deleted"
      ? current
      : {
          ...current,
          status: "synchronizing" as const,
          error: Option.none(),
        },
  );
  const invalidateOlderPageReads = Effect.fn("EnvironmentThreadState.invalidateOlderPageReads")(
    function* () {
      yield* Ref.update(historyEpoch, (epoch) => epoch + 1);
      yield* Ref.set(pendingOlderPage, null);
      yield* SubscriptionRef.update(state, (current) => ({
        ...current,
        page: Option.map(current.page, (page) => ({ ...page, loadingOlder: false })),
      }));
    },
  );
  const setDisconnected = applyLock.withPermits(1)(
    Effect.gen(function* () {
      yield* Ref.set(awaitingCompletion, false);
      // The capability belongs to the session that advertised it. During a
      // reconnect, a new prepared connection can exist before the new session's
      // config arrives; leaving the old value would let loadOlderTurns send
      // window parameters to a server that may not accept them. Invalidate any
      // page read that was issued through the old session at the same boundary.
      paginationRequestsEnabled = false;
      yield* Ref.set(paginationSupported, false);
      yield* invalidateOlderPageReads();
      yield* SubscriptionRef.update(state, (current) => ({
        ...current,
        status: current.status === "deleted" ? current.status : statusWithoutLiveData(current.data),
      }));
    }),
  );
  const setStreamError = (cause: Cause.Cause<unknown>) =>
    Ref.set(awaitingCompletion, false).pipe(
      Effect.andThen(
        SubscriptionRef.update(state, (current) => ({
          ...current,
          status:
            current.status === "deleted" ? current.status : statusWithoutLiveData(current.data),
          error: Option.some(formatThreadError(cause)),
        })),
      ),
    );

  const setThread = Effect.fn("EnvironmentThreadState.setThread")(function* (
    thread: OrchestrationThread,
    // "keep" preserves the current page state (live events touch only loaded
    // recent turns); a snapshot or merged page passes its own page state.
    page: Option.Option<EnvironmentThreadPageState> | "keep",
  ) {
    const waiting = yield* Ref.get(awaitingCompletion);
    yield* SubscriptionRef.update(state, (current) => ({
      data: Option.some(thread),
      status: waiting ? ("synchronizing" as const) : ("live" as const),
      error: Option.none(),
      page: page === "keep" ? current.page : page,
    }));
    // Legacy servers expose only full snapshots, so retain the old cache
    // behavior for them. Pagination-capable servers persist only exact recent
    // snapshots below: persisting this mutable display model after older pages
    // have been merged would make the next open decode the full history.
    if (shouldPersistThread(thread) && !(yield* Ref.get(windowedCacheMode))) {
      const snapshotSequence = yield* SubscriptionRef.get(lastSequence);
      const currentPage = yield* SubscriptionRef.get(state).pipe(Effect.map((value) => value.page));
      yield* Queue.offer(persistence, {
        snapshotSequence,
        thread,
        // Persist the window boundary with the window's content so a cache
        // restore can keep paging from where the loaded history ends.
        ...Option.match(currentPage, {
          onNone: () => ({}),
          onSome: (value) =>
            ({
              page: {
                beforeCursor: value.beforeCursor,
                hasMore: value.hasMore,
                snapshotSequence,
              },
            }) as const,
        }),
      });
    }
  });

  const setDeleted = Effect.fn("EnvironmentThreadState.setDeleted")(function* () {
    yield* Ref.set(awaitingCompletion, false);
    yield* Ref.update(historyEpoch, (epoch) => epoch + 1);
    yield* Ref.set(recentWindowSnapshot, Option.none());
    yield* Ref.set(recentWindowRequiresRefresh, false);
    yield* SubscriptionRef.set(state, {
      data: Option.none(),
      status: "deleted",
      error: Option.none(),
      page: Option.none(),
    });
    yield* cache.removeThread(environmentId, threadId).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not remove the cached thread.").pipe(
          Effect.annotateLogs({
            environmentId,
            threadId,
            error: error.message,
          }),
        ),
      ),
    );
  });

  const loadBoundedRecentSnapshot = Effect.fn("EnvironmentThreadState.loadBoundedRecentSnapshot")(
    function* (minimumSequence: number) {
      const prepared = Option.getOrUndefined(yield* SubscriptionRef.get(supervisor.prepared));
      if (!prepared) {
        return Option.none<OrchestrationThreadDetailSnapshot>();
      }
      return Option.filter(
        yield* snapshotLoader.load(prepared, threadId, {
          turnLimit: INITIAL_THREAD_USER_TURN_LIMIT,
        }),
        (snapshot) =>
          snapshot.page !== undefined &&
          (snapshot.page.threadSequence ?? snapshot.snapshotSequence) >= minimumSequence,
      );
    },
  );

  const refreshOversizedActiveWindow = Effect.fn(
    "EnvironmentThreadState.refreshOversizedActiveWindow",
  )(function* (thread: OrchestrationThread, minimumSequence: number) {
    if (shouldPersistThread(thread) || !(yield* Ref.get(windowedCacheMode))) {
      return false;
    }
    const thresholds = yield* Ref.get(activeWindowRefreshThresholds);
    if (!exceedsActiveWindowRefreshThreshold(thread, thresholds)) {
      return false;
    }

    // Advance before the read. If the projection has not caught up yet, a
    // later event retries only after another bounded amount of growth.
    yield* Ref.set(activeWindowRefreshThresholds, activeWindowRefreshThresholdsAfter(thread));
    const refreshed = yield* loadBoundedRecentSnapshot(minimumSequence);
    if (Option.isNone(refreshed)) {
      return false;
    }

    const snapshot = refreshed.value;
    const watermark = snapshot.page?.threadSequence ?? snapshot.snapshotSequence;
    // This is an authoritative replacement, not an older-page merge. Drop any
    // expanded display rows and invalidate a page read that began against the
    // old window. The returned cursor can page those rows back on demand.
    yield* Ref.update(historyEpoch, (epoch) => epoch + 1);
    yield* Ref.set(pendingOlderPage, null);
    yield* SubscriptionRef.set(lastSequence, watermark);
    yield* Ref.set(recentWindowSnapshot, Option.some(snapshot));
    yield* Ref.set(recentWindowRequiresRefresh, false);
    yield* Ref.set(
      activeWindowRefreshThresholds,
      activeWindowRefreshThresholdsAfter(snapshot.thread),
    );
    yield* setThread(snapshot.thread, pageStateFromSnapshot(snapshot.page));
    if (shouldPersistThread(snapshot.thread)) {
      yield* Queue.offer(persistence, snapshot);
    }
    return true;
  });

  const updateRecentWindowCache = Effect.fn("EnvironmentThreadState.updateRecentWindowCache")(
    function* (item: ThreadEventStreamItem) {
      const current = yield* Ref.get(recentWindowSnapshot);
      if (Option.isNone(current) || current.value.page === undefined) {
        return;
      }
      // A bounded refresh can observe projection events slightly ahead of the
      // WebSocket. Do not replay those events into its already-current body.
      if (
        item.event.sequence <= (current.value.page.threadSequence ?? current.value.snapshotSequence)
      ) {
        return;
      }
      const result = applyThreadDetailEvent(current.value.thread, item.event);
      if (result.kind === "deleted") {
        yield* Ref.set(recentWindowSnapshot, Option.none());
        return;
      }
      const thread = result.kind === "updated" ? result.thread : current.value.thread;
      const becamePersistable =
        !shouldPersistThread(current.value.thread) && shouldPersistThread(thread);
      const snapshot: OrchestrationThreadDetailSnapshot = {
        ...current.value,
        snapshotSequence: item.event.sequence,
        thread,
        page: {
          ...current.value.page,
          snapshotSequence: item.event.sequence,
          threadSequence: item.event.sequence,
        },
      };
      yield* Ref.set(recentWindowSnapshot, Option.some(snapshot));
      const requiresRefresh = becamePersistable || (yield* Ref.get(recentWindowRequiresRefresh));
      if (requiresRefresh) {
        yield* Ref.set(recentWindowRequiresRefresh, true);
        const refreshed = yield* loadBoundedRecentSnapshot(item.event.sequence);
        if (Option.isSome(refreshed)) {
          yield* Ref.set(recentWindowSnapshot, refreshed);
          const persistable = shouldPersistThread(refreshed.value.thread);
          yield* Ref.set(recentWindowRequiresRefresh, !persistable);
          if (persistable) {
            yield* Queue.offer(persistence, refreshed.value);
          }
        }
        return;
      }
      if (shouldPersistThread(thread)) {
        yield* Queue.offer(persistence, snapshot);
      }
    },
  );

  // Body of applyItem, running under applyLock.
  const applyItemLocked = Effect.fn("EnvironmentThreadState.applyItemLocked")(function* (
    item: OrchestrationThreadStreamItem,
  ) {
    if (item.kind === "synchronized") {
      yield* Ref.set(awaitingCompletion, false);
      yield* SubscriptionRef.update(state, (current) =>
        Option.isSome(current.data) && current.status !== "deleted"
          ? { ...current, status: "live" as const, error: Option.none() }
          : current,
      );
      return;
    }

    if (item.kind === "snapshot") {
      // A fresh snapshot replaces all loaded history, including older
      // pages: a turn reverted while disconnected would otherwise survive
      // in the preserved history with no event left to remove it. The
      // epoch bump discards any older-page fetch racing this snapshot.
      yield* Ref.update(historyEpoch, (epoch) => epoch + 1);
      yield* SubscriptionRef.set(lastSequence, item.snapshot.snapshotSequence);
      const isWindowed = item.snapshot.page !== undefined;
      yield* Ref.set(windowedCacheMode, isWindowed);
      yield* Ref.set(recentWindowSnapshot, isWindowed ? Option.some(item.snapshot) : Option.none());
      yield* Ref.set(recentWindowRequiresRefresh, false);
      yield* Ref.set(
        activeWindowRefreshThresholds,
        activeWindowRefreshThresholdsAfter(item.snapshot.thread),
      );
      yield* setThread(item.snapshot.thread, pageStateFromSnapshot(item.snapshot.page));
      // Keep the cache as the server's bounded recent window. Older pages are
      // merged only into the live display model and must never widen this
      // persisted snapshot.
      if (item.snapshot.page !== undefined && shouldPersistThread(item.snapshot.thread)) {
        yield* Queue.offer(persistence, item.snapshot);
      }
      return;
    }

    const sequence = yield* SubscriptionRef.get(lastSequence);
    if (item.event.sequence <= sequence) {
      return;
    }
    yield* SubscriptionRef.set(lastSequence, item.event.sequence);

    const current = yield* SubscriptionRef.get(state);
    if (Option.isNone(current.data)) {
      if (item.event.type === "thread.deleted") {
        yield* setDeleted();
      }
      return;
    }
    if (item.event.type === "thread.reverted") {
      // A revert rewrites loaded history (whole turns disappear), so an
      // older-page fetch in flight may straddle the removed range; the epoch
      // bump discards it. The stored page cursor stays valid: cursors are an
      // (anchor, turnId) keyset derived from event content, which survives
      // the revert projector's row rewrite, so no refresh is needed — the
      // revert reducer's turn filtering fully handles loaded history.
      yield* Ref.update(historyEpoch, (epoch) => epoch + 1);
    }
    const result = applyThreadDetailEvent(current.data.value, item.event);
    let refreshedActiveWindow = false;
    if (result.kind === "updated") {
      yield* setThread(result.thread, "keep");
      refreshedActiveWindow = yield* refreshOversizedActiveWindow(
        result.thread,
        item.event.sequence,
      );
    } else if (result.kind === "deleted") {
      yield* setDeleted();
    }
    if (!refreshedActiveWindow) {
      yield* updateRecentWindowCache(item);
    }
    // The event may have advanced the live state past a parked page's
    // watermark; merge it as soon as that happens.
    yield* tryMergePendingOlderPage();
  });

  // Merges a parked older page once the live state has caught up to the
  // page's thread watermark, or discards it if history was rewritten
  // (epoch advanced) while it waited. Must run under applyLock.
  const tryMergePendingOlderPage = Effect.fn("EnvironmentThreadState.tryMergePendingOlderPage")(
    function* () {
      const pending = yield* Ref.get(pendingOlderPage);
      if (pending === null) {
        return;
      }
      const epochNow = yield* Ref.get(historyEpoch);
      if (epochNow !== pending.epoch) {
        yield* Ref.set(pendingOlderPage, null);
        yield* SubscriptionRef.update(state, (value) => ({
          ...value,
          page: Option.map(value.page, (existing) => ({ ...existing, loadingOlder: false })),
        }));
        return;
      }
      const watermark = pending.snapshot.page?.threadSequence;
      const loadedSequence = yield* SubscriptionRef.get(lastSequence);
      if (watermark !== undefined && watermark > loadedSequence) {
        return;
      }
      yield* Ref.set(pendingOlderPage, null);
      yield* mergeOlderPage(pending.snapshot);
    },
  );

  const applyItem = Effect.fn("EnvironmentThreadState.applyItem")(function* (
    item: OrchestrationThreadStreamItem,
  ) {
    yield* applyLock.withPermits(1)(applyItemLocked(item));
  });

  const migrateLegacyFullCache = Effect.fn("EnvironmentThreadState.migrateLegacyFullCache")(
    function* (prepared: PreparedConnection) {
      return yield* applyLock.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* SubscriptionRef.get(state);
          if (Option.isNone(current.data) || Option.isSome(current.page)) {
            return false;
          }

          // Keep the full cached body visible while the bounded replacement
          // loads. Holding the apply lock makes the watermark check and
          // replacement atomic with respect to events from an older stream.
          const minimumSequence = yield* SubscriptionRef.get(lastSequence);
          const bounded = yield* snapshotLoader.load(prepared, threadId, {
            turnLimit: INITIAL_THREAD_USER_TURN_LIMIT,
          });
          if (
            Option.isNone(bounded) ||
            bounded.value.page === undefined ||
            bounded.value.snapshotSequence < minimumSequence
          ) {
            return false;
          }

          yield* applyItemLocked({ kind: "snapshot", snapshot: bounded.value });
          // Replacing a legacy full cache is a one-time bounded write, even
          // when the restored thread is active. Otherwise a long-running turn
          // leaves the giant legacy record in place until settlement and a
          // crash pays the decode + migration cost again.
          yield* Queue.offer(persistence, bounded.value);
          return true;
        }),
      );
    },
  );

  // Merges an older disjoint page below the currently loaded window. All four
  // windowed collections prepend; identity dedupe guards the (server-bug or
  // cursor-misuse) case of overlapping pages so a row never renders twice.
  const mergeOlderPage = Effect.fn("EnvironmentThreadState.mergeOlderPage")(function* (
    snapshot: OrchestrationThreadDetailSnapshot,
  ) {
    // The merge is built inside the update callback so it composes with
    // whatever thread value is current at commit time. The applyLock already
    // serializes this against event application; the atomic build is defense
    // in depth against future callers outside the lock.
    let merged: OrchestrationThread | null = null;
    yield* SubscriptionRef.update(state, (value) => {
      if (Option.isNone(value.data)) {
        return value;
      }
      const loaded = value.data.value;
      const older = snapshot.thread;
      const mergeById = <T extends { readonly id: string }>(
        olderRows: ReadonlyArray<T>,
        loadedRows: ReadonlyArray<T>,
      ): ReadonlyArray<T> => {
        const seen = new Set(loadedRows.map((row) => row.id));
        return [...olderRows.filter((row) => !seen.has(row.id)), ...loadedRows];
      };
      const seenCheckpoints = new Set(loaded.checkpoints.map((row) => row.turnId));
      merged = {
        // Thread metadata stays the loaded (newer) snapshot's; only the
        // windowed collections gain rows from the older page.
        ...loaded,
        messages: mergeById(older.messages, loaded.messages),
        activities: mergeById(older.activities, loaded.activities),
        proposedPlans: mergeById(older.proposedPlans, loaded.proposedPlans),
        checkpoints: [
          ...older.checkpoints.filter((row) => !seenCheckpoints.has(row.turnId)),
          ...loaded.checkpoints,
        ],
      };
      return {
        ...value,
        data: Option.some(merged),
        page: pageStateFromSnapshot(snapshot.page),
      };
    });
  });

  const loadOlderTurns = Effect.fn("EnvironmentThreadState.loadOlderTurns")(function* () {
    // Capture the cursor, history generation, and live watermark atomically
    // with the loading flag. A snapshot/revert/session replacement cannot then
    // slip between those reads and make a request look newer than it is.
    const request = yield* applyLock.withPermits(1)(
      Effect.gen(function* () {
        // Gated on the connected server's capability: a reconnect to a
        // pre-pagination server must never receive window parameters.
        if (!(yield* Ref.get(paginationSupported))) {
          return null;
        }
        const current = yield* SubscriptionRef.get(state);
        const page = Option.getOrNull(current.page);
        if (page === null || page.loadingOlder || !page.hasMore || page.beforeCursor === null) {
          return null;
        }
        const prepared = Option.getOrNull(yield* SubscriptionRef.get(supervisor.prepared));
        if (prepared === null) {
          return null;
        }
        const epochAtStart = yield* Ref.get(historyEpoch);
        const sequenceAtStart = yield* SubscriptionRef.get(lastSequence);
        yield* SubscriptionRef.update(state, (value) => ({
          ...value,
          page: Option.map(value.page, (existing) => ({ ...existing, loadingOlder: true })),
        }));
        return {
          prepared,
          epochAtStart,
          sequenceAtStart,
          window: {
            turnLimit: OLDER_THREAD_PAGE_USER_TURN_LIMIT,
            beforeCursor: page.beforeCursor,
          } satisfies ThreadSnapshotWindow,
        };
      }),
    );
    if (request === null) {
      return;
    }
    const response = yield* snapshotLoader.load(request.prepared, threadId, request.window);
    // Staleness check and merge run under the same lock as stream-item
    // application, so a revert/snapshot cannot land between them (TOCTOU
    // review finding) — anything that rewrites history bumps the epoch
    // before this permit is acquired.
    yield* applyLock.withPermits(1)(
      Effect.gen(function* () {
        const epochNow = yield* Ref.get(historyEpoch);
        const loadedSequence = yield* SubscriptionRef.get(lastSequence);
        // Normal live events can advance the subscription while a page read
        // is in flight. They are append/update operations and safely compose
        // with the disjoint older rows. Only history rewrites bump the epoch
        // and invalidate the page.
        const stale =
          epochNow !== request.epochAtStart ||
          Option.match(response, {
            onNone: () => false,
            // The rewrite may already have landed before this request began
            // while the projection read still lagged behind it. Epoch equality
            // only proves that no newer rewrite happened DURING the request;
            // the captured sequence rejects a response that started stale.
            onSome: (snapshot) => snapshot.snapshotSequence < request.sequenceAtStart,
          });
        if (Option.isNone(response) || stale) {
          yield* SubscriptionRef.update(state, (value) => ({
            ...value,
            page: Option.map(value.page, (existing) => ({ ...existing, loadingOlder: false })),
          }));
          return;
        }
        // A page read AHEAD of the live state may include content (e.g.
        // streaming deltas of an out-of-window turn) the subscription has
        // not delivered yet; merging now and then replaying those events
        // would duplicate them. Park the page until the live state reaches
        // the page's thread-scoped watermark; loadingOlder stays true so
        // the UI shows progress and no second fetch starts. Pages from
        // pre-watermark servers (threadSequence absent) merge immediately,
        // preserving the old behavior.
        const watermark = response.value.page?.threadSequence;
        if (watermark !== undefined && watermark > loadedSequence) {
          yield* Ref.set(pendingOlderPage, {
            snapshot: response.value,
            epoch: epochNow,
          });
          return;
        }
        yield* mergeOlderPage(response.value);
      }),
    );
  });

  yield* SubscriptionRef.changes(supervisor.state).pipe(
    Stream.runForEach((connectionState) => {
      switch (connectionProjectionPhase(connectionState)) {
        case "synchronizing":
          return setSynchronizing;
        case "disconnected":
          return setDisconnected;
        case "ready":
          return setReady;
      }
    }),
    Effect.forkScoped,
  );

  const foregroundResubscriptions = Option.match(wakeups, {
    onNone: () => Stream.never,
    onSome: (service) =>
      service.changes.pipe(Stream.filter(ConnectionWakeups.shouldResubscribeAfterWakeup)),
  });

  yield* setSynchronizing;
  yield* Effect.forkScoped(
    subscribeDynamic(
      ORCHESTRATION_WS_METHODS.subscribeThread,
      Effect.fn("EnvironmentThreadState.makeSubscribeInput")(function* (session) {
        const config = yield* session.initialConfig.pipe(
          Effect.orElseSucceed(
            () =>
              ({}) as {
                threadResumeCompletionMarker?: boolean;
                threadSnapshotPagination?: boolean;
              },
          ),
        );
        const supportsCompletionMarker = config.threadResumeCompletionMarker === true;
        // Windowed loads are gated on the server capability: pre-pagination
        // servers reject unknown query params, and a windowed WS fallback to
        // such a server would silently hide history.
        const supportsPagination = config.threadSnapshotPagination === true;
        // A replacement session owns a new capability set and prepared
        // connection. Serialize the boundary with page merging so a request
        // issued by the previous session cannot land in the new one.
        yield* applyLock.withPermits(1)(
          Effect.gen(function* () {
            paginationRequestsEnabled = supportsPagination;
            yield* Ref.set(paginationSupported, supportsPagination);
            yield* invalidateOlderPageReads();
          }),
        );
        yield* Ref.set(awaitingCompletion, supportsCompletionMarker);
        yield* setSynchronizing;

        let current = yield* SubscriptionRef.get(state);
        if (supportsPagination && Option.isSome(current.data) && Option.isNone(current.page)) {
          const prepared = yield* SubscriptionRef.get(supervisor.prepared).pipe(
            Effect.flatMap(
              Option.match({
                onSome: Effect.succeed,
                onNone: () =>
                  SubscriptionRef.changes(supervisor.prepared).pipe(
                    Stream.filter(Option.isSome),
                    Stream.map((value) => value.value),
                    Stream.runHead,
                    Effect.map(Option.getOrThrow),
                  ),
              }),
            ),
          );
          yield* migrateLegacyFullCache(prepared);
          current = yield* SubscriptionRef.get(state);
        }
        // A failed migration keeps legacy cache semantics for this session;
        // a later fallback snapshot or reconnect can still replace it.
        yield* Ref.set(
          windowedCacheMode,
          supportsPagination && (Option.isNone(current.data) || Option.isSome(current.page)),
        );
        // A windowed cache resuming against a server without pagination is a
        // trap: afterSequence resume keeps only the window, and the missing
        // older turns can never be loaded (the server has no cursor reads).
        // Drop the window marker and treat the data as needing a full reload.
        if (!supportsPagination && Option.isSome(current.page)) {
          yield* Ref.update(historyEpoch, (epoch) => epoch + 1);
          yield* Ref.set(recentWindowSnapshot, Option.none());
          yield* Ref.set(recentWindowRequiresRefresh, false);
          yield* SubscriptionRef.update(state, (value) => ({
            ...value,
            data: Option.none(),
            status: value.status === "deleted" ? value.status : ("empty" as const),
            page: Option.none(),
          }));
          yield* SubscriptionRef.set(lastSequence, 0);
          current = yield* SubscriptionRef.get(state);
        }
        if (Option.isNone(current.data) && current.status !== "deleted") {
          const prepared = yield* SubscriptionRef.get(supervisor.prepared).pipe(
            Effect.flatMap(
              Option.match({
                onSome: Effect.succeed,
                onNone: () =>
                  SubscriptionRef.changes(supervisor.prepared).pipe(
                    Stream.filter(Option.isSome),
                    Stream.map((value) => value.value),
                    Stream.runHead,
                    Effect.map(Option.getOrThrow),
                  ),
              }),
            ),
          );
          const httpSnapshot = yield* snapshotLoader.load(
            prepared,
            threadId,
            supportsPagination ? { turnLimit: INITIAL_THREAD_USER_TURN_LIMIT } : undefined,
          );
          if (Option.isSome(httpSnapshot)) {
            yield* applyItem({ kind: "snapshot", snapshot: httpSnapshot.value });
            current = yield* SubscriptionRef.get(state);
          }
        }

        const sequence = yield* SubscriptionRef.get(lastSequence);
        const canResume = Option.isSome(current.data);
        if (!supportsCompletionMarker && canResume) {
          yield* SubscriptionRef.update(state, (value) => ({
            ...value,
            status: value.status === "deleted" ? value.status : ("live" as const),
            error: Option.none(),
          }));
        }

        return {
          threadId,
          ...(canResume ? { afterSequence: sequence } : {}),
          ...(supportsCompletionMarker ? { requestCompletionMarker: true as const } : {}),
          // The WS fallback snapshot (sent when afterSequence is missing or
          // the gap is too large) should be windowed the same as the HTTP
          // path; without this a resume failure re-downloads the full thread.
          ...(supportsPagination ? { turnLimit: INITIAL_THREAD_USER_TURN_LIMIT } : {}),
        };
      }),
      {
        onExpectedFailure: setStreamError,
        retryExpectedFailureAfter: "250 millis",
        resubscribe: foregroundResubscriptions,
      },
    ).pipe(Stream.runForEach(applyItem)),
  );

  // Expose loadOlderTurns to UI actions through the request registry.
  // Requests funnel through a sliding queue drained serially, so mashing
  // "load earlier" coalesces (loadOlderTurns itself no-ops while a fetch is
  // in flight).
  const olderTurnRequestRegistry = yield* ThreadOlderTurnRequests;
  const olderTurnRequests = yield* Queue.sliding<void>(1);
  yield* Stream.fromQueue(olderTurnRequests).pipe(
    Stream.runForEach(() => loadOlderTurns()),
    Effect.forkScoped,
  );
  const deregister = olderTurnRequestRegistry.register(
    threadKey({ environmentId, threadId }),
    () => {
      if (!paginationRequestsEnabled) {
        return false;
      }
      Queue.offerUnsafe(olderTurnRequests, undefined);
      return true;
    },
  );
  yield* Effect.addFinalizer(() => Effect.sync(deregister));

  yield* Effect.addFinalizer(() =>
    Effect.all([
      SubscriptionRef.get(state),
      SubscriptionRef.get(lastSequence),
      Ref.get(windowedCacheMode),
      Ref.get(recentWindowSnapshot),
      Ref.get(recentWindowRequiresRefresh),
    ]).pipe(
      Effect.flatMap(
        ([current, snapshotSequence, useWindowedCache, recentSnapshot, requiresRefresh]) => {
          if (useWindowedCache) {
            return Effect.gen(function* () {
              const boundedSnapshot = requiresRefresh
                ? yield* loadBoundedRecentSnapshot(snapshotSequence)
                : recentSnapshot;
              if (
                Option.isSome(boundedSnapshot) &&
                shouldPersistThread(boundedSnapshot.value.thread)
              ) {
                yield* persist(boundedSnapshot.value);
              }
            });
          }
          return Option.match(current.data, {
            onNone: () => Effect.void,
            onSome: (thread) =>
              shouldPersistThread(thread)
                ? persist({
                    snapshotSequence,
                    thread,
                    ...Option.match(current.page, {
                      onNone: () => ({}),
                      onSome: (page) =>
                        ({
                          page: {
                            beforeCursor: page.beforeCursor,
                            hasMore: page.hasMore,
                            snapshotSequence,
                          },
                        }) as const,
                    }),
                  })
                : Effect.void,
          });
        },
      ),
    ),
  );

  return state;
});

export function threadStateChanges(environmentId: EnvironmentIdType, threadId: ThreadIdType) {
  return followStreamInEnvironment(
    environmentId,
    Stream.unwrap(makeEnvironmentThreadState(threadId).pipe(Effect.map(SubscriptionRef.changes))),
  );
}

export function createEnvironmentThreadStateAtoms<R, E>(
  runtime: Atom.AtomRuntime<
    EnvironmentRegistry | EnvironmentCacheStore | ThreadSnapshotLoader | R,
    E
  >,
) {
  const family = Atom.family((key: string) => {
    const { environmentId, threadId } = parseThreadKey(key);
    return runtime
      .atom(threadStateChanges(environmentId, threadId), {
        initialValue: EMPTY_ENVIRONMENT_THREAD_STATE,
      })
      .pipe(
        Atom.setIdleTTL(THREAD_STATE_IDLE_TTL_MS),
        Atom.withLabel(`environment-thread-state:${key}`),
      );
  });

  return {
    stateAtom: (environmentId: EnvironmentIdType, threadId: ThreadIdType) =>
      family(threadKey({ environmentId, threadId })),
  };
}

export * from "./archivedThreads.ts";
export * from "./checkpointDiff.ts";
export * from "./threadSnapshotHttp.ts";
export * from "./composerPathSearch.ts";
export * from "./threadCommands.ts";
export * from "./threadFeedback.ts";
export * from "./threadDetail.ts";
export * from "./threadReducer.ts";
export * from "./threadShell.ts";
export * from "./threadState.ts";
