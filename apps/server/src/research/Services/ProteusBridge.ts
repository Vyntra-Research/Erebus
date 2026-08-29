import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class ProteusBridgeError extends Schema.TaggedErrorClass<ProteusBridgeError>()(
  "ProteusBridgeError",
  {
    operation: Schema.Literals(["campaign", "branch", "checkpoint"]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface ProteusRecordIdentity {
  readonly id: number;
  readonly status: string | null;
  readonly campaignId: number | null;
}

export interface ProteusBridgeShape {
  readonly readCampaign: (
    root: string,
    campaignId: string,
  ) => Effect.Effect<ProteusRecordIdentity, ProteusBridgeError>;
  readonly readBranch: (
    root: string,
    branchId: string,
  ) => Effect.Effect<ProteusRecordIdentity, ProteusBridgeError>;
  readonly readCheckpoint: (
    root: string,
    checkpointId: string,
  ) => Effect.Effect<ProteusRecordIdentity, ProteusBridgeError>;
}

export class ProteusBridge extends Context.Reference<ProteusBridgeShape | undefined>(
  "erebus/research/Services/ProteusBridge",
  { defaultValue: () => undefined },
) {}
