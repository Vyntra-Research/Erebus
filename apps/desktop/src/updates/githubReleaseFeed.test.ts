import { describe, expect, it } from "vite-plus/test";

import { parseGithubReleaseFeedTags } from "./githubReleaseFeed.ts";

const RELEASE_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>tag:github.com,2008:https://github.com/acme/app/releases</id>
  <title>Release notes from app</title>
  <entry>
    <id>tag:github.com,2008:Repository/123456/v2.0.0</id>
    <link rel="alternate" type="text/html" href="https://github.com/acme/app/releases/tag/v2.0.0"/>
    <title>App 2.0.0</title>
  </entry>
  <entry>
    <id>tag:github.com,2008:Repository/123456/v2.1.0-beta.1</id>
    <link rel="alternate" type="text/html" href="https://github.com/acme/app/releases/tag/v2.1.0-beta.1"/>
    <title>App 2.1.0-beta.1</title>
  </entry>
  <entry>
    <link rel="alternate" type="text/html" href="https://github.com/acme/app/releases/tag/v2.0.1"/>
    <title>App 2.0.1</title>
  </entry>
</feed>`;

describe("GitHub release feed", () => {
  it("preserves feed order and extracts repository-scoped tags", () => {
    expect(parseGithubReleaseFeedTags(RELEASE_FEED)).toEqual(["v2.0.0", "v2.1.0-beta.1", "v2.0.1"]);
  });

  it("falls back to the release link when the entry id is missing", () => {
    expect(parseGithubReleaseFeedTags(RELEASE_FEED).at(-1)).toBe("v2.0.1");
  });

  it("ignores unrelated ids and duplicate entries", () => {
    const feed = `<feed>
      <entry><id>tag:github.com,2008:Repository/123456/v1.0.0</id></entry>
      <entry><id>tag:github.com,2008:Repository/123456/v1.0.0</id></entry>
      <entry><id>tag:github.com,2008:Repository/123456</id></entry>
    </feed>`;

    expect(parseGithubReleaseFeedTags(feed)).toEqual(["v1.0.0"]);
  });
});
