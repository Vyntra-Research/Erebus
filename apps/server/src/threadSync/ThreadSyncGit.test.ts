// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadSyncConfiguration } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { THREAD_SYNC_NAMESPACE } from "./ThreadSyncDocuments.ts";
import * as ThreadSyncGit from "./ThreadSyncGit.ts";

function runGit(cwd: string, args: ReadonlyArray<string>): string {
  const result = NodeChildProcess.spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args[0] ?? ""} exited ${String(result.status)}`);
  }
  return result.stdout.trim();
}

const testLayer = ThreadSyncGit.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "thread-sync-git-" })),
  Layer.provideMerge(NodeServices.layer),
);
const decodeConfiguration = Schema.decodeUnknownEffect(ThreadSyncConfiguration);

describe("ThreadSyncGit", () => {
  it("classifies embedded web credentials and URL state as unsafe", () => {
    expect(
      ThreadSyncGit.hasUnsafeThreadSyncRemoteComponents(
        "https://user:secret@example.test/owner/repo.git",
      ),
    ).toBe(true);
    expect(
      ThreadSyncGit.hasUnsafeThreadSyncRemoteComponents(
        "https://example.test/owner/repo.git?token=secret#branch",
      ),
    ).toBe(true);
    expect(
      ThreadSyncGit.hasUnsafeThreadSyncRemoteComponents("ssh://git@example.test/owner/repo.git"),
    ).toBe(false);
    expect(
      ThreadSyncGit.hasUnsafeThreadSyncRemoteComponents(
        "ssh://git:secret@example.test/owner/repo.git",
      ),
    ).toBe(true);
    expect(
      ThreadSyncGit.hasUnsafeThreadSyncRemoteComponents("git@example.test:owner/repo.git"),
    ).toBe(false);
    expect(ThreadSyncGit.hasUnsafeThreadSyncRemoteComponents("C:/work/sync.git")).toBe(false);
  });

  it.effect("rejects branch arguments that begin with a dash before invoking Git", () =>
    Effect.gen(function* () {
      const configuration = yield* decodeConfiguration({
        remoteUrl: "https://example.test/owner/repo.git",
        branch: "--upload-pack=unsafe",
        fetchIntervalSeconds: 60,
      });
      const syncGit = yield* ThreadSyncGit.ThreadSyncGit;
      const error = yield* syncGit.fetch(configuration).pipe(Effect.flip);
      expect(error.code).toBe("invalid-remote");
      expect(error.detail).not.toContain("secret");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects embedded credentials before invoking Git", () =>
    Effect.gen(function* () {
      const configuration = yield* decodeConfiguration({
        remoteUrl: "https://user:secret@example.test/owner/repo.git",
        branch: "main",
        fetchIntervalSeconds: 60,
      });
      const syncGit = yield* ThreadSyncGit.ThreadSyncGit;
      const error = yield* syncGit.fetch(configuration).pipe(Effect.flip);
      expect(error.code).toBe("invalid-remote");
      expect(error.detail).not.toContain("secret");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("creates an empty remote branch and rejects a stale normal push", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "thread-sync-remote-" });
        const remotePath = NodePath.join(root, "remote.git");
        NodeFS.mkdirSync(remotePath);
        runGit(remotePath, ["init", "--bare"]);
        const configuration = yield* decodeConfiguration({
          remoteUrl: remotePath,
          branch: "main",
          fetchIntervalSeconds: 60,
        });
        const syncGit = yield* ThreadSyncGit.ThreadSyncGit;
        const prepared = yield* syncGit.checkoutRemote(configuration, null);
        const namespacePath = NodePath.join(prepared.mirrorPath, THREAD_SYNC_NAMESPACE);
        NodeFS.mkdirSync(namespacePath, { recursive: true });
        NodeFS.writeFileSync(
          NodePath.join(namespacePath, "manifest.json"),
          '{"formatVersion":1,"kind":"erebus-thread-sync","updatedAt":"2026-10-11T12:00:00.000Z"}\n',
        );
        const firstRevision = yield* syncGit.commitAndPush({
          configuration,
          expectedRemoteRevision: null,
          message: "Sync 1 thread",
        });
        expect((yield* syncGit.fetch(configuration)).remoteRevision).toBe(firstRevision);

        yield* syncGit.checkoutRemote(configuration, firstRevision);
        NodeFS.writeFileSync(
          NodePath.join(namespacePath, "manifest.json"),
          '{"formatVersion":1,"kind":"erebus-thread-sync","updatedAt":"2026-10-11T12:01:00.000Z"}\n',
        );

        const competitorPath = NodePath.join(root, "competitor");
        runGit(root, ["clone", "--branch", "main", remotePath, competitorPath]);
        runGit(competitorPath, ["config", "user.name", "Competitor"]);
        runGit(competitorPath, ["config", "user.email", "competitor@localhost"]);
        NodeFS.writeFileSync(NodePath.join(competitorPath, "unrelated.txt"), "preserve me\n");
        runGit(competitorPath, ["add", "unrelated.txt"]);
        runGit(competitorPath, ["commit", "-m", "Concurrent unrelated change"]);
        runGit(competitorPath, ["push", "origin", "main"]);

        const stale = yield* syncGit
          .commitAndPush({
            configuration,
            expectedRemoteRevision: firstRevision,
            message: "Stale sync",
          })
          .pipe(Effect.flip);
        expect(stale.code).toBe("remote-changed");
        expect(
          runGit(prepared.mirrorPath, ["status", "--porcelain", "--", THREAD_SYNC_NAMESPACE]),
        ).toBe("");
        expect(
          NodeFS.readFileSync(NodePath.join(namespacePath, "manifest.json"), "utf8"),
        ).toContain("12:00:00.000Z");
        expect(
          NodeFS.readFileSync(NodePath.join(prepared.mirrorPath, "unrelated.txt"), "utf8").trim(),
        ).toBe("preserve me");
        expect(runGit(competitorPath, ["show", "HEAD:unrelated.txt"])).toBe("preserve me");

        const latestRevision = (yield* syncGit.fetch(configuration)).remoteRevision;
        expect(latestRevision).not.toBeNull();
        yield* syncGit.checkoutRemote(configuration, latestRevision);
        NodeFS.writeFileSync(
          NodePath.join(namespacePath, "manifest.json"),
          '{"formatVersion":1,"kind":"erebus-thread-sync","updatedAt":"2026-10-11T12:02:00.000Z"}\n',
        );
        const retryRevision = yield* syncGit.commitAndPush({
          configuration,
          expectedRemoteRevision: latestRevision,
          message: "Retry after concurrent sync",
        });
        expect((yield* syncGit.fetch(configuration)).remoteRevision).toBe(retryRevision);
        expect(runGit(prepared.mirrorPath, ["show", "HEAD:unrelated.txt"])).toBe("preserve me");
        expect(
          runGit(prepared.mirrorPath, ["show", `HEAD:${THREAD_SYNC_NAMESPACE}/manifest.json`]),
        ).toContain("12:02:00.000Z");
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("recreates a deleted branch without resurrecting its old tree", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "thread-sync-remote-" });
        const remotePath = NodePath.join(root, "remote.git");
        NodeFS.mkdirSync(remotePath);
        runGit(remotePath, ["init", "--bare"]);
        const configuration = yield* decodeConfiguration({
          remoteUrl: remotePath,
          branch: "main",
          fetchIntervalSeconds: 60,
        });
        const syncGit = yield* ThreadSyncGit.ThreadSyncGit;
        const prepared = yield* syncGit.checkoutRemote(configuration, null);
        const namespacePath = NodePath.join(prepared.mirrorPath, THREAD_SYNC_NAMESPACE);
        NodeFS.mkdirSync(namespacePath, { recursive: true });
        NodeFS.writeFileSync(
          NodePath.join(namespacePath, "manifest.json"),
          '{"formatVersion":1,"kind":"erebus-thread-sync","updatedAt":"2026-10-11T12:00:00.000Z"}\n',
        );
        yield* syncGit.commitAndPush({
          configuration,
          expectedRemoteRevision: null,
          message: "Initial sync",
        });

        const competitorPath = NodePath.join(root, "competitor");
        runGit(root, ["clone", "--branch", "main", remotePath, competitorPath]);
        runGit(competitorPath, ["config", "user.name", "Competitor"]);
        runGit(competitorPath, ["config", "user.email", "competitor@localhost"]);
        NodeFS.writeFileSync(NodePath.join(competitorPath, "stale.txt"), "must not return\n");
        runGit(competitorPath, ["add", "stale.txt"]);
        runGit(competitorPath, ["commit", "-m", "Old branch content"]);
        runGit(competitorPath, ["push", "origin", "main"]);
        const staleRevision = (yield* syncGit.fetch(configuration)).remoteRevision;
        yield* syncGit.checkoutRemote(configuration, staleRevision);
        expect(NodeFS.existsSync(NodePath.join(prepared.mirrorPath, "stale.txt"))).toBe(true);
        NodeFS.writeFileSync(
          NodePath.join(namespacePath, "manifest.json"),
          '{"formatVersion":1,"kind":"erebus-thread-sync","updatedAt":"2026-10-11T12:00:30.000Z"}\n',
        );

        runGit(competitorPath, ["push", "origin", "--delete", "main"]);
        const deletedRace = yield* syncGit
          .commitAndPush({
            configuration,
            expectedRemoteRevision: staleRevision,
            message: "Stale sync after branch deletion",
          })
          .pipe(Effect.flip);
        expect(deletedRace.code).toBe("remote-changed");
        expect(
          runGit(prepared.mirrorPath, ["status", "--porcelain", "--", THREAD_SYNC_NAMESPACE]),
        ).toBe("");
        expect(NodeFS.existsSync(NodePath.join(prepared.mirrorPath, "stale.txt"))).toBe(false);

        const empty = yield* syncGit.checkoutRemote(configuration, null);
        expect(empty.remoteRevision).toBeNull();
        expect(NodeFS.existsSync(NodePath.join(empty.mirrorPath, "stale.txt"))).toBe(false);
        NodeFS.mkdirSync(namespacePath, { recursive: true });
        NodeFS.writeFileSync(
          NodePath.join(namespacePath, "manifest.json"),
          '{"formatVersion":1,"kind":"erebus-thread-sync","updatedAt":"2026-10-11T12:01:00.000Z"}\n',
        );
        yield* syncGit.commitAndPush({
          configuration,
          expectedRemoteRevision: null,
          message: "Recreate sync branch",
        });
        const tree = runGit(empty.mirrorPath, ["ls-tree", "-r", "--name-only", "HEAD"]);
        expect(tree).toContain(`${THREAD_SYNC_NAMESPACE}/manifest.json`);
        expect(tree).not.toContain("stale.txt");
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects a remote branch that tracks the local mirror marker", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "thread-sync-remote-" });
        const remotePath = NodePath.join(root, "remote.git");
        NodeFS.mkdirSync(remotePath);
        runGit(remotePath, ["init", "--bare"]);
        const seedPath = NodePath.join(root, "seed");
        NodeFS.mkdirSync(seedPath);
        runGit(seedPath, ["init"]);
        runGit(seedPath, ["config", "user.name", "Hostile"]);
        runGit(seedPath, ["config", "user.email", "hostile@localhost"]);
        NodeFS.writeFileSync(
          NodePath.join(seedPath, ".erebus-thread-sync-managed"),
          "attacker-controlled\n",
        );
        runGit(seedPath, ["add", ".erebus-thread-sync-managed"]);
        runGit(seedPath, ["commit", "-m", "Track local marker"]);
        runGit(seedPath, ["branch", "-M", "main"]);
        runGit(seedPath, ["remote", "add", "origin", remotePath]);
        runGit(seedPath, ["push", "origin", "main"]);

        const configuration = yield* decodeConfiguration({
          remoteUrl: remotePath,
          branch: "main",
          fetchIntervalSeconds: 60,
        });
        const syncGit = yield* ThreadSyncGit.ThreadSyncGit;
        const error = yield* syncGit.fetch(configuration).pipe(Effect.flip);
        expect(error.code).toBe("integrity-failed");
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("removes only the mirror for the exact remote and branch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "thread-sync-remote-" });
        const remotePath = NodePath.join(root, "remote.git");
        NodeFS.mkdirSync(remotePath);
        runGit(remotePath, ["init", "--bare"]);
        const main = yield* decodeConfiguration({
          remoteUrl: remotePath,
          branch: "main",
          fetchIntervalSeconds: 60,
        });
        const alternate = yield* decodeConfiguration({
          remoteUrl: remotePath,
          branch: "alternate",
          fetchIntervalSeconds: 60,
        });
        const syncGit = yield* ThreadSyncGit.ThreadSyncGit;
        const mainMirror = (yield* syncGit.fetch(main)).mirrorPath;
        const alternateMirror = (yield* syncGit.fetch(alternate)).mirrorPath;

        yield* syncGit.removeMirror(alternate);

        expect(NodeFS.existsSync(mainMirror)).toBe(true);
        expect(NodeFS.existsSync(alternateMirror)).toBe(false);
      }),
    ).pipe(Effect.provide(testLayer)),
  );
});
