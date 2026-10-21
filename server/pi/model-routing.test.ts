import assert from "node:assert/strict";
import { test } from "vitest";

import { DEFAULT_SETTINGS } from "../hui-settings.ts";
import {
  answerSideQuestion,
  GENERATED_TITLE_LENGTH_MAX,
  generateSessionNames,
  generateSessionTitle,
  normalizeGeneratedTitle,
} from "./model-routing.ts";

test("normalizes utility titles to a descriptive OpenClaw-style label", () => {
  assert.equal(normalizeGeneratedTitle('Title: "Model routing."', "prompt"), "Model routing.");
  assert.equal(normalizeGeneratedTitle('Title: "Short names."', "prompt"), "Short names.");
  assert.equal(normalizeGeneratedTitle("one two three four five six seven eight", "prompt"), "one two three four five six seven eight");
  assert.equal(normalizeGeneratedTitle("Implement primary model fallback", "prompt"), "Implement primary model fallback");
  assert.equal(normalizeGeneratedTitle("Branch names today", "prompt"), "Branch names today");
  assert.equal(normalizeGeneratedTitle("Investigate why generated session titles lose important task context", "prompt").length, GENERATED_TITLE_LENGTH_MAX);
  assert.equal(normalizeGeneratedTitle("OAuth fix\nBecause the prompt mentions OAuth.", "prompt"), "OAuth fix");
  assert.equal(normalizeGeneratedTitle("  ", "Fix flaky build, please"), "Fix flaky build, please");
  assert.equal(normalizeGeneratedTitle(`${"a".repeat(59)}😀`, "prompt"), "a".repeat(59), "does not split a surrogate pair");
});

test("title generation uses the utility route and degrades to the prompt", async () => {
  const settings = { ...DEFAULT_SETTINGS, models: { ...DEFAULT_SETTINGS.models, utility: "fast/tiny" } };
  let seenModel = "";
  assert.equal(await generateSessionTitle({
    cwd: "/tmp",
    prompt: "Implement fallback routing\nwith tests",
    settings,
    run: async (options) => { seenModel = options.model; return "Improve model retry logic"; },
  }), "Improve model retry logic");
  assert.equal(seenModel, "fast/tiny");
  assert.equal(await generateSessionTitle({
    cwd: "/tmp",
    prompt: "Implement fallback routing\nwith tests",
    settings,
    run: async () => { throw new Error("down"); },
  }), "Implement fallback routing");
});

test("one utility call names the session and its new worktree branch", async () => {
  const settings = { ...DEFAULT_SETTINGS, branchPrefix: "feature/", models: { ...DEFAULT_SETTINGS.models, utility: "fast/tiny" } };
  const prompt = "El modelo de fallback debería elegir un nombre corto para la sesión";
  const calls: string[] = [];
  const named = await generateSessionNames({
    cwd: "/repo", prompt, settings, branch: true,
    run: async (options) => { calls.push(options.prompt); return "Title: Mejorar nombres de sesiones\nBranch: feature/improve-session-names"; },
  });
  assert.deepEqual(named, { title: "Mejorar nombres de sesiones", branchName: "improve-session-names" });
  assert.equal(calls.length, 1, "title and branch share one model call");
  assert.match(calls[0]!, /exactly two lines/u);
  assert.match(calls[0]!, /Title: a concise session title \(3-6 words, max 60 characters\)/u);
  assert.match(calls[0]!, /Use the same language as the message/u);
  assert.match(calls[0]!, /not participating in its conversation/u);
  assert.match(calls[0]!, /prefix "feature\/"/u);
  assert.match(calls[0]!, /El modelo de fallback/u);

  assert.deepEqual(await generateSessionNames({
    cwd: "/repo", prompt, settings, branch: true, run: async () => "Naming\nshort-names",
  }), { title: "Naming", branchName: "short-names" }, "an unlabelled answer is read in order");

  let branchPrompt = "";
  assert.deepEqual(await generateSessionNames({
    cwd: "/repo", prompt, settings, title: "My own title", branch: true,
    run: async (options) => { branchPrompt = options.prompt; return "fix/compact-titles"; },
  }), { title: "My own title", branchName: "compact-titles" }, "an operator title is kept verbatim");
  assert.match(branchPrompt, /Session title: My own title/u);
  assert.doesNotMatch(branchPrompt, /Title: 1-3/u);

  let called = false;
  assert.deepEqual(await generateSessionNames({
    cwd: "/repo", prompt, settings, title: "Kept", run: async () => { called = true; return "unused"; },
  }), { title: "Kept" });
  assert.equal(called, false, "nothing to name means no model call");
});

test("session naming degrades without a utility model or a usable answer", async () => {
  const settings = { ...DEFAULT_SETTINGS, branchPrefix: "feature/", models: { ...DEFAULT_SETTINGS.models, utility: "fast/tiny" } };
  const prompt = "Add rate limiting to the Jira proxy\nwith tests";
  const expected = { title: "Add rate limiting to the Jira proxy", branchName: "add-rate-limiting-jira" };
  let called = false;
  assert.deepEqual(await generateSessionNames({
    cwd: "/repo", prompt, branch: true,
    settings: { ...settings, models: { ...settings.models, utility: "" } },
    run: async () => { called = true; return "unused"; },
  }), expected);
  assert.equal(called, false, "no utility model means no model call");
  assert.deepEqual(await generateSessionNames({
    cwd: "/repo", prompt, settings, branch: true, run: async () => { throw new Error("down"); },
  }), expected);
  assert.deepEqual(await generateSessionNames({
    cwd: "/repo", prompt, settings, branch: true, run: async () => "Title: Jira limits\nBranch: feature/fix",
  }), { title: "Jira limits", branchName: "add-rate-limiting-jira" }, "an empty branch falls back to the prompt");
});

