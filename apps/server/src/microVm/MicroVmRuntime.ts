// @effect-diagnostics nodeBuiltinImport:off - Microsandbox uses a host-local runtime and paths.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  MicroVmError,
  type MicroVmControlInput,
  type MicroVmCreateInput,
  type MicroVmInfo,
  type MicroVmModifyInput,
  type MicroVmRemoveInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Microsandbox from "microsandbox";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

type MicrosandboxModule = typeof import("microsandbox");

const WINDOWS_GUI_SUBSYSTEM = 2;
const WINDOWS_CONSOLE_SUBSYSTEM = 3;
const PE_POINTER_OFFSET = 0x3c;
const PE_SIGNATURE_SIZE = 4;
const COFF_HEADER_SIZE = 20;
const OPTIONAL_HEADER_SUBSYSTEM_OFFSET = 68;

async function readPeSubsystem(filePath: string): Promise<{
  readonly offset: number;
  readonly subsystem: number;
}> {
  const handle = await NodeFSP.open(filePath, "r");
  try {
    const dosHeader = Buffer.alloc(PE_POINTER_OFFSET + 4);
    const dosRead = await handle.read(dosHeader, 0, dosHeader.length, 0);
    if (dosRead.bytesRead !== dosHeader.length || dosHeader.toString("ascii", 0, 2) !== "MZ") {
      throw new Error("Microsandbox runtime is not a valid Windows executable.");
    }
    const peOffset = dosHeader.readUInt32LE(PE_POINTER_OFFSET);
    const optionalHeaderOffset = peOffset + PE_SIGNATURE_SIZE + COFF_HEADER_SIZE;
    const header = Buffer.alloc(OPTIONAL_HEADER_SUBSYSTEM_OFFSET + 2);
    const headerRead = await handle.read(header, 0, header.length, optionalHeaderOffset);
    if (
      headerRead.bytesRead !== header.length ||
      (header.readUInt16LE(0) !== 0x10b && header.readUInt16LE(0) !== 0x20b)
    ) {
      throw new Error("Microsandbox runtime has an invalid PE optional header.");
    }
    return {
      offset: optionalHeaderOffset + OPTIONAL_HEADER_SUBSYSTEM_OFFSET,
      subsystem: header.readUInt16LE(OPTIONAL_HEADER_SUBSYSTEM_OFFSET),
    };
  } finally {
    await handle.close();
  }
}

export async function materializeWindowlessWindowsExecutable(
  sourcePath: string,
  destinationPath: string,
): Promise<void> {
  const [sourceStat, destinationStat] = await Promise.all([
    NodeFSP.stat(sourcePath),
    NodeFSP.stat(destinationPath).catch(() => null),
  ]);
  if (destinationStat === null || destinationStat.size !== sourceStat.size) {
    await NodeFSP.copyFile(sourcePath, destinationPath);
  }

  const executable = await readPeSubsystem(destinationPath).catch(async () => {
    await NodeFSP.copyFile(sourcePath, destinationPath);
    return readPeSubsystem(destinationPath);
  });
  if (executable.subsystem === WINDOWS_GUI_SUBSYSTEM) return;
  if (executable.subsystem !== WINDOWS_CONSOLE_SUBSYSTEM) {
    throw new Error(
      `Microsandbox runtime uses unsupported Windows subsystem ${executable.subsystem}.`,
    );
  }

  const handle = await NodeFSP.open(destinationPath, "r+");
  try {
    const value = Buffer.alloc(2);
    value.writeUInt16LE(WINDOWS_GUI_SUBSYSTEM);
    await handle.write(value, 0, value.length, executable.offset);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function configureWindowlessWindowsRuntime(
  sdk: MicrosandboxModule,
  home: string,
  platform: NodeJS.Platform,
): Promise<void> {
  if (platform !== "win32") return;
  const runtime = await sdk.ensureRuntime({ home });
  const version = (await sdk.resolveRuntimeVersion(runtime.msbPath)) ?? "unknown";
  const runtimeDir = NodePath.join(home, "runtime");
  await NodeFSP.mkdir(runtimeDir, { recursive: true });
  const destination = NodePath.join(
    runtimeDir,
    `msb-${version.replaceAll(/[^a-zA-Z0-9._-]/g, "_")}-windowless.exe`,
  );
  await materializeWindowlessWindowsExecutable(runtime.msbPath, destination);
  process.env.MSB_PATH = destination;
  process.env.MSB_LIBKRUNFW_PATH = runtime.libkrunfwPath;
}

export interface MicroVmExecInput {
  readonly name: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string;
  readonly detached?: boolean;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface MicroVmExecResult {
  readonly detached: boolean;
  readonly jobId: string | null;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface MicroVmCopyInput {
  readonly name: string;
  readonly source: string;
  readonly destination: string;
}

const errorDetail = (error: unknown): string => {
  if (error instanceof Error && error.message.trim().length > 0) return error.message.trim();
  return String(error);
};

const hasErrorCode = (error: unknown, code: string): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { readonly code?: unknown }).code === code;

const removableWithoutForce = new Set<Microsandbox.SandboxStatus>([
  "created",
  "stopped",
  "crashed",
]);

const attempt = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new MicroVmError({ operation, detail: errorDetail(cause) }),
  });

const positiveInt = (value: number | undefined, fallback: number, name: string): number => {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return resolved;
};

const vmName = (requested: string | undefined): string => {
  if (requested !== undefined) {
    const normalized = requested.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(normalized)) {
      throw new Error(
        "MicroVM names must start with a letter or number and contain only letters, numbers, dots, dashes, or underscores.",
      );
    }
    return normalized;
  }
  return `erebus-${NodeCrypto.randomUUID().slice(0, 8)}`;
};

