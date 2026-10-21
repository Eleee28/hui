import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { html } from "lit";

import {
  AutomationFormError,
  automationState,
  describeRoutineSchedule,
  describeSchedule,
  formatTimestamp,
  runIsActive,
  renderAutomationPage,
  type AutomationProps,
  scheduleFromForm,
  taskInputFromForm,
} from "./settings-automation.ts";
import type { AutomationRun, AutomationSnapshot } from "../api/schema/automation.ts";

function form(fields: Record<string, string | undefined>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) data.set(key, value);
  return data;
}

const READY: AutomationSnapshot = {
  scheduler: { enabled: true, activeRuns: 0, nextWakeAt: null },
  tasks: [],
  runs: [],
};

function run(status: AutomationRun["status"]): AutomationRun {
  return {
    id: "run-1",
    taskId: "task-1",
    taskName: "Nightly review",
    sessionId: "session-1",
    source: "manual",
    status,
    createdAt: "2026-09-23T08:00:00.000Z",
  };
}

test("automation distinguishes loading, failure and ready states", () => {
  assert.equal(automationState({ automation: undefined, automationError: "" }), "loading");
  assert.equal(automationState({ automation: undefined, automationError: "boom" }), "error");
  // A snapshot wins: a stale refresh error must not hide known scheduler state.
  assert.equal(automationState({ automation: READY, automationError: "boom" }), "ready");
});

test("schedules read as the cadence the scheduler will actually use", () => {
  assert.equal(describeSchedule({ kind: "every", everyMs: 60_000 }), "Every minute");
  assert.equal(describeSchedule({ kind: "every", everyMs: 15 * 60_000 }), "Every 15 minutes");
  assert.equal(describeSchedule({ kind: "every", everyMs: 60 * 60_000 }), "Every hour");
  assert.equal(describeSchedule({ kind: "every", everyMs: 3 * 60 * 60_000 }), "Every 3 hours");
  assert.equal(describeSchedule({ kind: "every", everyMs: 1440 * 60_000 }), "Every day");
  assert.equal(describeSchedule({ kind: "every", everyMs: 2 * 1440 * 60_000 }), "Every 2 days");
  assert.equal(
    describeSchedule({ kind: "cron", expression: "0 9 * * 1-5", timezone: "Europe/Madrid" }),
    "Cron 0 9 * * 1-5 (Europe/Madrid)",
  );
});

test("bot routines read as their panel wrote them, with the generic summary for anything else", () => {
  assert.equal(describeRoutineSchedule({ kind: "cron", expression: "0 8 * * *", timezone: "Europe/Madrid" }), "Daily at 08:00");
  assert.equal(describeRoutineSchedule({ kind: "cron", expression: "30 9 * * 1", timezone: "Europe/Madrid" }), "Mondays at 09:30");
  assert.equal(describeRoutineSchedule({ kind: "cron", expression: "0 9 * * 1-5", timezone: "Europe/Madrid" }), "Cron 0 9 * * 1-5 (Europe/Madrid)");
  assert.equal(describeRoutineSchedule({ kind: "every", everyMs: 2 * 60 * 60_000 }), "Every 2 hours");
});

test("missing and unparseable timestamps stay honest instead of rendering as a date", () => {
  assert.equal(formatTimestamp(null), "—");
  assert.equal(formatTimestamp(undefined), "—");
  assert.equal(formatTimestamp(""), "—");
  assert.equal(formatTimestamp("not-a-date"), "not-a-date");
});

test("only queued and running runs can be cancelled", () => {
  assert.equal(runIsActive(run("queued")), true);
  assert.equal(runIsActive(run("running")), true);
  for (const status of ["completed", "failed", "skipped", "cancelled"] as const) {
    assert.equal(runIsActive(run(status)), false);
  }
});

