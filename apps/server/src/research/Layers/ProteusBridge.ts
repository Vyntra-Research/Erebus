import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
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
const ProteusCampaignDigest = Schema.Struct({
  campaign: ProteusRecord,
  activeRounds: Schema.optionalKey(Schema.Array(ProteusRecord)),
});
const ProteusReadOutput = Schema.Union([ProteusRecord, ProteusCampaignDigest]);
const decodeProteusReadOutput = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProteusReadOutput),
);

const identityFromJson = (
  operation: "campaign" | "branch" | "checkpoint",
  requestedId: number,
  root: string,
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
    root,
    activeRoundIds:
      "activeRounds" in value ? (value.activeRounds ?? []).map((round) => round.id) : [],
  };
};

const makeProteusBridge = Effect.gen(function* () {
  const runner = yield* ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const initializedProteusRoots = Effect.fn("ProteusBridge.initializedProteusRoots")(function* (
    start: string,
  ) {
    const roots: string[] = [];
    let current = path.resolve(start);
    while (true) {
      const database = path.join(current, ".vros", "memory.sqlite");
      const info = yield* fileSystem.stat(database).pipe(Effect.orElseSucceed(() => null));
      if (info?.type === "File" && info.size > 0) roots.push(current);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return roots;
  });

  const runProteus = Effect.fn("ProteusBridge.runProteus")(function* (
    operation: ProteusBridgeError["operation"],
    root: string,
    args: ReadonlyArray<string>,
  ) {
    const runtime = yield* resolveManagedProteusRuntime().pipe(
      Effect.mapError(
        (cause) => new ProteusBridgeError({ operation, detail: cause.detail, cause }),
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
              detail: `Failed to execute the public Proteus CLI for ${operation}.`,
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
    return output.stdout;
  });

  const readExact = Effect.fn("ProteusBridge.readExact")(function* (
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
    const stdout = yield* runProteus(operation, root, args);
    const parsed = yield* decodeProteusReadOutput(stdout).pipe(
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
      try: () => identityFromJson(operation, id, root, parsed),
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

  const readCampaign = Effect.fn("ProteusBridge.readCampaign")(function* (
    start: string,
    campaignId: string,
  ) {
    if (!numericId("campaign", campaignId)) {
      return yield* new ProteusBridgeError({
        operation: "campaign",
        detail: "campaign id must be a positive Proteus numeric id.",
      });
    }
    const roots = yield* initializedProteusRoots(start);
    if (roots.length === 0) {
      return yield* new ProteusBridgeError({
        operation: "root",
        detail: `No initialized Proteus database was found at or above ${path.resolve(start)}.`,
      });
    }
    const matches: ProteusRecordIdentity[] = [];
    const failures: string[] = [];
    for (const root of roots) {
      const result = yield* Effect.result(readExact("campaign", root, campaignId));
      if (result._tag === "Success") matches.push(result.success);
      else failures.push(`${root}: ${result.failure.detail}`);
    }
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      return yield* new ProteusBridgeError({
        operation: "root",
        detail: `Proteus campaign ${campaignId} exists in more than one ancestor root: ${matches.map((match) => match.root).join(", ")}.`,
      });
    }
    return yield* new ProteusBridgeError({
      operation: "campaign",
      detail: `Proteus campaign ${campaignId} was not found in any ancestor database. ${failures.join(" | ")}`,
    });
  });

  const completeCampaign = Effect.fn("ProteusBridge.completeCampaign")(function* (
    root: string,
    campaignId: string,
    summary: string,
  ) {
    const before = yield* readExact("campaign", root, campaignId);
    const completedRounds: number[] = [];
    const rollback = () =>
      Effect.forEach(
        completedRounds.toReversed(),
        (roundId) =>
          runProteus("campaignComplete", root, [
            "update",
            "round",
            "--id",
            String(roundId),
            "--status",
            "active",
            "--root",
            root,
          ]).pipe(Effect.ignore),
        { discard: true },
      );

    const mutation = Effect.gen(function* () {
      for (const roundId of before.activeRoundIds) {
        yield* runProteus("campaignComplete", root, [
          "update",
          "round",
          "--id",
          String(roundId),
          "--status",
          "completed",
          "--root",
          root,
        ]);
        completedRounds.push(roundId);
      }
      if (before.status !== "completed") {
        yield* runProteus("campaignComplete", root, [
          "campaign",
          "close",
          "--id",
          String(before.id),
          "--status",
          "completed",
          "--summary",
          summary,
          "--root",
          root,
        ]);
      }
    }).pipe(Effect.tapError(rollback));
    yield* mutation;

    const after = yield* readExact("campaign", root, campaignId);
    if (after.status !== "completed" || after.activeRoundIds.length > 0) {
      return yield* new ProteusBridgeError({
        operation: "campaignComplete",
        detail: `Proteus campaign ${campaignId} did not reach a completed state with zero active rounds.`,
      });
    }
    return after;
  });

  return ProteusBridge.of({
    resolveCampaign: readCampaign,
    readCampaign: (root, campaignId) => readExact("campaign", root, campaignId),
    readBranch: (root, branchId) => readExact("branch", root, branchId),
    readCheckpoint: (root, checkpointId) => readExact("checkpoint", root, checkpointId),
    completeCampaign,
  });
});

export const ProteusBridgeLive = Layer.effect(ProteusBridge, makeProteusBridge);
