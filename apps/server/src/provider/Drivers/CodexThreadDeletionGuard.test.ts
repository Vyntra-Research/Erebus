// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { it } from "@effect/vitest";

import { inspectManagedCodexThreadDeletion } from "./CodexThreadDeletionGuard.ts";

it("refuses deletion when a second account indexes the same provider thread", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "erebus-codex-delete-guard-"));
  try {
    const currentDb = new NodeSqlite.DatabaseSync(NodePath.join(root, "state_5.sqlite"));
    currentDb.exec(
      "CREATE TABLE threads (id TEXT PRIMARY KEY); CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT)",
    );
    currentDb.prepare("INSERT INTO threads (id) VALUES (?)").run("provider-thread-1");
    currentDb.prepare("INSERT INTO threads (id) VALUES (?)").run("provider-thread-2");
    currentDb.prepare("INSERT INTO threads (id) VALUES (?)").run("provider-thread-3");
    currentDb
      .prepare("INSERT INTO thread_spawn_edges (parent_thread_id, child_thread_id) VALUES (?, ?)")
      .run("provider-thread-3", "provider-child-3");
    currentDb.close();
    const account = NodePath.join(root, "accounts", "codex_other");
    NodeFS.mkdirSync(account, { recursive: true });
    const db = new NodeSqlite.DatabaseSync(NodePath.join(account, "state_5.sqlite"));
    db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY)");
    db.prepare("INSERT INTO threads (id) VALUES (?)").run("provider-thread-1");
    db.prepare("INSERT INTO threads (id) VALUES (?)").run("provider-child-3");
    db.close();

    const check = (providerThreadId: string) =>
      inspectManagedCodexThreadDeletion({
        sharedHomePath: root,
        effectiveHomePath: root,
        providerThreadId,
      });
    NodeAssert.deepStrictEqual(check("provider-thread-1"), {
      indexedHere: true,
      indexedElsewhere: true,
    });
    NodeAssert.deepStrictEqual(check("provider-thread-2"), {
      indexedHere: true,
      indexedElsewhere: false,
    });
    NodeAssert.deepStrictEqual(check("provider-thread-3"), {
      indexedHere: true,
      indexedElsewhere: true,
    });
    NodeAssert.deepStrictEqual(check("already-deleted"), {
      indexedHere: false,
      indexedElsewhere: false,
    });
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
