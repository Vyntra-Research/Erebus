import { createWebRuntimeEnvironmentAtoms } from "@t3tools/client-runtime/state/web-runtime";

import { connectionAtomRuntime } from "../connection/runtime";

export const webRuntimeEnvironment = createWebRuntimeEnvironmentAtoms(connectionAtomRuntime);
