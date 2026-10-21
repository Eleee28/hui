import assert from "node:assert/strict";
import { test } from "vitest";
import { parseSlackLink } from "./slack-link.ts";

test("parses canonical Slack message and channel links without network access", () => {
  assert.deepEqual(parseSlackLink("https://acme.slack.com/archives/C01234567/p1723456789012345"), {
    url: "https://acme.slack.com/archives/C01234567/p1723456789012345",
    workspace: "acme",
    channelId: "C01234567",
    kind: "message",
  });
  assert.deepEqual(parseSlackLink("https://app.slack.com/client/T01234567/C01234567"), {
    url: "https://app.slack.com/client/T01234567/C01234567",
    workspace: "T01234567",
    channelId: "C01234567",
    kind: "channel",
  });
  assert.deepEqual(parseSlackLink("https://app.slack.com/client/T01234567/C01234567/thread/C01234567-1723456789.012345"), {
    url: "https://app.slack.com/client/T01234567/C01234567/thread/C01234567-1723456789.012345",
    workspace: "T01234567",
    channelId: "C01234567",
    kind: "message",
  });
});

test("rejects ambiguous, credentialed and non-Slack URLs", () => {
  for (const value of [
    "http://acme.slack.com/archives/C01234567",
    "https://user:secret@acme.slack.com/archives/C01234567",
    "https://acme.slack.com.evil.example/archives/C01234567",
    "https://slack.com/archives/C01234567",
    "https://acme.slack.com/archives/not-a-channel",
    "https://acme.slack.com/archives/C01234567/p123",
    "https://app.slack.com/client/T01234567/C01234567/thread/C01234567-1",
  ]) assert.equal(parseSlackLink(value), undefined, value);
});
