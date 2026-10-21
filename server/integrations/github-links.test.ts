import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";
import { githubRefKey, MAX_GITHUB_EMBEDS, parseGitHubUrl } from "./github-links.ts";

test("GitHub link parsing and keys match the portable fixtures", async () => {
  const fixture = JSON.parse(await readFile(new URL("./github-links.fixture.json", import.meta.url), "utf8"));
  assert.equal(MAX_GITHUB_EMBEDS, fixture.maxEmbeds);
  for (const item of fixture.urls) {
    const ref = parseGitHubUrl(item.input);
    assert.deepEqual(ref ?? null, item.expected, item.input);
    assert.equal(ref ? githubRefKey(ref) : null, item.key, item.input);
  }
});