const configRecord = (config: Microsandbox.SandboxConfig): Record<string, unknown> =>
  config as Record<string, unknown>;

const nestedRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

const configImage = (config: Microsandbox.SandboxConfig): string => {
  const image = nestedRecord(configRecord(config).image);
  const oci = nestedRecord(image.Oci);
  return typeof oci.reference === "string" ? oci.reference : "unknown";
};

const configLabels = (config: Microsandbox.SandboxConfig): Record<string, string> => {
  const labels = configRecord(config).labels;
  return typeof labels === "object" && labels !== null ? (labels as Record<string, string>) : {};
};

const toInfo = async (handle: Microsandbox.SandboxHandle): Promise<MicroVmInfo> => {
  const config = handle.config();
  const raw = configRecord(config);
  const resources = nestedRecord(raw.resources);
  const runtime = nestedRecord(raw.runtime);
  const labels = configLabels(config);
  const rootDisk = nestedRecord(nestedRecord(nestedRecord(raw.image).Oci).rootDisk);
  const storage = await handle.storageUsage().catch(() => null);
  const allocated = storage?.allocatedBytes ?? storage?.logicalBytes ?? null;
  return {
    id: handle.id,
    name: handle.name,
    status: handle.status,
    image: configImage(config),
    cpus: Number(resources.cpus ?? 0),
    memoryMiB: Number(resources.memoryMib ?? 0),
    maxCpus: Number(resources.maxCpus ?? resources.cpus ?? 0),
    maxMemoryMiB: Number(resources.maxMemoryMib ?? resources.memoryMib ?? 0),
    rootDiskMiB: typeof rootDisk.sizeMib === "number" ? rootDisk.sizeMib : null,
    workdir: typeof runtime.workdir === "string" ? runtime.workdir : "/workspace",
    projectId: labels["erebus.projectId"] ?? null,
    threadId: labels["erebus.threadId"] ?? null,
    createdAt: handle.createdAt?.toISOString() ?? null,
    updatedAt: handle.updatedAt?.toISOString() ?? null,
    storageBytes: allocated === null ? null : Number(allocated),
  };
};

const truncate = (value: string, maxBytes: number): { value: string; truncated: boolean } => {
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return { value, truncated: false };
  return { value: bytes.subarray(0, maxBytes).toString("utf8"), truncated: true };
};

