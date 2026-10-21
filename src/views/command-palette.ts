/**
 * The Cmd/Ctrl+K palette: its shortcut, the search and ranking over pages, settings pages and chats, keyboard
 * movement and the dialog. It keeps no state; the open flag, query and active index belong to the app.
 */
import { html, nothing, type TemplateResult } from "lit";

import { icons } from "../lib/icons.ts";
import type { HuiPage } from "../lib/pages.ts";
import type { SessionGroup, SessionView } from "../api/sessions.ts";
import { SETTINGS_PAGES, type SettingsPage } from "./settings.ts";

export type CommandPaletteAction =
  | { kind: "page"; page: HuiPage }
  | { kind: "settings"; page: SettingsPage }
  | { kind: "session"; session: SessionView };

export type CommandPaletteItem = {
  id: string;
  label: string;
  description: string;
  category: "navigation" | "settings" | "chats";
  searchText: string;
  action: CommandPaletteAction;
};

export type CommandPaletteProps = {
  open: boolean;
  query: string;
  activeIndex: number;
  pages: readonly HuiPage[];
  groups: readonly SessionGroup[];
  onQuery: (query: string) => void;
  onActiveIndex: (index: number) => void;
  onSelect: (action: CommandPaletteAction) => void;
  onClose: () => void;
};

export function isCommandPaletteShortcut(
  event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "defaultPrevented" | "isComposing" | "key" | "metaKey">,
  isApplePlatform = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/u.test(navigator.platform),
): boolean {
  if (event.defaultPrevented || event.isComposing || event.altKey || event.key.toLocaleLowerCase() !== "k") return false;
  return isApplePlatform
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}

const DEFAULT_PAGE_IDS = ["new-session", "sessions", "cron", "plugins"] as const;
const CATEGORY_LABELS: Record<CommandPaletteItem["category"], string> = {
  navigation: "Navigation",
  settings: "Settings",
  chats: "Chats",
};

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function pageItem(page: HuiPage): CommandPaletteItem {
  return {
    id: `page:${page.id}`,
    label: page.label,
    description: page.summary,
    category: "navigation",
    searchText: `${page.id} ${page.area} ${page.summary}`,
    action: { kind: "page", page },
  };
}

function settingsItem(page: (typeof SETTINGS_PAGES)[number]): CommandPaletteItem {
  return {
    id: `settings:${page.id}`,
    label: page.label,
    description: page.group || "Settings",
    category: "settings",
    searchText: `${page.id} ${page.group}`,
    action: { kind: "settings", page: page.id },
  };
}

function sessionItems(groups: readonly SessionGroup[]): CommandPaletteItem[] {
  return groups.flatMap((group) => group.sessions.map((session) => ({
    id: `session:${session.id}`,
    label: session.title,
    description: `${group.label} · ${session.cwd}`,
    category: "chats" as const,
    searchText: `${session.id} ${group.label} ${session.cwd} ${session.tool}`,
    action: { kind: "session" as const, session },
  })));
}

function rank(item: CommandPaletteItem, query: string): number {
  const label = normalize(item.label);
  if (label === query) return 3;
  if (label.startsWith(query)) return 2;
  return `${label} ${normalize(item.description)} ${normalize(item.searchText)}`.includes(query) ? 1 : 0;
}

export function commandPaletteItems(
  pages: readonly HuiPage[],
  groups: readonly SessionGroup[],
  query: string,
): readonly CommandPaletteItem[] {
  const defaults = DEFAULT_PAGE_IDS.flatMap((id) => {
    const page = pages.find((candidate) => candidate.id === id);
    return page ? [pageItem(page)] : [];
  });
  const settings = SETTINGS_PAGES.map(settingsItem);
  const normalized = normalize(query);
  if (!normalized) {
    return [...defaults, { ...settings[0]!, label: "Settings", description: "Appearance and preferences" }];
  }
  const defaultIds = new Set(defaults.map((item) => item.id));
  return [
    ...sessionItems(groups),
    ...defaults,
    ...pages.map(pageItem).filter((item) => !defaultIds.has(item.id)),
    ...settings,
  ]
    .map((item) => ({ item, rank: rank(item, normalized) }))
    .filter((entry) => entry.rank > 0)
    .sort((left, right) => right.rank - left.rank || left.item.label.localeCompare(right.item.label))
    .slice(0, 30)
    .map((entry) => entry.item);
}

