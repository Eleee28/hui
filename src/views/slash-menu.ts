/**
 * The composer's slash menu: HUI commands, plugin actions, skills and prompt templates, grouped by source, with
 * local paths after them. It renders options and their ids only; the composer owns the query, the active option and
 * loading the catalog.
 */
import { html, nothing } from "lit";
import type { ComposerCommand } from "../lib/composer/slash-commands.ts";
import { commandReference } from "../lib/composer/command-references.ts";
import type { LocalPathSuggestion } from "../lib/local-paths.ts";
import { icons } from "../lib/icons.ts";

export type SlashMenuProps = {
  id?: string;
  open: boolean;
  commands: readonly ComposerCommand[];
  catalog?: readonly ComposerCommand[];
  paths?: readonly LocalPathSuggestion[];
  pathsLoading?: boolean;
  pathsError?: string;
  onSelectPath?: (path: LocalPathSuggestion) => void;
  onRetryPaths?: () => void;
  activeIndex: number;
  loading: boolean;
  error: string;
  streaming: boolean;
  onSelect: (command: ComposerCommand) => void;
  onRetry: () => void;
  browseSession?: boolean;
};

export const SLASH_MENU_ID = "composer-slash-commands";
export const slashOptionId = (index: number, menuId = SLASH_MENU_ID) => `${menuId}-${index}`;
const labels = { hui: "HUI", extension: "Plugin actions", skill: "Skills", prompt: "Prompt templates" };

export function renderSlashMenu(props: SlashMenuProps) {
  if (!props.open) return nothing;
  const menuId = props.id ?? SLASH_MENU_ID;
  return html`
    <div class="slash-menu">
      <div class="slash-menu__scroll">
        ${props.loading ? html`<div class="slash-menu__status" role="status">Loading commands…</div>` : nothing}
        ${props.error ? html`<div class="slash-menu__status" role="alert">${props.error}
          <button type="button" class="btn btn--sm" @click=${props.onRetry}>Retry commands</button>
        </div>` : nothing}
        ${!props.browseSession && !props.loading && !props.error && !props.commands.length && !props.paths?.length && !props.pathsLoading ? html`<div class="slash-menu__status" role="status">No matching commands or paths.</div>` : nothing}
        <div id=${menuId} role="listbox" aria-label="Commands and paths" aria-busy=${String(props.loading || props.pathsLoading)}>
          ${(["hui", "extension", "skill", "prompt"] as const).map((source) => {
            const entries = props.commands.map((command, index) => ({ command, index })).filter((item) => item.command.source === source);
            if (!entries.length) return nothing;
            return html`<div class="slash-menu-group" role="group" aria-label=${labels[source]}>
              <div class="slash-menu-group__label" aria-hidden="true">${labels[source]}</div>
              ${entries.map(({ command, index }) => html`
                <button type="button" role="option" tabindex="-1" id=${slashOptionId(index, menuId)}
                  class="slash-menu-item ${index === props.activeIndex ? "slash-menu-item--active" : ""}"
                  aria-selected=${String(index === props.activeIndex)}
                  title=${command.description}
                  @pointerdown=${(event: PointerEvent) => event.preventDefault()}
                  @click=${() => props.onSelect(command)}>
                  <span class="slash-menu-icon" aria-hidden="true">${source === "extension" ? icons.terminal : source === "skill" ? icons.book : icons.fileText}</span>
                  <span class="slash-menu-copy"><span class="slash-menu-name">${commandReference(command, props.catalog ?? props.commands)}</span><span class="slash-menu-desc">${command.description}</span></span>
                </button>`)}
            </div>`;
          })}
          ${props.paths ? html`<div class="slash-menu-group" role="group" aria-label="Files and folders">
            <div class="slash-menu-group__label" aria-hidden="true">Files and folders</div>
            ${props.pathsLoading ? html`<div class="slash-menu__status" role="status">Loading local paths…</div>` : nothing}
            ${props.pathsError ? html`<div class="slash-menu__status" role="alert">${props.pathsError}<button type="button" class="btn btn--sm" @click=${props.onRetryPaths}>Retry paths</button></div>` : nothing}
            ${!props.pathsLoading && !props.pathsError && !props.paths.length ? html`<div class="slash-menu__status">No matching local paths.</div>` : nothing}
            ${props.paths.map((path, index) => {
              const optionIndex = props.commands.length + index;
              return html`<button type="button" role="option" tabindex="-1" id=${slashOptionId(optionIndex, menuId)}
                class="slash-menu-item ${optionIndex === props.activeIndex ? "slash-menu-item--active" : ""}"
                aria-selected=${String(optionIndex === props.activeIndex)}
                @pointerdown=${(event: PointerEvent) => event.preventDefault()}
                @click=${() => props.onSelectPath?.(path)}>
                <span class="slash-menu-icon" aria-hidden="true">${path.kind === "directory" ? icons.folder : icons.fileText}</span>
                <span class="slash-menu-copy"><span class="slash-menu-name">${path.path}</span><span class="slash-menu-desc">${path.kind}</span></span>
              </button>`;
            })}
          </div>` : nothing}
        </div>
        ${props.browseSession ? html`<div class="slash-menu__status">Start a session to load project skills, prompts and extension commands.</div>
          <button type="submit" value="commands" class="slash-menu-item"><span class="slash-menu-icon" aria-hidden="true">${icons.terminal}</span><span class="slash-menu-name">Start session & browse commands</span></button>` : nothing}
        ${props.streaming ? html`<div class="slash-menu__status">Skills and templates can be queued. Run extension commands after this turn.</div>` : nothing}
      </div>
    </div>`;
}
