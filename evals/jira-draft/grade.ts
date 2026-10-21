import type { JiraDraft } from "../../server/api/jira.ts";
import type { DraftCase } from "./cases.ts";

export type Grade = { pass: boolean; failures: string[] };

const HEADINGS = ["## Context", "## Scope", "## Acceptance criteria"];

/** Deterministic checks: a model draft, the goal in the title, no tail topic
 * in the title, the required facts and headings, and an acceptable parent. */
export function gradeDraft(draft: JiraDraft, expect: DraftCase["expect"]): Grade {
  const failures: string[] = [];
  if (!draft.model) failures.push("fallback: " + (draft.note ?? "no model draft"));
  for (const pattern of expect.summary) {
    if (!pattern.test(draft.summary)) failures.push("summary misses " + String(pattern));
  }
  for (const pattern of expect.summaryNot ?? []) {
    if (pattern.test(draft.summary)) failures.push("summary has tail topic " + String(pattern));
  }
  for (const pattern of expect.description ?? []) {
    if (!pattern.test(draft.description)) failures.push("description misses " + String(pattern));
  }
  for (const pattern of expect.descriptionNot ?? []) {
    if (pattern.test(draft.description)) failures.push("description has tail topic " + String(pattern));
  }
  for (const heading of HEADINGS) {
    if (!draft.description.includes(heading)) failures.push("description lacks " + heading);
  }
  if (draft.summary.length > 100) failures.push("summary over 100 characters");
  // Every case is written in English; another script means the model drifted.
  if (/[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u.test(draft.summary + draft.description)) {
    failures.push("draft is not in the session's language (English)");
  }
  if (draft.model && draft.parentChoice !== "suggested") {
    failures.push("parent not a deliberate choice (" + (draft.parentChoice ?? "unknown") + (draft.rejectedParent ? ": " + draft.rejectedParent : "") + ")");
  }
  if (!expect.parent.includes(draft.parent)) {
    failures.push("parent " + (draft.parent || "(none)") + " not in " + expect.parent.map((key) => key || "(none)").join("|"));
  }
  return { pass: failures.length === 0, failures };
}
