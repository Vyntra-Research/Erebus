import type { MicroVmInfo, MicroVmModifyInput } from "@t3tools/contracts";

export interface MicroVmEditValues {
  readonly cpus: string;
  readonly memoryMiB: string;
  readonly maxCpus: string;
  readonly maxMemoryMiB: string;
  readonly rootDiskMiB: string;
  readonly workdir: string;
  readonly apply: "now" | "next-start" | "restart";
}

export function buildMicroVmModifyInput(
  vm: MicroVmInfo,
  values: MicroVmEditValues,
): MicroVmModifyInput {
  const cpus = Number(values.cpus);
  const memoryMiB = Number(values.memoryMiB);
  const maxCpus = Number(values.maxCpus);
  const maxMemoryMiB = Number(values.maxMemoryMiB);
  const rootDiskText = values.rootDiskMiB.trim();
  const rootDiskMiB = rootDiskText.length > 0 ? Number(rootDiskText) : null;
  const workdir = values.workdir.trim() || vm.workdir;

  return {
    name: vm.name,
    ...(cpus !== vm.cpus ? { cpus } : {}),
    ...(memoryMiB !== vm.memoryMiB ? { memoryMiB } : {}),
    ...(maxCpus !== vm.maxCpus ? { maxCpus } : {}),
    ...(maxMemoryMiB !== vm.maxMemoryMiB ? { maxMemoryMiB } : {}),
    ...(rootDiskMiB !== null && rootDiskMiB !== vm.rootDiskMiB ? { rootDiskMiB } : {}),
    ...(workdir !== vm.workdir ? { workdir } : {}),
    apply: values.apply,
  };
}
