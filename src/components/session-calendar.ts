/**
 * The session calendar element. It reads session activity for the shown period from the gateway and keeps only
 * presentation state: the period, the grouping (remembered in localStorage), the open block and the highlight.
 */
import { LitElement, html, nothing } from "lit";

import { icons } from "../lib/icons.ts";
import { addDays, calendarPeriod, dayStart, formatDuration, localHour, MIN_DRAWN_MS, weekStart, type CalendarBlock, type CalendarGrouping, type CalendarUnit, type CalendarPeriod } from "../lib/session/calendar.ts";
import { loadSessionActivity } from "../api/session-calendar.ts";
import type { SessionActivity } from "../api/schema/github.ts";
import { loadViewAssets } from "../lib/view-assets.ts";

loadViewAssets(() => import("../styles/session-calendar.css"));

const HOUR_PX = 40;
const POPOVER_PX = 340;
const GROUPINGS: readonly [CalendarGrouping, string, string, string][] = [
  ["project", "Project", "project", "projects"],
  ["group", "Group", "group", "groups"],
  ["session", "Session", "session", "sessions"],
];
const PREFERENCES_KEY = "hui.calendar";

function readGrouping(): CalendarGrouping {
  try {
    const saved = (JSON.parse(localStorage.getItem(PREFERENCES_KEY) ?? "null") as { groupBy?: unknown } | null)?.groupBy;
    return GROUPINGS.find(([value]) => value === saved)?.[0] ?? "project";
  } catch {
    return "project";
  }
}
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const hourLabel = (hour: number) => new Date(2000, 0, 1, hour % 24).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
/** Whether `now` falls in the day that starts at `day` (5 AM). */
const holds = (day: Date, now: Date) => now >= day && now < addDays(day, 1);
const modelName = (model: string | undefined) => model?.slice(model.lastIndexOf("/") + 1);

function periodTitle(start: Date, today: Date, length: 1 | 7): string {
  const end = addDays(start, length - 1);
  const year = end.getFullYear() === today.getFullYear() ? {} : { year: "numeric" as const };
  const format = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", ...(length === 1 ? { weekday: "short" as const } : {}), ...year });
  return length === 1 ? format.format(start) : format.formatRange(start, end);
}

/** A day or week of HUI sessions: when work happened, laid out by hour as
 * blocks of one project, group or session each, with the time each took and
 * parallel work counted once. */
export class HuiSessionCalendar extends LitElement {
  onOpenSession?: (id: string) => void;
  #start = weekStart(new Date());
  #length: 1 | 7 = 7;
  #shown?: { start: Date; length: 1 | 7; activity: SessionActivity; period: CalendarPeriod };
  #grouping = readGrouping();
  #loading = false;
  #error = "";
  #request = 0;
  /** The clicked block, with the card position its popover takes. */
  #open?: { block: CalendarBlock; left?: number; top?: number; bottom?: number; returnFocus: HTMLElement };
  /** Unit highlighted from the side list: pinned by a click, or hovered. */
  #pinned?: string;
  #hovered?: string;
  #scrollToToday = false;

  override createRenderRoot() { return this; }

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener("pointerdown", this.#outside);
    void this.#load();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener("pointerdown", this.#outside);
    this.#request++;
  }

