import * as Schema from "effect/Schema";

const optional = <S extends Schema.Top>(schema: S) => Schema.optionalKey(schema);

export const MicroVmStatus = Schema.Literals([
  "created",
  "starting",
  "running",
  "draining",
  "paused",
  "stopped",
  "crashed",
]);
export type MicroVmStatus = typeof MicroVmStatus.Type;

export const MicroVmInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  status: MicroVmStatus,
  image: Schema.String,
  cpus: Schema.Int,
  memoryMiB: Schema.Int,
  maxCpus: Schema.Int,
  maxMemoryMiB: Schema.Int,
  rootDiskMiB: Schema.NullOr(Schema.Int),
  workdir: Schema.String,
  projectId: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(Schema.String),
  createdAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.NullOr(Schema.String),
  storageBytes: Schema.NullOr(Schema.Number),
});
export type MicroVmInfo = typeof MicroVmInfo.Type;

export const MicroVmListResult = Schema.Struct({
  sandboxes: Schema.Array(MicroVmInfo),
  home: Schema.String,
  backend: Schema.Literal("microsandbox"),
});
export type MicroVmListResult = typeof MicroVmListResult.Type;

export const MicroVmCreateInput = Schema.Struct({
  name: optional(Schema.String),
  image: optional(Schema.String),
  cpus: optional(Schema.Int),
  memoryMiB: optional(Schema.Int),
  maxCpus: optional(Schema.Int),
  maxMemoryMiB: optional(Schema.Int),
  rootDiskMiB: optional(Schema.Int),
  workdir: optional(Schema.String),
  sourcePath: optional(Schema.String),
  guestSourcePath: optional(Schema.String),
  projectId: optional(Schema.String),
  threadId: optional(Schema.String),
  env: optional(Schema.Record(Schema.String, Schema.String)),
});
export type MicroVmCreateInput = typeof MicroVmCreateInput.Type;

export const MicroVmControlInput = Schema.Struct({
  name: Schema.String,
  action: Schema.Literals(["start", "stop", "restart", "kill"]),
});
export type MicroVmControlInput = typeof MicroVmControlInput.Type;

export const MicroVmModifyInput = Schema.Struct({
  name: Schema.String,
  cpus: optional(Schema.Int),
  memoryMiB: optional(Schema.Int),
  maxCpus: optional(Schema.Int),
  maxMemoryMiB: optional(Schema.Int),
  rootDiskMiB: optional(Schema.Int),
  workdir: optional(Schema.String),
  env: optional(Schema.Record(Schema.String, Schema.String)),
  apply: optional(Schema.Literals(["now", "next-start", "restart"])),
});
export type MicroVmModifyInput = typeof MicroVmModifyInput.Type;

export const MicroVmRemoveInput = Schema.Struct({
  name: Schema.String,
  force: optional(Schema.Boolean),
});
export type MicroVmRemoveInput = typeof MicroVmRemoveInput.Type;

export class MicroVmError extends Schema.TaggedErrorClass<MicroVmError>()("MicroVmError", {
  operation: Schema.String,
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}
