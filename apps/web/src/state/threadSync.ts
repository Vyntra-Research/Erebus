import { createThreadSyncEnvironmentAtoms } from "@t3tools/client-runtime/state/thread-sync";
import type { ThreadSyncStatus } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";

export const threadSyncEnvironment = createThreadSyncEnvironmentAtoms(connectionAtomRuntime);

export const primaryThreadSyncStatusAtom = Atom.make((get): ThreadSyncStatus | null => {
  const environmentId = get(primaryEnvironmentIdAtom);
  if (environmentId === null) return null;

  return Option.getOrNull(
    AsyncResult.value(get(threadSyncEnvironment.status({ environmentId, input: {} }))),
  );
}).pipe(Atom.withLabel("web-primary-thread-sync-status"));
