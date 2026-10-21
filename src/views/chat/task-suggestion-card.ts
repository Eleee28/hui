/** Suggested-task card: HUI adaptation of OpenClaw 2026.9.5's task suggestion
 * tray (vendored `.task-suggestion*` CSS). HUI cards describe a problem and,
 * when known, a proposed fix instead of an instruction prompt. Actions: start
 * it in a new session, file it as a Jira work item or save it to the Kanban
 * backlog (the only filing action while Jira is not connected), copy or
 * dismiss. */
import { html, nothing } from "lit";
import { brandIcons } from "../../lib/brand-icons.ts";
import { icons } from "../../lib/icons.ts";
import { renderMarkdown } from "../../lib/markdown/markdown.ts";
import { clampSuggestionIndex, taskSuggestionLocation, taskSuggestionPreview, type TaskSuggestion, type TaskSuggestionStartMode } from "../../lib/task-suggestions.ts";

export type TaskSuggestionCardProps = {
  suggestions: readonly TaskSuggestion[];
  index: number;
  /** Id of the suggestion whose start/dismiss request is in flight. */
  pendingId: string;
  copied: boolean;
  onIndex: (index: number) => void;
  onStart: (suggestion: TaskSuggestion, mode: TaskSuggestionStartMode) => void;
  /** Jira connected: "Create Jira task" with a ▾ menu that also offers
   * "Add to backlog". Otherwise a single "Add to backlog" button. */
  jiraConfigured: boolean;
  onCreateJira: (suggestion: TaskSuggestion) => void;
  onAddToBacklog: (suggestion: TaskSuggestion) => void;
  onCopy: (suggestion: TaskSuggestion) => void;
  onDismiss: (suggestion: TaskSuggestion) => void;
};

const backlogIcon = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"></rect><path d="M8 7v7M12 7v4M16 7v9"></path></svg>`;
const playIcon = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 4 13 8-13 8Z"></path></svg>`;

