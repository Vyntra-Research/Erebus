// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadSyncConfiguration } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ServerConfig from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
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
  it("allows only supported Git remote forms without embedded URL state", () => {
    const allowed = [
      "https://example.test/owner/repo.git",
      "ssh://git@example.test/owner/repo.git",
      "ssh://deploy-user@127.0.0.1:2222/owner/repo.git",
      "file:///C:/work/sync.git",
      "file://server/share/sync.git",
      "git@example.test:owner/repo.git",
      "build-user@server:~/sync.git",
      "[2001:db8::1]:owner/repo.git",
      "C:/work/sync.git",
      "C:\\work\\sync.git",
      "C:sync.git",
      "\\\\server\\share\\sync.git",
      "/var/lib/erebus/sync.git",
      "../sync.git",
      "repositories/sync.git",
    ];
    const rejected = [
      "https://user@example.test/owner/repo.git",
      "https://user:secret@example.test/owner/repo.git",
      "https://user\\:secret@evil.example/repo.git",
      "https://example.test/owner/repo.git?token=secret#branch",
      "ssh://git:secret@example.test/owner/repo.git",
      "ssh://git@example.test/owner/repo.git#branch",
      "http://example.test/owner/repo.git",
      "git://example.test/owner/repo.git",
      "ftp://example.test/owner/repo.git",
      "rsync://example.test/owner/repo.git",
      "custom://example.test/owner/repo.git",
      "ext::sh -c calc.exe",
      "custom::payload",
      "https:example.test/owner/repo.git",
      "host:",
      "user@@host:repo.git",
      "host:repo.git?token=secret",
      "repo.git\nnext",
    ];

    for (const remoteUrl of allowed) {
      expect(ThreadSyncGit.hasUnsafeThreadSyncRemoteComponents(remoteUrl), remoteUrl).toBe(false);
    }
    for (const remoteUrl of rejected) {
      expect(ThreadSyncGit.hasUnsafeThreadSyncRemoteComponents(remoteUrl), remoteUrl).toBe(true);
    }
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

  it.effect("rejects remote helpers and unsupported protocols before invoking Git", () =>
    Effect.gen(function* () {
      const syncGit = yield* ThreadSyncGit.ThreadSyncGit;
      for (const remoteUrl of [
        "ext::sh -c calc.exe",
        "custom::payload",
        "git://example.test/owner/repo.git",
        "custom://example.test/owner/repo.git",
      ]) {
        const configuration = yield* decodeConfiguration({
          remoteUrl,
          branch: "main",
          fetchIntervalSeconds: 60,
        });
        const error = yield* syncGit.fetch(configuration).pipe(Effect.flip);
        expect(error.code, remoteUrl).toBe("invalid-remote");
        expect(error.detail, remoteUrl).not.toContain("payload");
        expect(error.detail, remoteUrl).not.toContain("calc.exe");
      }
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects Windows drive and UNC remotes on non-Windows hosts", () =>
    Effect.gen(function* () {
      const syncGit = yield* ThreadSyncGit.ThreadSyncGit;
      for (const remoteUrl of [
        "C:/work/sync.git",
        "C:\\work\\sync.git",
        "C:sync.git",
        "\\\\server\\share\\sync.git",
        "file:///C:/work/sync.git",
        "file://server/share/sync.git",
      ]) {
        const configuration = yield* decodeConfiguration({
          remoteUrl,
          branch: "main",
          fetchIntervalSeconds: 60,
        });
        const error = yield* syncGit.fetch(configuration).pipe(Effect.flip);
        expect(error.code, remoteUrl).toBe("invalid-remote");
      }
    }).pipe(Effect.provide(testLayer), Effect.provideService(HostProcessPlatform, "linux")),
  );

  it.effect("does not retry an ignored object filter with an unfiltered network fetch", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const environments: Array<NodeJS.ProcessEnv | undefined> = [];
    const vcsProcess = VcsProcess.VcsProcess.of({
      run: (input) =>
        Effect.sync(() => {
          calls.push(input.args);
          environments.push(input.env);
          const isRemoteLookup = input.args[0] === "remote" && input.args[1] === "get-url";
          const isReferenceLookup = input.args.includes("ls-remote");
          const isFilteredFetch =
            input.args[0] === "fetch" && input.args.includes("--filter=blob:none");
          return {
            exitCode: ChildProcessSpawner.ExitCode(isRemoteLookup ? 2 : 0),
            stdout: "",
            stderr: isReferenceLookup
              ? "packet: git< fetch=shallow wait-for-done filter"
              : isFilteredFetch
                ? "warning: filtering not recognized by server, ignoring"
                : "",
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }),
    });

    const dependencies = Layer.mergeAll(
      Layer.succeed(VcsProcess.VcsProcess, vcsProcess),
      ServerConfig.layerTest(process.cwd(), { prefix: "thread-sync-filter-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
      NodeServices.layer,
    );
    return Effect.gen(function* () {
      const configuration = yield* decodeConfiguration({
        remoteUrl: "https://example.test/owner/sync.git",
        branch: "main",
        fetchIntervalSeconds: 60,
      });
      const syncGit = yield* ThreadSyncGit.make;
      const error = yield* syncGit.fetch(configuration).pipe(Effect.flip);
      expect(error.code).toBe("git-failed");
      expect(error.detail).toContain("filtered blobless fetches");
      const fetchCalls = calls.filter((args) => args[0] === "fetch");
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0]).toContain("--filter=blob:none");
      expect(environments.length).toBeGreaterThan(0);
      expect(environments.every((env) => env?.LANG === "C" && env?.LC_ALL === "C")).toBe(true);
      const referenceLookupIndex = calls.findIndex((args) => args.includes("ls-remote"));
      expect(environments[referenceLookupIndex]?.GIT_TRACE_PACKET).toBe("1");
    }).pipe(Effect.provide(dependencies));
  });

  it.effect("does not accept an absent network branch without the filter capability", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const vcsProcess = VcsProcess.VcsProcess.of({
      run: (input) =>
        Effect.sync(() => {
          calls.push(input.args);
          const isRemoteLookup = input.args[0] === "remote" && input.args[1] === "get-url";
          const isReferenceLookup = input.args.includes("ls-remote");
          return {
            exitCode: ChildProcessSpawner.ExitCode(isRemoteLookup || isReferenceLookup ? 2 : 0),
            stdout: "",
            stderr: isReferenceLookup ? "packet: git< fetch=shallow wait-for-done" : "",
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }),
    });

    const dependencies = Layer.mergeAll(
      Layer.succeed(VcsProcess.VcsProcess, vcsProcess),
      ServerConfig.layerTest(process.cwd(), { prefix: "thread-sync-capability-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
      NodeServices.layer,
    );
    return Effect.gen(function* () {
      const configuration = yield* decodeConfiguration({
        remoteUrl: "ssh://git@example.test/owner/sync.git",
        branch: "main",
        fetchIntervalSeconds: 60,
      });
      const syncGit = yield* ThreadSyncGit.make;
      const error = yield* syncGit.fetch(configuration).pipe(Effect.flip);
      expect(error.code).toBe("git-failed");
      expect(error.detail).toContain("does not advertise");
      expect(calls.filter((args) => args[0] === "fetch")).toHaveLength(0);
    }).pipe(Effect.provide(dependencies));
  });

  it.effect("accepts an absent network branch after validating the filter capability", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const vcsProcess = VcsProcess.VcsProcess.of({
      run: (input) =>
        Effect.sync(() => {
          calls.push(input.args);
          const isRemoteLookup = input.args[0] === "remote" && input.args[1] === "get-url";
          const isReferenceLookup = input.args.includes("ls-remote");
          return {
            exitCode: ChildProcessSpawner.ExitCode(isRemoteLookup || isReferenceLookup ? 2 : 0),
            stdout: "",
            stderr: isReferenceLookup ? "packet: git< fetch=shallow wait-for-done filter" : "",
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }),
    });

    const dependencies = Layer.mergeAll(
      Layer.succeed(VcsProcess.VcsProcess, vcsProcess),
      ServerConfig.layerTest(process.cwd(), { prefix: "thread-sync-empty-network-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
      NodeServices.layer,
    );
    return Effect.gen(function* () {
      const configuration = yield* decodeConfiguration({
        remoteUrl: "https://example.test/owner/empty-sync.git",
        branch: "main",
        fetchIntervalSeconds: 60,
      });
      const syncGit = yield* ThreadSyncGit.make;
      const fetched = yield* syncGit.fetch(configuration);
      expect(fetched.remoteRevision).toBeNull();
      expect(calls.filter((args) => args[0] === "fetch")).toHaveLength(0);
    }).pipe(Effect.provide(dependencies));
  });

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
        expect(runGit(prepared.mirrorPath, ["ls-files"])).toBe("");
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
        expect(NodeFS.existsSync(NodePath.join(prepared.mirrorPath, "unrelated.txt"))).toBe(false);
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
        expect(NodeFS.existsSync(NodePath.join(prepared.mirrorPath, "unrelated.txt"))).toBe(false);
        expect(
          runGit(prepared.mirrorPath, ["show", `HEAD:${THREAD_SYNC_NAMESPACE}/manifest.json`]),
        ).toContain("12:02:00.000Z");
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("does not materialize a large unrelated blob and preserves it after push", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "thread-sync-sparse-" });
        const remotePath = NodePath.join(root, "remote.git");
        const seedPath = NodePath.join(root, "seed");
        NodeFS.mkdirSync(remotePath);
        NodeFS.mkdirSync(seedPath);
        runGit(remotePath, ["init", "--bare"]);
        runGit(remotePath, ["config", "uploadpack.allowFilter", "true"]);
        runGit(seedPath, ["init"]);
        runGit(seedPath, ["config", "user.name", "Seed"]);
        runGit(seedPath, ["config", "user.email", "seed@localhost"]);

        const namespacePath = NodePath.join(seedPath, THREAD_SYNC_NAMESPACE);
        const unrelatedSize = 4 * 1024 * 1024;
        NodeFS.mkdirSync(namespacePath, { recursive: true });
        NodeFS.writeFileSync(
          NodePath.join(namespacePath, "manifest.json"),
          '{"formatVersion":1,"kind":"erebus-thread-sync","updatedAt":"2026-10-11T12:00:00.000Z"}\n',
        );
        NodeFS.writeFileSync(
          NodePath.join(seedPath, "unrelated-large.bin"),
          Buffer.alloc(unrelatedSize, 0x5a),
        );
        runGit(seedPath, ["add", "."]);
        runGit(seedPath, ["commit", "-m", "Seed mixed repository"]);
        runGit(seedPath, ["branch", "-M", "main"]);
        runGit(seedPath, ["remote", "add", "origin", remotePath]);
        runGit(seedPath, ["push", "origin", "main"]);

        const configuration = yield* decodeConfiguration({
          remoteUrl: NodeURL.pathToFileURL(remotePath).href,
          branch: "main",
          fetchIntervalSeconds: 60,
        });
        const syncGit = yield* ThreadSyncGit.ThreadSyncGit;
        const fetched = yield* syncGit.fetch(configuration);
        const checkedOut = yield* syncGit.checkoutRemote(configuration, fetched.remoteRevision);
        const mirrorNamespace = NodePath.join(checkedOut.mirrorPath, THREAD_SYNC_NAMESPACE);
        expect(NodeFS.existsSync(NodePath.join(checkedOut.mirrorPath, "unrelated-large.bin"))).toBe(
          false,
        );
        expect(NodeFS.existsSync(NodePath.join(mirrorNamespace, "manifest.json"))).toBe(true);

        NodeFS.writeFileSync(
          NodePath.join(mirrorNamespace, "manifest.json"),
          '{"formatVersion":1,"kind":"erebus-thread-sync","updatedAt":"2026-10-11T12:01:00.000Z"}\n',
        );
        yield* syncGit.commitAndPush({
          configuration,
          expectedRemoteRevision: fetched.remoteRevision,
          message: "Update thread snapshot",
        });

        expect(NodeFS.existsSync(NodePath.join(checkedOut.mirrorPath, "unrelated-large.bin"))).toBe(
          false,
        );
        expect(runGit(remotePath, ["cat-file", "-s", "refs/heads/main:unrelated-large.bin"])).toBe(
          String(unrelatedSize),
        );
        expect(
          runGit(remotePath, ["show", `refs/heads/main:${THREAD_SYNC_NAMESPACE}/manifest.json`]),
        ).toContain("12:01:00.000Z");
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
        expect(NodeFS.existsSync(NodePath.join(prepared.mirrorPath, "stale.txt"))).toBe(false);
        expect(runGit(prepared.mirrorPath, ["ls-files", "--error-unmatch", "stale.txt"])).toBe(
          "stale.txt",
        );
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
        expect(runGit(prepared.mirrorPath, ["ls-files"])).toBe("");
        expect(NodeFS.existsSync(NodePath.join(prepared.mirrorPath, "stale.txt"))).toBe(false);

        const empty = yield* syncGit.checkoutRemote(configuration, null);
        expect(empty.remoteRevision).toBeNull();
        expect(runGit(empty.mirrorPath, ["ls-files"])).toBe("");
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
