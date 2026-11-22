import {
  MicroVmControlInput,
  MicroVmCreateInput,
  MicroVmError,
  MicroVmInfo,
  MicroVmModifyInput,
  MicroVmRemoveInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ServerConfig from "../../../config.ts";

const optional = <S extends Schema.Top>(schema: S) => Schema.optionalKey(schema);
const dependencies = [McpInvocationContext.McpInvocationContext, ServerConfig.ServerConfig];

export const MicroVmListTool = Tool.make("microvm_list", {
  description:
    "List persistent Microsandbox microVMs managed by Erebus, including their state, resource limits, owner thread or project, and disk use. These environments survive agent and Erebus restarts until removed, and all Erebus agents can access them.",
  parameters: Schema.Struct({}),
  success: Schema.Struct({ sandboxes: Schema.Array(MicroVmInfo), home: Schema.String }),
  failure: MicroVmError,
  dependencies,
})
  .annotate(Tool.Title, "List microVMs")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const MicroVmCreateTool = Tool.make("microvm_create", {
  description:
    "Create and start a persistent local microVM. Defaults are a minimal Debian image, 2 CPUs, 2048 MiB RAM, and /workspace; install the toolchain the task needs. Set CPU, memory, image, disk, workdir, and environment directly. sourcePath copies a private snapshot of a host directory into the guest; the guest never writes through to the original checkout. Outbound network access is available, but this tool does not publish inbound ports. A partial first start is recovered once or removed.",
  parameters: MicroVmCreateInput,
  success: MicroVmInfo,
  failure: MicroVmError,
  dependencies,
})
  .annotate(Tool.Title, "Create a microVM")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const MicroVmControlTool = Tool.make("microvm_control", {
  description:
    "Start, request a graceful stop, restart, or force-stop a persistent microVM. Stopping keeps its disk and setup for later recovery.",
  parameters: MicroVmControlInput,
  success: MicroVmInfo,
  failure: MicroVmError,
  dependencies,
})
  .annotate(Tool.Title, "Control a microVM")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const MicroVmModifyTool = Tool.make("microvm_modify", {
  description:
    "Change a persistent microVM's CPU, memory, disk size, working directory, or environment. apply controls whether changes apply live, at the next start, or through a managed restart.",
  parameters: MicroVmModifyInput,
  success: MicroVmInfo,
  failure: MicroVmError,
  dependencies,
})
  .annotate(Tool.Title, "Resize a microVM")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const MicroVmExecInput = Schema.Struct({
  name: Schema.String,
  command: Schema.String,
  args: optional(Schema.Array(Schema.String)),
  cwd: optional(Schema.String),
  env: optional(Schema.Record(Schema.String, Schema.String)),
  stdin: optional(Schema.String),
  detached: optional(Schema.Boolean),
  timeoutMs: optional(Schema.Int),
  maxOutputBytes: optional(Schema.Int),
});
export type MicroVmExecInput = typeof MicroVmExecInput.Type;

export const MicroVmExecTool = Tool.make("microvm_exec", {
  description:
    "Start the guest if needed, then run a command with literal argv, optional cwd/env/stdin, and no host shell. stdin works for synchronous and detached commands. Use detached=true for fuzzers, servers, builds, and other long work; inspect it later with microvm_job. Synchronous output is returned raw with truncation flags.",
  parameters: MicroVmExecInput,
  success: Schema.Struct({
    detached: Schema.Boolean,
    jobId: Schema.NullOr(Schema.String),
    exitCode: Schema.NullOr(Schema.Int),
    stdout: Schema.String,
    stderr: Schema.String,
    stdoutTruncated: Schema.Boolean,
    stderrTruncated: Schema.Boolean,
  }),
  failure: MicroVmError,
  dependencies,
})
  .annotate(Tool.Title, "Run in a microVM")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const MicroVmJobInput = Schema.Union([
  Schema.Struct({ name: Schema.String, action: Schema.Literal("list") }),
  Schema.Struct({
    name: Schema.String,
    action: Schema.Literal("logs"),
    jobId: Schema.String,
    tail: optional(Schema.Int),
  }),
  Schema.Struct({ name: Schema.String, action: Schema.Literal("stop"), jobId: Schema.String }),
]);
export type MicroVmJobInput = typeof MicroVmJobInput.Type;

export const MicroVmJobTool = Tool.make("microvm_job", {
  description:
    "List current background jobs in a microVM, read raw logs by the jobId returned from microvm_exec, or stop one job. Detached jobs keep running without holding the agent turn open.",
  parameters: MicroVmJobInput,
  success: Schema.Unknown,
  failure: MicroVmError,
  dependencies,
})
  .annotate(Tool.Title, "Manage a microVM job")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const MicroVmCopyInput = Schema.Struct({
  name: Schema.String,
  direction: Schema.Literals(["in", "out"]),
  source: Schema.String,
  destination: Schema.String,
});
export type MicroVmCopyInput = typeof MicroVmCopyInput.Type;

export const MicroVmCopyTool = Tool.make("microvm_copy", {
  description:
    "Start the guest if needed, then copy one file between the host and the microVM. direction=in treats source as a host path; direction=out treats source as a guest path. Use this to retrieve crashes, reports, corpora, and build artifacts.",
  parameters: MicroVmCopyInput,
  success: Schema.Struct({ copied: Schema.Boolean }),
  failure: MicroVmError,
  dependencies,
})
  .annotate(Tool.Title, "Copy a microVM file")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const MicroVmRemoveTool = Tool.make("microvm_remove", {
  description:
    "Permanently remove a persistent microVM and its private disk. Any active state requires force=true; stopped, crashed, and never-started guests do not. Copy out any needed artifacts first.",
  parameters: MicroVmRemoveInput,
  success: Schema.Struct({ removed: Schema.Boolean }),
  failure: MicroVmError,
  dependencies,
})
  .annotate(Tool.Title, "Remove a microVM")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const MicroVmToolkit = Toolkit.make(
  MicroVmListTool,
  MicroVmCreateTool,
  MicroVmControlTool,
  MicroVmModifyTool,
  MicroVmExecTool,
  MicroVmJobTool,
  MicroVmCopyTool,
  MicroVmRemoveTool,
);
