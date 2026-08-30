import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ProcessRunner, type ProcessRunInput } from "../../processRunner.ts";
import { ProteusBridge } from "../Services/ProteusBridge.ts";
import { ProteusBridgeLive } from "./ProteusBridge.ts";

const calls: ProcessRunInput[] = [];
const campaignRoots = new Set<string>();
let campaignCompleted = false;
const runner = ProcessRunner.of({
  run: (input) => {
    calls.push(input);
    const rootIndex = input.args.indexOf("--root");
    const root = rootIndex >= 0 ? input.args[rootIndex + 1] : undefined;
    if (input.args.includes("resume") && (!root || !campaignRoots.has(root))) {
      return Effect.succeed({
        stdout: "",
        stderr: "Campaign not found",
        code: 1 as never,
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      });
    }
    if (input.args.includes("close")) campaignCompleted = true;
    if (input.args.includes("update")) {
      return Effect.succeed({
        stdout: "Updated round",
        stderr: "",
        code: 0 as never,
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      });
    }
    if (input.args.includes("close")) {
      return Effect.succeed({
        stdout: "Closed campaign",
        stderr: "",
        code: 0 as never,
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      });
    }
    const branch = input.args.includes("branch");
    const checkpoint = input.args.includes("checkpoint");
    return Effect.succeed({
      stdout: branch
        ? '{"id":7,"status":"open","campaignId":3}'
        : checkpoint
          ? '{"id":11,"campaignId":3}'
          : campaignCompleted
            ? '{"campaign":{"id":3,"status":"completed"},"activeRounds":[]}'
            : '{"campaign":{"id":3,"status":"active"},"activeRounds":[{"id":9,"status":"active"}]}',
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

const layer = it.layer(
  ProteusBridgeLive.pipe(
    Layer.provide(Layer.succeed(ProcessRunner, runner)),
    Layer.provideMerge(NodeServices.layer),
  ),
);

layer("ProteusBridge", (it) => {
  it.effect("validates campaigns, branches, and checkpoints through the public Proteus CLI", () =>
    Effect.gen(function* () {
      calls.length = 0;
      campaignCompleted = false;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "erebus-proteus-" });
      yield* fileSystem.makeDirectory(path.join(root, ".vros"));
      yield* fileSystem.writeFileString(path.join(root, ".vros", "memory.sqlite"), "initialized");
      const nested = path.join(root, "target", "package");
      yield* fileSystem.makeDirectory(path.join(nested, ".vros"), { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(nested, ".vros", "memory.sqlite"),
        "schema-only database without the requested campaign",
      );
      campaignRoots.add(root);
      const bridge = yield* ProteusBridge;
      assert.isDefined(bridge);
      const campaign = yield* bridge!.resolveCampaign(nested, "C3");
      const branch = yield* bridge!.readBranch(root, "B7");
      const checkpoint = yield* bridge!.readCheckpoint(root, "K11");

      assert.deepStrictEqual(campaign, {
        id: 3,
        status: "active",
        campaignId: null,
        root,
        activeRoundIds: [9],
      });
      assert.deepStrictEqual(branch, {
        id: 7,
        status: "open",
        campaignId: 3,
        root,
        activeRoundIds: [],
      });
      assert.deepStrictEqual(checkpoint, {
        id: 11,
        status: null,
        campaignId: 3,
        root,
        activeRoundIds: [],
      });
      const campaignCall = calls.find(
        (call) => call.args.includes("resume") && call.args.includes(root),
      );
      const branchCall = calls.find((call) => call.args.includes("branch"));
      const checkpointCall = calls.find((call) => call.args.includes("checkpoint"));
      assert.deepStrictEqual(campaignCall?.args.slice(-6), [
        "campaign",
        "resume",
        "--root",
        root,
        "--id",
        "3",
      ]);
      assert.deepStrictEqual(branchCall?.args.slice(-5), ["show", "branch", "7", "--root", root]);
      assert.deepStrictEqual(checkpointCall?.args.slice(-5), [
        "show",
        "checkpoint",
        "11",
        "--root",
        root,
      ]);
      campaignRoots.delete(root);
    }),
  );

  it.effect("rejects malformed ids before spawning Proteus", () =>
    Effect.gen(function* () {
      calls.length = 0;
      const bridge = yield* ProteusBridge;
      assert.isDefined(bridge);
      const result = yield* Effect.result(bridge!.resolveCampaign(process.cwd(), "not-an-id"));
      assert.equal(result._tag, "Failure");
      assert.equal(calls.length, 0);
    }),
  );

  it.effect("accepts bare and display ids while rejecting a different record prefix", () =>
    Effect.gen(function* () {
      calls.length = 0;
      const bridge = yield* ProteusBridge;
      assert.isDefined(bridge);

      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "erebus-proteus-" });
      yield* fileSystem.makeDirectory(path.join(root, ".vros"));
      yield* fileSystem.writeFileString(path.join(root, ".vros", "memory.sqlite"), "initialized");
      campaignRoots.add(root);
      yield* bridge!.resolveCampaign(root, "3");
      yield* bridge!.readBranch("C:\\target", "B7");
      yield* bridge!.readCheckpoint("C:\\target", "K11");
      yield* bridge!.readCheckpoint("C:\\target", "CP11");
      const callsBeforeWrongPrefix = calls.length;

      const wrongPrefix = yield* Effect.result(bridge!.readCheckpoint("C:\\target", "B11"));
      assert.equal(wrongPrefix._tag, "Failure");
      assert.equal(calls.length, callsBeforeWrongPrefix);
      campaignRoots.delete(root);
    }),
  );

  it.effect("completes linked active rounds before closing and verifying the campaign", () =>
    Effect.gen(function* () {
      calls.length = 0;
      campaignCompleted = false;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "erebus-proteus-" });
      yield* fileSystem.makeDirectory(path.join(root, ".vros"));
      yield* fileSystem.writeFileString(path.join(root, ".vros", "memory.sqlite"), "initialized");
      campaignRoots.add(root);
      const bridge = yield* ProteusBridge;
      assert.isDefined(bridge);

      const completed = yield* bridge!.completeCampaign(root, "C3", "Research complete.");

      assert.equal(completed.status, "completed");
      assert.deepStrictEqual(completed.activeRoundIds, []);
      assert.isTrue(calls.some((call) => call.args.includes("update")));
      assert.isTrue(calls.some((call) => call.args.includes("close")));
      campaignRoots.delete(root);
    }),
  );
});
