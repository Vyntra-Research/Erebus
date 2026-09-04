import { describe, expect, it } from "vitest";

import {
  classifyCiChanges,
  isVersionOnlyPackagePatch,
  selectMeaningfulChanges,
} from "./ci-change-plan.mjs";

const change = (path, patch) => ({ path, patch });

describe("CI change plan", () => {
  it("ignores documentation and release-only package version updates", () => {
    const versionPatch = `--- a/apps/server/package.json
+++ b/apps/server/package.json
@@ -3 +3 @@
-  "version": "0.3.1",
+  "version": "0.3.2",
`;
    expect(isVersionOnlyPackagePatch(versionPatch)).toBe(true);
    expect(
      selectMeaningfulChanges([
        change("CHANGELOG.md"),
        change("README.md"),
        change("apps/server/package.json", versionPatch),
      ]),
    ).toEqual([]);
  });

  it("keeps package changes that alter more than the release version", () => {
    const dependencyPatch = `--- a/apps/server/package.json
+++ b/apps/server/package.json
@@ -3 +3 @@
-  "version": "0.3.1",
+  "version": "0.3.2",
@@ -20 +20 @@
-    "effect": "1.0.0"
+    "effect": "1.0.1"
`;
    expect(isVersionOnlyPackagePatch(dependencyPatch)).toBe(false);
    expect(
      selectMeaningfulChanges([change("apps/server/package.json", dependencyPatch)]),
    ).toHaveLength(1);
  });

  it("finishes documentation-only changes without starting build jobs", () => {
    expect(classifyCiChanges([change("README.md"), change("docs/setup.md")])).toMatchObject({
      build: false,
      desktop: false,
      libraries: false,
      node: false,
      rust: false,
      server: false,
      web: false,
    });
  });

  it("uses the narrow path for a server-only change", () => {
    expect(classifyCiChanges([change("apps/server/src/research/supervisor.ts")])).toMatchObject({
      build: true,
      desktop: false,
      full: false,
      libraries: false,
      node: true,
      rust: false,
      server: true,
      serverOnly: true,
      web: false,
    });
  });

  it("does not build product bundles for test-only changes", () => {
    expect(
      classifyCiChanges([change("apps/server/src/research/supervisor.test.ts")]),
    ).toMatchObject({
      build: false,
      desktop: false,
      libraries: false,
      node: true,
      server: true,
      serverOnly: true,
    });
  });

  it("fans shared contract changes out to every JavaScript test surface", () => {
    expect(classifyCiChanges([change("packages/contracts/src/index.ts")])).toMatchObject({
      build: true,
      desktop: true,
      libraries: true,
      node: true,
      server: true,
      serverOnly: false,
      web: true,
    });
  });

  it("keeps web changes off unrelated server and library tests", () => {
    expect(classifyCiChanges([change("apps/web/src/App.tsx")])).toMatchObject({
      build: true,
      desktop: false,
      libraries: false,
      server: false,
      web: true,
    });
  });

  it("runs only Rust checks for resource monitor changes", () => {
    expect(classifyCiChanges([change("native/resource-monitor/src/main.rs")])).toMatchObject({
      build: false,
      desktop: false,
      libraries: false,
      node: false,
      rust: true,
    });
  });

  it("uses full validation when CI policy changes", () => {
    expect(classifyCiChanges([change(".github/workflows/ci.yml")])).toMatchObject({
      build: true,
      desktop: true,
      full: true,
      libraries: true,
      node: true,
      rust: true,
      server: true,
      web: true,
    });
  });
});
