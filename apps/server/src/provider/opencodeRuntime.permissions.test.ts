import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import { buildOpenCodePermissionRules, fullAccessQuestionAnswers } from "./opencodeRuntime.ts";

function actionFor(
  runtimeMode: Parameters<typeof buildOpenCodePermissionRules>[0],
  permission: string,
) {
  return buildOpenCodePermissionRules(runtimeMode).find((rule) => rule.permission === permission)
    ?.action;
}

describe("buildOpenCodePermissionRules", () => {
  it("pre-approves edits once the user has chosen to auto-accept them", () => {
    NodeAssert.equal(actionFor("auto-accept-edits", "edit"), "allow");
  });

  it("still asks before editing when approval is required", () => {
    NodeAssert.equal(actionFor("approval-required", "edit"), "ask");
  });

  // Documented in docs/user/permission-modes.md: providers without an AI
  // reviewer, OpenCode among them, fall back to Supervised for "auto".
  it("leaves auto asking, as the docs say it does without a reviewer", () => {
    NodeAssert.equal(actionFor("auto", "edit"), "ask");
  });

  it("keeps asking for everything else in the auto modes", () => {
    for (const runtimeMode of ["auto-accept-edits", "auto"] as const) {
      NodeAssert.equal(actionFor(runtimeMode, "bash"), "ask");
      NodeAssert.equal(actionFor(runtimeMode, "webfetch"), "ask");
      NodeAssert.equal(actionFor(runtimeMode, "external_directory"), "ask");
      NodeAssert.equal(actionFor(runtimeMode, "*"), "ask");
    }
  });

  it("allows everything only under full access", () => {
    NodeAssert.deepEqual(buildOpenCodePermissionRules("full-access"), [
      { permission: "*", pattern: "*", action: "allow" },
    ]);
  });
});

describe("fullAccessQuestionAnswers", () => {
  it("accepts an explicit provider authorization without opening a prompt", () => {
    NodeAssert.deepEqual(
      fullAccessQuestionAnswers({
        id: "form-1",
        sessionID: "session-1",
        questions: [
          {
            header: "choice",
            question: "Allow web search?",
            options: [
              { label: "Allow search", description: "allow" },
              { label: "Disable web search", description: "disable" },
            ],
          },
        ],
      }),
      [["allow"]],
    );
  });

  it("does not guess an answer to an ordinary question", () => {
    NodeAssert.equal(
      fullAccessQuestionAnswers({
        id: "form-2",
        sessionID: "session-1",
        questions: [
          {
            header: "target",
            question: "Which target should I inspect?",
            options: [
              { label: "A", description: "First target" },
              { label: "B", description: "Second target" },
            ],
          },
        ],
      }),
      undefined,
    );
  });
});
