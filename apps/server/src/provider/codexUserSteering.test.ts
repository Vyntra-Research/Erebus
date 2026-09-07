import * as NodeAssert from "node:assert/strict";

import { TurnId } from "@t3tools/contracts";
import { describe, it } from "vite-plus/test";

import {
  buildCodexCompactionBoundaryMarker,
  buildCodexHistoricalUserSteerMarker,
  buildCodexCompactionContextInstruction,
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
    NodeAssert.match(marker, /not the current user turn/);
    NodeAssert.match(marker, /Do not reclassify any other message/);

    const last = {
      clientUserMessageId: "message-7",
      turnId: TurnId.make("turn-7"),
      kind: "userSteer" as const,
      state: "fresh" as const,
    };
    const laterTurnCompaction = markTrackedUserSteerHistorical(last, TurnId.make("turn-8"));
    NodeAssert.equal(laterTurnCompaction.next?.state, "historical");
    NodeAssert.equal(laterTurnCompaction.stale?.clientUserMessageId, "message-7");

    const repeatedSignal = markTrackedUserSteerHistorical(
      laterTurnCompaction.next,
      TurnId.make("turn-8"),
    );
    NodeAssert.equal(repeatedSignal.stale, null);
    NodeAssert.equal(buildCodexCompactionContextInstruction(last), "");
    NodeAssert.match(
      buildCodexCompactionContextInstruction(laterTurnCompaction.next),
      /stale_context_id="message-7"/,
    );
  });

  it("marks one chronological boundary without enumerating replayed steers", () => {
    const marker = buildCodexCompactionBoundaryMarker(TurnId.make('turn-"9"'));

    NodeAssert.match(marker, /after_compaction_turn_id="turn-&quot;9&quot;"/);
    NodeAssert.match(marker, /Every `<erebus_user_steer>` and `<erebus_coagent_delivery>`/);
    NodeAssert.match(marker, /appears before this boundary is historical/);
    NodeAssert.match(marker, /genuinely new delivery that appears after this boundary is fresh/);
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
