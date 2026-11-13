// @effect-diagnostics nodeBuiltinImport:off - Codex session cleanup must reconcile its native indexes and rollout files.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import type {
  ServerDeleteInactiveSubagentsInput,
  ServerDeleteInactiveSubagentsResult,
  ServerDeleteRecoverySnapshotsInput,
  ServerDeleteRecoverySnapshotsResult,
  ServerCompactStorageInput,
  ServerCompactStorageResult,
  ServerStorageDiagnosticsResult,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

const CODEX_STATE_DATABASE = /^state_\d+\.sqlite$/u;
const CODEX_HISTORY_DATABASE = /^thread_history_\d+\.sqlite$/u;
const MANUAL_CLEANUP_MINIMUM_IDLE_AGE_MS = 10 * 60 * 1_000;
const AUTOMATIC_CLEANUP_MINIMUM_IDLE_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

interface IndexedSubagent {
  readonly id: string;
  readonly rolloutPath: string;
  readonly updatedAtMs: number;
}

interface CleanupCandidate extends IndexedSubagent {
  readonly canonicalPath: string;
  readonly bytes: number;
}

interface CleanupSnapshot {
  readonly candidates: ReadonlyArray<CleanupCandidate>;
  readonly totalCount: number;
  readonly totalBytes: number;
  readonly protectedCount: number;
  readonly protectedBytes: number;
  readonly digest: string;
}

interface SpawnEdge {
  readonly parent_thread_id: string;
  readonly child_thread_id: string;
}

interface RecoverySnapshotEntry {
  readonly name: string;
  readonly path: string;
  readonly bytes: number;
  readonly modifiedAtMs: number;
}

interface RecoverySnapshot {
  readonly entries: ReadonlyArray<RecoverySnapshotEntry>;
  readonly totalBytes: number;
  readonly digest: string;
}

interface DatabaseStorageSnapshot {
  readonly databaseBytes: number;
  readonly reclaimableBytes: number;
  readonly activeTurnCount: number;
  readonly modifiedAtMs: number;
  readonly digest: string;
}

function managedCodexHomes(codexHome: string): ReadonlyArray<string> {
  const homes = [NodePath.resolve(codexHome)];
  const accountsRoot = NodePath.join(codexHome, "accounts");
  if (NodeFS.existsSync(accountsRoot)) {
    for (const account of NodeFS.readdirSync(accountsRoot, { withFileTypes: true })) {
      if (!account.isDirectory() || account.isSymbolicLink()) continue;
      homes.push(NodePath.resolve(account.parentPath, account.name));
    }
  }
  return homes;
}

function databasePaths(codexHome: string, pattern: RegExp): ReadonlyArray<string> {
  const paths: string[] = [];
  const appendDirectMatches = (root: string) => {
    if (!NodeFS.existsSync(root)) return;
    const entries = NodeFS.readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !pattern.test(entry.name)) continue;
      paths.push(NodePath.join(entry.parentPath, entry.name));
    }
  };
  for (const home of managedCodexHomes(codexHome)) appendDirectMatches(home);
  return [...new Set(paths.map((entry) => NodePath.resolve(entry)))];
}

function readIndexedSubagents(stateDatabases: ReadonlyArray<string>): {
  readonly rows: ReadonlyArray<IndexedSubagent>;
  readonly edges: ReadonlyArray<SpawnEdge>;
} {
  const rows = new Map<string, IndexedSubagent>();
  const edges = new Map<string, SpawnEdge>();
  for (const databasePath of stateDatabases) {
    const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
    try {
      const threadRows = database
        .prepare(
          `SELECT id, rollout_path AS rolloutPath,
                  COALESCE(updated_at_ms, updated_at * 1000) AS updatedAtMs
             FROM threads
            WHERE thread_source = 'subagent'`,
        )
        .all() as unknown as ReadonlyArray<IndexedSubagent>;
      for (const row of threadRows) {
        const previous = rows.get(row.id);
        if (!previous || row.updatedAtMs > previous.updatedAtMs) rows.set(row.id, row);
      }
      const spawnRows = database
        .prepare("SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges")
        .all() as unknown as ReadonlyArray<SpawnEdge>;
      for (const edge of spawnRows) edges.set(edge.child_thread_id, edge);
    } finally {
      database.close();
    }
  }
  return { rows: [...rows.values()], edges: [...edges.values()] };
}

