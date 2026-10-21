import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";

import { githubRefKey, githubRefsInText, MAX_GITHUB_EMBEDS, parseGitHubUrl } from "./github-links.ts";

test("parses repositories, pull requests and issues, and rejects other GitHub pages", () => {
  assert.deepEqual(parseGitHubUrl("https://github.com/cli/cli"), { kind: "repo", owner: "cli", repo: "cli", url: "https://github.com/cli/cli" });
  assert.deepEqual(parseGitHubUrl("https://www.github.com/DaniFdz/hui.git"), { kind: "repo", owner: "DaniFdz", repo: "hui", url: "https://github.com/DaniFdz/hui" });
  assert.deepEqual(parseGitHubUrl("https://github.com/cli/cli/tree/trunk/pkg")?.kind, "repo");
  assert.deepEqual(parseGitHubUrl("https://github.com/cli/cli/pull/14517/files#diff-1"), {
    kind: "pull", owner: "cli", repo: "cli", number: 14517, url: "https://github.com/cli/cli/pull/14517",
  });
  assert.deepEqual(parseGitHubUrl("https://github.com/cli/cli/issues/42?x=1"), {
    kind: "issue", owner: "cli", repo: "cli", number: 42, url: "https://github.com/cli/cli/issues/42",
  });
  for (const raw of [
    "https://github.com/settings/tokens", "https://github.com/cli", "https://gist.github.com/a/b",
    "https://github.com.evil.test/a/b", "ftp://github.com/a/b", "https://u:p@github.com/a/b", "not a url",
    "https://github.com/login/device",
  ]) assert.equal(parseGitHubUrl(raw), undefined, raw);
});

test("finds references in reading order, deduplicates, skips code and caps at three", () => {
  const text = [
    "See `https://github.com/ignored/inline` and cli/cli#14517 first.",
    "```sh",
    "gh pr view https://github.com/ignored/fenced/pull/1",
    "```",
    "Then https://github.com/cli/cli/pull/14517, the repo (https://github.com/cli/cli).",
    "Also https://github.com/acme/web/issues/7. And https://github.com/acme/api.",
  ].join("\n");
  const refs = githubRefsInText(text);
  assert.equal(MAX_GITHUB_EMBEDS, 3);
  assert.deepEqual(refs.map((ref) => ref.url), [
    "https://github.com/cli/cli/issues/14517",
    "https://github.com/cli/cli",
    "https://github.com/acme/web/issues/7",
  ]);
  assert.equal(githubRefKey(refs[0]!), githubRefKey(parseGitHubUrl("https://github.com/CLI/cli/pull/14517")!));
  assert.equal(githubRefsInText(text, 5).length, 4);
  assert.deepEqual(githubRefsInText("no links here, just #12 and path/to#3x"), []);
  assert.deepEqual(githubRefsInText("email me@host/repo#1 or ./local/repo#2"), []);
});

test("GitHub link parsing and keys match the portable fixtures", async () => {
  const fixture = JSON.parse(await readFile(new URL("./github-links.fixture.json", import.meta.url), "utf8"));
  assert.equal(MAX_GITHUB_EMBEDS, fixture.maxEmbeds);
  for (const item of fixture.urls) {
    const ref = parseGitHubUrl(item.input);
    assert.deepEqual(ref ?? null, item.expected, item.input);
    assert.equal(ref ? githubRefKey(ref) : null, item.key, item.input);
  }
});
