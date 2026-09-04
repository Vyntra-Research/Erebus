#!/usr/bin/env node

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

const VERSIONED_PACKAGE_FILES = new Set([
  "apps/desktop/package.json",
  "apps/server/package.json",
  "apps/web/package.json",
  "packages/contracts/package.json",
]);

const FULL_VALIDATION_FILES = new Set([
  ".gitattributes",
  ".mcp.json",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "t3.json",
  "tsconfig.base.json",
  "vite.config.ts",
]);

const normalizePath = (file) => file.trim().replaceAll("\\", "/").replace(/^\.\//, "");

const matchesAnyPrefix = (file, prefixes) => prefixes.some((prefix) => file.startsWith(prefix));

export function isVersionOnlyPackagePatch(patch) {
  const changedLines = patch
    .split(/\r?\n/u)
    .filter((line) => (line.startsWith("+") || line.startsWith("-")) && !/^\+\+\+|^---/u.test(line))
    .map((line) => line.trim())
    .filter(Boolean);

  return (
    changedLines.length > 0 &&
    changedLines.every((line) => /^[+-]\s*"version"\s*:\s*"[^"]+"\s*,?\s*$/u.test(line))
  );
}

export function isDocumentationPath(file) {
  return (
    file.endsWith(".md") ||
    file.startsWith("docs/") ||
    file === "LICENSE" ||
    file === "THIRD_PARTY_NOTICES.md"
  );
}

export function selectMeaningfulChanges(changes) {
  return changes
    .map((change) => ({ ...change, path: normalizePath(change.path) }))
    .filter(({ path, patch }) => {
      if (isDocumentationPath(path)) return false;
      if (VERSIONED_PACKAGE_FILES.has(path) && patch && isVersionOnlyPackagePatch(patch)) {
        return false;
      }
      return true;
    });
}

const isTestPath = (file) =>
  /(?:^|\/)(?:__tests__|test|tests)\//u.test(file) || /\.(?:spec|test)\.[cm]?[jt]sx?$/u.test(file);

export function classifyCiChanges(changes) {
  const meaningfulChanges = selectMeaningfulChanges(changes);
  const files = meaningfulChanges.map(({ path }) => path);
  const productFiles = files.filter((file) => !isTestPath(file));
  const full = files.some(
    (file) =>
      FULL_VALIDATION_FILES.has(file) ||
      file.startsWith(".github/workflows/") ||
      file.startsWith(".github/actions/") ||
      file.startsWith(".vite-hooks/") ||
      file.startsWith("assets/") ||
      file.startsWith("packaging/") ||
      file.startsWith("patches/"),
  );

  const node =
    full ||
    files.some((file) =>
      matchesAnyPrefix(file, [
        "apps/",
        "packages/",
        "scripts/",
        "infra/",
        "oxlint-plugin-t3code/",
        "native/libghostty-vt/",
      ]),
    );
  const server =
    full ||
    files.some((file) =>
      matchesAnyPrefix(file, [
        "apps/server/",
        "packages/contracts/",
        "packages/effect-acp/",
        "packages/effect-codex-app-server/",
        "packages/shared/",
        "packages/tailscale/",
        "scripts/lib/",
      ]),
    );
  const web =
    full ||
    files.some((file) =>
      matchesAnyPrefix(file, [
        "apps/web/",
        "packages/client-runtime/",
        "packages/contracts/",
        "packages/shared/",
        "native/libghostty-vt/",
      ]),
    );
  const nonServer =
    full ||
    files.some((file) =>
      matchesAnyPrefix(file, [
        "apps/desktop/",
        "packages/",
        "scripts/",
        "infra/relay/",
        "oxlint-plugin-t3code/",
        "native/libghostty-vt/",
      ]),
    );
  const build =
    full ||
    productFiles.some((file) =>
      matchesAnyPrefix(file, [
        "apps/desktop/",
        "apps/server/",
        "apps/web/",
        "packages/",
        "native/libghostty-vt/",
      ]),
    );
  const rust = full || files.some((file) => file.startsWith("native/resource-monitor/"));
  const serverOnly =
    node && !full && files.length > 0 && files.every((file) => file.startsWith("apps/server/"));

  return {
    build,
    full,
    node,
    nonServer,
    rust,
    server,
    serverOnly,
    web,
    meaningfulFiles: files,
  };
}

function git(...args) {
  return NodeChildProcess.execFileSync("git", args, { encoding: "utf8" });
}

function readGitChanges(base, head) {
  const paths = git("diff", "--name-only", "--diff-filter=ACMR", base, head, "--")
    .split(/\r?\n/u)
    .map(normalizePath)
    .filter(Boolean);

  return paths.map((path) => ({
    path,
    patch: VERSIONED_PACKAGE_FILES.has(path)
      ? git("diff", "--unified=0", base, head, "--", path)
      : undefined,
  }));
}

function outputPlan(plan) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) throw new Error("GITHUB_OUTPUT is required");
  const output = [
    `build=${String(plan.build)}`,
    `full=${String(plan.full)}`,
    `node=${String(plan.node)}`,
    `non_server=${String(plan.nonServer)}`,
    `rust=${String(plan.rust)}`,
    `server=${String(plan.server)}`,
    `server_only=${String(plan.serverOnly)}`,
    `web=${String(plan.web)}`,
  ].join("\n");
  NodeFS.appendFileSync(outputPath, `${output}\n`, "utf8");

  console.log(`Meaningful changes: ${plan.meaningfulFiles.join(", ") || "none"}`);
  console.log(output);
}

if (import.meta.url === `file://${process.argv[1]}` || import.meta.main) {
  const [, , base, head] = process.argv;
  if (!base || !head) throw new Error("Usage: ci-change-plan.mjs <base> <head>");
  outputPlan(classifyCiChanges(readGitChanges(base, head)));
}