export function nextCommandPaletteIndex(
  current: number,
  length: number,
  key: "ArrowDown" | "ArrowUp",
): number {
  if (length === 0) return 0;
  return key === "ArrowDown"
    ? (current + 1) % length
    : (current - 1 + length) % length;
}

function itemIcon(item: CommandPaletteItem): TemplateResult {
  if (item.action.kind === "session") return html`${icons.fileText}`;
  if (item.action.kind === "settings") return html`${icons.settings}`;
  switch (item.action.page.id) {
    case "new-session": return html`${icons.plus}`;
    case "cron": return html`${icons.calendarClock}`;
    case "plugins": return html`${icons.plug}`;
    default: return html`${icons.fileText}`;
  }
}

export function renderCommandPalette(props: CommandPaletteProps): TemplateResult {
  if (!props.open) return html``;
  const matches = commandPaletteItems(props.pages, props.groups, props.query);
  const groups = (["chats", "navigation", "settings"] as const)
    .map((category) => ({ category, items: matches.filter((item) => item.category === category) }))
    .filter((group) => group.items.length > 0);
  // Keyboard navigation must follow the rendered category order, not the
  // pre-grouping relevance order (the upstream palette uses the same flatten).
  const items = groups.flatMap((group) => group.items);
  const activeIndex = items.length === 0 ? 0 : Math.min(props.activeIndex, items.length - 1);
  const select = (item: CommandPaletteItem) => props.onSelect(item.action);
  return html`<dialog
    class="command-palette-dialog"
    aria-labelledby="command-palette-label"
    @cancel=${(event: Event) => { event.preventDefault(); props.onClose(); }}
    @click=${(event: MouseEvent) => { if (event.target === event.currentTarget) props.onClose(); }}
  >
    <div
      class="cmd-palette"
      @keydown=${(event: KeyboardEvent) => {
        if (event.key === "Escape") {
          event.preventDefault();
          props.onClose();
          return;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          props.onActiveIndex(nextCommandPaletteIndex(activeIndex, items.length, event.key));
          requestAnimationFrame(() => document.querySelector(".cmd-palette__item--active")?.scrollIntoView({ block: "nearest" }));
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          const item = items[activeIndex];
          if (item) select(item);
        }
      }}
    >
      <label id="command-palette-label" class="cmd-palette__label" for="command-palette-input">Search or jump to…</label>
      <input
        autofocus
        id="command-palette-input"
        class="cmd-palette__input"
        role="combobox"
        aria-autocomplete="list"
        aria-controls="command-palette-listbox"
        aria-activedescendant=${items[activeIndex] ? `command-palette-option-${activeIndex}` : nothing}
        aria-expanded="true"
        placeholder="Search or jump to…"
        .value=${props.query}
        @input=${(event: InputEvent) => props.onQuery((event.currentTarget as HTMLInputElement).value)}
      />
      <div id="command-palette-listbox" class="cmd-palette__results" role="listbox">
        ${items.length === 0 ? html`<div class="cmd-palette__empty" role="status"><span class="nav-item__icon" style="opacity:0.3;width:20px;height:20px">${icons.search}</span><span>No results</span></div>` : groups.map((group) => html`
          <div class="cmd-palette__group-label">${CATEGORY_LABELS[group.category]}</div>
          ${group.items.map((item) => {
            const index = items.indexOf(item);
            const active = index === activeIndex;
            return html`<div
              id=${`command-palette-option-${index}`}
              class="cmd-palette__item ${active ? "cmd-palette__item--active" : ""}"
              role="option"
              aria-selected=${String(active)}
              @click=${() => select(item)}
              @mouseenter=${() => props.onActiveIndex(index)}
            >
              <span class="nav-item__icon">${itemIcon(item)}</span>
              <span>${item.label}</span>
              <span class="cmd-palette__item-desc">${item.description}</span>
            </div>`;
          })}
        `)}
      </div>
      <div class="cmd-palette__footer">
        <span><kbd>↑↓</kbd> Navigate</span>
        <span><kbd>↵</kbd> Select</span>
        <span><kbd>esc</kbd> Close</span>
      </div>
    </div>
  </dialog>`;
}
