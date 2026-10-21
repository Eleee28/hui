import assert from "node:assert/strict";
import { test } from "vitest";
import { BOT_LIMITS } from "../../bots-format.ts";
import { TemplateFormatError } from "./common.ts";
import { composeSoul, KNOWN_HEADING, matchIntegration, normalizeTemplate, resolveModel } from "./mapping.ts";
import { readSchedule } from "./schedule.ts";

const ZONE = "Europe/Madrid";
const NOW = Date.parse("2026-10-07T10:00:00Z");
const cron = (expression: string, timezone = ZONE) => ({ kind: "cron", expression, timezone });

test("routine schedules as templates write them become Automation schedules; what is assumed or unreadable says so", () => {
  const read = (text: string | undefined) => readSchedule(text, ZONE, NOW);
  assert.deepEqual(read("every monday at 9am"), { schedule: cron("0 9 * * 1"), guessed: false });
  assert.deepEqual(read("Daily at 18:30"), { schedule: cron("30 18 * * *"), guessed: false });
  assert.deepEqual(read("weekdays at 8"), { schedule: cron("0 8 * * 1-5"), guessed: false });
  assert.deepEqual(read("every tuesday and friday at 7:15 pm"), { schedule: cron("15 19 * * 2,5"), guessed: false });
  assert.deepEqual(read("every morning"), { schedule: cron("0 8 * * *"), guessed: false });
  assert.deepEqual(read("weekly"), { schedule: cron("0 9 * * 1"), guessed: true }, "a day and time assumed");
  assert.deepEqual(read("monthly on the 15th at noon"), { schedule: cron("0 12 15 * *"), guessed: false });
  assert.deepEqual(read("every 30m"), { schedule: { kind: "every", everyMs: 1_800_000 }, guessed: false });
  assert.deepEqual(read("every 2 hours"), { schedule: { kind: "every", everyMs: 7_200_000 }, guessed: false });
  assert.deepEqual(read("hourly"), { schedule: { kind: "every", everyMs: 3_600_000 }, guessed: false });
  assert.deepEqual(read("every 10 seconds"), { schedule: { kind: "every", everyMs: 60_000 }, guessed: true }, "Automation runs a minute apart at least");
  assert.deepEqual(read("0 7 * * 1-5"), { schedule: cron("0 7 * * 1-5"), guessed: false });
  assert.deepEqual(read("cron 0 7 * * * America/New_York"), { schedule: cron("0 7 * * *", "America/New_York"), guessed: false });
  assert.deepEqual(read("at 2026-12-24T18:00:00Z"), { schedule: { kind: "at", at: "2026-12-24T18:00:00.000Z" }, guessed: false });
  for (const unreadable of [undefined, "", "whenever it feels right", "at 2020-01-01T00:00:00Z", "99 99 * * *"]) {
    assert.deepEqual(read(unreadable), { schedule: cron("0 9 * * *"), guessed: true }, String(unreadable));
  }
});

const TOOLS = [
  { name: "read", label: "Read files" }, { name: "bash", label: "Shell" }, { name: "browser", label: "Browser" },
  { name: "sessions_spawn", label: "Spawn subagent" }, { name: "show_widget", label: "Show widget" },
];

test("integrations map to the HUI tool that does their job, by name; apps HUI has no tool for are missing", () => {
  const match = (name: string) => matchIntegration({ name }, TOOLS)?.name;
  assert.equal(match("Web search"), "browser");
  assert.equal(match("fetch_webpage"), "browser");
  assert.equal(match("Browser"), "browser");
  assert.equal(match("Code Interpreter"), "bash");
  assert.equal(match("run_code"), "bash");
  assert.equal(match("Files"), "read");
  assert.equal(match("Charts"), "show_widget");
  assert.equal(match("show widget"), "show_widget");
  for (const app of ["Gmail", "Google Calendar", "X", "Notion", "SerperDevTool", "mcp__github__create_issue"]) assert.equal(match(app), undefined, app);
});

const MODELS = [
  { provider: "anthropic", id: "claude-sonnet-4-5" }, { provider: "anthropic", id: "claude-sonnet-4" }, { provider: "anthropic", id: "claude-3-7-sonnet-latest" },
  { provider: "anthropic", id: "claude-opus-4-1" }, { provider: "openai", id: "gpt-4o-mini" }, { provider: "openrouter", id: "gpt-4o-mini" }, { provider: "xai", id: "grok-4" },
];

