// @effect-diagnostics nodeBuiltinImport:off - Codex rollout recovery reads its native SQLite index.
import * as NodeSqlite from "node:sqlite";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const CODEX_STATE_DATABASE = /^state_\d+\.sqlite$/;
const ROLLOUT_HOME_SUFFIX = /(?:^|[\\/])(sessions|archived_sessions)[\\/](.+)$/i;

interface CodexThreadRolloutRow {
  readonly id: string;
  readonly rollout_path: string;
}

interface CodexRolloutPathRepair {
  readonly id: string;
  readonly previousPath: string;
  readonly repairedPath: string;
}

interface CodexRolloutMetadata {
  readonly path: string;
  readonly id: string;
  readonly createdAt: number;
  readonly cwd: string;
  readonly source: string;
  readonly modelProvider: string;
  readonly cliVersion: string;
}

function findRolloutMetadata(homePath: string, threadId: string): CodexRolloutMetadata | undefined {
  for (const directory of ["sessions", "archived_sessions"] as const) {
    const root = NodePath.join(homePath, directory);
    if (!NodeFS.existsSync(root)) continue;
    const entries = NodeFS.readdirSync(root, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl") || !entry.name.includes(threadId)) {
        continue;
      }
      const rolloutPath = NodePath.join(entry.parentPath, entry.name);
      const descriptor = NodeFS.openSync(rolloutPath, "r");
      try {
        const buffer = Buffer.alloc(128 * 1024);
        const length = NodeFS.readSync(descriptor, buffer, 0, buffer.length, 0);
        const firstLine = buffer.subarray(0, length).toString("utf8").split(/\r?\n/, 1)[0];
        if (!firstLine) continue;
        const record = JSON.parse(firstLine) as {
          readonly type?: string;
          readonly timestamp?: string;
          readonly payload?: {
            readonly id?: string;
            readonly session_id?: string;
            readonly cwd?: string;
            readonly source?: string;
            readonly model_provider?: string;
            readonly cli_version?: string;
          };
        };
        const id = record.payload?.id ?? record.payload?.session_id;
        if (record.type !== "session_meta" || id !== threadId) continue;
        const createdAtMs = Date.parse(record.timestamp ?? "");
        return {
          path: rolloutPath,
          id,
          createdAt: Number.isFinite(createdAtMs) ? Math.floor(createdAtMs / 1000) : 0,
          cwd: record.payload?.cwd ?? process.cwd(),
          source: record.payload?.source ?? "vscode",
          modelProvider: record.payload?.model_provider ?? "openai",
          cliVersion: record.payload?.cli_version ?? "",
        };
      } finally {
        NodeFS.closeSync(descriptor);
      }
    }
  }
  return undefined;
}

