import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ProcessRunner } from "../../processRunner.ts";
import { resolveManagedProteusRuntime } from "../../proteusRuntime.ts";
import {
  ProteusBridge,
  ProteusBridgeError,
  type ProteusRecordIdentity,
} from "../Services/ProteusBridge.ts";

const numericId = (
  operation: "campaign" | "branch" | "checkpoint",
  value: string,
): number | null => {
  const prefix = operation === "campaign" ? "C" : operation === "branch" ? "B" : "(?:CP|P)";
  const match = value.trim().match(new RegExp(`^(?:${prefix})?([1-9]\\d*)$`, "i"));
  if (!match?.[1]) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

const ProteusRecord = Schema.Struct({
  id: Schema.Number,
  status: Schema.optionalKey(Schema.String),
  campaignId: Schema.optionalKey(Schema.NullOr(Schema.Number)),
});
const ProteusReadOutput = Schema.Union([ProteusRecord, Schema.Struct({ campaign: ProteusRecord })]);
const decodeProteusReadOutput = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProteusReadOutput),
);

const identityFromJson = (
  operation: "campaign" | "branch" | "checkpoint",
  requestedId: number,
  value: typeof ProteusReadOutput.Type,
): ProteusRecordIdentity => {
  const record = "campaign" in value ? value.campaign : value;
  const id = record.id;
  if (id !== requestedId) {
    throw new ProteusBridgeError({
      operation,
      detail: `Proteus returned ${operation} ${String(id)} instead of ${requestedId}.`,
    });
  }
  return {
    id,
    status: record.status ?? null,
    campaignId: record.campaignId ?? null,
  };
};

const makeProteusBridge = Effect.gen(function* () {
  const runner = yield* ProcessRunner;

  const read = Effect.fn("ProteusBridge.read")(function* (
    operation: "campaign" | "branch" | "checkpoint",
    root: string,
    rawId: string,
  ) {
    const id = numericId(operation, rawId);
    if (!id) {
      return yield* new ProteusBridgeError({
        operation,
        detail: `${operation} id must be a positive Proteus numeric id.`,
      });
    }
    const args =
      operation === "campaign"
        ? ["campaign", "resume", "--root", root, "--id", String(id)]
        : ["show", operation, String(id), "--root", root];
    const runtime = yield* resolveManagedProteusRuntime().pipe(
      Effect.mapError(
        (cause) =>
          new ProteusBridgeError({
            operation,
            detail: cause.detail,
            cause,
          }),
      ),
    );
    const output = yield* runner
      .run({
        command: process.execPath,
        args: [runtime.cliPath, ...args],
        cwd: root,
        timeout: "10 seconds",
        maxOutputBytes: 1024 * 1024,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProteusBridgeError({
              operation,
              detail: `Failed to execute the public Proteus CLI for ${operation} validation.`,
              cause,
            }),
        ),
      );
    if (output.code !== 0) {
      return yield* new ProteusBridgeError({
        operation,
        detail: output.stderr.trim() || `Proteus exited with code ${String(output.code)}.`,
      });
    }
    const parsed = yield* decodeProteusReadOutput(output.stdout).pipe(
      Effect.mapError(
        (cause) =>
          new ProteusBridgeError({
            operation,
            detail: `Proteus returned invalid JSON while validating ${operation}.`,
            cause,
          }),
      ),
    );
    const isProteusBridgeError = Schema.is(ProteusBridgeError);
    return yield* Effect.try({
      try: () => identityFromJson(operation, id, parsed),
      catch: (cause) =>
        isProteusBridgeError(cause)
          ? cause
          : new ProteusBridgeError({
              operation,
              detail: `Proteus returned an invalid ${operation} record.`,
              cause,
            }),
    });
  });

  return ProteusBridge.of({
    readCampaign: (root, campaignId) => read("campaign", root, campaignId),
    readBranch: (root, branchId) => read("branch", root, branchId),
    readCheckpoint: (root, checkpointId) => read("checkpoint", root, checkpointId),
  });
});

export const ProteusBridgeLive = Layer.effect(ProteusBridge, makeProteusBridge);
