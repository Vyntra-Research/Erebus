import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import type * as CodexSchema from "effect-codex-app-server/schema";

import { EREBUS_THREADS_DYNAMIC_TOOL } from "../coagents/coagentTools.ts";
import { EREBUS_RESEARCH_DYNAMIC_TOOL } from "../research/researchTools.ts";

export const EREBUS_NATIVE_CONTROL_VERSION = 4;
const encodeTools = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export function fingerprintNativeControlTools(
  tools: ReadonlyArray<CodexSchema.V2ThreadStartParams__DynamicToolSpec>,
): string {
  return NodeCrypto.createHash("sha256").update(encodeTools(tools)).digest("hex");
}

export const EREBUS_NATIVE_CONTROL_FINGERPRINT = fingerprintNativeControlTools([
  EREBUS_RESEARCH_DYNAMIC_TOOL,
  EREBUS_THREADS_DYNAMIC_TOOL,
]);

// Codex freezes dynamic tool schemas in thread/start metadata. A release number
// alone cannot establish that a resumed rollout exposes today's tool contract.
export const hasCurrentNativeControlTools = Schema.is(
  Schema.Struct({
    erebusResearchNativeTools: Schema.Literal(true),
    erebusNativeControlVersion: Schema.Literal(EREBUS_NATIVE_CONTROL_VERSION),
    erebusNativeControlFingerprint: Schema.Literal(EREBUS_NATIVE_CONTROL_FINGERPRINT),
  }),
);
