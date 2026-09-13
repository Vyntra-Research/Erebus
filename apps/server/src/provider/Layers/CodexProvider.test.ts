import { assert, it } from "@effect/vitest";
import type * as CodexSchema from "effect-codex-app-server/schema";

import {
  applyPreferredCodexDefaultModel,
  codexLoginInstruction,
  deriveArgosHealth,
  deriveProteusHealth,
  mapCodexModelCapabilities,
} from "./CodexProvider.ts";

it("builds a login command for Erebus's isolated Codex profile", () => {
  assert.equal(
    codexLoginInstruction("C:\\Users\\researcher\\.erebus\\userdata\\providers\\codex", "win32"),
    "$env:CODEX_HOME='C:\\Users\\researcher\\.erebus\\userdata\\providers\\codex'; codex login",
  );
  assert.equal(
    codexLoginInstruction("/home/researcher/.erebus/userdata/providers/codex", "linux"),
    "CODEX_HOME='/home/researcher/.erebus/userdata/providers/codex' codex login",
  );
});

it("maps current Codex model capability fields", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "super-high",
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    defaultServiceTier: "flex",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "Lower latency responses.",
      },
      {
        id: "flex",
        name: "Flex",
        description: "Lower-cost asynchronous routing.",
      },
    ],
    supportedReasoningEfforts: [
      {
        description: "Maximum reasoning",
        reasoningEffort: "super-high",
      },
    ],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [{ id: "super-high", label: "super-high", isDefault: true }],
      currentValue: "super-high",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard" },
        {
          id: "priority",
          label: "Fast",
          description: "Lower latency responses.",
        },
        {
          id: "flex",
          label: "Flex",
          description: "Lower-cost asynchronous routing.",
          isDefault: true,
        },
      ],
      currentValue: "flex",
    },
  ]);
});

it("uses standard routing when the catalog has no default service tier", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: ["fast"],
    defaultReasoningEffort: "medium",
    defaultServiceTier: null,
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "1.5x speed, increased usage",
      },
    ],
    supportedReasoningEfforts: [],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        {
          id: "priority",
          label: "Fast",
          description: "1.5x speed, increased usage",
        },
      ],
      currentValue: "default",
    },
  ]);
});

it("marks the most preferred available model as default", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(
    models.map((model) => ({ slug: model.slug, isDefault: model.isDefault })),
    [
      { slug: "gpt-5.6-terra", isDefault: true },
      { slug: "gpt-5.4", isDefault: undefined },
    ],
  );
});

it("prefers sol over terra when both are available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.6-sol", name: "GPT-5.6-Sol", isCustom: false, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.6-sol");
});

it("keeps Codex's own default when no preferred model is available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

it("ignores custom models that shadow a preferred slug", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-sol", name: "gpt-5.6-sol", isCustom: true, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

it("reports read-only Proteus ready without loading Proteus skills", () => {
  const checkedAt = "2026-08-27T12:00:00.000Z";
  const health = deriveProteusHealth({
    pluginList: {
      marketplaces: [
        {
          name: "local",
          plugins: [
            {
              id: "proteus@local",
              name: "proteus",
              installed: true,
              enabled: true,
              localVersion: "2.1.5",
            },
          ],
        },
      ],
    } as unknown as CodexSchema.V2PluginListResponse,
    skills: [],
    mcpStatus: {
      data: [
        {
          name: "proteus",
          tools: { proteus_query_memory: { name: "proteus_query_memory", inputSchema: {} } },
          serverInfo: { name: "proteus", version: "2.1.5" },
        },
      ],
    } as unknown as CodexSchema.V2ListMcpServerStatusResponse,
    checkedAt,
  });

  assert.deepStrictEqual(health, {
    runtime: "ready",
    plugin: "ready",
    skills: "ready",
    mcp: "ready",
    version: "2.1.5",
    message: "Proteus read-only history is ready.",
    checkedAt,
  });
});

it("reports managed Argos ready when its plugin, MCP, and skills are loaded", () => {
  const checkedAt = "2026-09-12T12:00:00.000Z";
  const health = deriveArgosHealth({
    pluginList: {
      marketplaces: [
        {
          name: "argos-marketplace",
          plugins: [
            {
              id: "argos@argos-marketplace",
              name: "argos",
              installed: true,
              enabled: true,
              localVersion: "0.1.0",
            },
          ],
        },
      ],
    } as unknown as CodexSchema.V2PluginListResponse,
    skills: [{ name: "argos:argos", path: "skills/argos/SKILL.md", enabled: true }],
    mcpStatus: {
      data: [
        {
          name: "argos",
          tools: { argos_inspect_node: { name: "argos_inspect_node", inputSchema: {} } },
          serverInfo: { name: "argos", version: "0.1.0" },
        },
      ],
    } as unknown as CodexSchema.V2ListMcpServerStatusResponse,
    checkedAt,
  });

  assert.deepStrictEqual(health, {
    runtime: "ready",
    plugin: "ready",
    skills: "ready",
    mcp: "ready",
    version: "0.1.0",
    message: "Argos connected research memory is ready.",
    checkedAt,
  });
});

it("reports missing Argos parts without failing the Codex provider probe", () => {
  const health = deriveArgosHealth({
    pluginList: { marketplaces: [] },
    skills: [],
    mcpStatus: { data: [] },
    checkedAt: "2026-09-12T12:00:00.000Z",
  });

  assert.equal(health.plugin, "missing");
  assert.equal(health.skills, "missing");
  assert.equal(health.mcp, "missing");
  assert.equal(health.runtime, "missing");
});

it("reports missing Proteus parts without failing the Codex provider probe", () => {
  const health = deriveProteusHealth({
    pluginList: { marketplaces: [] },
    skills: [],
    mcpStatus: { data: [] },
    checkedAt: "2026-08-27T12:00:00.000Z",
  });

  assert.equal(health.plugin, "missing");
  assert.equal(health.skills, "ready");
  assert.equal(health.mcp, "missing");
  assert.equal(health.runtime, "missing");
});