export interface MicroVmRuntimeService {
  readonly home: string;
  readonly list: () => Effect.Effect<ReadonlyArray<MicroVmInfo>, MicroVmError>;
  readonly get: (name: string) => Effect.Effect<MicroVmInfo, MicroVmError>;
  readonly create: (input: MicroVmCreateInput) => Effect.Effect<MicroVmInfo, MicroVmError>;
  readonly control: (input: MicroVmControlInput) => Effect.Effect<MicroVmInfo, MicroVmError>;
  readonly modify: (input: MicroVmModifyInput) => Effect.Effect<MicroVmInfo, MicroVmError>;
  readonly remove: (input: MicroVmRemoveInput) => Effect.Effect<void, MicroVmError>;
  readonly exec: (input: MicroVmExecInput) => Effect.Effect<MicroVmExecResult, MicroVmError>;
  readonly jobs: (name: string) => Effect.Effect<Microsandbox.JobPage, MicroVmError>;
  readonly jobLogs: (
    name: string,
    jobId: string,
    tail?: number,
  ) => Effect.Effect<ReadonlyArray<Microsandbox.JobLogEntry>, MicroVmError>;
  readonly stopJob: (name: string, jobId: string) => Effect.Effect<void, MicroVmError>;
  readonly copyIn: (input: MicroVmCopyInput) => Effect.Effect<void, MicroVmError>;
  readonly copyOut: (input: MicroVmCopyInput) => Effect.Effect<void, MicroVmError>;
}