function readProtectedProviderThreads(erebusDatabasePath: string): Set<string> {
  if (!NodeFS.existsSync(erebusDatabasePath)) return new Set();
  const database = new NodeSqlite.DatabaseSync(erebusDatabasePath, { readOnly: true });
  try {
    const protectedIds = new Set<string>();
    const activeRows = database
      .prepare(
        `SELECT provider_thread_id AS id
           FROM projection_thread_sessions
          WHERE provider_thread_id IS NOT NULL
            AND (status = 'running' OR active_turn_id IS NOT NULL)`,
      )
      .all() as unknown as ReadonlyArray<{ readonly id: string }>;
    for (const row of activeRows) protectedIds.add(row.id);

    const visibleRows = database
      .prepare(
        `SELECT runtime.resume_cursor_json AS resumeCursor
           FROM projection_threads AS threads
           JOIN provider_session_runtime AS runtime ON runtime.thread_id = threads.thread_id
          WHERE threads.deleted_at IS NULL
            AND threads.archived_at IS NULL
            AND runtime.resume_cursor_json IS NOT NULL`,
      )
      .all() as unknown as ReadonlyArray<{ readonly resumeCursor: string }>;
    for (const row of visibleRows) {
      try {
        const parsed = JSON.parse(row.resumeCursor) as { readonly threadId?: unknown };
        if (typeof parsed.threadId === "string" && parsed.threadId.length > 0) {
          protectedIds.add(parsed.threadId);
          continue;
        }
      } catch {
        // Fall through to the fail-closed error below.
      }
      throw new Error("A visible task has an unreadable provider resume cursor.");
    }
    return protectedIds;
  } finally {
    database.close();
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = NodePath.relative(root, candidate);
  return relative.length > 0 && !relative.startsWith("..") && !NodePath.isAbsolute(relative);
}

function measureTreeBytes(root: string): number {
  const stat = NodeFS.lstatSync(root);
  if (stat.isSymbolicLink()) return 0;
  if (!stat.isDirectory()) return stat.size;

  let bytes = 0;
  for (const entry of NodeFS.readdirSync(root, { withFileTypes: true })) {
    const entryPath = NodePath.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    bytes += entry.isDirectory() ? measureTreeBytes(entryPath) : NodeFS.lstatSync(entryPath).size;
  }
  return bytes;
}

function buildRecoverySnapshot(stateDir: string): RecoverySnapshot {
  const recoveryRoot = NodePath.join(stateDir, "recovery");
  const entries: RecoverySnapshotEntry[] = [];
  if (NodeFS.existsSync(recoveryRoot)) {
    const canonicalRoot = NodeFS.realpathSync.native(recoveryRoot);
    for (const entry of NodeFS.readdirSync(recoveryRoot, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const entryPath = NodePath.join(recoveryRoot, entry.name);
      const canonicalPath = NodeFS.realpathSync.native(entryPath);
      if (!isWithin(canonicalRoot, canonicalPath)) continue;
      const stat = NodeFS.lstatSync(canonicalPath);
      entries.push({
        name: entry.name,
        path: canonicalPath,
        bytes: measureTreeBytes(canonicalPath),
        modifiedAtMs: stat.mtimeMs,
      });
    }
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const digest = NodeCrypto.createHash("sha256");
  for (const entry of entries) {
    digest
      .update(entry.name)
      .update("\0")
      .update(String(entry.bytes))
      .update("\0")
      .update(String(entry.modifiedAtMs))
      .update("\n");
  }
  return {
    entries,
    totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    digest: digest.digest("hex"),
  };
}

function readPragmaNumber(database: NodeSqlite.DatabaseSync, pragma: string): number {
  const row = database.prepare(`PRAGMA ${pragma}`).get() as Record<string, number>;
  return Object.values(row)[0] ?? 0;
}

function buildDatabaseStorageSnapshot(databasePath: string): DatabaseStorageSnapshot {
  if (!NodeFS.existsSync(databasePath)) {
    return {
      databaseBytes: 0,
      reclaimableBytes: 0,
      activeTurnCount: 0,
      modifiedAtMs: 0,
      digest: NodeCrypto.createHash("sha256").update("missing").digest("hex"),
    };
  }
  const files = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
    .filter(NodeFS.existsSync)
    .map((filePath) => NodeFS.statSync(filePath));
  const databaseBytes = files.reduce((total, stat) => total + stat.size, 0);
  const modifiedAtMs = Math.max(...files.map((stat) => stat.mtimeMs));
  const walBytes = NodeFS.existsSync(`${databasePath}-wal`)
    ? NodeFS.statSync(`${databasePath}-wal`).size
    : 0;
  const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    const pageSize = readPragmaNumber(database, "page_size");
    const freePages = readPragmaNumber(database, "freelist_count");
    const activeTurnCount = (
      database
        .prepare(
          `SELECT COUNT(*) AS count
             FROM projection_thread_sessions
            WHERE status IN ('starting', 'running') OR active_turn_id IS NOT NULL`,
        )
        .get() as { readonly count: number }
    ).count;
    const digest = NodeCrypto.createHash("sha256")
      .update(String(databaseBytes))
      .update("\0")
      .update(String(modifiedAtMs))
      .update("\0")
      .update(String(freePages))
      .digest("hex");
    return {
      databaseBytes,
      reclaimableBytes: pageSize * freePages + walBytes,
      activeTurnCount,
      modifiedAtMs,
      digest,
    };
  } finally {
    database.close();
  }
}

const compactDatabase = Effect.fn("compactDatabase")(function* (input: {
  readonly databasePath: string;
  readonly request: ServerCompactStorageInput;
  readonly sql: SqlClient.SqlClient;
}): Effect.fn.Return<ServerCompactStorageResult, SqlError> {
  const before = buildDatabaseStorageSnapshot(input.databasePath);
  if (before.digest !== input.request.snapshotDigest) {
    return yield* Effect.succeed({
      accepted: false,
      beforeBytes: before.databaseBytes,
      afterBytes: before.databaseBytes,
      freedBytes: 0,
      message: "Storage changed. Refresh the details before compacting it.",
    });
  }
  if (before.activeTurnCount > 0) {
    return yield* Effect.succeed({
      accepted: false,
      beforeBytes: before.databaseBytes,
      afterBytes: before.databaseBytes,
      freedBytes: 0,
      message: "Wait for active turns to finish before compacting local storage.",
    });
  }
  if (before.reclaimableBytes === 0) {
    return yield* Effect.succeed({
      accepted: true,
      beforeBytes: before.databaseBytes,
      afterBytes: before.databaseBytes,
      freedBytes: 0,
      message: "The local database is already compact.",
    });
  }

  const disk = NodeFS.statfsSync(NodePath.dirname(input.databasePath));
  const availableBytes = disk.bavail * disk.bsize;
  if (availableBytes < before.databaseBytes + 256 * 1024 * 1024) {
    return yield* Effect.succeed({
      accepted: false,
      beforeBytes: before.databaseBytes,
      afterBytes: before.databaseBytes,
      freedBytes: 0,
      message: "There is not enough free disk space to compact the local database safely.",
    });
  }

  const compacted = yield* Effect.scoped(
    Effect.gen(function* () {
      const connection = yield* input.sql.reserve;
      const activeRows = (yield* connection.executeUnprepared(
        `SELECT COUNT(*) AS count
           FROM projection_thread_sessions
          WHERE status IN ('starting', 'running') OR active_turn_id IS NOT NULL`,
        [],
        undefined,
      )) as ReadonlyArray<{ readonly count: number }>;
      if ((activeRows[0]?.count ?? 0) > 0) return false;
      yield* connection.executeUnprepared("PRAGMA busy_timeout = 30000", [], undefined);
      yield* connection.executeUnprepared("PRAGMA wal_checkpoint(TRUNCATE)", [], undefined);
      yield* connection.executeUnprepared("PRAGMA auto_vacuum = INCREMENTAL", [], undefined);
      yield* connection.executeUnprepared("VACUUM", [], undefined);
      yield* connection.executeUnprepared("PRAGMA optimize", [], undefined);
      return true;
    }),
  );
  if (!compacted) {
    const current = buildDatabaseStorageSnapshot(input.databasePath);
    return {
      accepted: false,
      beforeBytes: current.databaseBytes,
      afterBytes: current.databaseBytes,
      freedBytes: 0,
      message: "Wait for active turns to finish before compacting local storage.",
    };
  }
  const after = buildDatabaseStorageSnapshot(input.databasePath);
  return {
    accepted: true,
    beforeBytes: before.databaseBytes,
    afterBytes: after.databaseBytes,
    freedBytes: Math.max(0, before.databaseBytes - after.databaseBytes),
    message: "Local database storage was compacted.",
  };
});

function readRolloutIdentity(filePath: string): {
  readonly id: string;
  readonly threadSource: string;
} {
  const descriptor = NodeFS.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(256 * 1024);
    const length = NodeFS.readSync(descriptor, buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, length).toString("utf8").split(/\r?\n/u, 1)[0];
    if (!firstLine) return { id: "", threadSource: "" };
    const record = JSON.parse(firstLine) as {
      readonly type?: string;
      readonly payload?: {
        readonly id?: string;
        readonly session_id?: string;
        readonly thread_source?: string;
      };
    };
    if (record.type !== "session_meta") return { id: "", threadSource: "" };
    return {
      id: record.payload?.id ?? record.payload?.session_id ?? "",
      threadSource: record.payload?.thread_source ?? "",
    };
  } finally {
    NodeFS.closeSync(descriptor);
  }
}

function buildSnapshot(input: {
  readonly codexHome: string;
  readonly erebusDatabasePath: string;
  readonly nowMs: number;
  readonly minimumIdleAgeMs?: number;
}): CleanupSnapshot {
  const stateDatabases = databasePaths(input.codexHome, CODEX_STATE_DATABASE);
  if (stateDatabases.length === 0) {
    return {
      candidates: [],
      totalCount: 0,
      totalBytes: 0,
      protectedCount: 0,
      protectedBytes: 0,
      digest: NodeCrypto.createHash("sha256").digest("hex"),
    };
  }

  const { rows, edges } = readIndexedSubagents(stateDatabases);
  const parentByChild = new Map(edges.map((edge) => [edge.child_thread_id, edge.parent_thread_id]));
  const active = readProtectedProviderThreads(input.erebusDatabasePath);
  const lockRoots = managedCodexHomes(input.codexHome).map((home) =>
    NodePath.join(home, "thread-writer-locks"),
  );
  const sessionRoots = listCodexSessionRoots(input.codexHome);
  const protectedIds = new Set<string>();

  for (const row of rows) {
    const isActive =
      active.has(row.id) ||
      lockRoots.some((root) => NodeFS.existsSync(NodePath.join(root, `${row.id}.lock`)));
    if (!isActive && parentByChild.has(row.id)) continue;

    let current: string | undefined = row.id;
    while (current && !protectedIds.has(current)) {
      protectedIds.add(current);
      current = parentByChild.get(current);
    }
  }

  const candidates: CleanupCandidate[] = [];
  let totalBytes = 0;
  let protectedBytes = 0;
  let protectedCount = 0;
  for (const row of rows) {
    let canonicalPath = "";
    let bytes = 0;
    try {
      canonicalPath = NodeFS.realpathSync.native(row.rolloutPath);
      bytes = NodeFS.statSync(canonicalPath).size;
    } catch {
      protectedIds.add(row.id);
    }
    totalBytes += bytes;
    let identity = { id: "", threadSource: "" };
    try {
      if (canonicalPath) identity = readRolloutIdentity(canonicalPath);
    } catch {
      protectedIds.add(row.id);
    }
    const valid =
      identity.id === row.id &&
      identity.threadSource === "subagent" &&
      sessionRoots.some((root) => isWithin(root, canonicalPath));
    const isProtected =
      protectedIds.has(row.id) ||
      !valid ||
      row.updatedAtMs >
        input.nowMs - (input.minimumIdleAgeMs ?? MANUAL_CLEANUP_MINIMUM_IDLE_AGE_MS);
    if (isProtected) {
      protectedCount += 1;
      protectedBytes += bytes;
      continue;
    }
    candidates.push({ ...row, canonicalPath, bytes });
  }

  candidates.sort((left, right) => left.id.localeCompare(right.id));
  const digest = NodeCrypto.createHash("sha256");
  for (const candidate of candidates) {
    digest.update(candidate.id).update("\0").update(candidate.canonicalPath).update("\0");
    digest.update(String(candidate.bytes)).update("\n");
  }
  return {
    candidates,
    totalCount: rows.length,
    totalBytes,
    protectedCount,
    protectedBytes,
    digest: digest.digest("hex"),
  };
}

function deleteRows(
  database: NodeSqlite.DatabaseSync,
  qualifiedTable: string,
  ids: readonly string[],
) {
  for (let offset = 0; offset < ids.length; offset += 400) {
    const chunk = ids.slice(offset, offset + 400);
    const placeholders = chunk.map(() => "?").join(",");
    database
      .prepare(`DELETE FROM ${qualifiedTable} WHERE thread_id IN (${placeholders})`)
      .run(...chunk);
  }
}

function deleteCodexIndexes(input: {
  readonly codexHome: string;
  readonly ids: readonly string[];
}): void {
  const stateDatabases = databasePaths(input.codexHome, CODEX_STATE_DATABASE);
  const historyDatabases = databasePaths(input.codexHome, CODEX_HISTORY_DATABASE);
  if (stateDatabases.length === 0) return;
  const database = new NodeSqlite.DatabaseSync(stateDatabases[0]!);
  const aliases: string[] = ["main"];
  const historyAliases: string[] = [];
  try {
    database.exec("PRAGMA busy_timeout = 10000");
    for (const [index, path] of stateDatabases.slice(1).entries()) {
      const alias = `state_${index}`;
      database.prepare(`ATTACH DATABASE ? AS ${alias}`).run(path);
      aliases.push(alias);
    }
    for (const [index, path] of historyDatabases.entries()) {
      const alias = `history_${index}`;
      database.prepare(`ATTACH DATABASE ? AS ${alias}`).run(path);
      historyAliases.push(alias);
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const alias of historyAliases) {
        for (const table of [
          "thread_realtime_items",
          "thread_items",
          "thread_turns",
          "thread_history_projection_state",
        ]) {
          deleteRows(database, `${alias}.${table}`, input.ids);
        }
      }
      for (const alias of aliases) {
        for (let offset = 0; offset < input.ids.length; offset += 400) {
          const chunk = input.ids.slice(offset, offset + 400);
          const placeholders = chunk.map(() => "?").join(",");
          database
            .prepare(
              `DELETE FROM ${alias}.thread_spawn_edges
                WHERE child_thread_id IN (${placeholders})
                   OR parent_thread_id IN (${placeholders})`,
            )
            .run(...chunk, ...chunk);
          database
            .prepare(`DELETE FROM ${alias}.threads WHERE id IN (${placeholders})`)
            .run(...chunk);
        }
      }
      database.exec("COMMIT");
      for (const alias of [...aliases, ...historyAliases]) {
        try {
          database.exec(`PRAGMA ${alias}.incremental_vacuum`);
        } catch {
          // Index deletion is already durable. A later cleanup can reclaim the free pages.
        }
      }
    } catch (cause) {
      database.exec("ROLLBACK");
      throw cause;
    }
  } finally {
    database.close();
  }
}

