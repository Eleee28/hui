import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import type { SessionStage } from "../api/sessions.ts";
import {
  DEFAULT_SESSION_STAGE, effectiveSessionStage, isSessionStage, pullRequestStage, SESSION_STAGE_LABELS, SESSION_STAGES, stageRank,
} from "./session-stages.ts";

const fixture: {
  stages: string[];
  defaultStage: string;
  labels: Record<string, string>;
  isSessionStage: { input: unknown; expected: boolean }[];
  stageRank: { input: SessionStage; expected: number }[];
} = JSON.parse(readFileSync(new URL("./session-stages.fixture.json", import.meta.url), "utf8"));

test("session stages preserve the shared runtime fixtures", () => {
  assert.deepEqual(SESSION_STAGES, fixture.stages);
  assert.equal(DEFAULT_SESSION_STAGE, fixture.defaultStage);
  assert.deepEqual(SESSION_STAGE_LABELS, fixture.labels);
  for (const { input, expected } of fixture.isSessionStage) assert.equal(isSessionStage(input), expected, String(input));
  for (const { input, expected } of fixture.stageRank) assert.equal(stageRank(input), expected, input);
});

test("pull requests prove testing while any is open and done only once merged", () => {
  assert.equal(pullRequestStage([]), undefined);
  assert.equal(pullRequestStage([{ }]), undefined, "unconfirmed GitHub state proves nothing");
  assert.equal(pullRequestStage([{ state: "closed" }]), undefined);
  assert.equal(pullRequestStage([{ state: "draft" }]), "testing");
  assert.equal(pullRequestStage([{ state: "merged" }]), "done");
  assert.equal(pullRequestStage([{ state: "merged" }, { state: "open" }]), "testing");
});

test("an unplaced session starts in Investigation; Backlog is not a session stage", () => {
  assert.deepEqual(effectiveSessionStage({}), { stage: "investigation", stageOrigin: "default" });
  assert.equal(isSessionStage("backlog"), false);
});

test("pull-request evidence advances an agent stage but never moves it backwards", () => {
  assert.deepEqual(
    effectiveSessionStage({ stage: "implementation", stageSource: "agent" }, [{ state: "open", url: "https://github.com/o/r/pull/2" }]),
    { stage: "testing", stageOrigin: "pullRequest" },
  );
  assert.deepEqual(
    effectiveSessionStage({ stage: "done", stageSource: "agent" }, [{ state: "open", url: "https://github.com/o/r/pull/2" }]),
    { stage: "done", stageOrigin: "agent" },
  );
});

test("pull requests known at the last explicit placement are old news", () => {
  const merged = { state: "merged" as const, url: "https://github.com/O/R/pull/1" };
  assert.deepEqual(
    effectiveSessionStage({ stage: "investigation", stageSource: "agent", stagePullRequests: ["https://github.com/o/r/pull/1"] }, [merged]),
    { stage: "investigation", stageOrigin: "agent" },
  );
  assert.equal(effectiveSessionStage({ stage: "investigation", stageSource: "agent" }, [merged]).stage, "done");
});

test("an operator placement wins over pull-request evidence", () => {
  assert.deepEqual(
    effectiveSessionStage({ stage: "investigation", stageSource: "operator" }, [{ state: "merged", url: "https://github.com/o/r/pull/3" }]),
    { stage: "investigation", stageOrigin: "operator" },
  );
});
