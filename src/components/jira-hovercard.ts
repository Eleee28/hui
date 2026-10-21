/**
 * Preview card for a session's Jira mark: key, type, status, summary and a
 * scrollable Markdown description. The mark sits inside the session link, so it
 * is a non-focusable span; its details are also part of the row's accessible
 * name and the session menu offers "Open in Jira" for keyboard users.
 */
import { html, nothing } from "lit";
import { renderMarkdown } from "../lib/markdown/markdown.ts";
import { brandIcons } from "../lib/brand-icons.ts";
import { BadgeHovercardController } from "./badge-hovercard.ts";
import { jiraStatusLabel } from "../lib/jira.ts";
import type { SessionJiraIssue } from "../api/schema/sessions.ts";

export const JIRA_BADGE_SELECTOR = ".session-jira-badge";

export type JiraBadgeData = { issue: SessionJiraIssue; others: readonly SessionJiraIssue[] };
export type JiraBadgeElement = HTMLElement & { jira?: JiraBadgeData };

export function jiraCardState(issue: SessionJiraIssue): string {
  return issue.statusCategory ?? "unknown";
}

export function renderJiraCard({ issue, others }: JiraBadgeData) {
  return html`<div class="pr-hovercard__header">
      <span class="pr-hovercard__icon jira-hovercard__icon" aria-hidden="true">${brandIcons.jira}</span>
      <span class="pr-hovercard__ref">${issue.key}${issue.issueType ? html` · ${issue.issueType}` : nothing}</span>
      <span class="pr-hovercard__state" data-state=${jiraCardState(issue)}>${jiraStatusLabel(issue)}</span>
    </div>
    ${issue.summary ? html`<div class="pr-hovercard__title">${issue.summary}</div>` : nothing}
    ${issue.description
      ? html`<div class="pr-hovercard__body sidebar-markdown">${renderMarkdown(issue.description)}</div>`
      : html`<div class="pr-hovercard__empty">${issue.status
        ? "No description provided."
        : "Jira details are unavailable. Open the work item to view it."}</div>`}
    ${others.length ? html`<div class="jira-hovercard__others">Also linked: ${others.map((other) => other.key).join(", ")}</div>` : nothing}`;
}

let installed = false;
export function installJiraHovercard(root: Document = document) {
  if (installed) return;
  installed = true;
  new BadgeHovercardController<JiraBadgeData>({
    selector: JIRA_BADGE_SELECTOR,
    cardClass: "pr-hovercard jira-hovercard",
    data: (element) => (element as JiraBadgeElement).jira,
    render: renderJiraCard,
    state: ({ issue }) => jiraCardState(issue),
  }).install(root);
}