function listCodexSessionRoots(codexHome: string): ReadonlyArray<string> {
  return managedCodexHomes(codexHome)
    .flatMap((home) => ["sessions", "archived_sessions"].map((name) => NodePath.join(home, name)))
    .filter(NodeFS.existsSync)
    .map((root) => NodeFS.realpathSync.native(root));
}

function walkRolloutFiles(root: string): ReadonlyArray<string> {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    for (const entry of NodeFS.readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const entryPath = NodePath.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(entryPath);
      }
    }
  }
  return files;
}

function readIndexedRolloutPaths(
  stateDatabases: ReadonlyArray<string>,
  ids: ReadonlySet<string>,
): ReadonlyArray<string> {
  const paths = new Set<string>();
  for (const databasePath of stateDatabases) {
    const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
    try {
      const rows = database
        .prepare("SELECT id, rollout_path AS rolloutPath FROM threads")
        .all() as unknown as ReadonlyArray<{ readonly id: string; readonly rolloutPath: string }>;
      for (const row of rows) {
        if (ids.has(row.id) && row.rolloutPath.length > 0) paths.add(row.rolloutPath);
      }
    } finally {
      database.close();
    }
  }
  return [...paths];
}

function performCodexThreadHistoryDeletion(input: {
  readonly codexHome: string;
  readonly providerThreadIds: ReadonlyArray<string>;
}): boolean {
  const ids = new Set(input.providerThreadIds.filter((id) => id.length > 0));
  if (ids.size === 0) return true;

  const lockRoots = managedCodexHomes(input.codexHome).map((home) =>
    NodePath.join(home, "thread-writer-locks"),
  );
  if (
    [...ids].some((id) =>
      lockRoots.some((root) => NodeFS.existsSync(NodePath.join(root, `${id}.lock`))),
    )
  ) {
    return false;
  }

  const sessionRoots = listCodexSessionRoots(input.codexHome);
  const indexedPaths = readIndexedRolloutPaths(
    databasePaths(input.codexHome, CODEX_STATE_DATABASE),
    ids,
  );
  const candidates = new Map<string, string>();
  const resolvedIds = new Set<string>();
  const addCandidate = (filePath: string) => {
    if (!NodeFS.existsSync(filePath)) return;
    const canonicalPath = NodeFS.realpathSync.native(filePath);
    const identity = readRolloutIdentity(canonicalPath);
    if (!ids.has(identity.id)) return;
    if (!sessionRoots.some((root) => isWithin(root, canonicalPath))) {
      throw new Error("A Codex rollout selected for cleanup is outside the managed session roots.");
    }
    candidates.set(canonicalPath.toLowerCase(), canonicalPath);
    resolvedIds.add(identity.id);
  };
  for (const filePath of indexedPaths) addCandidate(filePath);

  const filenameSuffixes = [...ids]
    .filter((id) => !resolvedIds.has(id))
    .map((id) => `${id}.jsonl`.toLowerCase());
  if (filenameSuffixes.length > 0) {
    for (const filePath of sessionRoots.flatMap(walkRolloutFiles)) {
      const fileName = NodePath.basename(filePath).toLowerCase();
      if (filenameSuffixes.some((suffix) => fileName.endsWith(suffix))) addCandidate(filePath);
    }
  }

  const operationId = NodeCrypto.randomUUID();
  const trashRoot = NodePath.join(input.codexHome, ".erebus-trash", `threads-${operationId}`);
  NodeFS.mkdirSync(trashRoot, { recursive: true });
  const staged: Array<{ readonly original: string; readonly staged: string }> = [];
  try {
    for (const [index, candidate] of [...candidates.values()].entries()) {
      const stagedPath = NodePath.join(trashRoot, `${index}-${NodePath.basename(candidate)}`);
      NodeFS.renameSync(candidate, stagedPath);
      staged.push({ original: candidate, staged: stagedPath });
    }
    deleteCodexIndexes({ codexHome: input.codexHome, ids: [...ids] });
  } catch (cause) {
    for (const entry of staged.toReversed()) {
      if (!NodeFS.existsSync(entry.staged) || NodeFS.existsSync(entry.original)) continue;
      NodeFS.mkdirSync(NodePath.dirname(entry.original), { recursive: true });
      NodeFS.renameSync(entry.staged, entry.original);
    }
    NodeFS.rmSync(trashRoot, { recursive: true, force: true });
    throw cause;
  }
  NodeFS.rmSync(trashRoot, { recursive: true, force: true });
  return true;
}

