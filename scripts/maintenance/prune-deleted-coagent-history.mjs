import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";
import * as NodePath from "node:path";

const args = process.argv.slice(2);
const valueAfter = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const userdataArg = valueAfter("--userdata");
const codexEntrypoint = valueAfter("--codex-entrypoint");
const apply = args.includes("--apply");
const maxArg = valueAfter("--max");
const max = maxArg === undefined ? Number.POSITIVE_INFINITY : Number(maxArg);

if (!userdataArg || !NodePath.isAbsolute(userdataArg) || (apply && !codexEntrypoint)) {
  throw new Error(
    "Usage: node prune-deleted-coagent-history.mjs --userdata <absolute Erebus userdata> [--codex-entrypoint <absolute codex.js> --apply]",
  );
}
if (apply && (!NodePath.isAbsolute(codexEntrypoint) || !NodeFS.existsSync(codexEntrypoint))) {
  throw new Error("The Codex entrypoint must be an existing absolute file.");
}
if ((!Number.isInteger(max) && max !== Number.POSITIVE_INFINITY) || max < 1) {
  throw new Error("--max must be a positive integer.");
}

const userdata = NodeFS.realpathSync.native(userdataArg);
const codexHome = NodePath.join(userdata, "providers", "codex");
const sessionsHome = NodeFS.realpathSync.native(NodePath.join(codexHome, "sessions"));
const statePath = NodePath.join(userdata, "state.sqlite");
if (
  !NodeFS.existsSync(statePath) ||
  !NodeFS.existsSync(NodePath.join(codexHome, "state_5.sqlite"))
) {
  throw new Error("The selected directory is not an Erebus userdata directory with Codex history.");
}
const erebus = new NodeSqlite.DatabaseSync(statePath, { readOnly: true });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const cursorId = (json) => {
  try {
    const threadId = JSON.parse(json)?.threadId;
    return typeof threadId === "string" && uuid.test(threadId) ? threadId : null;
  } catch {
    return null;
  }
};
const rows = erebus
  .prepare(`
  SELECT c.child_thread_id AS erebus_id, t.deleted_at, p.provider_instance_id AS account,
         p.resume_cursor_json AS cursor
  FROM coagent_threads c
  JOIN projection_threads t ON t.thread_id = c.child_thread_id
  LEFT JOIN provider_session_runtime p ON p.thread_id = c.child_thread_id
`)
  .all();
const visibleCursorIds = () =>
  new Set(
    erebus
      .prepare(`
    SELECT p.resume_cursor_json AS cursor
    FROM projection_threads t
    JOIN provider_session_runtime p ON p.thread_id = t.thread_id
    WHERE t.deleted_at IS NULL
  `)
      .all()
      .map((row) => cursorId(row.cursor))
      .filter(Boolean),
  );

const accountNames = [...new Set(rows.map((row) => row.account).filter(Boolean))];
const accounts = new Map();
for (const account of accountNames) {
  if (account !== "codex" && !/^codex_[a-z0-9_-]+$/i.test(account)) {
    throw new Error("An unexpected Codex account identifier was found; cleanup stopped.");
  }
  const home = account === "codex" ? codexHome : NodePath.join(codexHome, "accounts", account);
  const state = NodePath.join(home, "state_5.sqlite");
  if (!NodeFS.existsSync(state)) continue;
  const db = new NodeSqlite.DatabaseSync(state, { readOnly: true });
  const indexed = new Map(
    db
      .prepare("SELECT id, rollout_path FROM threads")
      .all()
      .map((row) => [row.id, row]),
  );
  const edges = new Map();
  for (const edge of db
    .prepare("SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges")
    .all()) {
    const children = edges.get(edge.parent_thread_id) ?? [];
    children.push(edge.child_thread_id);
    edges.set(edge.parent_thread_id, children);
  }
  accounts.set(account, { home, db, indexed, edges });
}

