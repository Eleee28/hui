/**
 * The Contributions page element. It charts the GitHub activity the gateway reads through `gh` and hosts the session
 * calendar as its second tab; only the chosen metric, account and view persist, in localStorage.
 */
import { LitElement, html, nothing, svg } from "lit";

import type { GitHubContributions } from "../api/schema/github.ts";
import { contributionLevels, contributionRange, contributionWeeks, contributionYears, metricLabel, type ContributionMetric, type ContributionWeek } from "../lib/github-contributions.ts";
import { loadGitHubContributions } from "../api/github-contributions.ts";
import { icons } from "../lib/icons.ts";
import { renderPicker } from "../views/settings-picker.ts";
import "./session-calendar.ts";
import { loadViewAssets } from "../lib/view-assets.ts";

loadViewAssets(() => import("../styles/contributions.css"));

const ALL = "all";
const CELL = 10;
const STEP = 13;
const LEFT = 30;
const TOP = 16;
const BAR_HEIGHT = 96;
const METRICS: readonly [ContributionMetric, string][] = [["commits", "Commits"], ["pullRequests", "Pull requests"]];
type ContributionsView = "github" | "calendar";
const VIEWS: readonly [ContributionsView, string][] = [["github", "GitHub"], ["calendar", "Calendar"]];
const PREFERENCES_KEY = "hui.contributions";

function readPreferences(): { metric: ContributionMetric; account: string; view: ContributionsView } {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFERENCES_KEY) ?? "null") as { metric?: unknown; account?: unknown; view?: unknown } | null;
    return {
      metric: saved?.metric === "pullRequests" ? "pullRequests" : "commits",
      account: typeof saved?.account === "string" ? saved.account : ALL,
      view: saved?.view === "calendar" ? "calendar" : "github",
    };
  } catch {
    return { metric: "commits", account: ALL, view: "github" };
  }
}

const longDate = (date: Date) => date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
const shortDate = (date: Date) => date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
const chartWidth = (weeks: readonly ContributionWeek[]) => LEFT + weeks.length * STEP;

/** Month labels above (or below) the week columns that hold a month's first day. */
function monthLabels(weeks: readonly ContributionWeek[], y: number) {
  return weeks.map((week, index) => {
    const first = week.days.find((day) => day.date.getDate() === 1);
    return first ? svg`<text class="contributions-axis" x=${LEFT + index * STEP} y=${y}>${first.date.toLocaleDateString(undefined, { month: "short" })}</text>` : nothing;
  });
}

function renderCalendar(weeks: readonly ContributionWeek[], metric: ContributionMetric, label: string, today: Date) {
  const level = contributionLevels(weeks.flatMap((week) => week.days.map((day) => day.count)));
  return html`<div class="contributions-scroll">
      <svg class="contributions-chart" viewBox="0 0 ${chartWidth(weeks)} ${TOP + 7 * STEP}" role="img" aria-label=${label} data-contributions-calendar>
        ${monthLabels(weeks, 10)}
        ${(["Mon", "Wed", "Fri"] as const).map((text, index) => svg`<text class="contributions-axis" x="0" y=${TOP + (2 * index + 1) * STEP + CELL - 1}>${text}</text>`)}
        ${weeks.map((week, column) => week.days.filter((day) => day.date <= today).map((day) => svg`<rect class="contributions-cell" data-level=${level(day.count)}
            x=${LEFT + column * STEP} y=${TOP + day.date.getDay() * STEP} width=${CELL} height=${CELL} rx="2" data-tip=${`${metricLabel(metric, day.count)} on ${longDate(day.date)}`}></rect>`))}
      </svg>
    </div>
    <div class="contributions-legend" aria-hidden="true">Less ${[0, 1, 2, 3, 4].map((value) => html`<span class="contributions-legend__cell" data-level=${value}></span>`)} More</div>`;
}

