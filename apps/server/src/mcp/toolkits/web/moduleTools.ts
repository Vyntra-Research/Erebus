import { WebRuntimeRpcError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PentestModuleRuntime from "../../PentestModuleRuntime.ts";

const optional = <S extends Schema.Top>(schema: S) => Schema.optionalKey(schema);
const positiveInt = (description: string, maximum: number) =>
  Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(maximum)).annotate({
    description,
  });

export const WebPentestModule = Schema.Literals(["secrethound", "katana", "subfinder"]);

export const WebModuleExecInput = Schema.Struct({
  module: WebPentestModule.annotate({
    description: "Installed module executable to run.",
  }),
  args: Schema.Array(Schema.String).check(Schema.isMaxLength(2_048)).annotate({
    description:
      "CLI arguments passed to the executable unchanged and in order. Use an empty array to run it without arguments.",
  }),
  cwd: optional(
    Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty()).annotate({
      description: "Working directory for the process. Omit it to use the Erebus server directory.",
    }),
  ),
  stdin: optional(
    Schema.String.annotate({
      description: "Exact UTF-8 text written to standard input before it is closed.",
    }),
  ),
  maxOutputBytes: optional(
    positiveInt(
      "Maximum bytes retained from each of stdout and stderr. Defaults to 4194304 and may be at most 16777216.",
      16 * 1024 * 1024,
    ),
  ),
});
export type WebModuleExecInput = typeof WebModuleExecInput.Type;

export const WebModuleExecSuccess = Schema.Struct({
  module: WebPentestModule.annotate({ description: "Module that ran." }),
  version: Schema.String.annotate({ description: "Installed module version, or external." }),
  exitCode: Schema.NullOr(Schema.Int).annotate({
    description: "Process exit code, or null when the process ended without producing one.",
  }),
  stdout: Schema.String.annotate({ description: "Raw retained standard output." }),
  stderr: Schema.String.annotate({ description: "Raw retained standard error." }),
  stdoutTruncated: Schema.Boolean.annotate({
    description: "Whether stdout exceeded maxOutputBytes and was truncated.",
  }),
  stderrTruncated: Schema.Boolean.annotate({
    description: "Whether stderr exceeded maxOutputBytes and was truncated.",
  }),
  stdoutInvalidUtf8: Schema.Boolean.annotate({
    description: "Whether stdout contained invalid UTF-8 bytes that were replaced while decoding.",
  }),
  stderrInvalidUtf8: Schema.Boolean.annotate({
    description: "Whether stderr contained invalid UTF-8 bytes that were replaced while decoding.",
  }),
});

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  PentestModuleRuntime.PentestModuleRuntime,
];

export const WebModuleExecTool = Tool.make("web_module_exec", {
  description:
    "Run SecretHound, Katana, or Subfinder directly with arbitrary CLI arguments. Erebus passes args through unchanged after module config paths set in Settings, accepts optional stdin and cwd, and returns raw stdout and stderr with explicit truncation state. The process runs until it exits or the agent cancels the call. A non-zero exit code is returned as process output rather than hidden as a tool failure.",
  parameters: WebModuleExecInput,
  success: WebModuleExecSuccess,
  failure: Schema.Union([PentestModuleRuntime.PentestModuleExecutionError, WebRuntimeRpcError]),
  dependencies,
})
  .annotate(Tool.Title, "Run a web pentest module")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const WebModuleToolkit = Toolkit.make(WebModuleExecTool);
