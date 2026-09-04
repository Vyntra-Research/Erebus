// @effect-diagnostics nodeBuiltinImport:off - command policy must compare host paths.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export const EREBUS_COMMAND_GUARD_REASON_MARKER = "[erebus-command-guard]";

export const EREBUS_CODEX_EXEC_POLICY = `# Managed by Erebus. Local user rules belong in other files.
# Full-access sessions use approvalPolicy=never. These rules are objective hard
# denials, not approval hooks, so allowed commands remain prompt-free.
prefix_rule(pattern=["rg"], decision="forbidden", justification="${EREBUS_COMMAND_GUARD_REASON_MARKER} Use a bounded native search instead of rg.")
prefix_rule(pattern=["rg.exe"], decision="forbidden", justification="${EREBUS_COMMAND_GUARD_REASON_MARKER} Use a bounded native search instead of rg.")
prefix_rule(pattern=[["diskpart", "diskpart.exe"]], decision="forbidden", justification="${EREBUS_COMMAND_GUARD_REASON_MARKER} Disk-wide mutation is blocked.")
prefix_rule(pattern=[["format", "format.com"]], decision="forbidden", justification="${EREBUS_COMMAND_GUARD_REASON_MARKER} Filesystem formatting is blocked.")
prefix_rule(pattern=[["docker", "docker.exe"], ["system", "container", "image", "volume", "network", "builder"], "prune"], decision="forbidden", justification="${EREBUS_COMMAND_GUARD_REASON_MARKER} Host-wide Docker cleanup is blocked; remove named lab resources instead.")
prefix_rule(pattern=[["git", "git.exe"], "reset", "--hard"], decision="forbidden", justification="${EREBUS_COMMAND_GUARD_REASON_MARKER} Destructive Git reset is blocked; preserve work and use a scoped operation.")
`;

export type CommandSafetyCode =
  | "blocked-tool"
  | "unsafe-copy"
  | "recursive-dependency-traversal"
  | "broad-recursive-search"
  | "sensitive-path-mutation"
  | "unsafe-recursive-delete"
  | "global-resource-destruction"
  | "pattern-process-kill"
  | "opaque-shell-command"
  | "destructive-vcs";

export type CommandSafetyDecision =
  | { readonly decision: "allow" }
  | {
      readonly decision: "block";
      readonly code: CommandSafetyCode;
      readonly reason: string;
      readonly remediation: string;
    };

export interface CommandSafetyContext {
  readonly command: string;
  readonly cwd: string;
  readonly workspaceRoot?: string;
  readonly userHome?: string;
  readonly tempRoot?: string;
}

const segmentStart = String.raw`(?:^|[;&|{}()\r\n])\s*(?:&\s*)?`;
const executablePath = String.raw`(?:(?:[A-Za-z]:)?[^\s;|&"']*[\\/])?`;

function invokes(command: string, names: ReadonlyArray<string>): boolean {
  const alternatives = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return new RegExp(
    `${segmentStart}(?:["']${executablePath})?(?:${alternatives})(?:\\.exe)?(?:["'])?(?=\\s|$)`,
    "iu",
  ).test(command);
}

function trimOuterQuotes(value: string): string {
  const trimmed = value.trim();
  const first = trimmed[0];
  return first && (first === '"' || first === "'") && trimmed.at(-1) === first
    ? trimmed.slice(1, -1).trim()
    : trimmed;
}

function shellPayloadAfter(command: string, marker: RegExp): string | null {
  const match = marker.exec(command);
  if (!match) return null;
  const payload = command.slice(match.index + match[0].length);
  return payload.trim().length > 0 ? trimOuterQuotes(payload) : null;
}