const isWithin = (base, candidate) => {
  const rel = NodePath.relative(base, candidate);
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(`..\\`) &&
    !rel.startsWith("../") &&
    !NodePath.isAbsolute(rel)
  );
};
const safeRolloutSize = (rolloutPath) => {
  if (!rolloutPath || !NodePath.isAbsolute(rolloutPath)) return null;
  try {
    const real = NodeFS.realpathSync.native(rolloutPath);
    if (!isWithin(sessionsHome, real)) return null;
    return NodeFS.statSync(real).size;
  } catch {
    return null;
  }
};
const descendants = (root, edges) => {
  const closure = new Set();
  const pending = [root];
  while (pending.length) {
    const id = pending.pop();
    if (closure.has(id)) continue;
    closure.add(id);
    pending.push(...(edges.get(id) ?? []));
  }
  return closure;
};

const eligible = [];
const skipped = [];
const protectedIds = visibleCursorIds();
const claimedDescendants = new Set();
for (const row of rows.filter((candidate) => candidate.deleted_at !== null)) {
  const root = cursorId(row.cursor);
  const account = accounts.get(row.account);
  if (!root || !account) {
    skipped.push({ reason: "missing provider identity" });
    continue;
  }
  const closure = descendants(root, account.edges);
  const otherAccountIds = [...accounts.entries()]
    .filter(([name]) => name !== row.account)
    .map(([, value]) => value.indexed);
  const unsafe = [...closure].some(
    (id) =>
      protectedIds.has(id) ||
      claimedDescendants.has(id) ||
      otherAccountIds.some((index) => index.has(id)),
  );
  const sizes = [...closure].map((id) => safeRolloutSize(account.indexed.get(id)?.rollout_path));
  if (unsafe || sizes.some((size) => size === null)) {
    skipped.push({ reason: unsafe ? "visible or cross-account reference" : "unverified rollout" });
    continue;
  }
  eligible.push({
    erebusId: row.erebus_id,
    root,
    accountName: row.account,
    account,
    bytes: sizes.reduce((sum, size) => sum + size, 0),
    closure,
  });
  for (const id of closure) claimedDescendants.add(id);
}

const bytes = eligible.reduce((sum, target) => sum + target.bytes, 0);
console.log(
  `Eligible: ${eligible.length} removed co-agents, ${(bytes / 2 ** 30).toFixed(2)} GiB of verified rollout files.`,
);
console.log(`Skipped: ${skipped.length} (ambiguous identity, references, or missing files).`);
if (!apply) {
  console.log("Dry run only. Nothing was deleted.");
  process.exit(0);
}

let removed = 0;
let failed = 0;
for (const target of eligible.slice(0, max)) {
  const current = erebus
    .prepare(`
    SELECT t.deleted_at, p.provider_instance_id AS account, p.resume_cursor_json AS cursor
    FROM projection_threads t
    JOIN provider_session_runtime p ON p.thread_id = t.thread_id
    WHERE t.thread_id = ?
  `)
    .get(target.erebusId);
  if (
    !current?.deleted_at ||
    current.account !== target.accountName ||
    cursorId(current.cursor) !== target.root ||
    [...target.closure].some((id) => visibleCursorIds().has(id))
  ) {
    failed++;
    continue;
  }
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [codexEntrypoint, "delete", "--force", target.root],
    {
      cwd: NodePath.resolve(userdata),
      env: { ...process.env, CODEX_HOME: target.account.home },
      encoding: "utf8",
      timeout: 120_000,
      windowsHide: true,
    },
  );
  const stillIndexed = Boolean(
    target.account.db.prepare("SELECT 1 FROM threads WHERE id = ?").get(target.root),
  );
  if (result.status !== 0 || stillIndexed) {
    console.error(
      `Failed ${target.root}: exit=${result.status ?? "none"}, signal=${result.signal ?? "none"}, indexed=${stillIndexed}, error=${result.error?.code ?? "none"}, detail=${(result.stderr ?? "").trim().slice(0, 240)}`,
    );
    failed++;
  } else {
    removed++;
  }
  if ((removed + failed) % 10 === 0)
    console.log(
      `Processed ${removed + failed}/${eligible.length}: ${removed} removed, ${failed} skipped or failed.`,
    );
}
console.log(
  `Finished: ${removed} removed, ${failed} skipped or failed, ${skipped.length} excluded before execution.`,
);
if (failed) process.exitCode = 1;
