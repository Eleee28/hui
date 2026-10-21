/**
 * The Activity, Logs, Debug and Usage pages, rendered from the gateway's observability snapshot. They only read:
 * refreshing and exporting go back to the app, and usage totals come from PI's session files via the gateway.
 */
import { html, nothing, type TemplateResult } from "lit";

import type { HuiPage } from "../lib/pages.ts";
import type { ObservabilitySnapshot } from "../api/observability.ts";
import type { GatewayHealth } from "../api/control-surfaces.ts";
import { icons } from "../lib/icons.ts";

export type ObservabilityProps = {
  page: HuiPage;
  snapshot: ObservabilitySnapshot | undefined;
  health: GatewayHealth | undefined;
  loading: boolean;
  error: string;
  dense: boolean;
  detailedDebug: boolean;
  onRefresh: () => void;
  onExport: () => void;
};

const IDS = new Set(["activity", "logs", "debug", "usage"]);
export function isObservabilitySurface(page: HuiPage): boolean { return IDS.has(page.id); }

function header(props: ObservabilityProps, title: string, subtitle: string, exportable = false) {
  return html`<header class="content-header content-header--settings"><div><div class="page-title">${title}</div><div class="page-subtitle">${subtitle}</div></div><div class="page-header-actions">${exportable ? html`<button class="btn" type="button" @click=${props.onExport}>Export diagnostics</button>` : nothing}<button class="btn" type="button" ?disabled=${props.loading} @click=${props.onRefresh}>${icons.refresh}<span>${props.loading ? "Refreshing…" : "Refresh"}</span></button></div></header>`;
}

function time(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Unknown" : date.toLocaleString();
}

function feedback(props: ObservabilityProps) {
  if (props.error) return html`<div class="observability-feedback callout danger" role="alert">${props.error}<button class="btn btn--sm" @click=${props.onRefresh}>Retry</button></div>`;
  return html`<div class="observability-feedback" role="status">Reading HUI diagnostics…</div>`;
}

function events(props: ObservabilityProps, source: "activity" | "logs") {
  const snapshot = props.snapshot;
  if (!snapshot) return feedback(props);
  const rows = snapshot[source];
  const empty = html`<div class="settings-empty">No ${source} yet. Events appear after this gateway handles session or automation work.</div>`;
  if (source === "logs") {
    return html`<div class="log-stream ${props.dense ? "observability-stream--dense" : ""}" role="log" aria-label="logs">${rows.length ? rows.map((entry) => html`<div class="log-row"><span class="log-time" title=${time(entry.timestamp)}>${new Date(entry.timestamp).toLocaleTimeString()}</span><span class="log-level ${entry.level === "warning" ? "warn" : entry.level}">${entry.level}</span><span class="log-subsystem">${entry.area}</span><span class="log-message">${entry.action}: ${entry.summary}${entry.detail ? html`<span class="log-detail">${entry.detail}</span>` : nothing}</span></div>`) : empty}</div>`;
  }
  return html`<div class="settings-group activity-group"><div class="activity-stream ${props.dense ? "observability-stream--dense" : ""}" role="log" aria-label="activity">${rows.length ? rows.map((entry) => html`<details class="activity-entry"><summary class="activity-entry__summary"><span class="activity-entry__chevron" aria-hidden="true">${icons.chevron}</span><span class="activity-entry__main"><span class="activity-entry__title"><strong class="activity-entry__tool">${entry.action}</strong><span class="activity-entry__text">${entry.summary}</span></span></span><span class="activity-entry__meta">${new Date(entry.timestamp).toLocaleTimeString()}</span></summary><div class="activity-entry__body"><div class="activity-entry__facts"><span>${entry.area}</span><span>${entry.level}</span><span>${time(entry.timestamp)}</span>${entry.sessionId ? html`<span>Session ${entry.sessionId}</span>` : nothing}</div>${entry.detail ? html`<p class="activity-entry__detail">${entry.detail}</p>` : nothing}</div></details>`) : empty}</div></div>`;
}

function renderActivity(props: ObservabilityProps) {
  return html`${header(props, "Activity", "Recent gateway, session, runtime and automation events.")}<main class="settings-page settings-page--wide activity-page"><p class="settings-page__intro">Best-effort operational history · in-memory · up to ${props.snapshot?.retention.maximum ?? 300} events</p>${events(props, "activity")}</main>`;
}

function renderLogs(props: ObservabilityProps) {
  return html`${header(props, "Logs", "Structured HUI diagnostics with secret-shaped values redacted.", true)}<main class="settings-page settings-page--wide logs-page">${events(props, "logs")}</main>`;
}

