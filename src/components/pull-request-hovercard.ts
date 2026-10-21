/**
 * Preview card for a session's pull request badge.
 *
 * One delegated controller serves every `.session-pr-badge` anchor. The badge
 * itself stays a plain link to GitHub; the card opens from the badge on hover or
 * keyboard focus, portaled into the top layer so the sidebar cannot clip it.
 * The pointer may travel onto the card to scroll a long description: a
 * transparent bridge covers the gap and a short grace delay covers diagonal
 * paths. Touch pointers keep the native tap-to-open behavior only.
 */
import { html, nothing } from "lit";
import { renderMarkdown } from "../lib/markdown/markdown.ts";
import { icons } from "./openclaw/icons.ts";
import { BadgeHovercardController } from "./badge-hovercard.ts";
import { pullRequestReference, pullRequestStateLabel } from "../lib/pull-requests.ts";
import type { PullRequestState, SessionPullRequest } from "../api/schema/github.ts";

export const PULL_REQUEST_BADGE_SELECTOR = "a.session-pr-badge";

export type PullRequestBadgeElement = HTMLAnchorElement & { pullRequest?: SessionPullRequest };

export function pullRequestStateIcon(state: PullRequestState | undefined) {
  switch (state) {
    case "draft": return icons.gitPullRequestDraft;
    case "merged": return icons.gitMerge;
    case "closed": return icons.gitPullRequestClosed;
    default: return icons.gitPullRequest;
  }
}

export function renderPullRequestCard(pullRequest: SessionPullRequest) {
  const state = pullRequest.state ?? "unknown";
  return html`<div class="pr-hovercard__header">
      <span class="pr-hovercard__icon" aria-hidden="true">${pullRequestStateIcon(pullRequest.state)}</span>
      <span class="pr-hovercard__ref">${pullRequestReference(pullRequest)}</span>
      <span class="pr-hovercard__state" data-state=${state}>${pullRequestStateLabel(pullRequest.state)}</span>
    </div>
    ${pullRequest.title ? html`<div class="pr-hovercard__title">${pullRequest.title}</div>` : nothing}
    ${pullRequest.body
      ? html`<div class="pr-hovercard__body sidebar-markdown">${renderMarkdown(pullRequest.body)}</div>`
      : html`<div class="pr-hovercard__empty">${pullRequest.state
        ? "No description provided."
        : "GitHub details are unavailable. Open the pull request to view it."}</div>`}`;
}

let installed = false;
export function installPullRequestHovercard(root: Document = document) {
  if (installed) return;
  installed = true;
  new BadgeHovercardController<SessionPullRequest>({
    selector: PULL_REQUEST_BADGE_SELECTOR,
    cardClass: "pr-hovercard",
    data: (anchor) => (anchor as PullRequestBadgeElement).pullRequest,
    render: renderPullRequestCard,
    state: (pullRequest) => pullRequest.state ?? "unknown",
    gapSelector: ".session-pr-badges",
  }).install(root);
}