export function renderTaskSuggestionCard(props: TaskSuggestionCardProps) {
  const count = props.suggestions.length;
  if (!count) return nothing;
  const index = clampSuggestionIndex(props.index, count);
  const suggestion = props.suggestions[index]!;
  const busy = props.pendingId === suggestion.id;
  const titleId = `task-suggestion-title-${suggestion.id}`;
  return html`<div class="task-suggestions ${count > 1 ? "task-suggestions--stack" : ""}">
    <article class="task-suggestion" data-suggestion-id=${suggestion.id} aria-labelledby=${titleId} aria-busy=${String(busy)}>
      <div class="task-suggestion__body">
        <div class="task-suggestion__header">
          <span class="task-suggestion__eyebrow">
            <span>Suggested task · in ${taskSuggestionLocation(suggestion.cwd)}</span>
            ${count > 1 ? html`<span class="task-suggestion__position">${index + 1}/${count}</span>` : nothing}
          </span>
          <span class="task-suggestion__header-actions">
            ${count > 1 ? html`
              <button type="button" class="task-suggestion__header-action" aria-label="Previous suggestion" title="Previous suggestion" ?disabled=${index === 0} @click=${() => props.onIndex(index - 1)}>${icons.chevronUp}</button>
              <button type="button" class="task-suggestion__header-action" aria-label="Next suggestion" title="Next suggestion" ?disabled=${index === count - 1} @click=${() => props.onIndex(index + 1)}>${icons.chevronDown}</button>
            ` : nothing}
            <button type="button" class="task-suggestion__header-action" aria-label=${props.copied ? "Copied task" : "Copy task"} title=${props.copied ? "Copied" : "Copy problem and fix"} @click=${() => props.onCopy(suggestion)}>${props.copied ? icons.check : icons.copy}</button>
            <button type="button" class="task-suggestion__header-action" aria-label="Dismiss suggestion" title="Dismiss suggestion" ?disabled=${busy} @click=${() => props.onDismiss(suggestion)}>${icons.close}</button>
          </span>
        </div>
        <div class="task-suggestion__title" id=${titleId}>${suggestion.title}</div>
        <div class="task-suggestion__summary">${taskSuggestionPreview(suggestion.problem)}</div>
        <details class="task-suggestion__instructions">
          <summary>
            <span class="task-suggestion__instructions-chevron" aria-hidden="true">${icons.chevron}</span>
            <span class="task-suggestion__show">Show details</span><span class="task-suggestion__hide">Hide details</span>
          </summary>
          <div class="task-suggestion__instruction-body">
            <code title=${suggestion.cwd}>${suggestion.cwd}</code>
            <div class="task-suggestion__details" tabindex="0" aria-label="Problem and proposed fix">
              <h4 class="task-suggestion__section">Problem</h4>
              <div class="chat-text task-suggestion__markdown">${renderMarkdown(suggestion.problem)}</div>
              <h4 class="task-suggestion__section">Proposed fix</h4>
              ${suggestion.fix
                ? html`<div class="chat-text task-suggestion__markdown">${renderMarkdown(suggestion.fix)}</div>`
                : html`<p class="task-suggestion__unknown">Not known yet.</p>`}
            </div>
          </div>
        </details>
      </div>
      <div class="task-suggestion__actions">
        ${props.jiraConfigured ? html`<span class="task-suggestion__start-group task-suggestion__file-group">
          <button type="button" class="task-suggestion__start task-suggestion__start--primary task-suggestion__jira" ?disabled=${busy} @click=${() => props.onCreateJira(suggestion)}>
            <span class="task-suggestion__jira-icon" aria-hidden="true">${brandIcons.jira}</span>Create Jira task
          </button>
          <wa-dropdown class="session-menu task-suggestion__start-menu task-suggestion__file-menu" placement="top-end" distance="4" @wa-select=${(event: CustomEvent<{ item: HTMLElement }>) => {
            const action = event.detail.item.getAttribute("value");
            if (action === "jira") queueMicrotask(() => props.onCreateJira(suggestion));
            else if (action === "backlog") queueMicrotask(() => props.onAddToBacklog(suggestion));
          }}>
            <button slot="trigger" type="button" class="task-suggestion__start task-suggestion__jira task-suggestion__start--options" aria-label="More filing options" title="More filing options" ?disabled=${busy}>${icons.chevronDown}</button>
            <wa-dropdown-item value="jira" class="session-menu__item"><span class="session-menu__text">Create Jira task</span></wa-dropdown-item>
            <wa-dropdown-item value="backlog" class="session-menu__item"><span class="session-menu__text">Add to backlog</span></wa-dropdown-item>
          </wa-dropdown>
        </span>` : html`<button type="button" class="task-suggestion__start task-suggestion__jira task-suggestion__backlog" ?disabled=${busy} @click=${() => props.onAddToBacklog(suggestion)}>
          ${backlogIcon}Add to backlog
        </button>`}
        <span class="task-suggestion__start-group">
          <button type="button" class="task-suggestion__start task-suggestion__start--primary task-suggestion__start--run" ?disabled=${busy} @click=${() => props.onStart(suggestion, "session")}>
            ${busy ? html`<span class="hui-orbit" aria-hidden="true"><i></i><i></i><i></i></span>Starting…` : html`${playIcon}Start in a new session`}
          </button>
          <wa-dropdown class="session-menu task-suggestion__start-menu" placement="top-end" distance="4" @wa-select=${(event: CustomEvent<{ item: HTMLElement }>) => {
            const mode = event.detail.item.getAttribute("value");
            // Act after Web Awesome restores trigger focus, as the pane menu does.
            if (mode === "worktree" || mode === "current" || mode === "session") queueMicrotask(() => props.onStart(suggestion, mode));
          }}>
            <button slot="trigger" type="button" class="task-suggestion__start task-suggestion__start--options" aria-label="More start options" title="More start options" ?disabled=${busy}>${icons.chevronDown}</button>
            <wa-dropdown-item value="session" class="session-menu__item"><span class="session-menu__text">Start in a new session</span></wa-dropdown-item>
            <wa-dropdown-item value="worktree" class="session-menu__item"><span class="session-menu__text">Start in a new worktree</span></wa-dropdown-item>
            <wa-dropdown-item value="current" class="session-menu__item"><span class="session-menu__text">Start in this session</span></wa-dropdown-item>
          </wa-dropdown>
        </span>
      </div>
    </article>
  </div>`;
}
