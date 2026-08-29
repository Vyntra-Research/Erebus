import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProcessRunner, type ProcessRunInput } from "../../processRunner.ts";
import { ProteusBridge } from "../Services/ProteusBridge.ts";
import { ProteusBridgeLive } from "./ProteusBridge.ts";

const calls: ProcessRunInput[] = [];
const runner = ProcessRunner.of({
  run: (input) => {
    calls.push(input);
    const branch = input.args.includes("branch");
    const checkpoint = input.args.includes("checkpoint");
    return Effect.succeed({
      stdout: branch
        ? '{"id":7,"status":"open","campaignId":3}'
        : checkpoint
          ? '{"id":11,"campaignId":3}'
          : '{"campaign":{"id":3,"status":"active"}}',
      stderr: "",
      code: 0 as never,
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutInvalidUtf8: false,
      stderrInvalidUtf8: false,
    });
  },
});

const layer = it.layer(ProteusBridgeLive.pipe(Layer.provide(Layer.succeed(ProcessRunner, runner))));

layer("ProteusBridge", (it) => {
  it.effect("validates campaigns, branches, and checkpoints through the public Proteus CLI", () =>
    Effect.gen(function* () {
      calls.length = 0;
      const bridge = yield* ProteusBridge;
      assert.isDefined(bridge);
      const campaign = yield* bridge!.readCampaign("C:\\target", "C3");
      const branch = yield* bridge!.readBranch("C:\\target", "B7");
      const checkpoint = yield* bridge!.readCheckpoint("C:\\target", "CP11");

      assert.deepStrictEqual(campaign, { id: 3, status: "active", campaignId: null });
      assert.deepStrictEqual(branch, { id: 7, status: "open", campaignId: 3 });
      assert.deepStrictEqual(checkpoint, { id: 11, status: null, campaignId: 3 });
      assert.deepStrictEqual(calls[0]?.args, [
        "campaign",
        "resume",
        "--root",
        "C:\\target",
        "--id",
        "3",
      ]);
      assert.deepStrictEqual(calls[1]?.args, ["show", "branch", "7", "--root", "C:\\target"]);
      assert.deepStrictEqual(calls[2]?.args, ["show", "checkpoint", "11", "--root", "C:\\target"]);
    }),
  );

  it.effect("rejects malformed ids before spawning Proteus", () =>
    Effect.gen(function* () {
      calls.length = 0;
      const bridge = yield* ProteusBridge;
      assert.isDefined(bridge);
      const result = yield* Effect.result(bridge!.readCampaign("C:\\target", "not-an-id"));
      assert.equal(result._tag, "Failure");
      assert.equal(calls.length, 0);
    }),
  );

  it.effect("accepts bare ids and only the canonical prefix for each record kind", () =>
    Effect.gen(function* () {
      calls.length = 0;
      const bridge = yield* ProteusBridge;
      assert.isDefined(bridge);

      yield* bridge!.readCampaign("C:\\target", "3");
      yield* bridge!.readBranch("C:\\target", "B7");
      yield* bridge!.readCheckpoint("C:\\target", "CP11");
      assert.equal(calls.length, 3);

      const wrongPrefix = yield* Effect.result(bridge!.readCheckpoint("C:\\target", "B11"));
      assert.equal(wrongPrefix._tag, "Failure");
      assert.equal(calls.length, 3);
    }),
  );
});