test("a model hint is kept only when it resolves: exact, a bare id, or Claude Code's aliases to the newest of the family", () => {
  assert.equal(resolveModel("openai/gpt-4o-mini", MODELS), "openai/gpt-4o-mini");
  assert.equal(resolveModel("OpenRouter/GPT-4o-mini", MODELS), "openrouter/gpt-4o-mini");
  assert.equal(resolveModel("gpt-4o-mini", MODELS), "openai/gpt-4o-mini");
  assert.equal(resolveModel("grok-4", MODELS), "xai/grok-4");
  assert.equal(resolveModel("sonnet", MODELS), "anthropic/claude-sonnet-4-5");
  assert.equal(resolveModel("opus", MODELS), "anthropic/claude-opus-4-1");
  assert.equal(resolveModel("haiku", MODELS), undefined);
  assert.equal(resolveModel("mistral/large", MODELS), undefined);
});

test("SOUL.md is the persona, then what it already knows while it fits; memories need a persona", () => {
  const { soul, included, cut } = composeSoul("You are Nova.", [{ name: "Home", text: "Madrid" }, { text: "Prefers trains" }, { name: "Projects", text: "HUI\nPI" }], "OpenClaw workspace");
  assert.equal(soul, `You are Nova.\n\n${KNOWN_HEADING}\n\nBrought over from OpenClaw workspace when HUI created you. It is what you knew there; the operator may correct it.\n\n- **Home:** Madrid\n- Prefers trains\n\n### Projects\n\nHUI\nPI`);
  assert.deepEqual([included, cut], [3, false]);
  const long = composeSoul("x".repeat(BOT_LIMITS.soul + 50), [{ text: "never fits" }], "Plain text");
  assert.deepEqual([long.soul.length, long.included, long.cut], [BOT_LIMITS.soul, 0, true]);
  const full = composeSoul("y".repeat(BOT_LIMITS.soul - 300), [{ text: "a".repeat(50) }, { text: "b".repeat(400) }], "Plain text");
  assert.equal(full.included, 1);
  assert.ok(full.soul.length <= BOT_LIMITS.soul);
  assert.deepEqual(composeSoul("", [{ text: "lost" }], "x"), { soul: "", included: 0, cut: false });
  const again = composeSoul(soul, [{ name: "Memory of @nova when it was exported", text: "<chat>\n0+1|user: hi\n</chat>" }], "HUI bot export");
  assert.equal(again.soul.split(KNOWN_HEADING).length, 2, "a HUI export of an imported bot gets no second heading");
  assert.ok(again.soul.endsWith("PI\n\n### Memory of @nova when it was exported\n\n<chat>\n0+1|user: hi\n</chat>"));
});

test("a template from the browser is checked again: types, sizes and lists; what is left becomes a clean template", () => {
  const template = normalizeTemplate({
    format: "grok", name: "  Trip   Planner ", soul: "Plan.", emoji: "🧳", title: "x".repeat(200), description: "Trips",
    memories: [{ name: "Home", text: "Madrid" }, { text: "  " }], skills: [{ name: "pack", description: "Pack\nlist", content: "Go." }],
    routines: [{ name: "Deals", prompt: "Look", schedule: "daily", automation: { kind: "every", everyMs: 120_000 } }],
    integrations: [{ name: "Gmail" }], tools: ["Read"], dropped: ["x"], notes: [], avatar: { shape: "heart", color: "#FF0000" },
    hui: { handle: "trip", thinking: "high", memoryThinking: "wild", voice: { language: "es", live: "nobody" }, disabledTools: ["bash"], disabledSkills: [] },
  });
  assert.equal(template.name, "Trip Planner");
  assert.equal(template.title?.length, BOT_LIMITS.title);
  assert.deepEqual(template.memories, [{ name: "Home", text: "Madrid" }]);
  assert.equal(template.skills[0]!.description, "Pack list");
  assert.deepEqual(template.routines[0]!.automation, { kind: "every", everyMs: 120_000 });
  assert.deepEqual(template.avatar, { shape: "heart", color: "#ff0000" });
  assert.deepEqual(template.hui, { handle: "trip", thinking: "high", voice: { language: "es" }, disabledTools: ["bash"], disabledSkills: [] });
  for (const bad of [undefined, { format: "nope", name: "x" }, { format: "text", name: "x", soul: 4 }, { format: "text", name: "x", skills: [{ name: "" }] },
    { format: "text", name: "x", routines: [{ name: "r" }] }, { format: "text", name: "x", skills: Array.from({ length: 51 }, () => ({ name: "a", content: "b" })) },
    { format: "text", name: "x", soul: "\0" }]) {
    assert.throws(() => normalizeTemplate(bad), TemplateFormatError, JSON.stringify(bad)?.slice(0, 80));
  }
});
