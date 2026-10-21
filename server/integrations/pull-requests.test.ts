import assert from "node:assert/strict";
import { test } from "vitest";

import {
  pullRequestBodyPreview,
  PullRequestStatuses,
  pullRequestsFromTranscript,
  type PullRequestDetails,
} from "./pull-requests.ts";
import type { TranscriptEntry } from "../runtimes/types.ts";

const tool = (patch: Partial<Extract<TranscriptEntry, { kind: "tool" }>>): TranscriptEntry => ({
  kind: "tool", id: "call", name: "bash", ...patch,
});

test("detects pull requests only from creation commands with a reported URL", () => {
  const transcript: TranscriptEntry[] = [
    { kind: "message", role: "assistant", text: "See https://github.com/acme/web/pull/1 for context." },
    tool({ id: "a", args: { command: "gh pr view https://github.com/acme/web/pull/2" }, output: "https://github.com/acme/web/pull/2" }),
    tool({ id: "b", args: { command: "git push && gh pr create --fill" }, output: "Creating pull request\nhttps://github.com/acme/web/pull/12\n" }),
    tool({ id: "c", name: "create_pull_request", args: { title: "Docs" }, output: "{\"html_url\":\"https://github.com/acme/docs.site/pull/7\"}" }),
    tool({ id: "d", args: { command: "gh pr create --draft" }, output: "https://github.com/acme/web/pull/12" }),
  ];
  assert.deepEqual(pullRequestsFromTranscript(transcript), [
    { repository: "acme/web", number: 12, url: "https://github.com/acme/web/pull/12" },
    { repository: "acme/docs.site", number: 7, url: "https://github.com/acme/docs.site/pull/7" },
  ]);
});

test("an unfinished creation call is rescanned once its output arrives", () => {
  const pending = tool({ args: { command: "gh pr create --fill" } });
  assert.deepEqual(pullRequestsFromTranscript([pending]), []);
  const finished = { ...pending, output: "https://github.com/acme/web/pull/3" } as TranscriptEntry;
  assert.equal(pullRequestsFromTranscript([finished])[0]?.number, 3);
});

test("bounds Markdown descriptions and removes template comments", () => {
  assert.equal(pullRequestBodyPreview("<!-- template -->\r\n## Summary\r\n\r\n\r\n\r\n- One"), "## Summary\n\n- One");
  const long = pullRequestBodyPreview("word ".repeat(2_000));
  assert.ok(long.length <= 4_001 && long.endsWith("…"));
});

test("serves cached facts without waiting and never invents state after a failure", async () => {
  let now = 0;
  const calls: string[] = [];
  let fail = false;
  const details: PullRequestDetails = { state: "open", title: "Add badges", body: "Body" };
  const statuses = new PullRequestStatuses(async (url) => {
    calls.push(url);
    if (fail) throw new Error("offline");
    return details;
  }, { now: () => now, activeTtlMs: 100, failureTtlMs: 1_000 });
  const ref = { repository: "acme/web", number: 12, url: "https://github.com/acme/web/pull/12" };

  assert.deepEqual(statuses.view(ref), ref);
  assert.deepEqual(statuses.view(ref), ref, "one lookup is queued, not two");
  await statuses.whenIdle();
  assert.deepEqual(statuses.view(ref), { ...ref, ...details });
  assert.equal(calls.length, 1);

  now = 150;
  fail = true;
  assert.equal(statuses.view(ref).state, "open", "stale facts are served while revalidating");
  await statuses.whenIdle();
  assert.equal(statuses.view(ref).state, "open", "a failed refresh keeps the last confirmed state");
  assert.equal(calls.length, 2);

  const unknown = { repository: "acme/web", number: 99, url: "https://github.com/acme/web/pull/99" };
  statuses.view(unknown);
  await statuses.whenIdle();
  assert.deepEqual(statuses.view(unknown), unknown);
  assert.equal(calls.length, 3, "failures back off instead of retrying on every refresh");
});

test("one listing starts every due lookup at once, so the previews can batch them into one gh call", () => {
  const started: string[] = [];
  const statuses = new PullRequestStatuses((url) => {
    started.push(url);
    return new Promise(() => {});
  });
  for (const number of [1, 2, 3]) statuses.view({ repository: "acme/web", number, url: `https://github.com/acme/web/pull/${number}` });
  assert.equal(started.length, 3);
});