/** Nested templates expose the same recorded state, without a browser or CSS. */
function markup(value: unknown): string {
  if (Array.isArray(value)) return value.map(markup).join("");
  if (value && typeof value === "object" && "strings" in value && "values" in value) {
    const template = value as { strings: readonly string[]; values: unknown[] };
    return template.strings.map((part, i) => part + markup(template.values[i])).join("");
  }
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

test("automation renders recovery details and retains cancellation for a queued retry", () => {
  const retry = { ...run("queued"), attempt: 1, retryAt: "2026-10-18T08:00:30.000Z", error: "Worker is offline" };
  const attention = { ...run("failed"), id: "r2", error: "Missing credential", failure: { kind: "configuration" as const, needsAttention: true } };
  const page = markup(renderAutomationPage({
    automation: { ...READY, runs: [retry, attention] }, sessions: [], automationEditingId: "",
  } as unknown as AutomationProps, (heading, description, body) => html`<section>${heading}${description}${body}</section>`));
  assert.match(page, /Retry scheduled/);
  assert.match(page, /Attempt 1\/3 · Next retry/);
  assert.ok(page.includes(formatTimestamp(retry.retryAt)));
  assert.match(page, /Needs attention/);
  assert.match(page, /Check the target session, model and credentials/);
  assert.match(page, /Worker is offline/);
  assert.match(page, /Missing credential/);
  assert.equal(page.match(/>Cancel<\/button>/g)?.length, 1, "only the queued retry has a Cancel action");
});

test("the form builds each schedule kind in the shape the server accepts", () => {
  assert.deepEqual(
    scheduleFromForm(form({ scheduleKind: "cron", cronExpression: " 0 9 * * 1-5 ", cronTimezone: "UTC" })),
    { kind: "cron", expression: "0 9 * * 1-5", timezone: "UTC" },
  );
  assert.deepEqual(scheduleFromForm(form({ scheduleKind: "every", everyMinutes: "90" })), {
    kind: "every",
    everyMs: 5_400_000,
  });
  const once = scheduleFromForm(form({ scheduleKind: "at", at: "2027-01-02T03:04" }));
  assert.equal(once.kind, "at");
  // `datetime-local` has no offset, so the local value becomes a real instant.
  assert.equal(
    once.kind === "at" ? once.at : "",
    new Date(Date.parse("2027-01-02T03:04")).toISOString(),
  );
});

test("the form rejects schedules the scheduler could never run", () => {
  for (const fields of [
    { scheduleKind: "cron", cronExpression: "" },
    { scheduleKind: "every", everyMinutes: "0" },
    { scheduleKind: "every", everyMinutes: "1.5" },
    { scheduleKind: "every", everyMinutes: "" },
    { scheduleKind: "at", at: "" },
    { scheduleKind: "" },
  ]) {
    assert.throws(() => scheduleFromForm(form(fields)), AutomationFormError);
  }
});

test("a task input carries the trimmed fields and the default timeout", () => {
  const input = taskInputFromForm(
    form({
      name: "  Nightly review  ",
      description: "  Summarize the day  ",
      sessionId: " session-1 ",
      prompt: "  Review open work  ",
      scheduleKind: "cron",
      cronExpression: "0 9 * * *",
      cronTimezone: "Europe/Madrid",
    }),
  );
  assert.deepEqual(input, {
    name: "Nightly review",
    description: "Summarize the day",
    sessionId: "session-1",
    prompt: "Review open work",
    schedule: { kind: "cron", expression: "0 9 * * *", timezone: "Europe/Madrid" },
    timeoutSeconds: 900,
  });
});

test("a task input rejects the fields the server would reject", () => {
  const valid = {
    name: "Nightly review",
    sessionId: "session-1",
    prompt: "Review open work",
    scheduleKind: "cron",
    cronExpression: "0 9 * * *",
    cronTimezone: "UTC",
  };
  for (const override of [
    { name: "  " },
    { sessionId: "" },
    { prompt: " " },
    { timeoutSeconds: "9" },
    { timeoutSeconds: "86401" },
    { timeoutSeconds: "30.5" },
  ]) {
    assert.throws(() => taskInputFromForm(form({ ...valid, ...override })), AutomationFormError);
  }
});

test("the automation region renders real controls instead of a pending placeholder", () => {
  const settings = readFileSync(new URL("./settings.ts", import.meta.url), "utf8");

  assert.match(settings, /props\.page === "automation"\s*\?\s*renderAutomationPage\(props, renderSection\)/);
  // Dropping it from the pending summaries is what stops the placeholder copy.
  assert.doesNotMatch(settings, /automation: "Scheduled jobs/);
  assert.match(settings, /Exclude<SettingsPage, "appearance" \| "skills" \| "tools" \| "models" \| "automation" \| "security" \| "worktrees" \| "workers">/);
});

test("automation keeps the original row-control and field-control containers separate", () => {
  const source = readFileSync(new URL("./settings-automation.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /class="settings-row__control cron-control"/);
  assert.equal(source.match(/class="settings-row__control"><span class="cron-control"/g)?.length, 10);
});

test("the create form shows only the selected schedule kind", () => {
  const source = readFileSync(new URL("./settings-automation.ts", import.meta.url), "utf8");
  const css = readFileSync(new URL("../styles/openclaw-workspaces.css", import.meta.url), "utf8");

  assert.match(source, /data-schedule=\$\{initialKind\}/);
  assert.match(source, /form\?\.setAttribute\("data-schedule", select\.value\)/);
  assert.match(source, /syncScheduleVisibility\(form, select\.value\)/);
  assert.match(source, /field\.hidden =/);
  for (const kind of ["cron", "every", "at"]) {
    assert.match(source, new RegExp(`automation-field--${kind}`));
    assert.match(source, new RegExp(`\\?hidden=\\$\\{initialKind !== "${kind}"\\}`));
    assert.match(
      css,
      new RegExp(`\\.hui-automation-form:not\\(\\[data-schedule="${kind}"\\]\\) \\.automation-field--${kind}`),
    );
  }
});

test("a refused task action is reported next to the list, not inside the create form", () => {
  const source = readFileSync(new URL("./settings-automation.ts", import.meta.url), "utf8");

  assert.match(source, /data-automation-action-error/);
  // A refusal has to look like one, not like the muted notes around it.
  const css = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8");
  assert.match(css, /\.automation-action-error\s*\{[^}]*border: 1px solid var\(--danger\);/s);
  assert.match(css, /\.automation-action-error\s*\{[^}]*background: var\(--danger-subtle\);/s);
});

test("the create form only clears once the scheduler accepted the task", () => {
  const source = readFileSync(new URL("./settings-automation.ts", import.meta.url), "utf8");

  assert.match(source, /if \(!created\) return;[\s\S]*?form\.reset\(\);/);
  assert.match(source, /timezone\.value = localTimezone\(\)/);
  assert.match(source, /timeout\.value = "900"/);
  assert.match(source, /schedule\.value = "cron"/);
  assert.match(source, /form\.setAttribute\("data-schedule", "cron"\)/);
});

test("tasks can be edited without losing their enabled state", () => {
  const source = readFileSync(new URL("./settings-automation.ts", import.meta.url), "utf8");

  assert.match(source, /<wa-dropdown-item value="edit"[^>]*>Edit<\/wa-dropdown-item>/);
  assert.match(source, /editing \? "Update task" : "Create task"/);
  assert.match(source, /\{ \.\.\.input, enabled: editing\.enabled \}/);
  assert.match(source, /editing\?\.name \?\? ""/);
  assert.match(source, /editing\?\.prompt \?\? ""/);
});

test("automation validation is owned by HUI instead of native required bubbles", () => {
  const source = readFileSync(new URL("./settings-automation.ts", import.meta.url), "utf8");

  assert.match(source, /data-schedule=\$\{initialKind\} novalidate/);
  assert.doesNotMatch(source, /\srequired(?:\s|>)/);
  assert.match(source, /throw new AutomationFormError\("Name the task\."\)/);
});
