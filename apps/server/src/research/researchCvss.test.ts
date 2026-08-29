import { assert, it } from "@effect/vitest";

import {
  calculateCvssV31,
  findCvssMismatchesInText,
  hasCvssDrivenDecisionLanguage,
} from "./researchCvss.ts";

it("calculates the disputed unchanged-scope vectors deterministically", () => {
  assert.equal(calculateCvssV31("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:L/A:L")?.score, 7.3);
  assert.equal(calculateCvssV31("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:L/A:N")?.score, 6.5);
  assert.equal(calculateCvssV31("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:L/A:H")?.score, 8.6);
});

it("distinguishes ancillary classification from a CVSS-driven research decision", () => {
  assert.isFalse(hasCvssDrivenDecisionLanguage("The ancillary CVSS score is 6.5 Medium."));
  assert.isTrue(
    hasCvssDrivenDecisionLanguage("Reject the finding because the CVSS score is Medium."),
  );
});

it("finds a score that contradicts its vector", () => {
  assert.deepEqual(
    findCvssMismatchesInText("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:L/A:L = 6.5 Medium"),
    [
      {
        vector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:L/A:L",
        declaredScore: 6.5,
        calculatedScore: 7.3,
      },
    ],
  );
});
