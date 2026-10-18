// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

const readSource = (relativePath: string) =>
  NodeFS.readFileSync(NodePath.join(import.meta.dirname, relativePath), "utf8");

describe("large-thread read boundaries", () => {
  it("loads a missing current user message by id instead of scanning prior history", () => {
    const source = readSource("./ProviderCommandReactor.ts");

    assert.match(source, /getThreadMessageById/);
    assert.notMatch(source, /currentMessageId:[\s\S]{0,160}maxChars: 1/);
  });

  it("keeps normal turn checkpointing off the unbounded thread query", () => {
    const source = readSource("./CheckpointReactor.ts");

    assert.notMatch(source, /\.getThreadDetailById\s*\(/);
    assert.notMatch(source, /\.getThreadCheckpointContext\s*\(/);
    assert.match(source, /getThreadCheckpointHeadContext\?\.\(threadId, turnId\)/);
  });

  it("keeps co-agent operations on shells or bounded detail pages", () => {
    const source = readSource("../../coagents/Layers/CoagentToolController.ts");

    assert.notMatch(source, /\.getThreadDetailById\s*\(/);
    assert.notMatch(source, /\.getSnapshot\s*\(/);
    assert.match(source, /getThreadShellById\(threadId\)/);
    assert.match(source, /turnLimit: COAGENT_THREAD_WINDOW_USER_TURNS/);
  });

  it("keeps Judge delivery on thread and project shells", () => {
    const source = readSource("../../research/Layers/ResearchSupervisor.ts");

    assert.notMatch(source, /\.getThreadDetailById\s*\(/);
    assert.match(source, /\.getThreadShellById\(threadId\)/);
    assert.match(source, /\.getProjectShellById\(thread\.projectId\)/);
  });
});