  override updated() {
    if (!this.#scrollToToday) return;
    this.#scrollToToday = false;
    // A narrow screen scrolls the days; start at today, beside the hour labels.
    const today = this.querySelector<HTMLElement>(".session-calendar__day--today");
    const hours = this.querySelector<HTMLElement>(".session-calendar__hours");
    const scroll = this.querySelector<HTMLElement>(".session-calendar__scroll");
    if (!scroll) return;
    scroll.scrollLeft = 0;
    if (today && hours) scroll.scrollLeft = today.getBoundingClientRect().left - hours.getBoundingClientRect().right;
  }

  #outside = (event: PointerEvent) => {
    if (this.#open && !(event.target as Element).closest?.(".session-calendar__popover, .session-calendar__block")) this.#close(false);
  };

  async #load(returnFocus?: HTMLElement | null) {
    const request = ++this.#request;
    const start = this.#start;
    const length = this.#length;
    this.#loading = true;
    this.#error = "";
    this.requestUpdate();
    try {
      const activity = await loadSessionActivity(start, addDays(start, length));
      if (request !== this.#request) return;
      this.#show(start, length, activity);
      this.#scrollToToday = true;
    } catch (error) {
      if (request !== this.#request) return;
      this.#error = error instanceof Error ? error.message : "Session activity could not be loaded.";
      if (this.#shown) { this.#start = this.#shown.start; this.#length = this.#shown.length; }
    } finally {
      if (request === this.#request) { this.#loading = false; this.requestUpdate(); }
    }
    if (returnFocus !== undefined) {
      await this.updateComplete;
      if (request !== this.#request) return;
      const target = returnFocus?.isConnected && !returnFocus.matches(":disabled")
        ? returnFocus : this.querySelector<HTMLElement>(".session-calendar__title");
      target?.focus({ preventScroll: true });
    }
  }

  #show(start: Date, length: 1 | 7, activity: SessionActivity) {
    const period = calendarPeriod(activity, start, this.#grouping, length);
    this.#shown = { start, length, activity, period };
    this.#open = undefined;
    // A re-render removes rows without a pointerleave; a pinned unit may have no time in this period.
    this.#hovered = undefined;
    if (!period.units.some(({ key }) => key === this.#pinned)) this.#pinned = undefined;
  }

  #group(grouping: CalendarGrouping) {
    if (grouping === this.#grouping) return;
    this.#grouping = grouping;
    try { localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ groupBy: grouping })); } catch { /* Keep the in-memory choice. */ }
    this.#pinned = undefined;
    if (this.#shown) this.#show(this.#shown.start, this.#shown.length, this.#shown.activity);
    this.requestUpdate();
  }

  #go(start: Date, length: 1 | 7) {
    const active = this.ownerDocument.activeElement;
    const returnFocus = active instanceof HTMLElement && this.contains(active) ? active : null;
    this.#start = start;
    this.#length = length;
    this.#close(false);
    void this.#load(returnFocus);
  }

  #select(block: CalendarBlock, event: Event) {
    const target = event.currentTarget as HTMLElement;
    if (this.#open?.block === block) { this.#close(true); return; }
    const card = this.querySelector<HTMLElement>(".session-calendar__grid-card")!.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    const lower = rect.top + rect.height / 2 > card.top + card.height / 2;
    if (card.width < 2 * POPOVER_PX) {
      // No room beside it: the card's width, under the block, or above it in the lower half.
      this.#open = { block, returnFocus: target, ...(lower ? { bottom: card.bottom - rect.top + 8 } : { top: rect.bottom - card.top + 8 }) };
    } else {
      // Beside the block, on whichever side has room; level with it, or rising from its bottom in the lower half.
      const right = rect.right + 8 - card.left;
      const left = right + POPOVER_PX <= card.width ? right : Math.max(8, rect.left - 8 - POPOVER_PX - card.left);
      this.#open = { block, left, returnFocus: target, ...(lower ? { bottom: Math.max(8, card.bottom - rect.bottom) } : { top: Math.max(8, rect.top - card.top) }) };
    }
    this.requestUpdate();
    void this.updateComplete.then(() => this.querySelector<HTMLElement>(".session-calendar__popover")?.focus());
  }

  #close(restoreFocus: boolean) {
    const open = this.#open;
    if (!open) return;
    this.#open = undefined;
    this.requestUpdate();
    if (restoreFocus && open.returnFocus.isConnected) open.returnFocus.focus();
  }

  #highlight(): string | undefined { return this.#hovered ?? this.#pinned; }

  #focus(key?: string) {
    this.#pinned = key;
    this.#hovered = undefined;
    this.#close(false);
    this.requestUpdate();
  }

  #renderBlock(entry: CalendarBlock, day: Date, first: number) {
    const top = (localHour(entry.start, day) - first) * HOUR_PX;
    const bottom = (localHour(Math.max(entry.end, entry.start + MIN_DRAWN_MS), day) - first) * HOUR_PX;
    const height = Math.max(bottom - top, 14);
    const showTime = height >= 46;
    // Title lines that fit above the time: 15px lines inside 10px of padding.
    const lines = Math.max(1, Math.floor((height - 12 - (showTime ? 17 : 0)) / 15));
    const duration = formatDuration(entry.ms);
    const sessions = entry.sessions.length;
    const detail = sessions > 1 ? `${duration} · ${plural(sessions, "session", "sessions")}` : duration;
    const highlight = this.#highlight();
    const classes = [
      "session-calendar__block",
      this.#pinned === undefined && highlight !== undefined && highlight !== entry.unit.key ? "session-calendar__block--dim" : "",
      this.#open?.block === entry ? "session-calendar__block--open" : "",
      height < 30 ? "session-calendar__block--short" : "",
    ].join(" ");
    const left = this.#pinned !== undefined ? 0 : (entry.lane / entry.lanes) * 100;
    const width = this.#pinned !== undefined ? 100 : (entry.span / entry.lanes) * 100;
    return html`<button type="button" class=${classes} data-color=${entry.unit.color}
      style="top:${top}px;height:${height - 2}px;left:calc(${left}% + 2px);width:calc(${width}% - 4px);--lines:${lines}"
      aria-label=${`${entry.unit.label}, ${time(entry.start)} – ${time(entry.end)}, ${duration} of activity${sessions > 1 ? `, ${plural(sessions, "session", "sessions")}` : ""}`}
      aria-expanded=${String(this.#open?.block === entry)}
      @click=${(event: Event) => this.#select(entry, event)}>
      <span class="session-calendar__block-title">${entry.unit.label}</span>
      ${showTime ? html`<span class="session-calendar__block-time">${detail}</span>` : nothing}
    </button>`;
  }

  #renderGrid(period: CalendarPeriod, now: Date) {
    const [first, last] = period.hours;
    const hours = Array.from({ length: last - first + 1 }, (_, index) => first + index);
    const dayView = period.days.length === 1;
    return html`<div class="session-calendar__scroll">
      <div class="session-calendar__grid ${dayView ? "session-calendar__grid--day" : ""}" style="--hours:${last - first};--hour-px:${HOUR_PX}px">
        <div class="session-calendar__corner"></div>
        ${period.days.map(({ date }) => {
          const classes = `session-calendar__day-head ${holds(date, now) ? "session-calendar__day-head--today" : ""}`;
          const label = html`${date.toLocaleDateString(undefined, { weekday: "short" })} <span class="session-calendar__day-number">${date.getDate()}</span>`;
          return dayView ? html`<div class=${classes}>${label}</div>` : html`<button type="button" class=${classes}
            aria-label=${`View ${date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}`}
            title="View day" ?disabled=${this.#loading || date > dayStart(now)} @click=${() => this.#go(date, 1)}>${label}</button>`;
        })}
        <div class="session-calendar__hours" aria-hidden="true">
          ${hours.filter((hour) => hour % 3 === 0).map((hour) => html`<span class="session-calendar__hour" style="grid-row:${hour - first + 1}">${hourLabel(hour)}</span>`)}
        </div>
        ${period.days.map(({ date, blocks }) => {
          const today = holds(date, now);
          const hour = localHour(now.valueOf(), date);
          return html`<div class="session-calendar__day ${today ? "session-calendar__day--today" : ""}"
            role="group" aria-label=${date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}>
            ${blocks.filter((block) => this.#pinned === undefined || block.unit.key === this.#pinned).map((block) => this.#renderBlock(block, date, first))}
            ${today && hour >= first && hour <= last
              ? html`<div class="session-calendar__now" style="top:${(hour - first) * HOUR_PX}px" aria-hidden="true"></div>` : nothing}
          </div>`;
        })}
      </div>
    </div>
    ${period.units.length === 0 ? html`<div class="session-calendar__empty">No HUI session activity this ${dayView ? "day" : "week"}.</div>` : nothing}`;
  }

  #renderPopover() {
    const open = this.#open;
    if (!open) return nothing;
    const { unit, start, end, ms, sessions } = open.block;
    const place = `${open.left === undefined ? "" : `left:${open.left}px;`}${open.top === undefined ? `bottom:${open.bottom}px` : `top:${open.top}px`}`;
    const single = this.#grouping === "session" ? sessions[0] : undefined;
    return html`<div class="session-calendar__popover ${open.left === undefined ? "session-calendar__popover--full" : ""}" role="dialog" aria-labelledby="session-calendar-popover-title" tabindex="-1" style=${place}
      @keydown=${(event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); this.#close(true); } }}>
      <h3 class="session-calendar__popover-title" id="session-calendar-popover-title">${unit.label}</h3>
      <div class="session-calendar__popover-when">
        ${new Date(start).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
        · ${time(start)} – ${time(end)} · ${formatDuration(ms)} of activity
      </div>
      ${single ? html`
        <div class="session-calendar__popover-meta">
          <span class="session-calendar__chip"><span class="session-calendar__dot" data-color=${unit.color}></span>${single.session.project}</span>
          <span>${single.session.group || "Other"}</span>
          ${single.model ? html`<span>${modelName(single.model)}</span>` : nothing}
        </div>
        ${single.first ? html`<div class="session-calendar__popover-label">First message</div>
          <p class="session-calendar__popover-quote">“${single.first}”</p>` : nothing}` : html`
        <div class="session-calendar__popover-label">${plural(sessions.length, "session", "sessions")}</div>
        <ul class="session-calendar__popover-sessions" aria-label="Sessions in this block">
          ${sessions.map(({ session, ms, first }) => html`<li>
            <button type="button" class="session-calendar__popover-session" title=${`Open ${session.title}`} @click=${() => this.onOpenSession?.(session.id)}>
              <span class="session-calendar__session-title">${session.title}</span>
              <span class="session-calendar__session-time">${formatDuration(ms)}</span>
              ${first ? html`<span class="session-calendar__popover-first">${first}</span>` : nothing}
            </button>
          </li>`)}
        </ul>`}
      <div class="session-calendar__popover-foot">
        <span><strong>${formatDuration(unit.ms)}</strong> this ${this.#shown?.length === 1 ? "day" : "week"}</span>
        ${single && this.onOpenSession ? html`<button type="button" class="btn btn--sm" @click=${() => this.onOpenSession?.(single.session.id)}>Open session</button>` : nothing}
      </div>
    </div>`;
  }

  #nouns(): [string, string] {
    const [, , one, many] = GROUPINGS.find(([value]) => value === this.#grouping)!;
    return [one, many];
  }

  /** A side-list row; pinning a project or group also lists its sessions. */
  #renderUnit(unit: CalendarUnit, highlight: string | undefined) {
    const pinned = this.#pinned === unit.key;
    return html`<li>
      <button type="button" class="session-calendar__session ${highlight === unit.key ? "session-calendar__session--active" : ""}"
        aria-pressed=${String(pinned)} aria-expanded=${this.#grouping === "session" ? nothing : String(pinned)}
        @click=${() => this.#focus(pinned ? undefined : unit.key)}
        @pointerenter=${() => { this.#hovered = unit.key; this.requestUpdate(); }}
        @pointerleave=${() => { this.#hovered = undefined; this.requestUpdate(); }}>
        <span class="session-calendar__dot" data-color=${unit.color}></span>
        <span class="session-calendar__session-title">${unit.label}</span>
        <span class="session-calendar__session-time">${formatDuration(unit.ms)}</span>
      </button>
      ${pinned && this.#grouping !== "session" ? html`<ul class="session-calendar__members" aria-label=${`Sessions in ${unit.label}`}>
        ${unit.sessions.map(({ session, ms }) => html`<li>
          <button type="button" class="session-calendar__member" title=${`Open ${session.title}`} @click=${() => this.onOpenSession?.(session.id)}>
            <span class="session-calendar__session-title">${session.title}</span>
            <span class="session-calendar__session-time">${formatDuration(ms)}</span>
          </button>
        </li>`)}
      </ul>` : nothing}
    </li>`;
  }

  #renderSide(period: CalendarPeriod, now: Date) {
    const highlight = this.#highlight();
    const dayMax = Math.max(1, ...period.days.map((day) => day.activeMs));
    const busiest = period.days.reduce((best, day) => day.activeMs > best.activeMs ? day : best, period.days[0]!);
    // "<1m" means a one-message stretch; a period without any is plainly zero.
    const total = (ms: number) => period.units.length ? formatDuration(ms) : "0m";
    return html`<aside class="session-calendar__side">
      <section class="session-calendar__panel">
        <h2 class="session-calendar__total"><strong>${total(period.activeMs)}</strong>
          ${`across ${plural(period.units.length, ...this.#nouns())}`}</h2>
        <div class="session-calendar__stack" aria-hidden="true">
          ${period.units.map(({ key, color, ms }) => html`<span data-color=${color}
            class=${highlight !== undefined && highlight !== key ? "session-calendar__stack--dim" : ""}
            style="flex-grow:${ms}"></span>`)}
        </div>
        <p class="session-calendar__caption">Recorded activity, parallel time counted once · ${total(period.sessionMs)} of session time</p>
        ${period.units.length ? html`<p class="session-calendar__caption">Select a ${this.#nouns()[0]} to focus the calendar.</p>` : nothing}
        <ul class="session-calendar__sessions" aria-label=${`Time per ${this.#nouns()[0]}`}>
          ${period.units.map((unit) => this.#renderUnit(unit, highlight))}
        </ul>
      </section>
      ${period.days.length === 7 ? html`<section class="session-calendar__panel">
        <h2 class="session-calendar__panel-title">Hours per day</h2>
        <div class="session-calendar__days" role="list">
          ${period.days.map((day) => html`<div class="session-calendar__bar ${holds(day.date, now) ? "session-calendar__bar--today" : ""}" role="listitem"
            aria-label=${`${day.date.toLocaleDateString(undefined, { weekday: "long" })}: ${day.blocks.length ? formatDuration(day.activeMs) : "none"}`}
            title=${day.blocks.length ? formatDuration(day.activeMs) : "None"}>
            <span class="session-calendar__bar-track">
              <span class="session-calendar__bar-fill ${day === busiest && day.activeMs > 0 ? "session-calendar__bar-fill--max" : ""}" style="height:${Math.max(2, (day.activeMs / dayMax) * 100)}%">
                ${day === busiest && day.activeMs > 0 ? html`<span class="session-calendar__bar-value">${formatDuration(day.activeMs)}</span>` : nothing}
              </span>
            </span>
            <span class="session-calendar__bar-label">${day.date.toLocaleDateString(undefined, { weekday: "narrow" })}</span>
          </div>`)}
        </div>
      </section>` : nothing}
    </aside>`;
  }

  override render() {
    const today = new Date();
    const shown = this.#shown;
    const length = shown?.length ?? this.#length;
    const start = shown?.start ?? this.#start;
    const dayView = length === 1;
    const current = dayView ? dayStart(today) : weekStart(today);
    const unit = dayView ? "day" : "week";
    const nav = html`<div class="session-calendar__nav">
      ${dayView ? html`<button type="button" class="btn btn--sm" ?disabled=${this.#loading} @click=${() => this.#go(weekStart(start), 7)}>Back to week</button>` : nothing}
      <button type="button" class="btn btn--icon session-calendar__prev" aria-label=${`Previous ${unit}`} title=${`Previous ${unit}`} ?disabled=${this.#loading}
        @click=${() => this.#go(addDays(start, -length), length)}>${icons.chevron}</button>
      <button type="button" class="btn btn--sm" ?disabled=${this.#loading || start.valueOf() === current.valueOf()} @click=${() => this.#go(current, length)}>${dayView ? "Today" : "This week"}</button>
      <button type="button" class="btn btn--icon" aria-label=${`Next ${unit}`} title=${`Next ${unit}`} ?disabled=${this.#loading || start >= current}
        @click=${() => this.#go(addDays(start, length), length)}>${icons.chevron}</button>
      <button type="button" class="btn btn--icon" aria-label="Refresh" title="Refresh" ?disabled=${this.#loading} @click=${() => void this.#load()}>${icons.refresh}</button>
    </div>`;
    if (!shown) {
      return html`<div class="session-calendar__toolbar"><h2 class="session-calendar__title" tabindex="-1">${periodTitle(start, today, length)}</h2>${nav}</div>
        ${this.#error
          ? html`<div class="callout danger" role="alert">${this.#error} <button type="button" class="btn btn--sm" @click=${() => void this.#load()}>Retry</button></div>`
          : html`<div class="observability-feedback" role="status">Reading session activity…</div>`}`;
    }
    const period = shown.period;
    const blocks = period.days.reduce((sum, day) => sum + day.blocks.length, 0);
    return html`
      <div class="session-calendar__toolbar">
        <h2 class="session-calendar__title" tabindex="-1">${periodTitle(start, today, length)}</h2>
        <div class="session-calendar__summary">
          <span><strong>${period.sessions}</strong> ${period.sessions === 1 ? "session" : "sessions"}</span>
          <span><strong>${blocks}</strong> ${blocks === 1 ? "block" : "blocks"}</span>
          ${period.peak > 1 ? html`<span>up to <strong>${period.peak}</strong> at once</span>` : nothing}
        </div>
        <div class="settings-segmented session-calendar__grouping" role="group" aria-label="Group by">
          ${GROUPINGS.map(([value, label]) => html`<button type="button" class="settings-segmented__btn ${this.#grouping === value ? "settings-segmented__btn--active" : ""}"
            aria-pressed=${String(this.#grouping === value)} @click=${() => this.#group(value)}>${label}</button>`)}
        </div>
        ${nav}
      </div>
      ${this.#error ? html`<div class="callout warning" role="alert">${this.#error}</div>` : nothing}
      ${this.#pinned !== undefined ? html`<div class="session-calendar__focus" role="status">
        Showing ${period.units.find(({ key }) => key === this.#pinned)?.label}
        <button class="btn btn--sm" type="button" @click=${() => this.#focus()}>Show all</button>
      </div>` : nothing}
      <div class="session-calendar__layout" aria-busy=${String(this.#loading)}>
        <div class="session-calendar__grid-card">
          ${this.#renderGrid(period, today)}
          ${this.#renderPopover()}
        </div>
        ${this.#renderSide(period, today)}
      </div>`;
  }
}

if (typeof customElements !== "undefined" && !customElements.get("hui-session-calendar")) customElements.define("hui-session-calendar", HuiSessionCalendar);
