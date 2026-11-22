import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { ServerConfig } from "../config.ts";

export class WebRuntimeBinaryNotFound extends Schema.TaggedErrorClass<WebRuntimeBinaryNotFound>()(
  "WebRuntimeBinaryNotFound",
  { path: Schema.String },
) {
  override get message(): string {
    return `Web runtime binary was not found at '${this.path}'.`;
  }
}

export class WebRuntimeBinaryNotExecutable extends Schema.TaggedErrorClass<WebRuntimeBinaryNotExecutable>()(
  "WebRuntimeBinaryNotExecutable",
  { path: Schema.String, mode: Schema.Number },
) {
  override get message(): string {
    return `Web runtime binary at '${this.path}' is not executable.`;
  }
}

export class WebRuntimeBinaryNotFile extends Schema.TaggedErrorClass<WebRuntimeBinaryNotFile>()(
  "WebRuntimeBinaryNotFile",
  { path: Schema.String },
) {
  override get message(): string {
    return `Web runtime binary path '${this.path}' is not a file.`;
  }
}

export class WebRuntimeBinaryAccessFailed extends Schema.TaggedErrorClass<WebRuntimeBinaryAccessFailed>()(
  "WebRuntimeBinaryAccessFailed",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not inspect the web runtime binary at '${this.path}'.`;
  }
}

export type WebRuntimeBinaryError =
  | WebRuntimeBinaryNotFound
  | WebRuntimeBinaryNotFile
  | WebRuntimeBinaryNotExecutable
  | WebRuntimeBinaryAccessFailed;

export class WebRuntimeBinary extends Context.Service<
  WebRuntimeBinary,
  { readonly resolve: Effect.Effect<Option.Option<string>, WebRuntimeBinaryError> }
>()("erebus/webRuntime/WebRuntimeBinary") {}

export const resolvePath = Effect.fn("webRuntime.webRuntimeBinary.resolvePath")(function* (
  candidate: string | undefined,
) {
  if (!candidate) return Option.none<string>();
  const fileSystem = yield* FileSystem.FileSystem;
  const platform = yield* HostProcessPlatform;
  const exists = yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false));
  if (!exists) return yield* new WebRuntimeBinaryNotFound({ path: candidate });
  const stat = yield* fileSystem
    .stat(candidate)
    .pipe(Effect.mapError((cause) => new WebRuntimeBinaryAccessFailed({ path: candidate, cause })));
  if (stat.type !== "File") return yield* new WebRuntimeBinaryNotFile({ path: candidate });
  if (platform !== "win32" && (stat.mode & 0o111) === 0) {
    return yield* new WebRuntimeBinaryNotExecutable({ path: candidate, mode: stat.mode });
  }
  return Option.some(candidate);
});

export const make = Effect.fn("webRuntime.webRuntimeBinary.make")(function* () {
  const config = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const candidate = process.env.EREBUS_WEB_RUNTIME_PATH ?? config.webRuntimePath;
  return WebRuntimeBinary.of({
    resolve: resolvePath(candidate).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem)),
  });
});

export const layer = Layer.effect(WebRuntimeBinary, make());
