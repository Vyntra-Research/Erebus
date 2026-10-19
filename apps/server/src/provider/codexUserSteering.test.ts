import * as NodeAssert from "node:assert/strict";

import { TurnId } from "@t3tools/contracts";
import { describe, it } from "vite-plus/test";

import {
  buildCodexCompactionBoundaryMarker,
  buildCodexLiveCoagentMessagePrompt,
  buildCodexLiveUserSteerPrompt,
  contextCompactionSignal,
  erebusContextClientId,
  isHiddenErebusContextItem,
} from "./codexUserSteering.ts";

const assertTransientCodexContext = (prompt: string): void => {
  NodeAssert.ok(prompt.startsWith('<codex_internal_context source="erebus">\n'));
  NodeAssert.ok(prompt.endsWith("\n</codex_internal_context>"));
};

describe("Codex user steering across compaction", () => {
  it("delivers a live user steer as transient Codex context", () => {
    const text = "Continue from C30 <without> restarting & keep the current evidence.";
    const prompt = buildCodexLiveUserSteerPrompt('message-"7"', text);

    assertTransientCodexContext(prompt);
    NodeAssert.match(prompt, /kind="user_steer"/);
    NodeAssert.match(prompt, /id="message-&quot;7&quot;"/);
    NodeAssert.ok(prompt.includes(text));
    NodeAssert.match(prompt, /consumed by this delivery/);
    NodeAssert.doesNotMatch(prompt, /<erebus_user_steer/);
  });

  it("delivers a co-agent handback through the same transient boundary", () => {
    const text =
      '<erebus_coagent_message from_thread_id="child" from_title="Child">done</erebus_coagent_message>';
    const prompt = buildCodexLiveCoagentMessagePrompt("coagent-message-1", text);

    assertTransientCodexContext(prompt);
    NodeAssert.match(prompt, /kind="coagent_message"/);
    NodeAssert.match(prompt, /id="coagent-message-1"/);
    NodeAssert.ok(prompt.includes(text));
    NodeAssert.match(prompt, /must not become a fresh handback after automatic compaction/);
    NodeAssert.doesNotMatch(prompt, /<erebus_coagent_delivery/);
  });

  it("uses transient internal context for the post-compaction boundary", () => {
    const marker = buildCodexCompactionBoundaryMarker(TurnId.make('turn-"9"'));

    assertTransientCodexContext(marker);
    NodeAssert.match(marker, /<erebus_compaction_boundary turn_id="turn-&quot;9&quot;">/);
    NodeAssert.match(marker, /not a new user request/);
    NodeAssert.match(marker, /historical source material/);
    NodeAssert.match(marker, /Continue from the compacted state and later events/);
    NodeAssert.doesNotMatch(marker, /stale_context_id/);
  });

  it("recognizes both Codex compaction signals and ignores unrelated items", () => {
    NodeAssert.deepEqual(
      contextCompactionSignal({
        method: "thread/compacted",
        params: { threadId: "thread-1", turnId: "turn-1" },
      }),
      { turnId: "turn-1", identity: "legacy-turn:turn-1" },
    );
    NodeAssert.deepEqual(
      contextCompactionSignal({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-2",
          item: { id: "compact-1", type: "contextCompaction" },
        },
      }),
      { turnId: "turn-2", identity: "item:compact-1" },
    );
    NodeAssert.equal(
      contextCompactionSignal({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-3",
          item: { id: "message-1", type: "agentMessage" },
        },
      }),
      undefined,
    );
  });

  it("distinguishes repeated compactions inside one long-running turn", () => {
    const first = contextCompactionSignal({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-long",
        item: { id: "compact-1", type: "contextCompaction" },
      },
    });
    const second = contextCompactionSignal({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-long",
        item: { id: "compact-2", type: "contextCompaction" },
      },
    });

    NodeAssert.equal(first?.turnId, second?.turnId);
    NodeAssert.notEqual(first?.identity, second?.identity);
  });

  it("hides transient Erebus context items from the visible provider timeline", () => {
    const clientId = erebusContextClientId("live-user-steer:message-7");
    NodeAssert.equal(isHiddenErebusContextItem({ type: "userMessage", clientId }), true);
    NodeAssert.equal(
      isHiddenErebusContextItem({ type: "userMessage", clientId: "message-7" }),
      false,
    );
    NodeAssert.equal(isHiddenErebusContextItem({ type: "agentMessage", clientId }), false);
  });
});