function performCleanup(input: {
  readonly codexHome: string;
  readonly erebusDatabasePath: string;
  readonly request: ServerDeleteInactiveSubagentsInput;
  readonly nowMs: number;
  readonly minimumIdleAgeMs?: number;
}): ServerDeleteInactiveSubagentsResult {
  const snapshot = buildSnapshot(input);
  if (snapshot.digest !== input.request.snapshotDigest) {
    return {
      accepted: false,
      deletedCount: 0,
      deletedBytes: 0,
      message: "Agent session state changed. Refresh storage details and confirm again.",
    };
  }
  if (snapshot.candidates.length === 0) {
    return {
      accepted: true,
      deletedCount: 0,
      deletedBytes: 0,
      message: "No inactive sub-agent sessions were eligible for deletion.",
    };
  }

  const operationId = NodeCrypto.randomUUID();
  const trashRoot = NodePath.join(input.codexHome, ".erebus-trash", operationId);
  NodeFS.mkdirSync(trashRoot, { recursive: true });
  const staged: Array<{ readonly original: string; readonly staged: string }> = [];
  try {
    for (const candidate of snapshot.candidates) {
      const stagedPath = NodePath.join(trashRoot, `${candidate.id}.jsonl`);
      NodeFS.renameSync(candidate.canonicalPath, stagedPath);
      staged.push({ original: candidate.canonicalPath, staged: stagedPath });
    }
    deleteCodexIndexes({
      codexHome: input.codexHome,
      ids: snapshot.candidates.map((candidate) => candidate.id),
    });
  } catch (cause) {
    for (const entry of staged.toReversed()) {
      if (!NodeFS.existsSync(entry.staged) || NodeFS.existsSync(entry.original)) continue;
      NodeFS.mkdirSync(NodePath.dirname(entry.original), { recursive: true });
      NodeFS.renameSync(entry.staged, entry.original);
    }
    NodeFS.rmSync(trashRoot, { recursive: true, force: true });
    throw cause;
  }
  try {
    NodeFS.rmSync(trashRoot, { recursive: true, force: true });
  } catch {
    // Indexes already committed. A later cleanup may remove the private trash folder.
  }
  return {
    accepted: true,
    deletedCount: snapshot.candidates.length,
    deletedBytes: snapshot.candidates.reduce((sum, candidate) => sum + candidate.bytes, 0),
    message: "Inactive sub-agent sessions were deleted.",
  };
}

