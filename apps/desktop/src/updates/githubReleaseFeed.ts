import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

const RELEASE_ENTRY_PATTERN = /<entry>([\s\S]*?)<\/entry>/g;
const RELEASE_ID_PATTERN = /<id>[^<]*?Repository\/[^/<]+\/([^/<]+)<\/id>/;
const RELEASE_LINK_PATTERN = /<link[^>]*rel="alternate"[^>]*href="[^"]*\/releases\/tag\/([^"]+)"/;

export class DesktopGithubReleaseFeedError extends Schema.TaggedErrorClass<DesktopGithubReleaseFeedError>()(
  "DesktopGithubReleaseFeedError",
  {
    owner: Schema.String,
    repo: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read the GitHub release feed for ${this.owner}/${this.repo}.`;
  }
}

/**
 * Release tags in feed order (newest published first), including the leading
 * `v`. The feed is the same Atom feed electron-updater reads, so discovery
 * here cannot drift from the versions the updater itself can install.
 */
export function parseGithubReleaseFeedTags(feedXml: string): ReadonlyArray<string> {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const match of feedXml.matchAll(RELEASE_ENTRY_PATTERN)) {
    const entry = match[1] ?? "";
    const tag = RELEASE_ID_PATTERN.exec(entry)?.[1] ?? RELEASE_LINK_PATTERN.exec(entry)?.[1];
    if (tag === undefined || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
}

export const fetchGithubReleaseTags = Effect.fn("desktop.updates.fetchGithubReleaseTags")(
  function* (input: {
    readonly owner: string;
    readonly repo: string;
    readonly timeoutMs?: number;
  }) {
    const httpClient = yield* HttpClient.HttpClient;
    const timeoutMs = input.timeoutMs ?? 5_000;
    const makeError = (cause: unknown) =>
      new DesktopGithubReleaseFeedError({ owner: input.owner, repo: input.repo, cause });

    const response = yield* httpClient
      .execute(
        HttpClientRequest.get(`https://github.com/${input.owner}/${input.repo}/releases.atom`),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.mapError(makeError),
        Effect.timeoutOption(Duration.millis(timeoutMs)),
      );

    const body = yield* Option.match(response, {
      onNone: () =>
        Effect.fail(makeError(new Error(`Release feed timed out after ${timeoutMs}ms.`))),
      onSome: (value) => value.text.pipe(Effect.mapError(makeError)),
    });
    return parseGithubReleaseFeedTags(body);
  },
);