function nestedShellPayloads(command: string): ReadonlyArray<string> {
  const payloads: Array<string> = [];
  if (invokes(command, ["powershell", "pwsh"])) {
    const payload = shellPayloadAfter(command, /-(?:Command|C)\s+/iu);
    if (payload) payloads.push(payload);
  }
  if (invokes(command, ["cmd"])) {
    const payload = shellPayloadAfter(command, /\/[Cc]\s+/u);
    if (payload) payloads.push(payload);
  }
  if (invokes(command, ["bash", "sh"])) {
    const payload = shellPayloadAfter(command, /-[A-Za-z]*[Cc][A-Za-z]*\s+/u);
    if (payload) payloads.push(payload);
  }
  if (invokes(command, ["wsl"])) {
    const separatorPayload = shellPayloadAfter(command, /\s--\s+/u);
    if (separatorPayload) {
      payloads.push(separatorPayload);
    } else {
      const executable = command.match(
        /(?:^|[;&|{}()\r\n])\s*(?:&\s*)?(?:["']?[^\s;|&"']*[\\/])?["']?wsl(?:\.exe)?["']?\s+/iu,
      );
      if (executable) {
        const payload = command.slice((executable.index ?? 0) + executable[0].length).trim();
        if (payload && !payload.startsWith("-")) payloads.push(trimOuterQuotes(payload));
      }
    }
  }
  return payloads;
}

function usesFlag(command: string, flags: ReadonlyArray<string>): boolean {
  return flags.some((flag) =>
    new RegExp(`(?:^|\\s)${flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|$)`, "iu").test(
      command,
    ),
  );
}

function touchesDependencyTree(command: string): boolean {
  return /(?:^|[\\/\s"'])(?:node_modules|\.pnpm)(?=[\\/\s"']|$)/iu.test(command);
}

function pathApi(value: string): typeof NodePath.win32 | typeof NodePath.posix {
  return /^[A-Za-z]:[\\/]/u.test(value) || value.includes("\\") ? NodePath.win32 : NodePath.posix;
}

function normalizedPath(value: string): string {
  const api = pathApi(value);
  const resolved = api.resolve(value);
  const root = api.parse(resolved).root;
  const trimmed = resolved.length > root.length ? resolved.replace(/[\\/]+$/u, "") : resolved;
  return api === NodePath.win32 ? trimmed.toLowerCase() : trimmed;
}

function isWithin(candidate: string, root: string): boolean {
  const api = pathApi(root);
  const normalizedCandidate = normalizedPath(candidate);
  const normalizedRoot = normalizedPath(root);
  const relative = api.relative(normalizedRoot, normalizedCandidate);
  return relative === "" || (!relative.startsWith("..") && !api.isAbsolute(relative));
}

function resolveFromCwd(candidate: string, cwd: string): string {
  const unquoted = candidate.replace(/^["']|["']$/gu, "");
  const api = unquoted.startsWith("/") ? NodePath.posix : pathApi(cwd);
  return normalizedPath(
    api.isAbsolute(unquoted) ? api.resolve(unquoted) : api.resolve(cwd, unquoted),
  );
}

function explicitPowerShellPath(command: string): string | null {
  const match = command.match(/-(?:LiteralPath|Path)\s+(?:"([^"]+)"|'([^']+)'|([^\s;|]+))/iu);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function containsUnresolvedOrBroadPath(value: string): boolean {
  return (
    value === "." ||
    value === ".." ||
    value === "~" ||
    /[*?]/u.test(value) ||
    /(?:\$(?:HOME|env:USERPROFILE)|%USERPROFILE%|%HOMEDRIVE%|%HOMEPATH%)/iu.test(value) ||
    /^\$[A-Za-z_][A-Za-z0-9_]*$/u.test(value)
  );
}

function isDriveOrFilesystemRoot(value: string): boolean {
  const normalized = normalizedPath(value);
  return normalized === normalizedPath(pathApi(value).parse(value).root || "/");
}

function commandAbsolutePaths(command: string): ReadonlyArray<string> {
  const paths = new Set<string>();
  for (const match of command.matchAll(/["']([A-Za-z]:[\\/][^"']+)["']/gu)) {
    if (match[1]) paths.add(match[1]);
  }
  for (const match of command.matchAll(/(?:^|\s)([A-Za-z]:[\\/][^\s;|&"']+)/gu)) {
    if (match[1]) paths.add(match[1]);
  }
  for (const match of command.matchAll(/(?:^|\s|["'])(\/(?!\/)[^\s;|&"']+)/gu)) {
    if (match[1] && !/^\/[A-Za-z](?::\d+)?$/u.test(match[1])) paths.add(match[1]);
  }
  return [...paths];
}

function commandArguments(command: string, names: ReadonlyArray<string>): ReadonlyArray<string> {
  const alternatives = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const invocation = new RegExp(
    `${segmentStart}(?:["']${executablePath})?(?:${alternatives})(?:\\.exe)?(?:["'])?(?=\\s|$)`,
    "iu",
  ).exec(command);
  if (!invocation) return [];

  const source = command.slice(invocation.index + invocation[0].length);
  const tokens: Array<string> = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const character of source) {
    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/[;&|{}()\r\n]/u.test(character)) break;
    if (/\s/u.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }
  if (current) tokens.push(current);
  return tokens;
}

function explicitRecursiveDeleteTargets(command: string): ReadonlyArray<string> {
  const powershellTarget = explicitPowerShellPath(command);
  if (invokes(command, ["Remove-Item"])) return powershellTarget ? [powershellTarget] : [];
  if (invokes(command, ["rm"])) {
    return commandArguments(command, ["rm"]).filter((argument) => !argument.startsWith("-"));
  }
  if (invokes(command, ["rmdir", "rd", "del", "erase"])) {
    return commandArguments(command, ["rmdir", "rd", "del", "erase"]).filter(
      (argument) => !/^\/[A-Za-z]+$/u.test(argument),
    );
  }
  return [];
}

function isDirectChild(candidate: string, parent: string): boolean {
  const api = pathApi(parent);
  return normalizedPath(api.dirname(candidate)) === normalizedPath(parent);
}

function isProtectedHostPath(candidate: string, userHome: string): boolean {
  const api = pathApi(candidate);
  const normalizedCandidate = normalizedPath(candidate);
  if (isDriveOrFilesystemRoot(candidate) || normalizedCandidate === normalizedPath(userHome)) {
    return true;
  }
  if (api !== NodePath.win32) {
    return ["/bin", "/boot", "/etc", "/lib", "/lib64", "/sbin", "/usr"].some((root) =>
      isWithin(candidate, root),
    );
  }

  const driveRoot = api.parse(userHome).root;
  return ["Windows", "Program Files", "Program Files (x86)", "ProgramData"].some((name) =>
    isWithin(candidate, api.join(driveRoot, name)),
  );
}

function block(
  code: CommandSafetyCode,
  reason: string,
  remediation: string,
): CommandSafetyDecision {
  return { decision: "block", code, reason, remediation };
}

function evaluateCommandSafetyAtDepth(
  input: CommandSafetyContext,
  depth: number,
): CommandSafetyDecision {
  const command = input.command.trim();
  if (!command) return { decision: "allow" };

  const cwd = normalizedPath(input.cwd);
  const workspaceRoot = normalizedPath(input.workspaceRoot ?? input.cwd);
  const userHome = normalizedPath(input.userHome ?? NodeOS.homedir());
  const tempRoot = normalizedPath(input.tempRoot ?? NodeOS.tmpdir());

  if (invokes(command, ["powershell", "pwsh"]) && /-(?:EncodedCommand|Enc)\b/iu.test(command)) {
    return block(
      "opaque-shell-command",
      "Encoded shell commands cannot be inspected by the Erebus command guard.",
      "Run the same bounded operation as readable shell text so the guard and Observer can audit it.",
    );
  }

  if (depth < 4) {
    for (const payload of nestedShellPayloads(command)) {
      const nestedDecision = evaluateCommandSafetyAtDepth(
        { ...input, command: payload },
        depth + 1,
      );
      if (nestedDecision.decision === "block") return nestedDecision;
    }
  }

  if (invokes(command, ["rg"])) {
    return block(
      "blocked-tool",
      "rg is disabled by the Erebus global command policy.",
      "Search a narrow source directory with Get-ChildItem and Select-String, and exclude generated trees.",
    );
  }

  if (invokes(command, ["robocopy"])) {
    const destructiveFlags = usesFlag(command, ["/MIR", "/MOVE", "/MOV", "/PURGE"]);
    const recursiveCopy = usesFlag(command, ["/E", "/S", "/MIR"]);
    const excludesJunctions = usesFlag(command, ["/XJ"]);
    const parallelism = Number(/(?:^|\s)\/MT:(\d+)(?=\s|$)/iu.exec(command)?.[1] ?? "0");
    if (
      destructiveFlags ||
      touchesDependencyTree(command) ||
      (recursiveCopy && !excludesJunctions) ||
      parallelism > 32
    ) {
      return block(
        "unsafe-copy",
        "This robocopy command can destructively mirror or move data, traverse dependencies or junctions, or use excessive parallelism.",
        "Use explicit source and target paths. For a recursive copy, add /XJ, exclude dependency trees, avoid /MIR, /PURGE, /MOVE, and /MOV, and keep /MT at 32 or below.",
      );
    }
  }

  const recursive =
    /(?:^|\s)(?:-Recurse|-R|-r|--recursive|\/E|\/S)(?=\s|$)/u.test(command) ||
    /\brm\s+-[^\s]*r[^\s]*/iu.test(command);
  const touchesDependencies = touchesDependencyTree(command);
  const followsLinks =
    /(?:^|\s)-FollowSymlink(?=\s|$)/iu.test(command) ||
    (invokes(command, ["grep"]) && usesFlag(command, ["-R"]));
  if (recursive && followsLinks) {
    return block(
      "broad-recursive-search",
      "Recursive link traversal can escape the intended tree or loop across reparse points.",
      "Do not follow symlinks, junctions, or reparse points. Search one explicit real source directory at a time.",
    );
  }
  if (
    recursive &&
    touchesDependencies &&
    (invokes(command, ["Get-ChildItem", "gci", "find", "grep", "Copy-Item", "cp", "robocopy"]) ||
      /Select-String/iu.test(command))
  ) {
    return block(
      "recursive-dependency-traversal",
      "Recursive search or copy across node_modules is unbounded and may cross package-manager junctions.",
      "Inspect one package or source directory at a time. Never materialize node_modules; reinstall dependencies in the isolated lab when needed.",
    );
  }

  if (touchesDependencies && invokes(command, ["Compress-Archive", "tar", "7z"])) {
    return block(
      "recursive-dependency-traversal",
      "Archiving a dependency or package-store tree can expand across links and consume unbounded disk space.",
      "Archive only exact source, PoC, or finding files. Reinstall dependencies in the destination instead of copying or archiving them.",
    );
  }

  if (invokes(command, ["Get-ChildItem", "gci"]) && /(?:^|\s)-Recurse(?=\s|$)/iu.test(command)) {
    const target = explicitPowerShellPath(command);
    if (target && containsUnresolvedOrBroadPath(target) && target !== ".") {
      return block(
        "broad-recursive-search",
        "Recursive Get-ChildItem cannot safely resolve this target.",
        "Use a literal path without wildcards or environment-variable expansion and exclude generated or dependency trees.",
      );
    }
    const resolvedTarget = resolveFromCwd(target ?? cwd, cwd);
    if (
      resolvedTarget === userHome ||
      isDriveOrFilesystemRoot(resolvedTarget) ||
      touchesDependencies
    ) {
      return block(
        "broad-recursive-search",
        "The recursive search targets a user home, filesystem root, or dependency tree.",
        "Search a smaller source subtree with an explicit -LiteralPath.",
      );
    }
  }

  if (
    (invokes(command, ["find"]) ||
      (invokes(command, ["grep"]) && usesFlag(command, ["-R", "-r", "--recursive"]))) &&
    (/(?:^|\s)(?:\/|~)(?=\s|$)/u.test(command) ||
      /(?:^|\s)(?:\/home|\/mnt\/[a-z]\/Users)(?=\s|$)/iu.test(command) ||
      touchesDependencies ||
      commandAbsolutePaths(command).some((candidate) => {
        const resolved = resolveFromCwd(candidate, cwd);
        return resolved === userHome || isDriveOrFilesystemRoot(resolved);
      }))
  ) {
    return block(
      "broad-recursive-search",
      "The recursive search starts at a broad root or dependency tree.",
      "Use a narrow source path and a bounded file filter.",
    );
  }

  const invokesGit = invokes(command, ["git"]);
  const gitArguments = invokesGit ? commandArguments(command, ["git"]) : [];
  const cleanIndex = gitArguments.findIndex((argument) => argument.toLowerCase() === "clean");
  const cleanTargets =
    cleanIndex < 0
      ? []
      : gitArguments
          .slice(cleanIndex + 1)
          .filter((argument) => argument !== "--" && !argument.startsWith("-"));
  const forcedGitClean =
    cleanIndex >= 0 &&
    /(?:^|\s)(?:-[^\s]*f[^\s]*|--force)(?=\s|$)/iu.test(command) &&
    (cleanTargets.length === 0 ||
      cleanTargets.some(
        (target) => containsUnresolvedOrBroadPath(target) || touchesDependencyTree(target),
      ));
  const destructiveVcs =
    invokesGit && (forcedGitClean || /\bgit(?:\.exe)?\s+reset\s+--hard\b/iu.test(command));
  if (destructiveVcs) {
    return block(
      "destructive-vcs",
      "This version-control command can discard or delete local work.",
      "Inspect status and diffs first. Preserve unrelated changes and remove or restore only exact user-approved paths.",
    );
  }

  const destructiveRecursive =
    (invokes(command, ["Remove-Item"]) && /(?:^|\s)-Recurse(?=\s|$)/iu.test(command)) ||
    /(?:^|[;&|{}()\r\n])\s*rm\s+-[^\s]*r[^\s]*/iu.test(command) ||
    (invokes(command, ["rmdir", "rd", "del", "erase"]) && usesFlag(command, ["/S"])) ||
    forcedGitClean;

  if (destructiveRecursive) {
    const targets = explicitRecursiveDeleteTargets(command);
    const unsafeTarget =
      targets.length !== 1 ||
      targets.some(
        (target) =>
          containsUnresolvedOrBroadPath(target) ||
          (() => {
            const resolvedTarget = resolveFromCwd(target, cwd);
            return (
              resolvedTarget === workspaceRoot ||
              isProtectedHostPath(resolvedTarget, userHome) ||
              isDirectChild(resolvedTarget, userHome) ||
              isDirectChild(resolvedTarget, pathApi(resolvedTarget).parse(resolvedTarget).root) ||
              touchesDependencyTree(target)
            );
          })(),
      );
    if (unsafeTarget) {
      return block(
        "unsafe-recursive-delete",
        "Recursive deletion requires one resolved, bounded target and cannot affect a home, filesystem, workspace, dependency, or protected host root.",
        "Delete one explicit task-owned path. Never target a broad root, wildcard, unresolved variable, dependency tree, or protected host directory.",
      );
    }
  }

  const mutatesFiles =
    destructiveRecursive ||
    invokes(command, [
      "Remove-Item",
      "Move-Item",
      "Copy-Item",
      "Set-Content",
      "Add-Content",
      "Out-File",
      "New-Item",
      "rm",
      "mv",
      "cp",
      "del",
      "erase",
      "rmdir",
      "rd",
    ]) ||
    /(?:^|[^>])>{1,2}\s*(?:["']?[A-Za-z]:[\\/]|["']?~)/u.test(command);
  if (mutatesFiles) {
    const unsafeAbsolutePath = commandAbsolutePaths(command)
      .map((candidate) => resolveFromCwd(candidate, cwd))
      .some((candidate) => {
        if (isWithin(candidate, workspaceRoot) || isWithin(candidate, tempRoot)) return false;
        return (
          isProtectedHostPath(candidate, userHome) ||
          isDirectChild(candidate, userHome) ||
          isDirectChild(candidate, pathApi(candidate).parse(candidate).root)
        );
      });
    if (unsafeAbsolutePath) {
      return block(
        "sensitive-path-mutation",
        "The command mutates a protected host path, filesystem root, or a loose file directly in the user-home root.",
        "Use the assigned workspace as the host lab, use system temp for disposable scratch data, or target one explicitly scoped external project path.",
      );
    }
  }

  if (
    /\bdocker\s+(?:system|volume|builder)\s+prune\b/iu.test(command) ||
    /\bwsl(?:\.exe)?\s+--(?:unregister|shutdown)\b/iu.test(command) ||
    invokes(command, ["diskpart", "format"])
  ) {
    return block(
      "global-resource-destruction",
      "The command destroys host-wide Docker, WSL, disk, or volume state.",
      "Remove only the exact container, image, volume, distribution, or lab resource created for this task after verifying its identity.",
    );
  }

  if (
    /\btaskkill(?:\.exe)?\b[^\r\n]*(?:\/IM|\*)/iu.test(command) ||
    /\bStop-Process\b[^\r\n]*-(?:Name|InputObject)\b/iu.test(command) ||
    /(?:^|[;&|{}()\r\n])\s*(?:pkill|killall)\b/iu.test(command)
  ) {
    return block(
      "pattern-process-kill",
      "Pattern-based process termination can kill unrelated Erebus, Codex, lab, or user processes.",
      "Capture the exact PID when the task starts, verify its executable and working directory, then stop only that PID.",
    );
  }

  return { decision: "allow" };
}

export function evaluateCommandSafety(input: CommandSafetyContext): CommandSafetyDecision {
  return evaluateCommandSafetyAtDepth(input, 0);
}

export function redactCommandForAudit(command: string, maximumLength = 600): string {
  const redacted = command
    .replace(/(Authorization\s*:\s*(?:Bearer|Basic)\s+)[^\s"']+/giu, "$1<redacted>")
    .replace(
      /\b(api[_-]?key|token|password|passwd|secret|authorization)\b(\s*[:=]\s*)(["']?)[^\s;|&"']+\3/giu,
      "$1$2<redacted>",
    )
    .replace(
      /([?&](?:access_token|api_key|key|token|secret|password)=)[^&#\s]+/giu,
      "$1<redacted>",
    );
  return redacted.length <= maximumLength
    ? redacted
    : `${redacted.slice(0, Math.max(0, maximumLength - 1))}…`;
}
