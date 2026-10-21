/**
 * A goal-anchored summary of a session for utility drafting (Jira work items).
 * A plain tail slice of the transcript drops the operator's original request
 * on any long session and over-weights whatever happened last, such as lint
 * fixes or pull request chatter. The digest keeps, in priority order:
 *
 * 1. the first real user request (the goal),
 * 2. later user messages, which may refine or replace it,
 * 3. files the agent changed, from successful edit/write tool calls,
 * 4. the most recent conversation, for current state.
 *
 * HUI's own control prompts (Continue, resume after an error or interruption,
 * subagent completion events) are PI user messages but not operator intent;
 * they are dropped, and an interruption prompt contributes its wrapped request.
 */
import type { TranscriptEntry } from "../runtimes/types.ts";
import { interruptedRunOriginal } from "./interrupted-run.ts";
import { CONTINUE_PROMPT, SUBAGENT_COMPLETION_MARKER } from "../agent-tools/subagent-completion.ts";
export const CONTINUE_AFTER_ERROR_PROMPT = "Continue from where you left off.";

export type SessionDigest = { text: string; goal: string };

const GOAL_MAX = 4_000;
const FOLLOW_UP_MAX = 700;
const FOLLOW_UPS_BUDGET = 3_500;
const FILES_MAX = 40;
const RECENT_BUDGET = 4_500;
const ENTRY_MAX = 1_500;

const CONTROL_PROMPTS = new Set([CONTINUE_PROMPT, CONTINUE_AFTER_ERROR_PROMPT]);
const FILE_TOOLS = new Set(["edit", "write", "multiedit", "multi_edit", "apply_patch", "create"]);

function clip(text: string, max: number): string {
  const clean = text.trim();
  return clean.length > max ? clean.slice(0, max - 1).trimEnd() + "…" : clean;
}

/** The operator's words in a user message, or undefined for HUI control prompts. */
export function operatorText(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed || CONTROL_PROMPTS.has(trimmed) || trimmed.startsWith(SUBAGENT_COMPLETION_MARKER)) return undefined;
  const original = interruptedRunOriginal(trimmed);
  if (original === undefined) return trimmed;
  return original && !CONTROL_PROMPTS.has(original) ? original : undefined;
}

function changedFile(entry: TranscriptEntry): string | undefined {
  if (entry.kind !== "tool" || entry.failed || !FILE_TOOLS.has(entry.name.toLowerCase())) return undefined;
  const args = entry.args && typeof entry.args === "object" ? entry.args as Record<string, unknown> : {};
  const path = args["path"] ?? args["file_path"] ?? args["filePath"];
  return typeof path === "string" && path.trim() ? path.trim() : undefined;
}

type Line = { text: string; operator: boolean };

export function sessionDigest(entries: readonly TranscriptEntry[]): SessionDigest {
  const lines: Line[] = [];
  const requests: string[] = [];
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.kind === "message" && entry.role === "user") {
      const text = operatorText(entry.text);
      if (text === undefined) continue;
      // A resumed run repeats its original request; count it once.
      if (!requests.includes(text)) requests.push(text);
      lines.push({ text: "user: " + text, operator: true });
    } else if (entry.kind === "message") {
      if (entry.text.trim()) lines.push({ text: "assistant: " + entry.text.trim(), operator: false });
    } else if (entry.kind === "error") {
      lines.push({ text: "error: " + entry.message, operator: false });
    } else {
      const file = changedFile(entry);
      if (file && !files.includes(file)) files.push(file);
    }
  }

  const goal = requests[0] ?? "";
  const sections: string[] = [];
  sections.push("## Session goal (the user's first request)\n\n" + (goal ? clip(goal, GOAL_MAX) : "(No request yet)"));

  const followUps: string[] = [];
  let used = 0;
  for (const request of requests.slice(1).reverse()) {
    const line = "- " + clip(request, FOLLOW_UP_MAX).replace(/\n+/gu, " ");
    if (used + line.length > FOLLOW_UPS_BUDGET) break;
    followUps.unshift(line);
    used += line.length;
  }
  if (followUps.length) {
    const omitted = requests.length - 1 - followUps.length;
    sections.push("## Later user messages (oldest first; explicit changes override the goal)\n\n"
      + (omitted ? "(" + omitted + " earlier messages omitted)\n" : "") + followUps.join("\n"));
  }

  if (files.length) {
    sections.push("## Files the agent changed\n\n" + files.slice(0, FILES_MAX).join("\n")
      + (files.length > FILES_MAX ? "\n(" + (files.length - FILES_MAX) + " more)" : ""));
  }

  // Recent conversation, newest last, after the goal message (already above).
  // Resumed runs repeat the goal; those copies are skipped, not repeated.
  const goalLine = "user: " + goal;
  const start = lines.findIndex((line) => line.operator && line.text === goalLine) + 1;
  const recent: string[] = [];
  let budget = RECENT_BUDGET;
  for (const line of lines.slice(start).reverse()) {
    if (line.operator && line.text === goalLine) continue;
    const text = clip(line.text, ENTRY_MAX);
    if (text.length > budget) break;
    recent.unshift(text);
    budget -= text.length;
  }
  if (recent.length) sections.push("## Most recent conversation (where the session ended)\n\n" + recent.join("\n\n"));

  return { text: sections.join("\n\n"), goal };
}