function bytes(value: number) { return `${(value / 1024 / 1024).toFixed(1)} MB`; }
function number(value: number) { return new Intl.NumberFormat().format(value); }

function renderDebug(props: ObservabilityProps) {
  const value = props.snapshot;
  return html`${header(props, "Debug", "Gateway vitals and bounded diagnostic export.", true)}<main class="settings-page debug-page">${!value ? feedback(props) : html`
    <section class="settings-section"><header class="settings-section__header"><h2 class="settings-section__heading">Snapshots</h2></header><div class="settings-group">
      ${[
        ["Gateway", props.health?.status ?? "Unknown", props.health?.transport ?? "No health snapshot"],
        ["Runtime", value.debug.node, value.debug.platform],
        ["Memory", bytes(value.debug.memory.rssBytes), `${bytes(value.debug.memory.heapUsedBytes)} heap used`],
        ["Events", number(value.debug.eventCount), "Since gateway start"],
      ].map(([title, current, description]) => html`<div class="settings-row"><div class="settings-row__text"><span class="settings-row__title">${title}</span><span class="settings-row__desc">${description}</span></div><div class="settings-row__control"><span class="settings-row__value">${current}</span></div></div>`)}
    </div></section>
    ${props.detailedDebug ? html`<section class="settings-section"><header class="settings-section__header"><div class="settings-section__copy"><h2 class="settings-section__heading">Runtime detail</h2><p class="settings-section__desc">Local metadata only. Prompts and tool payloads are excluded.</p></div></header><div class="settings-group"><div class="settings-row"><div class="settings-row__text"><strong>Heap total</strong><span>${bytes(value.debug.memory.heapTotalBytes)}</span></div><code>${value.generatedAt}</code></div></div></section>` : nothing}
    <div class="callout">Exports contain operational metadata and redacted failure causes. HUI never includes prompt text, tool arguments/output, credentials or secret values.</div>`}</main>`;
}

function renderUsage(props: ObservabilityProps) {
  const value = props.snapshot;
  return html`${header(props, "Usage", "Token metadata aggregated from PI-owned session files.")}<main class="settings-page settings-page--wide usage-page">${!value ? feedback(props) : html`
    <section class="usage-summary-grid">
      <article class="stat usage-summary-card"><span class="usage-summary-title">Total tokens</span><strong class="usage-summary-value">${number(value.usage.totalTokens)}</strong><small class="usage-summary-sub">${value.usage.filesRead} PI transcript${value.usage.filesRead === 1 ? "" : "s"} read</small></article>
      <article class="stat usage-summary-card"><span class="usage-summary-title">Input</span><strong class="usage-summary-value">${number(value.usage.inputTokens)}</strong><small class="usage-summary-sub">${number(value.usage.cacheReadTokens)} cache-read</small></article>
      <article class="stat usage-summary-card"><span class="usage-summary-title">Output</span><strong class="usage-summary-value">${number(value.usage.outputTokens)}</strong><small class="usage-summary-sub">${number(value.usage.cacheWriteTokens)} cache-write</small></article>
      <article class="stat usage-summary-card"><span class="usage-summary-title">Cost</span><strong class="usage-summary-value">${value.usage.costUsd === null ? "Unavailable" : `$${value.usage.costUsd.toFixed(4)}`}</strong><small class="usage-summary-sub">${value.usage.costUsd === null ? "PI metadata did not provide cost" : "Reported metadata only"}</small></article>
    </section>
    <section class="settings-section"><header class="settings-section__header"><div class="settings-section__copy"><h2 class="settings-section__heading">Models</h2><p class="settings-section__desc">Tokens grouped by the model label stored by PI.</p></div></header><div class="settings-group usage-model-list">${value.usage.models.length ? value.usage.models.map((model) => html`<div class="settings-row"><code>${model.model}</code><strong>${number(model.tokens)}</strong></div>`) : html`<div class="surface-empty"><p>No token metadata is available yet.</p></div>`}</div></section>
    ${value.usage.unavailable.length ? html`<div class="callout warning">${value.usage.unavailable.length} transcript${value.usage.unavailable.length === 1 ? " was" : "s were"} unavailable. Totals are partial.</div>` : nothing}`}</main>`;
}

export function renderObservabilitySurface(props: ObservabilityProps): TemplateResult {
  switch (props.page.id) {
    case "activity": return renderActivity(props);
    case "logs": return renderLogs(props);
    case "debug": return renderDebug(props);
    case "usage": return renderUsage(props);
    default: return html``;
  }
}
