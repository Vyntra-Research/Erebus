// @effect-diagnostics nodeBuiltinImport:off - managed skills are materialized for provider runtimes.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { MANAGED_RESEARCH_SKILLS } from "./researchSkills.generated.ts";

interface ManagedResearchSkillDefinition {
  readonly name: string;
  readonly skill: string;
  readonly supportingFiles?: Readonly<Record<string, string>>;
}

export class ResearchSkillMaterializationError extends Schema.TaggedErrorClass<ResearchSkillMaterializationError>()(
  "ResearchSkillMaterializationError",
  {
    detail: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export const EREBUS_RESEARCH_SKILL_NAMES = [
  "erebus-adaptive-fuzzing",
  "erebus-chain-discovery",
  "erebus-codebase-research",
  "erebus-evidence-testing",
  "erebus-exploit-validation",
  "erebus-external-intel",
  "erebus-finding-report",
  "erebus-web-research",
] as const;

export function addErebusResearchSkillsToOpenCodeConfig(
  configContent: string,
  skillRoot: string,
): string {
  const parsed = JSON.parse(configContent.trim() || "{}") as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("OpenCode configuration content must be a JSON object.");
  }
  const config = parsed as Record<string, unknown>;
  const configuredSkills = config.skills;
  if (configuredSkills !== undefined && !Array.isArray(configuredSkills)) {
    throw new Error("OpenCode configuration 'skills' must be an array.");
  }
  const skills = [...(configuredSkills ?? [])];
  if (!skills.includes(skillRoot)) skills.push(skillRoot);
  return JSON.stringify({ ...config, skills });
}

async function writeManagedFile(path: string, content: string): Promise<void> {
  const current = await NodeFSP.readFile(path, "utf8").catch(() => null);
  if (current === content) return;
  await NodeFSP.writeFile(path, content, "utf8");
}

async function materialize(root: string): Promise<string> {
  await NodeFSP.mkdir(root, { recursive: true });
  for (const definition of MANAGED_RESEARCH_SKILLS as ReadonlyArray<ManagedResearchSkillDefinition>) {
    const skillRoot = NodePath.join(root, definition.name);
    await NodeFSP.mkdir(skillRoot, { recursive: true });
    await writeManagedFile(NodePath.join(skillRoot, "SKILL.md"), definition.skill);
    for (const [relativePath, content] of Object.entries(definition.supportingFiles ?? {})) {
      const target = NodePath.join(skillRoot, relativePath);
      await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
      await writeManagedFile(target, content);
    }
  }
  return root;
}

export const materializeErebusResearchSkills = Effect.fn(
  "ResearchSkills.materializeErebusResearchSkills",
)(function* (root: string) {
  return yield* Effect.tryPromise({
    try: () => materialize(root),
    catch: (cause) =>
      new ResearchSkillMaterializationError({
        detail: "Failed to materialize Erebus research skills.",
        cause,
      }),
  });
});

export const materializeManagedErebusResearchSkills = Effect.fn(
  "ResearchSkills.materializeManagedErebusResearchSkills",
)(function* (stateDir: string) {
  return yield* materializeErebusResearchSkills(
    NodePath.join(stateDir, "managed", "research-skills"),
  );
});
