/**
 * GitHub link previews shown after a chat message, Slack-style: at most three
 * per message, in reading order. The card is always a link to GitHub; facts
 * come from the gateway's `gh` login and stay absent until it answers.
 */
import { LitElement, html, nothing, svg, type TemplateResult } from "lit";
import { githubRefKey, githubRefsInText } from "../lib/markdown/github-links.ts";
import type { GitHubPreview, GitHubPreviewResult } from "../api/schema/github.ts";
import type { GitHubRef } from "../lib/markdown/github-links.ts";
import { pullRequestStateLabel } from "../lib/pull-requests.ts";
import { compactCount, previewErrorLabel } from "../lib/github-previews.ts";
import { loadGitHubPreviews, settledGitHubPreview } from "../lib/github-previews-store.ts";
import { pullRequestStateIcon, renderPullRequestCard } from "./pull-request-hovercard.ts";
import { BadgeHovercardController } from "./badge-hovercard.ts";
import type { SessionPullRequest } from "../api/schema/github.ts";
import { icons } from "./openclaw/icons.ts";

/** Octicons mark-github (MIT). */
const githubMark = html`<svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">${svg`<path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"></path>`}</svg>`;
/** Octicons issue-opened / issue-closed / skip (MIT), 16px. */
const issueOpen = html`<svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">${svg`<path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"></path><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z"></path>`}</svg>`;
const issueClosed = html`<svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">${svg`<path d="M11.28 6.78a.75.75 0 0 0-1.06-1.06L7.25 8.69 5.78 7.22a.75.75 0 0 0-1.06 1.06l2 2a.75.75 0 0 0 1.06 0l3.5-3.5Z"></path><path d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0Zm-1.5 0a6.5 6.5 0 1 0-13 0 6.5 6.5 0 0 0 13 0Z"></path>`}</svg>`;
const issueSkipped = html`<svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">${svg`<path d="M11.28 6.78a.75.75 0 0 0-1.06-1.06l-5.5 5.5a.75.75 0 1 0 1.06 1.06l5.5-5.5Z"></path><path d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0Zm-1.5 0a6.5 6.5 0 1 0-13 0 6.5 6.5 0 0 0 13 0Z"></path>`}</svg>`;

function refLabel(ref: GitHubRef): string {
  return ref.kind === "repo" ? `${ref.owner}/${ref.repo}` : `${ref.owner}/${ref.repo}#${ref.number}`;
}

