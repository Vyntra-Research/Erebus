#!/usr/bin/env node

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const root = NodePath.resolve(import.meta.dirname, "..");
const vpEntry = NodePath.join(root, "node_modules", "vite-plus", "bin", "vp");

if (!NodeFS.existsSync(vpEntry)) {
  console.error("[smoke] dependencies are not installed; run `pnpm install` first.");
  process.exit(1);
}

const suites = [
  {
    package: "apps/server",
    files: [
      "src/mcp/McpHttpServer.test.ts",
      "src/mcp/McpSessionRegistry.test.ts",
      "src/persistence/Layers/Sqlite.test.ts",
      "src/provider/Layers/ProviderService.test.ts",
      "src/webRuntime/WebRuntimeClient.test.ts",
    ],
  },
  {
    package: "apps/desktop",
    files: [
      "src/backend/DesktopBackendConfiguration.test.ts",
      "src/preview/BrowserProfileRegistry.test.ts",
      "src/electron/ElectronShell.test.ts",
    ],
  },
  {
    package: "apps/web",
    files: [
      "src/rightPanelStore.test.ts",
      "src/components/preview/extensionAutomationTarget.test.ts",
      "src/components/preview/previewAutomationErrors.test.ts",
    ],
  },
  {
    package: "packages/contracts",
    files: ["src/settings.test.ts", "src/webRuntime.test.ts"],
  },
  {
    package: "scripts",
    files: ["ci-change-plan.test.mjs"],
  },
];

for (const suite of suites) {
  console.log(`\n[smoke] ${suite.package}`);
  const args = ["test", "run", ...suite.files];
  const result = NodeChildProcess.spawnSync(process.execPath, [vpEntry, ...args], {
    cwd: NodePath.join(root, suite.package),
    stdio: "inherit",
    env: process.env,
    windowsHide: true,
  });
  if (result.error) {
    console.error(`[smoke] failed to start ${suite.package}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log("\n[smoke] critical paths passed.");