export const make = Effect.fn("MicroVmRuntime.make")(function* (stateDir: string) {
  const home = NodePath.join(stateDir, "microvms");
  yield* attempt("initialize", () => NodeFSP.mkdir(home, { recursive: true }));
  process.env.MSB_HOME = home;

  const sdk = yield* attempt("load", () => import("microsandbox"));
  const platform = yield* HostProcessPlatform;
  yield* attempt("prepare-runtime", () => configureWindowlessWindowsRuntime(sdk, home, platform));
  sdk.setDefaultBackend("local");

  const getHandle = (name: string) => attempt("get", () => sdk.Sandbox.get(name));
  const getRunning = (name: string) =>
    getHandle(name).pipe(
      Effect.flatMap((handle) =>
        attempt("connect", () => handle.connectOrStart({ detached: true })),
      ),
    );

  const list: MicroVmRuntimeService["list"] = () =>
    attempt("list", async () => {
      const handles: Microsandbox.SandboxHandle[] = [];
      let cursor: string | undefined;
      do {
        const page = cursor
          ? await sdk.Sandbox.listWith((builder) => builder.limit(100).cursor(cursor!))
          : await sdk.Sandbox.listWith((builder) => builder.limit(100));
        handles.push(...page.sandboxes);
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return Promise.all(handles.map(toInfo));
    });

  const get: MicroVmRuntimeService["get"] = (name) =>
    getHandle(name).pipe(Effect.flatMap((handle) => attempt("get", () => toInfo(handle))));

  const create: MicroVmRuntimeService["create"] = (input) =>
    attempt("create", async () => {
      const name = vmName(input.name);
      try {
        await sdk.Sandbox.get(name);
        throw new Error(`A microVM named ${name} already exists.`);
      } catch (cause) {
        if (!hasErrorCode(cause, "sandboxNotFound")) throw cause;
      }
      const cpus = positiveInt(input.cpus, 2, "cpus");
      const memory = positiveInt(input.memoryMiB, 2048, "memoryMiB");
      const maxCpus = positiveInt(input.maxCpus, cpus, "maxCpus");
      const maxMemory = positiveInt(input.maxMemoryMiB, memory, "maxMemoryMiB");
      if (maxCpus < cpus || maxMemory < memory) {
        throw new Error("Maximum resources cannot be lower than active resources.");
      }
      const workdir = input.workdir?.trim() || input.guestSourcePath?.trim() || "/workspace";
      let builder = sdk.Sandbox.builder(name)
        .image(input.image?.trim() || "debian")
        .cpus(cpus)
        .maxCpus(maxCpus)
        .memory(memory)
        .maxMemory(maxMemory)
        .workdir(workdir)
        .detached(true)
        .ephemeral(false)
        .labels({
          "erebus.managed": "true",
          ...(input.projectId ? { "erebus.projectId": input.projectId } : {}),
          ...(input.threadId ? { "erebus.threadId": input.threadId } : {}),
        });
      builder = builder.patch((patch) => patch.mkdir(workdir));
      if (input.rootDiskMiB !== undefined) {
        builder = builder.rootDisk(positiveInt(input.rootDiskMiB, 0, "rootDiskMiB"));
      }
      if (input.env !== undefined) builder = builder.envs({ ...input.env });
      if (input.sourcePath !== undefined) {
        const source = NodePath.resolve(input.sourcePath);
        const stat = await NodeFSP.stat(source);
        if (!stat.isDirectory()) throw new Error("sourcePath must be a directory.");
        const guestPath = input.guestSourcePath?.trim() || "/workspace";
        builder = builder.patch((patch) => patch.copyDir(source, guestPath, { replace: true }));
      }
      try {
        const sandbox = await builder.create();
        await sandbox.detach();
        return toInfo(await sdk.Sandbox.get(name));
      } catch (createCause) {
        if (hasErrorCode(createCause, "sandboxAlreadyExists")) throw createCause;

        let partial: Microsandbox.SandboxHandle;
        try {
          partial = await sdk.Sandbox.get(name);
        } catch (lookupCause) {
          if (hasErrorCode(lookupCause, "sandboxNotFound")) throw createCause;
          throw new Error(
            `${errorDetail(createCause)} Failed to inspect the partial microVM: ${errorDetail(lookupCause)}`,
            { cause: lookupCause },
          );
        }

        try {
          const recovered = await partial.connectOrStart({ detached: true });
          await recovered.detach();
          return toInfo(await partial.refresh());
        } catch (recoveryCause) {
          try {
            await partial.destroy({ force: true });
          } catch (cleanupCause) {
            throw new Error(
              `${errorDetail(createCause)} Recovery failed: ${errorDetail(recoveryCause)} Cleanup also failed: ${errorDetail(cleanupCause)}`,
              { cause: cleanupCause },
            );
          }
          throw new Error(
            `${errorDetail(createCause)} Recovery failed: ${errorDetail(recoveryCause)} The partial microVM was removed.`,
            { cause: recoveryCause },
          );
        }
      }
    });

  const control: MicroVmRuntimeService["control"] = (input) =>
    getHandle(input.name).pipe(
      Effect.flatMap((handle) =>
        attempt("control", async () => {
          switch (input.action) {
            case "start": {
              const sandbox = await handle.startDetached();
              await sandbox.detach();
              break;
            }
            case "stop":
              await handle.requestStop();
              break;
            case "restart": {
              const sandbox = await handle.restart({ detached: true });
              await sandbox.detach();
              break;
            }
            case "kill":
              await handle.kill();
              break;
          }
          return toInfo(await handle.refresh());
        }),
      ),
    );

  const modify: MicroVmRuntimeService["modify"] = (input) =>
    getHandle(input.name).pipe(
      Effect.flatMap((handle) =>
        attempt("modify", async () => {
          await handle.modify({
            ...(input.cpus !== undefined ? { cpus: positiveInt(input.cpus, 0, "cpus") } : {}),
            ...(input.memoryMiB !== undefined
              ? { memory: positiveInt(input.memoryMiB, 0, "memoryMiB") }
              : {}),
            ...(input.maxCpus !== undefined
              ? { maxCpus: positiveInt(input.maxCpus, 0, "maxCpus") }
              : {}),
            ...(input.maxMemoryMiB !== undefined
              ? { maxMemory: positiveInt(input.maxMemoryMiB, 0, "maxMemoryMiB") }
              : {}),
            ...(input.rootDiskMiB !== undefined
              ? { rootDiskSize: positiveInt(input.rootDiskMiB, 0, "rootDiskMiB") }
              : {}),
            ...(input.workdir !== undefined ? { workdir: input.workdir } : {}),
            ...(input.env !== undefined ? { env: { ...input.env } } : {}),
            policy:
              input.apply === "restart"
                ? "restart"
                : input.apply === "next-start"
                  ? "next_start"
                  : "no_restart",
          });
          return toInfo(await handle.refresh());
        }),
      ),
    );

  const remove: MicroVmRuntimeService["remove"] = (input) =>
    getHandle(input.name).pipe(
      Effect.flatMap((handle) =>
        attempt("remove", async () => {
          const current = await handle.refresh();
          if (!removableWithoutForce.has(current.status) && input.force !== true) {
            throw new Error(
              `${current.name} is ${current.status}; pass force=true to remove an active microVM.`,
            );
          }
          await current.destroy({ force: input.force ?? false });
        }),
      ),
    );

  const exec: MicroVmRuntimeService["exec"] = (input) =>
    getRunning(input.name).pipe(
      Effect.flatMap((sandbox) =>
        attempt("exec", async () => {
          if (input.detached === true) {
            const job = await sandbox.execDetachedWith(input.command, (builder) => {
              builder.args([...input.args]);
              if (input.cwd !== undefined) builder.cwd(input.cwd);
              if (input.env !== undefined) builder.envs({ ...input.env });
              if (input.timeoutMs !== undefined) builder.timeout(input.timeoutMs);
              if (input.stdin !== undefined) builder.stdinBytes(Buffer.from(input.stdin));
              else builder.stdinNull();
              return builder;
            });
            await sandbox.detach();
            return {
              detached: true,
              jobId: job.id,
              exitCode: null,
              stdout: "",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            };
          }
          const output = await sandbox.execWith(input.command, (builder) => {
            builder.args([...input.args]);
            if (input.cwd !== undefined) builder.cwd(input.cwd);
            if (input.env !== undefined) builder.envs({ ...input.env });
            if (input.timeoutMs !== undefined) builder.timeout(input.timeoutMs);
            if (input.stdin !== undefined) builder.stdinBytes(Buffer.from(input.stdin));
            else builder.stdinNull();
            return builder;
          });
          await sandbox.detach();
          const max = input.maxOutputBytes ?? 4 * 1024 * 1024;
          const stdout = truncate(output.stdout(), max);
          const stderr = truncate(output.stderr(), max);
          return {
            detached: false,
            jobId: null,
            exitCode: output.code,
            stdout: stdout.value,
            stderr: stderr.value,
            stdoutTruncated: stdout.truncated,
            stderrTruncated: stderr.truncated,
          };
        }),
      ),
    );

  const jobs: MicroVmRuntimeService["jobs"] = (name) =>
    getHandle(name).pipe(Effect.flatMap((handle) => attempt("jobs", () => handle.listJobs())));

  const jobLogs: MicroVmRuntimeService["jobLogs"] = (name, jobId, tail) =>
    getHandle(name).pipe(
      Effect.flatMap((handle) =>
        attempt("jobLogs", async () =>
          (await handle.getJob(jobId)).logs(tail === undefined ? {} : { tail }),
        ),
      ),
    );

  const stopJob: MicroVmRuntimeService["stopJob"] = (name, jobId) =>
    getHandle(name).pipe(
      Effect.flatMap((handle) =>
        attempt("stopJob", async () => (await handle.getJob(jobId)).kill()),
      ),
    );

  const copyIn: MicroVmRuntimeService["copyIn"] = (input) =>
    getRunning(input.name).pipe(
      Effect.flatMap((sandbox) =>
        attempt("copyIn", async () => {
          await sandbox.fs().copyFromHost(input.source, input.destination);
          await sandbox.detach();
        }),
      ),
    );

  const copyOut: MicroVmRuntimeService["copyOut"] = (input) =>
    getRunning(input.name).pipe(
      Effect.flatMap((sandbox) =>
        attempt("copyOut", async () => {
          await sandbox.fs().copyToHost(input.source, input.destination);
          await sandbox.detach();
        }),
      ),
    );

  return {
    home,
    list,
    get,
    create,
    control,
    modify,
    remove,
    exec,
    jobs,
    jobLogs,
    stopJob,
    copyIn,
    copyOut,
  } satisfies MicroVmRuntimeService;
});
