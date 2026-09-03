// @effect-diagnostics preferSchemaOverJson:off - fixtures mirror Codex's native JSONL records.
import * as NodeSqlite from "node:sqlite";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { NodeServices } from "@effect/platform-node";

import {
  ensureCodexThreadRolloutIndexed,
  reconcileCodexRolloutPaths,
} from "./CodexRolloutPathRepair.ts";

const makeTempHome = Effect.fn("CodexRolloutPathRepair.test.makeTempHome")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "erebus-codex-rollout-repair-" });
});

function createStateDatabase(databasePath: string, rows: readonly (readonly [string, string])[]) {
  const database = new NodeSqlite.DatabaseSync(databasePath);
  try {
    database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
    const insert = database.prepare("INSERT INTO threads (id, rollout_path) VALUES (?, ?)");
    for (const row of rows) insert.run(...row);
  } finally {
    database.close();
  }
}

function readRolloutPath(databasePath: string, id: string): string {
  const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  try {
    return (
      database.prepare("SELECT rollout_path FROM threads WHERE id = ?").get(id) as {
        readonly rollout_path: string;
      }
    ).rollout_path;
  } finally {
    database.close();
  }
}

function createCurrentStateDatabase(databasePath: string) {
  const database = new NodeSqlite.DatabaseSync(databasePath);
  try {
    database.exec(`CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      model_provider TEXT NOT NULL,
      cwd TEXT NOT NULL,
      title TEXT NOT NULL,
      sandbox_policy TEXT NOT NULL,
      approval_mode TEXT NOT NULL,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      has_user_event INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      cli_version TEXT NOT NULL DEFAULT '',
      first_user_message TEXT NOT NULL DEFAULT '',
      preview TEXT NOT NULL DEFAULT '',
      recency_at INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER,
      updated_at_ms INTEGER,
      recency_at_ms INTEGER NOT NULL DEFAULT 0,
      history_mode TEXT NOT NULL DEFAULT 'legacy'
    )`);
  } finally {
    database.close();
  }
}

it.layer(NodeServices.layer)("CodexRolloutPathRepair", (it) => {
  describe("reconcileCodexRolloutPaths", () => {
    it.effect("repairs a copied rollout path only when the local rollout exists", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const homePath = yield* makeTempHome();
          const rolloutPath = path.join(
            homePath,
            "sessions",
            "2026",
            "08",
            "29",
            "rollout-thread-1.jsonl",
          );
          yield* fileSystem.makeDirectory(path.dirname(rolloutPath), { recursive: true });
          yield* fileSystem.writeFileString(rolloutPath, "{}\n");
          const databasePath = path.join(homePath, "state_5.sqlite");
          createStateDatabase(databasePath, [
            [
              "thread-1",
              String.raw`C:\Users\researcher\old-home\sessions\2026\08\29\rollout-thread-1.jsonl`,
            ],
            [
              "thread-missing",
              String.raw`C:\Users\researcher\old-home\sessions\2026\08\29\missing.jsonl`,
            ],
          ]);

          assert.equal(yield* reconcileCodexRolloutPaths(homePath), 1);
          assert.equal(readRolloutPath(databasePath, "thread-1"), rolloutPath);
          assert.equal(
            readRolloutPath(databasePath, "thread-missing"),
            String.raw`C:\Users\researcher\old-home\sessions\2026\08\29\missing.jsonl`,
          );
        }),
      ),
    );

    it.effect("preserves a valid rollout outside the current home", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const homePath = yield* makeTempHome();
          const externalHome = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "erebus-codex-external-home-",
          });
          const relativePath = path.join("sessions", "2026", "08", "29", "rollout.jsonl");
          const externalRollout = path.join(externalHome, relativePath);
          const localRollout = path.join(homePath, relativePath);
          yield* fileSystem.makeDirectory(path.dirname(externalRollout), { recursive: true });
          yield* fileSystem.makeDirectory(path.dirname(localRollout), { recursive: true });
          yield* fileSystem.writeFileString(externalRollout, "external\n");
          yield* fileSystem.writeFileString(localRollout, "local\n");
          const databasePath = path.join(homePath, "state_6.sqlite");
          createStateDatabase(databasePath, [["thread-1", externalRollout]]);

          assert.equal(yield* reconcileCodexRolloutPaths(homePath), 0);
          assert.equal(readRolloutPath(databasePath, "thread-1"), externalRollout);
        }),
      ),
    );
  });

  describe("ensureCodexThreadRolloutIndexed", () => {
    it.effect("indexes a shared rollout before cross-account resume", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const homePath = yield* makeTempHome();
          const threadId = "01a067c6-f1ab-7fa0-938e-0e3b86482f97";
          const rolloutPath = path.join(
            homePath,
            "sessions",
            "2026",
            "09",
            "03",
            `rollout-2026-09-03T11-58-06-${threadId}.jsonl`,
          );
          yield* fileSystem.makeDirectory(path.dirname(rolloutPath), { recursive: true });
          yield* fileSystem.writeFileString(
            rolloutPath,
            `${JSON.stringify({
              type: "session_meta",
              timestamp: "2026-09-03T14:58:06.516Z",
              payload: {
                id: threadId,
                cwd: "C:\\research",
                source: "vscode",
                model_provider: "openai",
                cli_version: "0.152.1",
              },
            })}\n`,
          );
          const databasePath = path.join(homePath, "state_5.sqlite");
          createCurrentStateDatabase(databasePath);

          assert.isTrue(yield* ensureCodexThreadRolloutIndexed(homePath, threadId));
          assert.equal(readRolloutPath(databasePath, threadId), rolloutPath);
        }),
      ),
    );
  });
});
