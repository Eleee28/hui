/** Browser half of the Jira integration: merging project search results and the draft form's parent hint and
 * edits. Its requests live in src/api/jira.ts. */
import type { JiraDraft, JiraProject } from "../api/schema/jira.ts";
import type { SessionJiraIssue } from "../api/schema/sessions.ts";

export const JIRA_API_TOKEN_URL = "https://id.atlassian.com/manage-profile/security/api-tokens";

export function jiraStatusLabel(issue: Pick<SessionJiraIssue, "status">): string {
  return issue.status || "Status unavailable";
}

export function jiraIssueAccessibleLabel(issue: SessionJiraIssue, total = 1): string {
  const summary = issue.summary ? `: ${issue.summary}` : "";
  const more = total > 1 ? `, ${total - 1} more linked` : "";
  return `Jira ${issue.key}, ${jiraStatusLabel(issue).toLocaleLowerCase()}${summary}${more}`;
}

/** The newest linked item owns the row mark; older ones are listed in its card. */
export function primaryJiraIssue(
  issues: readonly SessionJiraIssue[] | undefined,
): { issue: SessionJiraIssue; others: SessionJiraIssue[] } | undefined {
  if (!issues?.length) return undefined;
  return { issue: issues.at(-1)!, others: issues.slice(0, -1) };
}

/** Adds search results to the known projects without dropping the selection. */
export function mergeJiraProjects(known: readonly JiraProject[], found: readonly JiraProject[]): JiraProject[] {
  const byKey = new Map(known.map((project) => [project.key, project]));
  for (const project of found) byKey.set(project.key, project);
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Tracks which draft fields the operator has edited, so a late or repeated
 * agent draft never overwrites their words. */
export type JiraDraftFields = { parent: string; summary: string; description: string };

/**
 * The parent field's hint and explanation. The model's choice (a parent or
 * deliberately none) is marked `suggested`; an empty parent that the model did
 * not choose says why. Once the operator edits the parent, both disappear.
 */
export function jiraParentHint(
  draft: Pick<JiraDraft, "project" | "parent" | "parentChoice" | "rejectedParent"> | undefined,
  edited: boolean,
): { suggested: boolean; reason: string } {
  if (!draft || edited) return { suggested: false, reason: "" };
  switch (draft.parentChoice) {
    case "suggested":
      return { suggested: true, reason: draft.parent ? "" : "No open parent matches this work." };
    case "unmatched":
      return { suggested: false, reason: `The model suggested ${draft.rejectedParent || "a parent"}, which isn't an open parent in ${draft.project}.` };
    case "none-available":
      return { suggested: false, reason: `${draft.project} has no open parent work items.` };
    case "omitted":
      return { suggested: false, reason: "The model didn't choose a parent." };
    case "not-drafted":
      return { suggested: false, reason: "No parent was suggested because the draft was prefilled locally." };
    default:
      return { suggested: Boolean(draft.parent), reason: "" };
  }
}

export function applyJiraDraft(
  current: JiraDraftFields,
  edited: ReadonlySet<keyof JiraDraftFields>,
  draft: Pick<JiraDraft, "parent" | "summary" | "description">,
): JiraDraftFields {
  return {
    parent: edited.has("parent") ? current.parent : draft.parent,
    summary: edited.has("summary") ? current.summary : draft.summary,
    description: edited.has("description") ? current.description : draft.description,
  };
}
