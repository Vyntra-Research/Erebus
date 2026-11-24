// @effect-diagnostics nodeBuiltinImport:off - the test creates a synthetic PE fixture in temp.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeFSP from "node:fs/promises";

import { describe, expect, it } from "@effect/vitest";

import {
  buildMicroVmModifyOptions,
  materializeWindowlessWindowsExecutable,
  resolveMicrosandboxBinaryPaths,
} from "./MicroVmRuntime.ts";

const crashedVm = {
  id: "local:13",
  name: "capri-host-shutdown-check",
  status: "crashed" as const,
  image: "debian:bookworm-slim",
  cpus: 1,
  memoryMiB: 512,
  maxCpus: 2,
  maxMemoryMiB: 1024,
  rootDiskMiB: 4096,
  workdir: "/workspace",
  projectId: null,
  threadId: null,
  createdAt: null,
  updatedAt: null,
  storageBytes: null,
};

describe("buildMicroVmModifyOptions", () => {
  it("omits unchanged resources and changes only the requested CPU", () => {
    expect(
      buildMicroVmModifyOptions(crashedVm, {
        name: crashedVm.name,
        cpus: 2,
        memoryMiB: 512,
        maxCpus: 2,
        maxMemoryMiB: 1024,
        rootDiskMiB: 4096,
        workdir: "/workspace",
        apply: "now",
      }),
    ).toEqual({ cpus: 2, policy: "no_restart" });
  });

  it("returns no operation when every requested value is unchanged", () => {
    expect(
      buildMicroVmModifyOptions(crashedVm, {
        name: crashedVm.name,
        rootDiskMiB: 4096,
      }),
    ).toBeNull();
  });

  it("rejects resource limits and disk shrink before calling Microsandbox", () => {
    expect(() => buildMicroVmModifyOptions(crashedVm, { name: crashedVm.name, cpus: 3 })).toThrow(
      "cpus (3) cannot exceed maxCpus (2)",
    );
    expect(() =>
      buildMicroVmModifyOptions(crashedVm, { name: crashedVm.name, memoryMiB: 2048 }),
    ).toThrow("memoryMiB (2048) cannot exceed maxMemoryMiB (1024)");
    expect(() =>
      buildMicroVmModifyOptions(crashedVm, { name: crashedVm.name, rootDiskMiB: 2048 }),
    ).toThrow("rootDiskMiB cannot shrink from 4096 to 2048");
  });
});

function consoleExecutable(): Buffer {
  const bytes = Buffer.alloc(512);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write("PE\0\0", 0x80, "ascii");
  const optionalHeader = 0x80 + 4 + 20;
  bytes.writeUInt16LE(0x20b, optionalHeader);
  bytes.writeUInt16LE(3, optionalHeader + 68);
  bytes.write("preserved", optionalHeader + 96, "ascii");
  return bytes;
}

describe("resolveMicrosandboxBinaryPaths", () => {
  it("finds the unpacked Windows runtime pair next to server.asar", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "erebus-msb-packaged-"));
    const packageDirectory = NodePath.join(
      directory,
      "server.asar.unpacked",
      "node_modules",
      "@superradcompany",
      "microsandbox-win32-x64-msvc",
    );
    try {
      await NodeFSP.mkdir(NodePath.join(packageDirectory, "bin"), { recursive: true });
      await NodeFSP.mkdir(NodePath.join(packageDirectory, "lib"), { recursive: true });
      await NodeFSP.writeFile(NodePath.join(packageDirectory, "bin", "msb.exe"), "msb");
      await NodeFSP.writeFile(NodePath.join(packageDirectory, "lib", "libkrunfw.dll"), "dll");

      expect(
        resolveMicrosandboxBinaryPaths({
          platform: "win32",
          arch: "x64",
          resourcesPath: directory,
          moduleDirectory: NodePath.join(directory, "server.asar", "apps", "server", "dist"),
        }),
      ).toEqual({
        msbPath: NodePath.join(packageDirectory, "bin", "msb.exe"),
        libkrunfwPath: NodePath.join(packageDirectory, "lib", "libkrunfw.dll"),
      });
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("does not resolve packaged Windows binaries on other platforms", () => {
    expect(
      resolveMicrosandboxBinaryPaths({
        platform: "linux",
        arch: "x64",
        moduleDirectory: "/srv/erebus/apps/server/dist",
      }),
    ).toBeNull();
  });
});

describe("materializeWindowlessWindowsExecutable", () => {
  it("copies a console executable and changes only its PE subsystem", async () => {
    const directory = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "erebus-msb-windowless-"),
    );
    const source = NodePath.join(directory, "msb.exe");
    const destination = NodePath.join(directory, "msb-windowless.exe");
    try {
      const original = consoleExecutable();
      await NodeFSP.writeFile(source, original);

      await materializeWindowlessWindowsExecutable(source, destination);

      const copied = await NodeFSP.readFile(destination);
      const optionalHeader = 0x80 + 4 + 20;
      expect(copied.readUInt16LE(optionalHeader + 68)).toBe(2);
      copied.writeUInt16LE(3, optionalHeader + 68);
      expect(copied).toEqual(original);
      expect(await NodeFSP.readFile(source)).toEqual(original);
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("is idempotent for an existing windowless copy", async () => {
    const directory = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "erebus-msb-windowless-"),
    );
    const source = NodePath.join(directory, "msb.exe");
    const destination = NodePath.join(directory, "msb-windowless.exe");
    try {
      await NodeFSP.writeFile(source, consoleExecutable());
      await materializeWindowlessWindowsExecutable(source, destination);
      const first = await NodeFSP.readFile(destination);

      await materializeWindowlessWindowsExecutable(source, destination);

      expect(await NodeFSP.readFile(destination)).toEqual(first);
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});
