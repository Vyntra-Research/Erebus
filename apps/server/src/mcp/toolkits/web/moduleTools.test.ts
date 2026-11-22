import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import { Tool } from "effect/unstable/ai";

import { WebModuleToolkit } from "./moduleTools.ts";

const schemaHasDescription = (schema: unknown): boolean => {
  if (!schema || typeof schema !== "object") return false;
  const record = schema as Record<string, unknown>;
  if (typeof record.description === "string" && record.description.length > 0) return true;
  return [record.anyOf, record.oneOf, record.allOf]
    .filter(Array.isArray)
    .some((members) => members.some(schemaHasDescription));
};

it("exposes one direct module execution tool with arbitrary arguments and raw output", () => {
  expect(Object.keys(WebModuleToolkit.tools)).toEqual(["web_module_exec"]);
  const tool = WebModuleToolkit.tools.web_module_exec;
  const input = Tool.getJsonSchema(tool) as {
    readonly type?: unknown;
    readonly properties?: Readonly<Record<string, unknown>>;
    readonly required?: ReadonlyArray<string>;
  };
  expect(input.type).toBe("object");
  expect(Object.keys(input.properties ?? {})).toEqual([
    "module",
    "args",
    "cwd",
    "stdin",
    "maxOutputBytes",
  ]);
  expect(input.required).toEqual(["module", "args"]);
  for (const [field, fieldSchema] of Object.entries(input.properties ?? {})) {
    expect(schemaHasDescription(fieldSchema), `${field} needs a description`).toBe(true);
  }

  const success = Tool.getJsonSchemaFromSchema(tool.successSchema) as {
    readonly properties?: Readonly<Record<string, unknown>>;
    readonly required?: ReadonlyArray<string>;
  };
  expect(Object.keys(success.properties ?? {})).toEqual([
    "module",
    "version",
    "exitCode",
    "stdout",
    "stderr",
    "stdoutTruncated",
    "stderrTruncated",
    "stdoutInvalidUtf8",
    "stderrInvalidUtf8",
  ]);
  expect(success.required).toEqual(Object.keys(success.properties ?? {}));
});

it("marks direct module execution as open-world and non-idempotent", () => {
  const tool = WebModuleToolkit.tools.web_module_exec;
  expect(Context.get(tool.annotations, Tool.Readonly)).toBe(false);
  expect(Context.get(tool.annotations, Tool.Destructive)).toBe(false);
  expect(Context.get(tool.annotations, Tool.Idempotent)).toBe(false);
  expect(Context.get(tool.annotations, Tool.OpenWorld)).toBe(true);
});
