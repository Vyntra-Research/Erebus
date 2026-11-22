// @effect-diagnostics nodeBuiltinImport:off - the test validates materialized skill files in temp.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeFSP from "node:fs/promises";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  addErebusResearchSkillsToOpenCodeConfig,
  EREBUS_RESEARCH_SKILL_NAMES,
  materializeErebusResearchSkills,
} from "./researchSkills.ts";

describe("Erebus research skills", () => {
  it.effect("materializes every managed skill and its report reference", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() =>
            NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "erebus-research-skills-")),
          ),
          (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
        );
        yield* materializeErebusResearchSkills(directory);

        for (const name of EREBUS_RESEARCH_SKILL_NAMES) {
          const content = yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(directory, name, "SKILL.md"), "utf8"),
          );
          expect(content).toContain(`name: ${name}`);
          const source = yield* Effect.promise(() =>
            NodeFSP.readFile(
              NodePath.resolve(
                import.meta.dirname,
                "../../../..",
                ".agents",
                "skills",
                name,
                "SKILL.md",
              ),
              "utf8",
            ),
          );
          expect(content).toBe(source);
        }

        const reportTemplate = yield* Effect.promise(() =>
          NodeFSP.readFile(
            NodePath.join(directory, "erebus-finding-report", "references", "report-template.md"),
            "utf8",
          ),
        );
        expect(reportTemplate).toContain("# Vulnerability report template");
      }),
    ),
  );

  it("adds the managed source to OpenCode config without replacing user sources", () => {
    const root = "C:/erebus/research-skills";
    const first = addErebusResearchSkillsToOpenCodeConfig(
      JSON.stringify({ provider: { custom: {} }, skills: ["C:/user/skills"] }),
      root,
    );
    expect(JSON.parse(first)).toEqual({
      provider: { custom: {} },
      skills: ["C:/user/skills", root],
    });

    const second = addErebusResearchSkillsToOpenCodeConfig(first, root);
    expect(JSON.parse(second).skills).toEqual(["C:/user/skills", root]);
  });
});
