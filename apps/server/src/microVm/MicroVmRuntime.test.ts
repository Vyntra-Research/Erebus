// @effect-diagnostics nodeBuiltinImport:off - the test creates a synthetic PE fixture in temp.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeFSP from "node:fs/promises";

import { describe, expect, it } from "@effect/vitest";

import { materializeWindowlessWindowsExecutable } from "./MicroVmRuntime.ts";

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
