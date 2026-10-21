/**
 * A bot's Tools & skills page (HUI-18): "Available tools", every one on until the
 * operator turns it off, grouped as Files, Shell, HUI, each extension by its
 * source, and Bots; then its skills, searchable once there are many; an access
 * request waiting in its chat, answerable here as in the chat; and what is
 * always on. Rendering only: `BotToolsController`
 * (`controllers/bot-tools-controller.ts`) owns the state and the requests.
 */
import { html, nothing } from "lit";
import { live } from "lit/directives/live.js";
import { BOT_ACCESS_ANSWERS, type BotView } from "../lib/bots/bots.ts";
import { botToolsSummary, groupBotTools, matchingSkills, SKILL_SEARCH_MIN, type BotToolsActions, type BotToolsState } from "../lib/bots/tools.ts";
import { renderSettingsToggle } from "./settings-toggle.ts";
import { loadViewAssets } from "../lib/view-assets.ts";

loadViewAssets(() => import("../styles/bot-tools.css"));

export type BotToolsProps = { bot: BotView; state: BotToolsState } & BotToolsActions;

const POWERFUL_HINT = "Powerful: it reaches past what is off. It runs commands, changes files other programs load, or acts through another session.";

/** The request its chat waits on, with Allow and Deny: the same answer the chat's question takes. */
function renderRequest(props: BotToolsProps) {
  const request = props.state.catalog?.request;
  if (!request) return nothing;
  const [allow, deny] = BOT_ACCESS_ANSWERS;
  const busy = props.state.answering;
  return html`<section class="bot-tools__request" role="group" aria-labelledby="bot-tools-request-title">
    <p class="bot-tools__request-title" id="bot-tools-request-title">${props.bot.name} asks: ${request.title}</p>
    ${request.message ? html`<p class="bot-tools__request-reason">${request.message}</p>` : nothing}
    <div class="bot-tools__request-actions">
      <button type="button" class="btn primary btn--sm" ?disabled=${busy} @click=${() => props.onAnswer(allow)}>${allow}</button>
      <button type="button" class="btn btn--sm" ?disabled=${busy} @click=${() => props.onAnswer(deny)}>${deny}</button>
    </div>
    <p class="bot-panel__hint">You can answer it in the chat too. Only you can.</p>
  </section>`;
}

function renderTools(props: BotToolsProps) {
  const catalog = props.state.catalog!;
  const disabled = props.state.saving || props.bot.archived === true;
  return html`<section class="bot-panel__section bot-tools__section" aria-labelledby="bot-tools-available">
    <h3 class="bot-panel__heading" id="bot-tools-available">Available tools</h3>
    ${catalog.live ? nothing : html`<p class="bot-panel__hint">${props.bot.name}'s chat isn't running, so an extension's tools aren't listed yet.</p>`}
    ${groupBotTools(catalog.tools).map((group) => html`<div class="bot-tools__group" role="group" aria-label=${group.source ? `${group.title}: ${group.source}` : group.title}>
      <p class="bot-tools__group-title">${group.title}${group.source ? html` <span class="bot-tools__source">${group.source}</span>` : nothing}</p>
      ${group.tools.map((tool) => html`<div class="bot-tools__row ${tool.enabled ? "" : "bot-tools__row--off"}" data-tool=${tool.name}>
        <div class="bot-tools__text">
          <span class="bot-tools__name">${tool.label}<code class="bot-tools__id">${tool.name}</code>${tool.powerful
            ? html`<span class="capability-badge bot-tools__powerful" title=${POWERFUL_HINT}>Powerful</span>` : nothing}</span>
          ${tool.description ? html`<span class="bot-tools__desc">${tool.description}</span>` : nothing}
        </div>
        ${renderSettingsToggle(`${tool.label} (${tool.name})`, tool.enabled, (checked) => props.onToggleTool(tool.name, checked), disabled)}
      </div>`)}
    </div>`)}
  </section>`;
}

function renderSkills(props: BotToolsProps) {
  const catalog = props.state.catalog!;
  const disabled = props.state.saving || props.bot.archived === true;
  const searchable = catalog.skills.length >= SKILL_SEARCH_MIN;
  const shown = searchable ? matchingSkills(catalog.skills, props.state.query) : catalog.skills;
  return html`<section class="bot-panel__section bot-tools__section" aria-labelledby="bot-tools-skills">
    <h3 class="bot-panel__heading" id="bot-tools-skills">Skills</h3>
    ${searchable ? html`<input class="settings-input bot-tools__search" type="search" placeholder="Search skills" aria-label="Search skills" autocomplete="off"
      .value=${live(props.state.query)} @input=${(event: Event) => props.onSearch((event.currentTarget as HTMLInputElement).value)} />` : nothing}
    ${!catalog.skills.length
      ? html`<p class="bot-panel__hint">No skills in its directory.</p>`
      : !shown.length
        ? html`<p class="bot-panel__hint">No skill matches “${props.state.query.trim()}”.</p>`
        : html`<div class="bot-tools__group" role="group" aria-label="Skills">${shown.map((skill) => html`<div class="bot-tools__row ${skill.enabled ? "" : "bot-tools__row--off"}" data-skill=${skill.name}>
          <div class="bot-tools__text">
            <span class="bot-tools__name">${skill.name}</span>
            ${skill.description ? html`<span class="bot-tools__desc">${skill.description}</span>` : nothing}
            <span class="bot-tools__source">${skill.source}</span>
          </div>
          ${renderSettingsToggle(`Skill ${skill.name}`, skill.enabled, (checked) => props.onToggleSkill(skill, checked), disabled)}
        </div>`)}</div>`}
  </section>`;
}

export function renderBotToolsTab(props: BotToolsProps) {
  const { state } = props;
  if (!state.catalog) {
    return state.error
      ? html`<div class="bot-panel__state" role="alert">${state.error} <button type="button" class="btn btn--sm" @click=${props.onRetry}>Retry</button></div>`
      : html`<p class="bot-panel__state" role="status">Reading ${props.bot.name}'s tools…</p>`;
  }
  const catalog = state.catalog;
  return html`<div class="bot-tools" aria-busy=${state.saving ? "true" : "false"}>
    ${renderRequest(props)}
    <p class="bot-tools__summary" role="status">${botToolsSummary(catalog)} ${props.bot.archived ? "Restore it to change them." : "Changes apply from its next request."}</p>
    ${state.saveError ? html`<p class="bot-field__error" role="alert">${state.saveError}</p>` : nothing}
    ${state.error ? html`<p class="bot-field__error" role="alert">Refresh failed: ${state.error}</p>` : nothing}
    ${renderTools(props)}
    ${renderSkills(props)}
    <section class="bot-panel__section bot-tools__section" aria-labelledby="bot-tools-always">
      <h3 class="bot-panel__heading" id="bot-tools-always">Always on</h3>
      <ul class="bot-tools__always">${catalog.alwaysOn.map((tool) => html`<li><code class="bot-tools__id">${tool.name}</code> ${tool.description}</li>`)}</ul>
    </section>
    <p class="bot-panel__hint">A turned-off tool is gone from ${props.bot.name}'s chat, and it can ask you for it back. Tools are the boundary, not a sandbox: with bash or read it reaches whatever your account can, and message_bot lets it ask another bot to act. Run it on a worker in a container to isolate it.</p>
  </div>`;
}
