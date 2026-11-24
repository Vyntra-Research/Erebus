#!/usr/bin/env node

import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

if (NodePath.sep === "\\") {
  console.error(
    "[full-tests] The full suite is Linux-only. Use `pnpm test` for the cross-platform smoke suite.",
  );
  process.exit(1);
}

const root = NodePath.resolve(import.meta.dirname, "..");
const vpEntry = NodePath.join(root, "node_modules", "vite-plus", "bin", "vp");
const result = NodeChildProcess.spawnSync(process.execPath, [vpEntry, "run", "-r", "test"], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
  windowsHide: true,
});

if (result.error) {
  console.error(`[full-tests] failed to start: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