function performRecoveryCleanup(input: {
  readonly stateDir: string;
  readonly request: ServerDeleteRecoverySnapshotsInput;
}): ServerDeleteRecoverySnapshotsResult {
  const snapshot = buildRecoverySnapshot(input.stateDir);
  if (snapshot.digest !== input.request.snapshotDigest) {
    return {
      accepted: false,
      deletedCount: 0,
      deletedBytes: 0,
      message: "Recovery storage changed. Refresh storage details and confirm again.",
    };
  }
  if (snapshot.entries.length === 0) {
    return {
      accepted: true,
      deletedCount: 0,
      deletedBytes: 0,
      message: "No recovery snapshots were available for deletion.",
    };
  }

  const trashRoot = NodePath.join(
    input.stateDir,
    ".erebus-trash",
    `recovery-${NodeCrypto.randomUUID()}`,
  );
  NodeFS.mkdirSync(trashRoot, { recursive: true });
  const staged: Array<{ readonly original: string; readonly staged: string }> = [];
  try {
    for (const entry of snapshot.entries) {
      const stagedPath = NodePath.join(trashRoot, entry.name);
      NodeFS.renameSync(entry.path, stagedPath);
      staged.push({ original: entry.path, staged: stagedPath });
    }
  } catch (cause) {
    for (const entry of staged.toReversed()) {
      if (!NodeFS.existsSync(entry.staged) || NodeFS.existsSync(entry.original)) continue;
      NodeFS.renameSync(entry.staged, entry.original);
    }
    NodeFS.rmSync(trashRoot, { recursive: true, force: true });
    throw cause;
  }

  try {
    NodeFS.rmSync(trashRoot, { recursive: true, force: true });
  } catch {
    // The snapshots are detached from recovery; keep the private trash for a later cleanup.
  }
  return {
    accepted: true,
    deletedCount: snapshot.entries.length,
    deletedBytes: snapshot.totalBytes,
    message: "Recovery snapshots were deleted.",
  };
}