test("btw uses bounded reference context and the utility model", async () => {
  const settings = { ...DEFAULT_SETTINGS, models: { primary: "strong/main", fallback: "", utility: "fast/tiny" } };
  let prompt = "";
  const result = await answerSideQuestion({
    cwd: "/tmp",
    question: "Which file?",
    transcript: [{ kind: "message", role: "user", text: "Edit settings.ts" }],
    settings,
    run: async (options) => { prompt = options.prompt; return "settings.ts"; },
  });
  assert.deepEqual(result, { answer: "settings.ts", model: "fast/tiny" });
  assert.match(prompt, /user: Edit settings\.ts/u);
  assert.match(prompt, /SIDE QUESTION\nWhich file\?/u);
});

test("suggested branch names drop the prefix, type words, Jira keys and chatter", async () => {
  const { fallbackBranchName, normalizeSuggestedBranchName } = await import("../git/branch-names.ts");
  const prefix = "feature/";
  assert.equal(normalizeSuggestedBranchName("rate-limit-jira-proxy", { prefix }), "rate-limit-jira-proxy");
  assert.equal(normalizeSuggestedBranchName("feature/rate-limit-jira-proxy", { prefix }), "rate-limit-jira-proxy");
  assert.equal(normalizeSuggestedBranchName("Branch name: `fix/CI-2-Rate limit Jira proxy`", { prefix, jiraKey: "CI-2" }), "rate-limit-jira-proxy");
  assert.equal(normalizeSuggestedBranchName("\"bugfix-oauth-callback\"\nThis name describes the fix.", { prefix }), "oauth-callback");
  assert.equal(normalizeSuggestedBranchName("chore feature document backlog file", { prefix: "developer/" }), "document-backlog-file");
  assert.equal(normalizeSuggestedBranchName("developer-tidy-logs", { prefix: "developer/" }), "tidy-logs");
  assert.equal(normalizeSuggestedBranchName("Fixture response.", { prefix }), "fixture-response");
  assert.equal(normalizeSuggestedBranchName("feature/fix", { prefix }), "");
  const long = normalizeSuggestedBranchName("one-two-three-four-five-six-seven-eight", { prefix });
  assert.equal(long, "one-two-three-four-five");
  assert.ok(normalizeSuggestedBranchName("x".repeat(90), { prefix }).length <= 40);
  assert.equal(fallbackBranchName("Fix: add rate limiting to the Jira proxy"), "add-rate-limiting-jira");
  assert.equal(fallbackBranchName("CI-2 Document the backlog file", "CI-2"), "document-backlog-file");
  assert.equal(fallbackBranchName("¿Qué pasa?"), "que-pasa");
  assert.equal(fallbackBranchName("!!!"), "session");
});

test("worktree name suggestion uses the utility model with bounded task context", async () => {
  const { suggestWorktreeName } = await import("./model-routing.ts");
  const settings = { ...DEFAULT_SETTINGS, branchPrefix: "feature/", models: { ...DEFAULT_SETTINGS.models, utility: "fast/tiny" } };
  const item = {
    title: "Add rate limiting to the Jira proxy",
    jira: { key: "CI-2", url: "https://acme.test/browse/CI-2", summary: "Rate limit Jira", description: "d".repeat(10_000) },
  };
  let seen = { model: "", prompt: "", cwd: "", timeoutMs: 0 };
  const result = await suggestWorktreeName({
    cwd: "/repo",
    item,
    settings,
    run: async (options) => { seen = { model: options.model, prompt: options.prompt, cwd: options.cwd, timeoutMs: options.timeoutMs ?? 0 }; return "feature/CI-2-throttle-jira-proxy"; },
  });
  assert.deepEqual(result, { name: "throttle-jira-proxy", source: "model" });
  assert.equal(seen.model, "fast/tiny");
  assert.equal(seen.cwd, "/repo");
  assert.equal(seen.timeoutMs, 20_000);
  assert.match(seen.prompt, /prefix "feature\/"/u);
  assert.match(seen.prompt, /Title: Add rate limiting to the Jira proxy/u);
  assert.match(seen.prompt, /Jira summary: Rate limit Jira/u);
  assert.match(seen.prompt, /feature, fix, bugfix/u);
  assert.ok(seen.prompt.length < 5_000, "task context is bounded");

  const fallback = { name: "add-rate-limiting-jira", source: "fallback" };
  let called = false;
  assert.deepEqual(await suggestWorktreeName({
    cwd: "/repo", item, settings: { ...settings, models: { ...settings.models, utility: "" } },
    run: async () => { called = true; return "unused"; },
  }), fallback);
  assert.equal(called, false, "no utility model means no model call");
  assert.deepEqual(await suggestWorktreeName({ cwd: "/repo", item, settings, run: async () => { throw new Error("down"); } }), fallback);
  assert.deepEqual(await suggestWorktreeName({ cwd: "/repo", item, settings, run: async () => "feature/fix" }), fallback);
});

test("a side question without any configured model asks for a utility model", async () => {
  const settings = { ...DEFAULT_SETTINGS, models: { primary: "", fallback: "", utility: "" } };
  await assert.rejects(answerSideQuestion({ cwd: "/tmp", question: "why", transcript: [], settings,
    run: async () => { throw new Error("no model must not reach PI"); } }), /Choose a utility model/);
});
