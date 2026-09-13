import { assert, it } from "@effect/vitest";

import {
  calculateCvss,
  calculateCvssV31,
  findCvssMismatchesInText,
  hasCvssDrivenDecisionLanguage,
} from "./researchCvss.ts";

it("calculates validated CVSS 3.0, 3.1, and 4.0 vectors", () => {
  assert.equal(calculateCvss("CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:L/A:L").score, 7.3);
  assert.equal(calculateCvss("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:L/A:L").score, 7.3);
  assert.equal(
    calculateCvss("CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N").score,
    9.3,
  );
});

it("rejects incomplete, duplicate, and unsupported vectors", () => {
  assert.throws(() => calculateCvss("CVSS:4.0/AV:N/AC:L"), /missing required base metrics/);
  assert.throws(
    () => calculateCvss("CVSS:3.1/AV:N/AV:L/AC:L/PR:N/UI:N/S:U/C:L/I:L/A:L"),
    /Duplicate CVSS metric: AV/,
  );
  assert.throws(
    () => calculateCvss("CVSS:2.0/AV:N/AC:L/Au:N/C:P/I:P/A:P"),
    /Unsupported CVSS version/,
  );
});

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