export const readStorageDiagnostics = Effect.fn("readStorageDiagnostics")(function* (input: {
  readonly stateDir: string;
  readonly databasePath: string;
}): Effect.fn.Return<ServerStorageDiagnosticsResult> {
  const codexHome = NodePath.join(input.stateDir, "providers", "codex");
  const readAt = DateTime.formatIso(yield* DateTime.now);
  const nowMs = yield* Clock.currentTimeMillis;
  const recoverySnapshot = yield* Effect.try(() => buildRecoverySnapshot(input.stateDir)).pipe(
    Effect.orElseSucceed(() => ({
      entries: [],
      totalBytes: 0,
      digest: "unavailable",
    })),
  );
  const databaseSnapshot = yield* Effect.try(() =>
    buildDatabaseStorageSnapshot(input.databasePath),
  ).pipe(
    Effect.orElseSucceed(() => ({
      databaseBytes: 0,
      reclaimableBytes: 0,
      activeTurnCount: 0,
      modifiedAtMs: 0,
      digest: "unavailable",
    })),
  );
  const result = yield* Effect.result(
    Effect.try(() => buildSnapshot({ codexHome, erebusDatabasePath: input.databasePath, nowMs })),
  );
  if (result._tag === "Failure") {
    return {
      readAt,
      error: "Codex agent session storage could not be inspected.",
      codexAvailable: false,
      subagentSessionCount: 0,
      subagentSessionBytes: 0,
      deletableSubagentCount: 0,
      deletableSubagentBytes: 0,
      protectedSubagentCount: 0,
      protectedSubagentBytes: 0,
      snapshotDigest: "unavailable",
      recoverySnapshotCount: recoverySnapshot.entries.length,
      recoverySnapshotBytes: recoverySnapshot.totalBytes,
      recoverySnapshotDigest: recoverySnapshot.digest,
      databaseBytes: databaseSnapshot.databaseBytes,
      reclaimableDatabaseBytes: databaseSnapshot.reclaimableBytes,
      databaseSnapshotDigest: databaseSnapshot.digest,
    };
  }
  const snapshot = result.success;
  return {
    readAt,
    error: null,
    codexAvailable: databasePaths(codexHome, CODEX_STATE_DATABASE).length > 0,
    subagentSessionCount: snapshot.totalCount,
    subagentSessionBytes: snapshot.totalBytes,
    deletableSubagentCount: snapshot.candidates.length,
    deletableSubagentBytes: snapshot.candidates.reduce(
      (sum, candidate) => sum + candidate.bytes,
      0,
    ),
    protectedSubagentCount: snapshot.protectedCount,
    protectedSubagentBytes: snapshot.protectedBytes,
    snapshotDigest: snapshot.digest,
    recoverySnapshotCount: recoverySnapshot.entries.length,
    recoverySnapshotBytes: recoverySnapshot.totalBytes,
    recoverySnapshotDigest: recoverySnapshot.digest,
    databaseBytes: databaseSnapshot.databaseBytes,
    reclaimableDatabaseBytes: databaseSnapshot.reclaimableBytes,
    databaseSnapshotDigest: databaseSnapshot.digest,
  };
});

