import assert from "node:assert/strict";
import { test } from "vitest";
import { renderTaskSuggestionCard, type TaskSuggestionCardProps } from "./task-suggestion-card.ts";

function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).join("");
  if (value && typeof value === "object" && "strings" in value && "values" in value) {
    const template = value as { strings: readonly string[]; values: unknown[] };
    return template.strings.map((part, i) => part + text(template.values[i])).join("");
  }
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

const suggestion = { id: "s1", title: "Fix the picker", problem: "It differs.", fix: "", cwd: "/repo/web", createdAt: "2026-09-26T00:00:00.000Z" };

function render(jiraConfigured: boolean): string {
  const noop = () => {};
  const props: TaskSuggestionCardProps = {
    suggestions: [suggestion], index: 0, pendingId: "", copied: false, jiraConfigured,
    onIndex: noop, onStart: noop, onCreateJira: noop, onAddToBacklog: noop, onCopy: noop, onDismiss: noop,
  };
  return text(renderTaskSuggestionCard(props));
}

test("without Jira the card offers a single Add to backlog button", () => {
  const card = render(false);
  assert.match(card, /task-suggestion__backlog[^>]*>[\s\S]*Add to backlog/u);
  assert.doesNotMatch(card, /Create Jira task/u);
  assert.doesNotMatch(card, /task-suggestion__file-menu/u);
});

test("with Jira, Create Jira task is a split button whose menu adds Add to backlog", () => {
  const card = render(true);
  assert.match(card, /task-suggestion__start--primary task-suggestion__jira[\s\S]*Create Jira task/u);
  assert.match(card, /task-suggestion__file-menu[\s\S]*value="jira"[\s\S]*Create Jira task[\s\S]*value="backlog"[\s\S]*Add to backlog/u);
  assert.match(card, /aria-label="More filing options"/u);
  assert.doesNotMatch(card, /task-suggestion__backlog/u);
  // The start split button is unchanged.
  assert.match(card, /More start options/u);
});