function renderWeekly(weeks: readonly ContributionWeek[], metric: ContributionMetric, label: string, today: Date) {
  const width = chartWidth(weeks);
  const max = Math.max(1, ...weeks.map((week) => week.total));
  return html`<div class="contributions-scroll">
    <svg class="contributions-chart" viewBox="0 0 ${width} ${BAR_HEIGHT + 22}" role="img" aria-label=${label} data-contributions-weekly>
      <text class="contributions-axis" x="0" y="9">${max}</text>
      <text class="contributions-axis" x="0" y=${BAR_HEIGHT}>0</text>
      <line class="contributions-baseline" x1=${LEFT} x2=${width} y1=${BAR_HEIGHT + 0.5} y2=${BAR_HEIGHT + 0.5}></line>
      ${weeks.map((week, column) => {
        const start = week.days[0]!.date;
        if (start > today) return nothing;
        const height = (week.total / max) * (BAR_HEIGHT - 4);
        // The full-height hit area keeps short and empty weeks hoverable.
        return svg`<g class="contributions-week" data-tip=${`${metricLabel(metric, week.total)} · week of ${shortDate(start)}`}>
          <rect class="contributions-week__hit" x=${LEFT + column * STEP - 1} y="0" width=${STEP} height=${BAR_HEIGHT}></rect>
          <rect class="contributions-bar" x=${LEFT + column * STEP} y=${BAR_HEIGHT - height} width=${CELL} height=${height} rx="2"></rect></g>`;
      })}
      ${monthLabels(weeks, BAR_HEIGHT + 16)}
    </svg>
  </div>`;
}

/** Contributions page. The GitHub tab charts the commits or pull requests of
 * the `gh` accounts the gateway is signed in to, as a GitHub-style calendar and
 * a per-week bar chart, over the last year or one calendar year. The Calendar
 * tab lays out a week of HUI sessions. */
export class HuiContributionsPage extends LitElement {
  onOpenSettings?: () => void;
  onOpenSession?: (id: string) => void;
  /** The loaded range; `year` stays on the previous one until the next arrives. */
  #shown?: { year?: number; data: GitHubContributions };
  #loading = false;
  #error = "";
  /** Saved in localStorage; an account no longer signed in shows all without forgetting it. */
  #account: string;
  #metric: ContributionMetric;
  #view: ContributionsView;
  /** The hovered day or week, positioned inside its chart card. */
  #tip?: { card: string; text: string; x: number; y: number; end: boolean };
  /** Selected calendar year; undefined is the last year. */
  #year?: number;
  #request = 0;
  #scrollToLatest = false;

