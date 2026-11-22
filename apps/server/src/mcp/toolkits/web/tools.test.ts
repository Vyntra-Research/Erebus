import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import { Tool } from "effect/unstable/ai";

import { WebToolkit } from "./tools.ts";

const schemaHasDescription = (schema: unknown): boolean => {
  if (!schema || typeof schema !== "object") return false;
  const record = schema as Record<string, unknown>;
  if (typeof record.description === "string" && record.description.length > 0) return true;
  return [record.anyOf, record.oneOf, record.allOf]
    .filter(Array.isArray)
    .some((members) => members.some(schemaHasDescription));
};

it("exports the focused web evidence toolkit with provider-compatible schemas", () => {
  expect(Object.keys(WebToolkit.tools)).toEqual([
    "web_capture_list",
    "web_capture_start",
    "web_capture_control",
    "web_extension_pair",
    "web_capture_gaps",
    "web_scope_list",
    "web_scope_save",
    "web_scope_delete",
    "web_traffic_search",
    "web_exchange_get",
    "web_body_get",
    "web_map_query",
    "web_map_neighborhood",
    "web_websocket_search",
    "web_websocket_get",
    "web_annotate",
    "web_annotation_list",
    "web_annotation_update",
    "web_annotation_delete",
    "web_replay",
  ]);

  for (const tool of Object.values(WebToolkit.tools)) {
    const schema = Tool.getJsonSchema(tool) as {
      readonly type?: unknown;
      readonly properties?: Readonly<Record<string, unknown>>;
      readonly anyOf?: unknown;
      readonly oneOf?: unknown;
    };
    expect(tool.description?.length ?? 0).toBeGreaterThan(40);
    expect(schema.type, `${tool.name} must use a top-level object schema`).toBe("object");
    expect(schema.anyOf, `${tool.name} must not use a root anyOf`).toBeUndefined();
    expect(schema.oneOf, `${tool.name} must not use a root oneOf`).toBeUndefined();
    for (const [field, fieldSchema] of Object.entries(schema.properties ?? {})) {
      expect(
        schemaHasDescription(fieldSchema),
        `${tool.name}.${field} should tell the agent what to pass`,
      ).toBe(true);
    }
  }
});

it("marks reads, annotations, and replay with accurate MCP hints", () => {
  const readNames = [
    "web_capture_list",
    "web_capture_gaps",
    "web_scope_list",
    "web_traffic_search",
    "web_exchange_get",
    "web_body_get",
    "web_map_query",
    "web_map_neighborhood",
    "web_websocket_search",
    "web_websocket_get",
    "web_annotation_list",
  ] as const;
  for (const name of readNames) {
    const tool = WebToolkit.tools[name];
    expect(Context.get(tool.annotations, Tool.Readonly)).toBe(true);
    expect(Context.get(tool.annotations, Tool.Destructive)).toBe(false);
    expect(Context.get(tool.annotations, Tool.Idempotent)).toBe(true);
    expect(Context.get(tool.annotations, Tool.OpenWorld)).toBe(false);
  }

  const annotate = WebToolkit.tools.web_annotate;
  expect(Context.get(annotate.annotations, Tool.Readonly)).toBe(false);
  expect(Context.get(annotate.annotations, Tool.Destructive)).toBe(false);
  expect(Context.get(annotate.annotations, Tool.Idempotent)).toBe(false);
  expect(Context.get(annotate.annotations, Tool.OpenWorld)).toBe(false);

  const localWriteNames = ["web_capture_start", "web_extension_pair"] as const;
  for (const name of localWriteNames) {
    const tool = WebToolkit.tools[name];
    expect(Context.get(tool.annotations, Tool.Readonly)).toBe(false);
    expect(Context.get(tool.annotations, Tool.Destructive)).toBe(false);
    expect(Context.get(tool.annotations, Tool.Idempotent)).toBe(false);
    expect(Context.get(tool.annotations, Tool.OpenWorld)).toBe(false);
  }

  const localDestructiveNames = [
    "web_capture_control",
    "web_scope_save",
    "web_scope_delete",
    "web_annotation_update",
    "web_annotation_delete",
  ] as const;
  for (const name of localDestructiveNames) {
    const tool = WebToolkit.tools[name];
    expect(Context.get(tool.annotations, Tool.Readonly)).toBe(false);
    expect(Context.get(tool.annotations, Tool.Destructive)).toBe(true);
    expect(Context.get(tool.annotations, Tool.OpenWorld)).toBe(false);
  }

  const replay = WebToolkit.tools.web_replay;
  expect(Context.get(replay.annotations, Tool.Readonly)).toBe(false);
  expect(Context.get(replay.annotations, Tool.Destructive)).toBe(true);
  expect(Context.get(replay.annotations, Tool.Idempotent)).toBe(false);
  expect(Context.get(replay.annotations, Tool.OpenWorld)).toBe(true);
});

it("advertises an exclusive nested browser profile selector", () => {
  const schema = Tool.getJsonSchema(WebToolkit.tools.web_capture_start) as {
    readonly properties?: Readonly<
      Record<
        string,
        {
          readonly anyOf?: ReadonlyArray<{ readonly required?: ReadonlyArray<string> }>;
        }
      >
    >;
  };
  const properties = schema.properties ?? {};
  const alternatives = properties.browserProfile?.anyOf ?? [];

  expect(properties.browserProfileId).toBeUndefined();
  expect(properties.browserProfileName).toBeUndefined();
  expect(alternatives.map((alternative) => alternative.required)).toEqual([
    ["profileId"],
    ["profileName"],
  ]);
});

it("requires an annotation target type whenever an id is supplied", () => {
  const schema = Tool.getJsonSchema(WebToolkit.tools.web_annotation_list) as {
    readonly properties?: Readonly<
      Record<
        string,
        {
          readonly type?: string;
          readonly properties?: Readonly<Record<string, unknown>>;
          readonly required?: ReadonlyArray<string>;
        }
      >
    >;
  };
  const properties = schema.properties ?? {};

  expect(properties.targetType).toBeUndefined();
  expect(properties.targetId).toBeUndefined();
  expect(properties.target?.type).toBe("object");
  expect(properties.target?.required).toEqual(["type"]);
  expect(properties.target?.properties).toHaveProperty("id");
});

it("documents capture exclusions and the complete map vocabulary", () => {
  const capture = WebToolkit.tools.web_capture_start;
  const captureSchema = Tool.getJsonSchema(capture) as {
    readonly properties?: Readonly<Record<string, unknown>>;
  };
  const map = WebToolkit.tools.web_map_query;
  const mapSchema = Tool.getJsonSchema(map) as {
    readonly properties?: Readonly<Record<string, unknown>>;
  };

  expect(capture.description).toContain("source and browserProfile are mutually exclusive");
  expect(capture.description).toContain("upstreamTls requires proxy=true");
  expect(JSON.stringify(captureSchema.properties?.source)).toContain(
    "cannot be combined with browserProfile",
  );
  expect(map.description).toContain("routes");
  expect(map.description).not.toContain("paths");
  expect(JSON.stringify(mapSchema.properties?.kind)).toContain("route");
  expect(JSON.stringify(mapSchema.properties?.inScopeOnly)).toContain("Defaults to false");
});
