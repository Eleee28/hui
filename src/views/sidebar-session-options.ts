/**
 * The sidebar's Filter & sort menu for the session list. It renders the choices and reports the normalized result;
 * the options themselves and how they are applied belong to the sidebar.
 */
import { html, nothing } from "lit";
import { live } from "lit/directives/live.js";
import { icons } from "../lib/icons.ts";
import { closeDropdownOnEscape, labelDropdown } from "../lib/web-awesome.ts";
import { normalizeSidebarSessionOptions, type SidebarSessionOptions } from "../lib/session/sidebar-sessions.ts";

export function renderSidebarSessionOptions(
  options: SidebarSessionOptions,
  onChange: (options: SidebarSessionOptions) => void,
) {
  function section<K extends keyof SidebarSessionOptions>(
    title: string, key: K, choices: readonly (readonly [SidebarSessionOptions[K], string])[],
  ) {
    return html`
      <div class="sidebar-session-sort-menu__label">${title}</div>
      ${choices.map(([value, label]) => html`
        <wa-dropdown-item class="session-menu__item sidebar-session-sort-menu__item"
          type="checkbox" .checked=${live(options[key] === value)} value=${`${key}:${value}`}>
          <span class="session-menu__text">${label}</span>
          <span slot="details" class="session-menu__check" aria-hidden="true">${options[key] === value ? icons.check : nothing}</span>
        </wa-dropdown-item>
      `)}
    `;
  }
  return html`
    <wa-dropdown class="session-menu sidebar-session-sort-menu" placement="bottom-start" distance="8"
      aria-label="Filter & sort" @wa-show=${labelDropdown} @keydown=${closeDropdownOnEscape}
      @wa-select=${(event: CustomEvent<{ item: { value: string } }>) => {
        const [key, value] = event.detail.item.value.split(":");
        // Only choices rendered by this menu can reach its callback.
        if (key && value) onChange(normalizeSidebarSessionOptions({ ...options, [key]: value }));
      }}>
      <button slot="trigger" type="button" aria-label="Filter & sort" title="Filter & sort"
        class=${options.status !== "all" || options.groupBy !== "custom" || options.sortBy !== "updated" || options.hideEmpty !== "filtering" ? "is-active" : ""}>
        ${icons.filter}
      </button>
      ${section("Group by", "groupBy", [["custom", "Custom groups"], ["project", "Project"], ["none", "None"]])}
      <div class="session-menu__separator" role="separator"></div>
      ${section("Sort by", "sortBy", [["created", "Created"], ["updated", "Last updated"], ["title", "Name"], ["stage", "Stage"]])}
      <div class="session-menu__separator" role="separator"></div>
      ${section("Status", "status", [["all", "All"], ["running", "Running"], ["starting", "Starting"], ["waiting", "Waiting"], ["idle", "Idle"], ["error", "Error"], ["reconnecting", "Reconnecting"], ["disconnected", "Disconnected"]])}
      <div class="session-menu__separator" role="separator"></div>
      ${section("Hide empty groups", "hideEmpty", [["filtering", "When filtering"], ["always", "Always"], ["never", "Never"]])}
    </wa-dropdown>
  `;
}
