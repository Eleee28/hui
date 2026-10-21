import assert from "node:assert/strict";
import { test } from "vitest";

import { pullRequestAccessibleLabel, pullRequestReference } from "./pull-requests.ts";
import type { SessionPullRequest } from "../api/schema/github.ts";

const pr = (number: number, patch: Partial<SessionPullRequest> = {}): SessionPullRequest => ({
  repository: "acme/web", number, url: `https://github.com/acme/web/pull/${number}`, ...patch,
});

test("labels expose repo#number, confirmed state and title", () => {
  assert.equal(pullRequestReference(pr(12)), "acme/web#12");
  assert.equal(pullRequestAccessibleLabel(pr(12, { state: "merged", title: "Add badges" })), "Pull request acme/web#12, merged: Add badges");
  assert.equal(pullRequestAccessibleLabel(pr(3)), "Pull request acme/web#3, status unavailable");
});
