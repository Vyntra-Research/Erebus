import { describe, expect, it } from "vite-plus/test";

import type { MicroVmInfo } from "@t3tools/contracts";

import { buildMicroVmModifyInput } from "./microVmModify";

const vm: MicroVmInfo = {
  id: "local:13",
  name: "capri-host-shutdown-check",
  status: "crashed",
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

describe("buildMicroVmModifyInput", () => {
  it("sends only the CPU when the other fields are unchanged", () => {
    expect(
      buildMicroVmModifyInput(vm, {
        cpus: "2",
        memoryMiB: "512",
        maxCpus: "2",
        maxMemoryMiB: "1024",
        rootDiskMiB: "4096",
        workdir: "/workspace",
        apply: "now",
      }),
    ).toEqual({ name: vm.name, cpus: 2, apply: "now" });
  });

  it("omits an unavailable or unchanged disk value", () => {
    expect(
      buildMicroVmModifyInput(
        { ...vm, rootDiskMiB: null },
        {
          cpus: "1",
          memoryMiB: "512",
          maxCpus: "2",
          maxMemoryMiB: "1024",
          rootDiskMiB: "",
          workdir: "/workspace",
          apply: "next-start",
        },
      ),
    ).toEqual({ name: vm.name, apply: "next-start" });
  });
});
