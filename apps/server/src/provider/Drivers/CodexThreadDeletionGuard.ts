// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

const stateDatabaseName = "state_5.sqlite";
const comparablePath = (path: string) => {
  const resolved = NodePath.resolve(path);
  return NodePath.sep === "\\" ? resolved.toLowerCase() : resolved;
};

/** Inspect native history before deleting a co-agent and its spawned descendants. */
export function inspectManagedCodexThreadDeletion(input: {
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string;
  readonly providerThreadId: string;
}): { readonly indexedHere: boolean; readonly indexedElsewhere: boolean } {
  const currentHome = comparablePath(input.effectiveHomePath);
  const currentStatePath = NodePath.join(input.effectiveHomePath, stateDatabaseName);
  if (!NodeFS.existsSync(currentStatePath) || !NodeFS.lstatSync(currentStatePath).isFile()) {
    throw new Error(`Codex state index is unavailable: ${currentStatePath}`);
  }
  const currentDb = new NodeSqlite.DatabaseSync(currentStatePath, { readOnly: true });
  let nativeThreadIds: ReadonlyArray<string>;
  let indexedHere: boolean;
  try {
    indexedHere = Boolean(
      currentDb.prepare("SELECT 1 FROM threads WHERE id = ? LIMIT 1").get(input.providerThreadId),
    );
    nativeThreadIds = currentDb
      .prepare(
        `WITH RECURSIVE descendants(id) AS (
          SELECT ?
          UNION
          SELECT edges.child_thread_id
          FROM thread_spawn_edges edges
          JOIN descendants ON descendants.id = edges.parent_thread_id
        ) SELECT id FROM descendants`,
      )
      .all(input.providerThreadId)
      .map((row) => String(row.id));
  } finally {
    currentDb.close();
  }
  const candidates = [input.sharedHomePath];
  const accountsPath = NodePath.join(input.sharedHomePath, "accounts");
  if (NodeFS.existsSync(accountsPath)) {
    for (const entry of NodeFS.readdirSync(accountsPath, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        candidates.push(NodePath.join(accountsPath, entry.name));
      }
    }
  }

  for (const home of candidates) {
    if (comparablePath(home) === currentHome) continue;
    const statePath = NodePath.join(home, stateDatabaseName);
    if (!NodeFS.existsSync(statePath)) continue;
    if (!NodeFS.lstatSync(statePath).isFile()) {
      throw new Error(`Codex state index is not a regular file: ${statePath}`);
    }
    const db = new NodeSqlite.DatabaseSync(statePath, { readOnly: true });
    try {
      const indexed = db.prepare("SELECT 1 FROM threads WHERE id = ? LIMIT 1");
      for (const nativeThreadId of nativeThreadIds) {
        if (indexed.get(nativeThreadId)) return { indexedHere, indexedElsewhere: true };
      }
    } finally {
      db.close();
    }
  }
  return { indexedHere, indexedElsewhere: false };
}