export const deleteInactiveSubagents = Effect.fn("deleteInactiveSubagents")(function* (input: {
  readonly stateDir: string;
  readonly databasePath: string;
  readonly request: ServerDeleteInactiveSubagentsInput;
}): Effect.fn.Return<ServerDeleteInactiveSubagentsResult> {
  const codexHome = NodePath.join(input.stateDir, "providers", "codex");
  const nowMs = yield* Clock.currentTimeMillis;
  return yield* Effect.try(() =>
    performCleanup({
      codexHome,
      erebusDatabasePath: input.databasePath,
      request: input.request,
      nowMs,
    }),
  ).pipe(
    Effect.orElseSucceed(() => ({
      accepted: false,
      deletedCount: 0,
      deletedBytes: 0,
      message: "Codex agent session cleanup failed without deleting the selected files.",
    })),
  );
});

export const pruneExpiredInactiveSubagents = Effect.fn("pruneExpiredInactiveSubagents")(
  function* (input: {
    readonly stateDir: string;
    readonly databasePath: string;
  }): Effect.fn.Return<ServerDeleteInactiveSubagentsResult> {
    const codexHome = NodePath.join(input.stateDir, "providers", "codex");
    const nowMs = yield* Clock.currentTimeMillis;
    return yield* Effect.try(() => {
      const snapshot = buildSnapshot({
        codexHome,
        erebusDatabasePath: input.databasePath,
        nowMs,
        minimumIdleAgeMs: AUTOMATIC_CLEANUP_MINIMUM_IDLE_AGE_MS,
      });
      return performCleanup({
        codexHome,
        erebusDatabasePath: input.databasePath,
        request: { snapshotDigest: snapshot.digest },
        nowMs,
        minimumIdleAgeMs: AUTOMATIC_CLEANUP_MINIMUM_IDLE_AGE_MS,
      });
    }).pipe(
      Effect.orElseSucceed(() => ({
        accepted: false,
        deletedCount: 0,
        deletedBytes: 0,
        message: "Automatic Codex agent session cleanup was skipped.",
      })),
    );
  },
);

