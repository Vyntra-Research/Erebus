// @effect-diagnostics nodeBuiltinImport:off - fixtures exercise native Codex SQLite and rollout cleanup.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import {
  deleteInactiveSubagents,
  deleteRecoverySnapshots,
  readStorageDiagnostics,
} from "./StorageMaintenance.ts";

interface Fixture {
  readonly root: string;
  readonly stateDir: string;
  readonly erebusDatabasePath: string;
  readonly codexDatabasePath: string;
  readonly rolloutPath: string;
  readonly recoveryPath: string;
}

function makeFixture(activeParent = false): Fixture {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "erebus-storage-maintenance-"));
  const stateDir = NodePath.join(root, "userdata");
  const recoveryPath = NodePath.join(stateDir, "recovery", "snapshot-one", "state.sqlite");
  NodeFS.mkdirSync(NodePath.dirname(recoveryPath), { recursive: true });
  NodeFS.writeFileSync(recoveryPath, "recovery-data");
  const codexHome = NodePath.join(stateDir, "providers", "codex");
  const sessions = NodePath.join(codexHome, "sessions", "2026", "09", "04");
  NodeFS.mkdirSync(sessions, { recursive: true });
  const rolloutPath = NodePath.join(sessions, "rollout-child.jsonl");
  NodeFS.writeFileSync(
    rolloutPath,
    `${JSON.stringify({
      type: "session_meta",
      payload: { id: "child", thread_source: "subagent" },
    })}\n`,
  );

  const codexDatabasePath = NodePath.join(codexHome, "state_5.sqlite");
  const codex = new NodeSqlite.DatabaseSync(codexDatabasePath);
  try {
    codex.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        updated_at_ms INTEGER,
        thread_source TEXT
      );
      CREATE TABLE thread_spawn_edges (
        parent_thread_id TEXT NOT NULL,
        child_thread_id TEXT NOT NULL PRIMARY KEY,
        status TEXT NOT NULL
      );
    `);
    codex
      .prepare(
        "INSERT INTO threads (id, rollout_path, updated_at, updated_at_ms, thread_source) VALUES (?, ?, 1, 1, 'subagent')",
      )
      .run("child", rolloutPath);
    codex
      .prepare(
        "INSERT INTO thread_spawn_edges (parent_thread_id, child_thread_id, status) VALUES ('parent', 'child', 'open')",
      )
      .run();
  } finally {
    codex.close();
  }

  const erebusDatabasePath = NodePath.join(stateDir, "state.sqlite");
  const erebus = new NodeSqlite.DatabaseSync(erebusDatabasePath);
  try {
    erebus.exec(`
      CREATE TABLE projection_threads (
        thread_id TEXT PRIMARY KEY,
        deleted_at TEXT,
        archived_at TEXT
      );
      CREATE TABLE projection_thread_sessions (
        thread_id TEXT,
        provider_thread_id TEXT,
        status TEXT,
        active_turn_id TEXT
      );
      CREATE TABLE provider_session_runtime (
        thread_id TEXT PRIMARY KEY,
        resume_cursor_json TEXT
      );
    `);
    if (activeParent) {
      erebus
        .prepare(
          "INSERT INTO projection_threads (thread_id, deleted_at, archived_at) VALUES ('erebus-parent', NULL, NULL)",
        )
        .run();
      erebus
        .prepare(
          "INSERT INTO provider_session_runtime (thread_id, resume_cursor_json) VALUES (?, ?)",
        )
        .run("erebus-parent", JSON.stringify({ threadId: "parent" }));
      erebus
        .prepare(
          "INSERT INTO projection_thread_sessions (thread_id, provider_thread_id, status, active_turn_id) VALUES ('erebus-parent', NULL, 'ready', NULL)",
        )
        .run();
    }
  } finally {
    erebus.close();
  }

  return {
    root,
    stateDir,
    erebusDatabasePath,
    codexDatabasePath,
    rolloutPath,
    recoveryPath,
  };
}

function countRows(databasePath: string, table: string): number {
  const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  try {
    return (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number })
      .count;
  } finally {
    database.close();
  }
}

describe("StorageMaintenance", () => {
  it.effect("deletes the unchanged inactive set from its rollout and Codex index", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => makeFixture()),
      (fixture) =>
        Effect.gen(function* () {
          yield* TestClock.adjust("20 minutes");
          const before = yield* readStorageDiagnostics({
            stateDir: fixture.stateDir,
            databasePath: fixture.erebusDatabasePath,
          });
          assert.equal(before.deletableSubagentCount, 1);
          assert.isAbove(before.deletableSubagentBytes, 0);

          const result = yield* deleteInactiveSubagents({
            stateDir: fixture.stateDir,
            databasePath: fixture.erebusDatabasePath,
            request: { snapshotDigest: before.snapshotDigest },
          });

          assert.isTrue(result.accepted);
          assert.equal(result.deletedCount, 1);
          assert.isFalse(NodeFS.existsSync(fixture.rolloutPath));
          assert.equal(countRows(fixture.codexDatabasePath, "threads"), 0);
          assert.equal(countRows(fixture.codexDatabasePath, "thread_spawn_edges"), 0);
        }),
      (fixture) => Effect.sync(() => NodeFS.rmSync(fixture.root, { recursive: true, force: true })),
    ),
  );

  it.effect("rejects a stale snapshot without changing files or indexes", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => makeFixture()),
      (fixture) =>
        Effect.gen(function* () {
          const result = yield* deleteInactiveSubagents({
            stateDir: fixture.stateDir,
            databasePath: fixture.erebusDatabasePath,
            request: { snapshotDigest: "stale" },
          });

          assert.isFalse(result.accepted);
          assert.isTrue(NodeFS.existsSync(fixture.rolloutPath));
          assert.equal(countRows(fixture.codexDatabasePath, "threads"), 1);
        }),
      (fixture) => Effect.sync(() => NodeFS.rmSync(fixture.root, { recursive: true, force: true })),
    ),
  );

  it.effect("protects every sub-agent whose ancestry reaches a visible task between turns", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => makeFixture(true)),
      (fixture) =>
        Effect.gen(function* () {
          const snapshot = yield* readStorageDiagnostics({
            stateDir: fixture.stateDir,
            databasePath: fixture.erebusDatabasePath,
          });
          assert.equal(snapshot.subagentSessionCount, 1);
          assert.equal(snapshot.deletableSubagentCount, 0);
          assert.equal(snapshot.protectedSubagentCount, 1);
        }),
      (fixture) => Effect.sync(() => NodeFS.rmSync(fixture.root, { recursive: true, force: true })),
    ),
  );

  it.effect("deletes the exact recovery snapshot set after confirmation", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => makeFixture()),
      (fixture) =>
        Effect.gen(function* () {
          const before = yield* readStorageDiagnostics({
            stateDir: fixture.stateDir,
            databasePath: fixture.erebusDatabasePath,
          });
          assert.equal(before.recoverySnapshotCount, 1);
          assert.isAbove(before.recoverySnapshotBytes, 0);

          const result = yield* deleteRecoverySnapshots({
            stateDir: fixture.stateDir,
            request: { snapshotDigest: before.recoverySnapshotDigest },
          });

          assert.isTrue(result.accepted);
          assert.equal(result.deletedCount, 1);
          assert.isFalse(NodeFS.existsSync(fixture.recoveryPath));
          assert.isTrue(NodeFS.existsSync(fixture.rolloutPath));
        }),
      (fixture) => Effect.sync(() => NodeFS.rmSync(fixture.root, { recursive: true, force: true })),
    ),
  );

  it.effect("rejects stale recovery cleanup without deleting a snapshot", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => makeFixture()),
      (fixture) =>
        Effect.gen(function* () {
          const result = yield* deleteRecoverySnapshots({
            stateDir: fixture.stateDir,
            request: { snapshotDigest: "stale" },
          });

          assert.isFalse(result.accepted);
          assert.isTrue(NodeFS.existsSync(fixture.recoveryPath));
        }),
      (fixture) => Effect.sync(() => NodeFS.rmSync(fixture.root, { recursive: true, force: true })),
    ),
  );
});
