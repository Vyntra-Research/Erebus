import { describe, expect, it } from "vite-plus/test";

import {
  EREBUS_CODEX_EXEC_POLICY,
  evaluateCommandSafety,
  redactCommandForAudit,
} from "./commandSafety.ts";

const context = (command: string, cwd = "C:\\Users\\researcher\\work\\target") => ({
  command,
  cwd,
  workspaceRoot: "C:\\Users\\researcher\\work\\target",
  userHome: "C:\\Users\\researcher",
  tempRoot: "C:\\Users\\researcher\\AppData\\Local\\Temp",
});

describe("evaluateCommandSafety", () => {
  it("blocks rg without confusing a search for the literal name", () => {
    expect(evaluateCommandSafety(context("rg --files apps/server/src"))).toMatchObject({
      decision: "block",
      code: "blocked-tool",
    });
    expect(
      evaluateCommandSafety(
        context("Get-ChildItem -LiteralPath apps/server/src | Select-String -Pattern 'rg'"),
      ),
    ).toEqual({ decision: "allow" });
  });

  it("inspects commands nested in supported shell wrappers", () => {
    expect(
      evaluateCommandSafety(context('pwsh.exe -NoProfile -Command "rg --files apps/server/src"')),
    ).toMatchObject({ decision: "block", code: "blocked-tool" });
    expect(
      evaluateCommandSafety(
        context('cmd.exe /c "robocopy C:\\repo\\node_modules C:\\repo\\work\\copy /E /MT:16"'),
      ),
    ).toMatchObject({ decision: "block", code: "unsafe-copy" });
    expect(
      evaluateCommandSafety(
        context(
          "pwsh -Command \"Get-ChildItem -LiteralPath apps/server/src | Select-String -Pattern 'rg'\"",
        ),
      ),
    ).toEqual({ decision: "allow" });
    expect(
      evaluateCommandSafety(
        context(
          "$src='C:\\Users\\researcher\\other-repo\\packages\\app\\src'; Get-ChildItem -LiteralPath $src -Recurse -File | Select-String -Pattern handler",
        ),
      ),
    ).toEqual({ decision: "allow" });
    expect(
      evaluateCommandSafety(
        context("$src='C:\\Users\\researcher'; Get-ChildItem -LiteralPath $src -Recurse -File"),
      ),
    ).toMatchObject({ decision: "block", code: "broad-recursive-search" });
  });

  it("does not mistake an absolute shell executable for a mutation target", () => {
    const safePayload =
      "$d='C:\\Users\\researcher\\work\\target\\reachability'; New-Item -ItemType Directory -Force -Path $d | Out-Null; Get-Item -LiteralPath $d";
    expect(
      evaluateCommandSafety(
        context(
          `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -Command "${safePayload}"`,
        ),
      ),
    ).toEqual({ decision: "allow" });

    const unsafePayload =
      "New-Item -ItemType Directory -Force -Path C:\\Windows\\System32\\unsafe-artifact";
    expect(
      evaluateCommandSafety(
        context(
          `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -Command "${unsafePayload}"`,
        ),
      ),
    ).toMatchObject({ decision: "block", code: "sensitive-path-mutation" });

    expect(
      evaluateCommandSafety(
        context(
          '"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "docker exec target-gitlab sh -c \'test -f /tmp/task-probe.rb && rm /tmp/task-probe.rb || true\'"',
        ),
      ),
    ).toEqual({ decision: "allow" });
  });

  it("blocks opaque encoded PowerShell commands", () => {
    expect(
      evaluateCommandSafety(context("powershell.exe -EncodedCommand ZQBjAGgAbwAgAHg=")),
    ).toMatchObject({ decision: "block", code: "opaque-shell-command" });
  });

  it("blocks the recursive robocopy shape from the disk incident", () => {
    expect(
      evaluateCommandSafety(
        context("robocopy C:\\repo\\node_modules C:\\repo\\work\\case\\node_modules /E /MT:16"),
      ),
    ).toMatchObject({ decision: "block", code: "unsafe-copy" });
  });

  it("permits bounded robocopy and rejects destructive or unbounded forms", () => {
    expect(
      evaluateCommandSafety(context("robocopy C:\\repo\\one.txt C:\\repo\\work\\one.txt")),
    ).toEqual({ decision: "allow" });
    expect(
      evaluateCommandSafety(
        context('robocopy "C:\\external lab\\source" "D:\\target lab\\copy" /E /XJ /MT:16'),
      ),
    ).toEqual({ decision: "allow" });
    expect(evaluateCommandSafety(context("robocopy C:\\repo D:\\backup /MIR /XJ"))).toMatchObject({
      decision: "block",
      code: "unsafe-copy",
    });
    expect(evaluateCommandSafety(context("robocopy C:\\repo D:\\backup /E"))).toMatchObject({
      decision: "block",
      code: "unsafe-copy",
    });
  });

  it("allows workspace recursion but blocks host roots, dependencies, and followed links", () => {
    expect(evaluateCommandSafety(context("Get-ChildItem -LiteralPath . -Recurse -File"))).toEqual({
      decision: "allow",
    });
    expect(
      evaluateCommandSafety(
        context(
          "Get-ChildItem -LiteralPath apps/server/src/research -Recurse -File | Select-String -Pattern policy",
        ),
      ),
    ).toEqual({ decision: "allow" });
    expect(
      evaluateCommandSafety(
        context(
          "Get-ChildItem -LiteralPath C:\\Users\\researcher\\other-repo\\src -Recurse -File | Select-String -Pattern handler",
        ),
      ),
    ).toEqual({ decision: "allow" });
    expect(
      evaluateCommandSafety(context("Get-ChildItem -LiteralPath node_modules -Recurse -File")),
    ).toMatchObject({ decision: "block", code: "recursive-dependency-traversal" });
    expect(
      evaluateCommandSafety(
        context("Get-ChildItem -LiteralPath apps/server/src -Recurse -FollowSymlink -File"),
      ),
    ).toMatchObject({ decision: "block", code: "broad-recursive-search" });
    expect(
      evaluateCommandSafety(
        context("Get-ChildItem -LiteralPath C:\\Users\\researcher -Recurse -File"),
      ),
    ).toMatchObject({ decision: "block", code: "broad-recursive-search" });
  });

  it("blocks package-store archives and broad recursive external searches", () => {
    expect(
      evaluateCommandSafety(context("tar -cf .\\work\\deps.tar .\\node_modules")),
    ).toMatchObject({ decision: "block", code: "recursive-dependency-traversal" });
    expect(evaluateCommandSafety(context("grep -r pattern C:\\Users\\researcher"))).toMatchObject({
      decision: "block",
      code: "broad-recursive-search",
    });
  });

  it("blocks unresolved or protected recursive deletion while allowing exact external labs", () => {
    expect(
      evaluateCommandSafety(context("Remove-Item -LiteralPath $target -Recurse -Force")),
    ).toMatchObject({ decision: "block", code: "unsafe-recursive-delete" });
    expect(
      evaluateCommandSafety(context("Remove-Item -LiteralPath . -Recurse -Force")),
    ).toMatchObject({ decision: "block", code: "unsafe-recursive-delete" });
    expect(
      evaluateCommandSafety(
        context(
          "Remove-Item -LiteralPath C:\\Users\\researcher\\Downloads\\fixture -Recurse -Force",
        ),
      ),
    ).toEqual({ decision: "allow" });
    expect(
      evaluateCommandSafety(
        context("Remove-Item -LiteralPath .\\work\\old-fixture -Recurse -Force"),
      ),
    ).toEqual({ decision: "allow" });
    expect(evaluateCommandSafety(context("wsl -- rm -rf /tmp/task-fixture"))).toEqual({
      decision: "allow",
    });
    expect(evaluateCommandSafety(context("wsl -- rm -rf /tmp"))).toMatchObject({
      decision: "block",
      code: "unsafe-recursive-delete",
    });
    expect(evaluateCommandSafety(context("wsl -- rm -rf /etc/task-fixture"))).toMatchObject({
      decision: "block",
      code: "unsafe-recursive-delete",
    });
  });

  it("blocks protected or loose home-root writes but allows scoped external work", () => {
    expect(
      evaluateCommandSafety(
        context("Set-Content -LiteralPath C:\\Users\\researcher\\attack.txt -Value data"),
      ),
    ).toMatchObject({ decision: "block", code: "sensitive-path-mutation" });
    expect(
      evaluateCommandSafety(context("Set-Content -LiteralPath .\\work\\result.txt -Value data")),
    ).toEqual({ decision: "allow" });
    expect(
      evaluateCommandSafety(
        context(
          "Set-Content -LiteralPath C:\\Users\\researcher\\other-repo\\result.txt -Value data",
        ),
      ),
    ).toEqual({ decision: "allow" });
    expect(
      evaluateCommandSafety(
        context("Set-Content -LiteralPath C:\\Windows\\System32\\unsafe.txt -Value data"),
      ),
    ).toMatchObject({ decision: "block", code: "sensitive-path-mutation" });
  });

  it("allows scoped Docker and WSL work but blocks host-wide cleanup and pattern kills", () => {
    expect(evaluateCommandSafety(context("docker exec target-lab npm test"))).toEqual({
      decision: "allow",
    });
    expect(evaluateCommandSafety(context("wsl --terminate TargetLab"))).toEqual({
      decision: "allow",
    });
    expect(evaluateCommandSafety(context("docker system prune -af"))).toMatchObject({
      decision: "block",
      code: "global-resource-destruction",
    });
    expect(evaluateCommandSafety(context("wsl --unregister Ubuntu"))).toMatchObject({
      decision: "block",
      code: "global-resource-destruction",
    });
    expect(evaluateCommandSafety(context("taskkill /IM robocopy.exe /F"))).toMatchObject({
      decision: "block",
      code: "pattern-process-kill",
    });
  });

  it("blocks destructive version-control commands", () => {
    expect(evaluateCommandSafety(context("git reset --hard HEAD~1"))).toMatchObject({
      decision: "block",
      code: "destructive-vcs",
    });
    expect(evaluateCommandSafety(context("git clean -fd"))).toMatchObject({
      decision: "block",
      code: "destructive-vcs",
    });
    expect(evaluateCommandSafety(context("git clean -fd -- .\\work\\generated"))).toEqual({
      decision: "allow",
    });
    expect(evaluateCommandSafety(context("git restore -- apps/server/src/example.ts"))).toEqual({
      decision: "allow",
    });
    expect(evaluateCommandSafety(context("git checkout -- apps/server/src/example.ts"))).toEqual({
      decision: "allow",
    });
    expect(evaluateCommandSafety(context("git status --short"))).toEqual({ decision: "allow" });
  });
});

it("redacts secrets and bounds Observer command text", () => {
  const command = `curl -H "Authorization: Bearer private-value" "https://host/path?token=secret" API_KEY=hidden ${"x".repeat(800)}`;
  const redacted = redactCommandForAudit(command, 180);

  expect(redacted).not.toContain("private-value");
  expect(redacted).not.toContain("token=secret");
  expect(redacted).not.toContain("API_KEY=hidden");
  expect(redacted.length).toBeLessThanOrEqual(180);
});

it("ships a prompt-free managed Codex policy with objective hard denials", () => {
  expect(EREBUS_CODEX_EXEC_POLICY).toContain('pattern=["rg"]');
  expect(EREBUS_CODEX_EXEC_POLICY).toContain('decision="forbidden"');
  expect(EREBUS_CODEX_EXEC_POLICY).not.toContain('decision="prompt"');
  expect(EREBUS_CODEX_EXEC_POLICY).not.toContain('pattern=[["powershell"');
  expect(EREBUS_CODEX_EXEC_POLICY).toContain("[erebus-command-guard]");
});