export const ensureCodexThreadRolloutIndexed = Effect.fn("ensureCodexThreadRolloutIndexed")(
  function* (homePath: string, threadId: string) {
    return yield* Effect.try({
      try: () => {
        const metadata = findRolloutMetadata(homePath, threadId);
        if (!metadata) return false;
        const databaseName = NodeFS.readdirSync(homePath)
          .filter((entry) => CODEX_STATE_DATABASE.test(entry))
          .toSorted((left, right) => right.localeCompare(left, undefined, { numeric: true }))[0];
        if (!databaseName) return false;
        const databasePath = NodePath.join(homePath, databaseName);
        const database = new NodeSqlite.DatabaseSync(databasePath);
        try {
          database.exec("PRAGMA busy_timeout = 10000");
          const physicalRow = database
            .prepare("SELECT id, rollout_path FROM threads NOT INDEXED WHERE id = ?")
            .get(threadId) as CodexThreadRolloutRow | undefined;
          const indexedRow = database
            .prepare("SELECT id, rollout_path FROM threads WHERE id = ?")
            .get(threadId) as CodexThreadRolloutRow | undefined;
          if (
            indexedRow?.id !== physicalRow?.id ||
            indexedRow?.rollout_path !== physicalRow?.rollout_path
          ) {
            database.exec("REINDEX");
          }
          database.exec("BEGIN IMMEDIATE");
          try {
            if (physicalRow) {
              database
                .prepare("UPDATE threads SET rollout_path = ? WHERE id = ?")
                .run(metadata.path, threadId);
            } else {
              database
                .prepare(
                  `INSERT INTO threads (
                    id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
                    sandbox_policy, approval_mode, has_user_event, cli_version, first_user_message,
                    preview, recency_at, created_at_ms, updated_at_ms, recency_at_ms, history_mode
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .run(
                  threadId,
                  metadata.path,
                  metadata.createdAt,
                  metadata.createdAt,
                  metadata.source,
                  metadata.modelProvider,
                  metadata.cwd,
                  threadId,
                  '{"type":"disabled"}',
                  "never",
                  metadata.cliVersion,
                  threadId,
                  threadId,
                  metadata.createdAt,
                  metadata.createdAt * 1000,
                  metadata.createdAt * 1000,
                  metadata.createdAt * 1000,
                  "paginated",
                );
            }
            database.exec("COMMIT");
          } catch (cause) {
            database.exec("ROLLBACK");
            throw cause;
          }
          return true;
        } finally {
          database.close();
        }
      },
      catch: (cause) =>
        new CodexRolloutPathRepairError({
          homePath,
          databasePath: homePath,
          cause,
        }),
    });
  },
);

export class CodexRolloutPathRepairError extends Schema.TaggedErrorClass<CodexRolloutPathRepairError>()(
  "CodexRolloutPathRepairError",
  {
    homePath: Schema.String,
    databasePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to reconcile copied Codex rollout paths in '${this.databasePath}'.`;
  }
}

function readThreadRollouts(input: {
  readonly homePath: string;
  readonly databasePath: string;
}): Effect.Effect<readonly CodexThreadRolloutRow[], CodexRolloutPathRepairError> {
  return Effect.try({
    try: () => {
      const database = new NodeSqlite.DatabaseSync(input.databasePath, { readOnly: true });
      try {
        const hasThreadsTable = database
          .prepare(
            "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'threads'",
          )
          .get();
        if (!hasThreadsTable) return [];
        return database
          .prepare("SELECT id, rollout_path FROM threads")
          .all() as unknown as readonly CodexThreadRolloutRow[];
      } finally {
        database.close();
      }
    },
    catch: (cause) =>
      new CodexRolloutPathRepairError({
        homePath: input.homePath,
        databasePath: input.databasePath,
        cause,
      }),
  });
}

function applyRepairs(input: {
  readonly homePath: string;
  readonly databasePath: string;
  readonly repairs: readonly CodexRolloutPathRepair[];
}): Effect.Effect<number, CodexRolloutPathRepairError> {
  if (input.repairs.length === 0) return Effect.succeed(0);

  return Effect.try({
    try: () => {
      const database = new NodeSqlite.DatabaseSync(input.databasePath);
      try {
        database.exec("PRAGMA busy_timeout = 5000");
        const update = database.prepare(
          "UPDATE threads SET rollout_path = ? WHERE id = ? AND rollout_path = ?",
        );
        let repaired = 0;
        database.exec("BEGIN IMMEDIATE");
        try {
          for (const repair of input.repairs) {
            repaired += Number(
              update.run(repair.repairedPath, repair.id, repair.previousPath).changes,
            );
          }
          database.exec("COMMIT");
        } catch (cause) {
          database.exec("ROLLBACK");
          throw cause;
        }
        return repaired;
      } finally {
        database.close();
      }
    },
    catch: (cause) =>
      new CodexRolloutPathRepairError({
        homePath: input.homePath,
        databasePath: input.databasePath,
        cause,
      }),
  });
}

export const reconcileCodexRolloutPaths = Effect.fn("reconcileCodexRolloutPaths")(function* (
  homePath: string,
): Effect.fn.Return<number, CodexRolloutPathRepairError, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fileSystem.readDirectory(homePath).pipe(
    Effect.catchTags({
      PlatformError: (cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed<readonly string[]>([])
          : new CodexRolloutPathRepairError({
              homePath,
              databasePath: homePath,
              cause,
            }),
    }),
  );
  const databasePaths = entries
    .filter((entry) => CODEX_STATE_DATABASE.test(entry))
    .map((entry) => path.join(homePath, entry));

  let repaired = 0;
  for (const databasePath of databasePaths) {
    const rows = yield* readThreadRollouts({ homePath, databasePath });
    const repairs: CodexRolloutPathRepair[] = [];
    const pathExists = (candidatePath: string) =>
      fileSystem.exists(candidatePath).pipe(
        Effect.mapError(
          (cause) =>
            new CodexRolloutPathRepairError({
              homePath,
              databasePath,
              cause,
            }),
        ),
      );
    for (const row of rows) {
      const match = ROLLOUT_HOME_SUFFIX.exec(row.rollout_path);
      if (!match?.[1] || !match[2]) continue;
      const repairedPath = path.resolve(
        homePath,
        match[1],
        ...match[2].split(/[\\/]+/).filter(Boolean),
      );
      if (path.resolve(row.rollout_path) === repairedPath) continue;
      if (yield* pathExists(row.rollout_path)) continue;
      if (!(yield* pathExists(repairedPath))) continue;
      repairs.push({ id: row.id, previousPath: row.rollout_path, repairedPath });
    }
    repaired += yield* applyRepairs({ homePath, databasePath, repairs });
  }

  return repaired;
});
