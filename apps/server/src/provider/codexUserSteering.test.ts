import * as NodeAssert from "node:assert/strict";

import { TurnId } from "@t3tools/contracts";
import { describe, it } from "vite-plus/test";

import {
  buildCodexHistoricalUserSteerMarker,
  buildCodexLiveCoagentMessagePrompt,
  buildCodexLiveUserSteerPrompt,
  contextCompactionTurnId,
  deliveredLiveContext,
  deliveredLiveUserSteerId,
  erebusCoagentSteerClientId,
  erebusContextClientId,
  erebusUserSteerClientId,
  isHiddenErebusContextItem,
  markTrackedUserSteerHistorical,
} from "./codexUserSteering.ts";

describe("Codex user steering across compaction", () => {
  it("labels one live user steer without rewriting its text", () => {
    const text = "Continue from C30 <without> restarting & keep the current evidence.";
    const prompt = buildCodexLiveUserSteerPrompt('message-"7"', text);

    NodeAssert.match(prompt, /<erebus_user_steer/);
    NodeAssert.match(prompt, /id="message-&quot;7&quot;"/);
    NodeAssert.match(prompt, /delivery="live"/);
    NodeAssert.ok(prompt.endsWith(text));
    NodeAssert.match(prompt, /replays them literally after automatic context compaction/);
  });

  it("marks only the exact last steer as historical", () => {
    const marker = buildCodexHistoricalUserSteerMarker("message-7");

    NodeAssert.match(marker, /stale_context_id="message-7"/);
    NodeAssert.match(marker, /stale_context_kind="userSteer"/);
    NodeAssert.match(marker, /Only the user steer with this exact id/);
    NodeAssert.match(marker, /Do not reclassify any other message/);

    const last = {
      clientUserMessageId: "message-7",
      turnId: TurnId.make("turn-7"),
      kind: "userSteer" as const,
      state: "fresh" as const,
    };
    const unrelatedCompaction = markTrackedUserSteerHistorical(last, TurnId.make("turn-6"));
    NodeAssert.strictEqual(unrelatedCompaction.next, last);
    NodeAssert.equal(unrelatedCompaction.stale, null);

    const matchingCompaction = markTrackedUserSteerHistorical(last, TurnId.make("turn-7"));
    NodeAssert.equal(matchingCompaction.next?.state, "historical");
    NodeAssert.equal(matchingCompaction.stale?.clientUserMessageId, "message-7");
  });

  it("recognizes both Codex compaction signals and ignores unrelated items", () => {
    NodeAssert.equal(
      contextCompactionTurnId({
        method: "thread/compacted",
        params: { threadId: "thread-1", turnId: "turn-1" },
      }),
      "turn-1",
    );
    NodeAssert.equal(
      contextCompactionTurnId({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-2",
          item: { id: "compact-1", type: "contextCompaction" },
        },
      }),
      "turn-2",
    );
    NodeAssert.equal(
      contextCompactionTurnId({
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

  it("hides only Erebus context markers from the visible provider timeline", () => {
    const clientId = erebusContextClientId("message-7");
    NodeAssert.equal(isHiddenErebusContextItem({ type: "userMessage", clientId }), true);
    NodeAssert.equal(
      isHiddenErebusContextItem({ type: "userMessage", clientId: "message-7" }),
      false,
    );
    NodeAssert.equal(isHiddenErebusContextItem({ type: "agentMessage", clientId }), false);
  });

  it("identifies a delivered live steer without retaining a queued history", () => {
    const clientId = erebusUserSteerClientId("message-8");
    NodeAssert.equal(deliveredLiveUserSteerId({ type: "userMessage", clientId }), "message-8");
    NodeAssert.equal(
      deliveredLiveUserSteerId({ type: "userMessage", clientId: "message-8" }),
      undefined,
    );
    NodeAssert.equal(deliveredLiveUserSteerId({ type: "agentMessage", clientId }), undefined);
  });

  it("tracks a co-agent delivery as the exact transient context across compaction", () => {
    const clientId = erebusCoagentSteerClientId("coagent-message-1");
    NodeAssert.deepEqual(deliveredLiveContext({ type: "userMessage", clientId }), {
      clientUserMessageId: "coagent-message-1",
      kind: "coagentMessage",
    });

    const prompt = buildCodexLiveCoagentMessagePrompt(
      "coagent-message-1",
      '<erebus_coagent_message from_thread_id="child" from_title="Child">done</erebus_coagent_message>',
    );
    NodeAssert.match(prompt, /<erebus_coagent_delivery/);
    NodeAssert.match(prompt, /visual position after the compacted summary does not make it newer/);

    const marker = buildCodexHistoricalUserSteerMarker("coagent-message-1", "coagentMessage");
    NodeAssert.match(marker, /stale_context_kind="coagentMessage"/);
    NodeAssert.match(marker, /Only the co-agent message with this exact id/);
  });
});