/** First paragraph of a Markdown body, as plain text. */
export function bodySnippet(body: string | undefined, limit = 220): string {
  if (!body) return "";
  const paragraph = body.split(/\n{2,}/u).map((part) => part.trim()).find((part) => part && !/^#{1,6}\s/u.test(part)) ?? "";
  const plain = paragraph.replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1").replace(/[`*_>#]+/gu, "").replace(/\s+/gu, " ").trim();
  return plain.length > limit ? `${plain.slice(0, limit - 1).trimEnd()}…` : plain;
}

function issueState(preview: Extract<GitHubPreview, { kind: "issue" }>): { icon: TemplateResult; label: string; state: string } {
  if (preview.state === "open") return { icon: issueOpen, label: "Open", state: "open" };
  if (preview.stateReason === "not_planned") return { icon: issueSkipped, label: "Closed as not planned", state: "skipped" };
  return { icon: issueClosed, label: "Closed", state: "completed" };
}

function renderPreview(preview: GitHubPreview) {
  if (preview.kind === "repo") {
    return html`<span class="github-embed__head">
        <span class="github-embed__mark">${githubMark}</span>
        <span class="github-embed__ref">${preview.fullName}</span>
        ${preview.private ? html`<span class="github-embed__tag">Private</span>` : nothing}
        ${preview.archived ? html`<span class="github-embed__tag">Archived</span>` : nothing}
      </span>
      ${preview.description ? html`<span class="github-embed__body">${preview.description}</span>` : nothing}
      <span class="github-embed__meta">
        ${preview.language ? html`<span>${preview.language}</span>` : nothing}
        <span aria-label=${`${preview.stars} stars`}>★ ${compactCount(preview.stars)}</span>
        <span aria-label=${`${preview.forks} forks`}>${icons.gitBranch} ${compactCount(preview.forks)}</span>
      </span>`;
  }
  if (preview.kind === "pull") {
    const snippet = bodySnippet(preview.body);
    return html`<span class="github-embed__head">
        <span class="github-embed__state-icon" data-state=${preview.state}>${pullRequestStateIcon(preview.state)}</span>
        <span class="github-embed__ref">${preview.repository}#${preview.number}</span>
        <span class="github-embed__state" data-state=${preview.state}>${pullRequestStateLabel(preview.state)}</span>
      </span>
      <span class="github-embed__title">${preview.title}</span>
      ${snippet ? html`<span class="github-embed__body">${snippet}</span>` : nothing}
      <span class="github-embed__meta">
        ${preview.author ? html`<span>${preview.author}</span>` : nothing}
        <span class="github-embed__diff"><span class="github-embed__add">+${compactCount(preview.additions)}</span> <span class="github-embed__del">−${compactCount(preview.deletions)}</span></span>
        <span>${preview.changedFiles} file${preview.changedFiles === 1 ? "" : "s"}</span>
        ${preview.comments ? html`<span>${preview.comments} comment${preview.comments === 1 ? "" : "s"}</span>` : nothing}
      </span>`;
  }
  const state = issueState(preview);
  const snippet = bodySnippet(preview.body);
  return html`<span class="github-embed__head">
      <span class="github-embed__state-icon" data-state=${state.state}>${state.icon}</span>
      <span class="github-embed__ref">${preview.repository}#${preview.number}</span>
      <span class="github-embed__state" data-state=${state.state}>${state.label}</span>
    </span>
    <span class="github-embed__title">${preview.title}</span>
    ${snippet ? html`<span class="github-embed__body">${snippet}</span>` : nothing}
    <span class="github-embed__meta">
      ${preview.author ? html`<span>${preview.author}</span>` : nothing}
      ${preview.labels.map((label) => html`<span class="github-embed__tag">${label}</span>`)}
      ${preview.comments ? html`<span>${preview.comments} comment${preview.comments === 1 ? "" : "s"}</span>` : nothing}
    </span>`;
}

function accessibleName(ref: GitHubRef, result: GitHubPreviewResult | undefined): string {
  const preview = result?.preview;
  if (!preview) return `GitHub ${refLabel(ref)}`;
  if (preview.kind === "repo") return `GitHub repository ${preview.fullName}`;
  if (preview.kind === "pull") return `Pull request ${preview.repository}#${preview.number}, ${pullRequestStateLabel(preview.state).toLowerCase()}: ${preview.title}`;
  return `Issue ${preview.repository}#${preview.number}, ${issueState(preview).label.toLowerCase()}: ${preview.title}`;
}

/** How long a message's text must stay unchanged before it unfurls; Datadog cards (`datadog-embeds.ts`) share it. */
export const SETTLE_MS = 800;
const PULL_EMBED_SELECTOR = "a.github-embed[data-kind=\"pull\"]";

type PullEmbedAnchor = HTMLAnchorElement & { githubPreview?: GitHubPreview };

/** Full pull request description on hover or keyboard focus, reusing the PR badge card. */
function pullRequestFromAnchor(anchor: HTMLElement): SessionPullRequest | undefined {
  const preview = (anchor as PullEmbedAnchor).githubPreview;
  if (preview?.kind !== "pull") return undefined;
  return {
    repository: preview.repository,
    number: preview.number,
    url: preview.url,
    state: preview.state,
    title: preview.title,
    ...(preview.body ? { body: preview.body } : {}),
  };
}

let hovercardInstalled = false;
function installPullEmbedHovercard() {
  if (hovercardInstalled || typeof document === "undefined") return;
  hovercardInstalled = true;
  new BadgeHovercardController<SessionPullRequest>({
    selector: PULL_EMBED_SELECTOR,
    cardClass: "pr-hovercard github-embed-hovercard",
    data: pullRequestFromAnchor,
    render: renderPullRequestCard,
    state: (pullRequest) => pullRequest.state ?? "unknown",
  }).install(document);
}

export class HuiGitHubEmbeds extends LitElement {
  static override properties = { text: { type: String } };
  declare text: string;
  #refs: GitHubRef[] = [];
  #results = new Map<string, GitHubPreviewResult>();
  #requested = "";
  #settle?: ReturnType<typeof setTimeout>;

  constructor() {
    super();
    this.text = "";
  }

  override createRenderRoot() { return this; }

  override connectedCallback() {
    super.connectedCallback();
    installPullEmbedHovercard();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this.#settle) clearTimeout(this.#settle);
    this.#settle = undefined;
  }

  override willUpdate(changed: Map<string, unknown>) {
    if (!changed.has("text")) return;
    // A streaming message grows a URL character by character; unfurl only once the
    // text has been stable briefly so partial links are never looked up or shown.
    if (this.#settle) clearTimeout(this.#settle);
    this.#settle = undefined;
    // A message's first render shows its cards at once, already filled in when they were seen before, so a
    // transcript that renders again does not grow card by card under the reader.
    if (this.#requested === "" && this.#refs.length === 0) this.#unfurl();
    else this.#settle = setTimeout(() => { this.#settle = undefined; this.#unfurl(); }, SETTLE_MS);
  }

  #unfurl() {
    const refs = githubRefsInText(this.text ?? "");
    const signature = refs.map(githubRefKey).join(" ");
    if (signature === this.#requested) return;
    this.#requested = signature;
    this.#refs = refs;
    for (const ref of refs) {
      const known = settledGitHubPreview(ref);
      if (known && !this.#results.has(githubRefKey(ref))) this.#results.set(githubRefKey(ref), known);
    }
    this.requestUpdate();
    if (!refs.length) return;
    void loadGitHubPreviews(refs).then((results) => {
      if (this.#requested !== signature) return;
      results.forEach((result, index) => { const ref = refs[index]; if (ref) this.#results.set(githubRefKey(ref), result); });
      this.requestUpdate();
    });
  }

  override render() {
    if (!this.#refs.length) return nothing;
    return html`<div class="github-embeds" role="list" aria-label="GitHub links">
      ${this.#refs.map((ref) => {
        const result = this.#results.get(githubRefKey(ref));
        const preview = result?.preview;
        const kind = preview?.kind ?? ref.kind;
        return html`<a role="listitem" class="github-embed" data-kind=${kind} data-loading=${result ? "false" : "true"}
          .githubPreview=${preview}
          href=${preview?.url ?? ref.url} target="_blank" rel="noopener noreferrer" aria-label=${accessibleName(ref, result)}>
          ${preview ? renderPreview(preview) : html`<span class="github-embed__head">
              <span class="github-embed__mark">${githubMark}</span>
              <span class="github-embed__ref">${refLabel(ref)}</span>
            </span>
            <span class="github-embed__body github-embed__body--muted">${result ? previewErrorLabel(result.error) : "Loading GitHub preview…"}</span>`}
        </a>`;
      })}
    </div>`;
  }
}

if (typeof customElements !== "undefined" && !customElements.get("hui-github-embeds")) customElements.define("hui-github-embeds", HuiGitHubEmbeds);