export const deleteCodexThreadHistories = Effect.fn("deleteCodexThreadHistories")(
  function* (input: {
    readonly stateDir: string;
    readonly providerThreadIds: ReadonlyArray<string>;
  }): Effect.fn.Return<boolean> {
    return yield* Effect.try(() =>
      performCodexThreadHistoryDeletion({
        codexHome: NodePath.join(input.stateDir, "providers", "codex"),
        providerThreadIds: input.providerThreadIds,
      }),
    ).pipe(Effect.orElseSucceed(() => false));
  },
);

export const compactDatabaseStorage = Effect.fn("compactDatabaseStorage")(function* (input: {
  readonly databasePath: string;
  readonly request: ServerCompactStorageInput;
  readonly sql: SqlClient.SqlClient;
}): Effect.fn.Return<ServerCompactStorageResult> {
  return yield* compactDatabase(input).pipe(
    Effect.orElseSucceed(() => ({
      accepted: false,
      beforeBytes: 0,
      afterBytes: 0,
      freedBytes: 0,
      message: "The local database could not be compacted. No data was removed.",
    })),
  );
});

export const deleteRecoverySnapshots = Effect.fn("deleteRecoverySnapshots")(function* (input: {
  readonly stateDir: string;
  readonly request: ServerDeleteRecoverySnapshotsInput;
}): Effect.fn.Return<ServerDeleteRecoverySnapshotsResult> {
  return yield* Effect.try(() => performRecoveryCleanup(input)).pipe(
    Effect.orElseSucceed(() => ({
      accepted: false,
      deletedCount: 0,
      deletedBytes: 0,
      message: "Recovery snapshot cleanup failed without deleting the selected entries.",
    })),
  );
});
