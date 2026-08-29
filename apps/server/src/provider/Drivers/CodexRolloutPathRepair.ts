import * as NodeSqlite from "node:sqlite";

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