  constructor() {
    super();
    ({ metric: this.#metric, account: this.#account, view: this.#view } = readPreferences());
  }

  override createRenderRoot() { return this; }
  override connectedCallback() { super.connectedCallback(); if (this.#view === "github") void this.#load(); }
  override disconnectedCallback() { super.disconnectedCallback(); this.#request++; }

  override updated() {
    // Narrow screens scroll the charts; start at the most recent weeks, like GitHub.
    const charts = this.querySelectorAll(".contributions-scroll");
    if (!this.#scrollToLatest || charts.length === 0) return;
    this.#scrollToLatest = false;
    charts.forEach((element) => { element.scrollLeft = element.scrollWidth; });
  }

  async #load(refresh = false) {
    const request = ++this.#request;
    const year = this.#year;
    this.#loading = true;
    this.#error = "";
    this.requestUpdate();
    try {
      const data = await loadGitHubContributions(year, refresh);
      if (request !== this.#request) return;
      this.#shown = { year, data };
      this.#scrollToLatest = true;
    } catch (error) {
      if (request !== this.#request) return;
      this.#error = error instanceof Error ? error.message : "GitHub activity could not be loaded.";
      // The year list must keep matching the charts still on screen.
      if (this.#shown) this.#year = this.#shown.year;
    } finally {
      if (request === this.#request) { this.#loading = false; this.requestUpdate(); }
    }
  }

  #selectYear(year: number | undefined) {
    if (year === this.#year) return;
    this.#year = year;
    void this.#load();
  }

  #selectedAccount() {
    return this.#shown?.data.accounts.some((account) => account.login === this.#account) ? this.#account : ALL;
  }

  #accounts() {
    const selected = this.#selectedAccount();
    return (this.#shown?.data.accounts ?? []).filter((account) => selected === ALL || account.login === selected);
  }

  #savePreferences(change: { metric?: ContributionMetric; account?: string; view?: ContributionsView }) {
    this.#metric = change.metric ?? this.#metric;
    this.#account = change.account ?? this.#account;
    this.#view = change.view ?? this.#view;
    try { localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ metric: this.#metric, account: this.#account, view: this.#view })); } catch { /* Keep the in-memory choice. */ }
    // GitHub is read the first time its tab is shown.
    if (this.#view === "github" && !this.#shown && !this.#loading && !this.#error) void this.#load();
    this.requestUpdate();
  }

  #hover(event: PointerEvent) {
    const card = event.currentTarget as HTMLElement;
    const target = (event.target as Element).closest("[data-tip]");
    const text = target?.getAttribute("data-tip");
    if (!target || !text) { this.#leave(); return; }
    const box = card.getBoundingClientRect();
    // A week points at its bar, not the full-height hover area around it.
    const rect = (target.querySelector(".contributions-bar") ?? target).getBoundingClientRect();
    const x = rect.left + rect.width / 2 - box.left;
    // Past the middle the tip grows leftwards so it never leaves the card.
    this.#tip = { card: card.dataset.card ?? "", text, x, y: rect.top - box.top, end: x > box.width / 2 };
    this.requestUpdate();
  }

  #leave() {
    if (!this.#tip) return;
    this.#tip = undefined;
    this.requestUpdate();
  }

  #section(title: string, description: string, chart: unknown) {
    return html`<section class="settings-section">
      <div class="settings-section__header">
        <div class="settings-section__copy">
          <h2 class="settings-section__heading">${title}</h2>
          <p class="settings-section__desc">${description}</p>
        </div>
      </div>
      <div class="settings-group contributions-card" data-card=${title} @pointerover=${(event: PointerEvent) => this.#hover(event)} @pointerleave=${() => this.#leave()}>
        ${chart}
        ${this.#tip?.card === title
          ? html`<div class="contributions-tip ${this.#tip.end ? "contributions-tip--end" : ""}" role="tooltip" style="left:${this.#tip.x}px;top:${this.#tip.y}px">${this.#tip.text}</div>`
          : nothing}
      </div>
    </section>`;
  }

  #years() {
    const option = (year: number | undefined, label: string) => html`<button type="button"
      class="contributions-years__item ${this.#year === year ? "contributions-years__item--active" : ""}"
      aria-pressed=${String(this.#year === year)} @click=${() => this.#selectYear(year)}>${label}</button>`;
    return html`<nav class="contributions-years" aria-label="Year">
      ${option(undefined, "Last 12 months")}
      ${contributionYears(this.#accounts().map((account) => account.createdAt)).map((year) => option(year, String(year)))}
    </nav>`;
  }

  #body() {
    const shown = this.#shown;
    if (!shown) {
      return this.#error
        ? html`<div class="callout danger" role="alert">${this.#error} <button type="button" class="btn btn--sm" @click=${() => void this.#load(true)}>Retry</button></div>`
        : html`<div class="observability-feedback" role="status">Reading GitHub activity… The first load can take a few seconds.</div>`;
    }
    if (shown.data.accounts.length === 0) {
      return html`<div class="settings-empty">No GitHub account is signed in to <code>gh</code> on the HUI machine.
        <button type="button" class="btn btn--sm" @click=${() => this.onOpenSettings?.()}>Connect GitHub</button></div>`;
    }
    const today = new Date();
    const metric = this.#metric;
    const accounts = this.#accounts();
    const weeks = contributionWeeks(accounts.flatMap((account) => account[metric]), contributionRange(shown.year, today));
    const total = weeks.reduce((sum, week) => sum + week.total, 0);
    const elapsed = weeks.filter((week) => week.days[0]!.date <= today).length;
    const period = shown.year === undefined ? "in the last year" : `in ${shown.year}`;
    return html`
      ${this.#error ? html`<div class="callout warning" role="alert">${this.#error}</div>` : nothing}
      ${accounts.filter((account) => account.error).map((account) => html`<div class="callout warning" role="alert"><strong>${account.login}</strong>: ${account.error}</div>`)}
      <div class="contributions-layout">
        <div class="contributions-charts" aria-busy=${String(this.#loading)}>
          ${this.#section(
            `${metricLabel(metric, total)} ${period}`,
            metric === "commits" ? "Commits authored on default branches, by day." : "Pull requests opened, by day.",
            renderCalendar(weeks, metric, `${metricLabel(metric, total)} ${period}`, today),
          )}
          ${this.#section(
            `${metric === "commits" ? "Commits" : "Pull requests"} per week`,
            `${(total / Math.max(1, elapsed)).toFixed(1)} a week on average ${period}.`,
            renderWeekly(weeks, metric, `${metricLabel(metric, total)} per week ${period}`, today),
          )}
        </div>
        ${this.#years()}
      </div>`;
  }

  override render() {
    const accounts = this.#shown?.data.accounts ?? [];
    const calendar = this.#view === "calendar";
    return html`
      <header class="content-header content-header--settings">
        <div>
          <div class="page-title">Contributions</div>
          <div class="page-subtitle">${calendar
            ? "When you worked in HUI sessions, and how long each one took."
            : html`Commits and pull requests of the GitHub accounts signed in to <code>gh</code>.`}</div>
        </div>
        <div class="page-header-actions">
          <div class="settings-segmented" role="group" aria-label="View">
            ${VIEWS.map(([view, text]) => html`<button type="button" class="settings-segmented__btn ${this.#view === view ? "settings-segmented__btn--active" : ""}"
              aria-pressed=${String(this.#view === view)} @click=${() => this.#savePreferences({ view })}>${text}</button>`)}
          </div>
          ${calendar ? nothing : this.#githubActions(accounts)}
        </div>
      </header>
      <main class="settings-page settings-page--wide contributions-page">${calendar
        ? html`<hui-session-calendar .onOpenSession=${this.onOpenSession}></hui-session-calendar>`
        : this.#body()}</main>`;
  }

  #githubActions(accounts: GitHubContributions["accounts"]) {
    return html`
      <div class="settings-segmented" role="group" aria-label="Count">
        ${METRICS.map(([metric, text]) => html`<button type="button" class="settings-segmented__btn ${this.#metric === metric ? "settings-segmented__btn--active" : ""}"
          aria-pressed=${String(this.#metric === metric)} @click=${() => this.#savePreferences({ metric })}>${text}</button>`)}
      </div>
      <div class="contributions-account">${renderPicker({
        label: "Account",
        value: this.#selectedAccount(),
        options: [{ value: ALL, label: "All accounts" }, ...accounts.map((account) => ({ value: account.login, label: account.login }))],
        disabled: accounts.length === 0,
        onChange: (account) => this.#savePreferences({ account }),
      })}</div>
      <button class="btn" type="button" ?disabled=${this.#loading} @click=${() => void this.#load(true)}>${icons.refresh}<span>${this.#loading && this.#shown ? "Loading…" : "Refresh"}</span></button>`;
  }
}

if (typeof customElements !== "undefined" && !customElements.get("hui-contributions-page")) customElements.define("hui-contributions-page", HuiContributionsPage);
