/**
 * The search field on long settings lists (skills, plugins, tools). It hides its page's `[data-filter]` rows and the
 * sections they leave empty, and re-applies when rows arrive or change, so late loads and re-renders stay filtered.
 * The app's Cmd/Ctrl+F shortcut focuses it.
 */
import { LitElement, html } from "lit";

export function renderListFilter(label: string) {
  return html`<hui-list-filter class="settings-list-filter" role="search" .label=${label}></hui-list-filter>`;
}

/** Cmd+F on Apple platforms, Ctrl+F elsewhere, as the command palette's shortcut. */
export function isListFilterShortcut(
  event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "defaultPrevented" | "isComposing" | "key" | "metaKey" | "shiftKey">,
  isApplePlatform = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/u.test(navigator.platform),
): boolean {
  if (event.defaultPrevented || event.isComposing || event.altKey || event.shiftKey || event.key.toLocaleLowerCase() !== "f") return false;
  return isApplePlatform ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

export class HuiListFilter extends LitElement {
  static override properties = { label: { attribute: false } };
  declare label: string;
  #query = "";
  #empty = false;
  // Only row additions and changed row text: the `hidden` this sets is not observed, so applying cannot loop.
  #observer = new MutationObserver(() => this.#apply());

  constructor() { super(); this.label = "Search"; }
  override createRenderRoot() { return this; }
  override connectedCallback() {
    super.connectedCallback();
    const page = this.closest(".settings-page");
    if (page) this.#observer.observe(page, { childList: true, subtree: true, attributeFilter: ["data-filter"] });
  }
  override disconnectedCallback() { super.disconnectedCallback(); this.#observer.disconnect(); }

  #apply() {
    const page = this.closest(".settings-page");
    let visible = 0;
    for (const item of page?.querySelectorAll<HTMLElement>("[data-filter]") ?? []) {
      item.hidden = !item.dataset.filter?.toLocaleLowerCase().includes(this.#query);
      if (!item.hidden) visible += 1;
    }
    for (const section of page?.querySelectorAll<HTMLElement>(".settings-section:has([data-filter])") ?? []) {
      section.hidden = !section.querySelector("[data-filter]:not([hidden])");
    }
    const empty = this.#query !== "" && visible === 0;
    if (empty !== this.#empty) { this.#empty = empty; this.requestUpdate(); }
  }

  override render() {
    return html`<input class="settings-input settings-list-filter__input" type="search" autocomplete="off" spellcheck="false"
        aria-label=${this.label} placeholder=${`${this.label}…`}
        @input=${(event: Event) => { this.#query = (event.target as HTMLInputElement).value.trim().toLocaleLowerCase(); this.#apply(); }} />
      <p class="settings-row__muted settings-list-filter__empty" role="status">${this.#empty ? "No matches." : ""}</p>`;
  }
}

if (typeof customElements !== "undefined" && !customElements.get("hui-list-filter")) customElements.define("hui-list-filter", HuiListFilter);
