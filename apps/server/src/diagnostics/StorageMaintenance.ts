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
  ServerStorageDiagnosticsResult,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

const CODEX_STATE_DATABASE = /^state_\d+\.sqlite$/u;
const CODEX_HISTORY_DATABASE = /^thread_history_\d+\.sqlite$/u;
const MINIMUM_IDLE_AGE_MS = 10 * 60 * 1_000;

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
  appendDirectMatches(codexHome);
  const accountsRoot = NodePath.join(codexHome, "accounts");
  if (NodeFS.existsSync(accountsRoot)) {
    for (const account of NodeFS.readdirSync(accountsRoot, { withFileTypes: true })) {
      if (!account.isDirectory()) continue;
      appendDirectMatches(NodePath.join(account.parentPath, account.name));
    }
  }
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
  const lockRoot = NodePath.join(input.codexHome, "thread-writer-locks");
  const sessionRoots = ["sessions", "archived_sessions"]
    .map((name) => NodePath.join(input.codexHome, name))
    .filter(NodeFS.existsSync)
    .map((root) => NodeFS.realpathSync.native(root));
  const protectedIds = new Set<string>();

  for (const row of rows) {
    let current: string | undefined = row.id;
    const visited = new Set<string>();
    while (current && !visited.has(current)) {
      visited.add(current);
      if (active.has(current) || NodeFS.existsSync(NodePath.join(lockRoot, `${current}.lock`))) {
        for (const id of visited) protectedIds.add(id);
        break;
      }
      current = parentByChild.get(current);
    }
    if (!parentByChild.has(row.id)) protectedIds.add(row.id);
  }

  // If an active descendant is protected, retain its whole ancestry as well.
  for (const id of protectedIds) {
    let current = parentByChild.get(id);
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
      protectedIds.has(row.id) || !valid || row.updatedAtMs > input.nowMs - MINIMUM_IDLE_AGE_MS;
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
    } catch (cause) {
      database.exec("ROLLBACK");
      throw cause;
    }
  } finally {
    database.close();
  }
}

function performCleanup(input: {
  readonly codexHome: string;
  readonly erebusDatabasePath: string;
  readonly request: ServerDeleteInactiveSubagentsInput;
  readonly nowMs: number;
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
