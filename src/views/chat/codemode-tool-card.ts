/** PI's `codemode` tool as one card: the script, the calls it made (live while it runs, from the gateway's
 * `tool_update` details; afterwards from its result's `details.calls`) and the output the model got. The script's
 * calls never get rows of their own: their results went to the script, not the model. */
import { html, nothing, type TemplateResult } from "lit";
import { until } from "lit/directives/until.js";
import { icons } from "../../lib/icons.ts";
import { openMessageContextMenu } from "../../lib/message-context-menu.ts";
import type { TranscriptItem } from "../../api/sessions.ts";
import { renderToolFileReference, syncToolOverflow } from "./read-tool-card.ts";
import { shouldToggleToolDisclosure } from "./command-tool-card.ts";

type Tool = Extract<TranscriptItem, { kind: "tool" }>;
export type CodemodeCall = { name: string; args: string; status: "running" | "ok" | "error" | "cancelled"; durationMs?: number; error?: string };
export type CodemodeView = {
  code: string;
  calls: CodemodeCall[];
  /** The tools called, in first-call order: `read ×3, bash`. */
  tools: string;
  state: "running" | "completed" | "failed";
  failedCalls: number;
  /** What the model got, without the "Script completed / Wall time / Output:" header. */
  output: string;
  wallSeconds?: string;
  fullOutputPath?: string;
};

const STATUSES = new Set(["running", "ok", "error", "cancelled"]);
const HEADER = /^Script (completed|failed)\nWall time ([\d.]+) seconds\nOutput:\n?/u;

function isCall(value: unknown): value is CodemodeCall {
  const call = value as Partial<CodemodeCall> | null;
  return typeof call?.name === "string" && STATUSES.has(call.status as string);
}

/** Transcript items are replaced, never mutated: one view per item. */
const views = new WeakMap<Tool, CodemodeView | null>();

export function codemodeToolPresentation(item: Tool): CodemodeView | null {
  let view = views.get(item);
  if (view === undefined) views.set(item, view = presentCodemode(item));
  return view;
}

function presentCodemode(item: Tool): CodemodeView | null {
  const code = (item.args as { code?: unknown } | undefined)?.code;
  if (item.name !== "codemode" || typeof code !== "string") return null;
  const details = (item.details ?? {}) as { calls?: unknown; fullOutputPath?: unknown };
  const calls = Array.isArray(details.calls) ? details.calls.filter(isCall) : [];
  const counts = new Map<string, number>();
  for (const call of calls) counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
  const named = [...counts].map(([name, count]) => count > 1 ? `${name} ×${count}` : name);
  const header = HEADER.exec(item.output ?? "");
  const running = (item.status ?? "running") === "running";
  return {
    code,
    calls,
    tools: named.length > 4 ? `${named.slice(0, 4).join(", ")} +${named.length - 4} more` : named.join(", "),
    state: running ? "running" : item.failed || item.status === "failed" || header?.[1] === "failed" ? "failed" : "completed",
    failedCalls: calls.filter((call) => call.status === "error").length,
    output: (header ? item.output!.slice(header[0].length) : item.output ?? "").replace(/\n+$/u, ""),
    ...(header ? { wallSeconds: header[2]! } : {}),
    ...(typeof details.fullOutputPath === "string" ? { fullOutputPath: details.fullOutputPath } : {}),
  };
}

export function formatCallDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1_000)}s`;
}

/** The row's line after the name: the tools the script called. Its badge says what failed. */
export function codemodeSummary(view: CodemodeView): string {
  if (!view.calls.length) return view.state === "running" ? "Starting…" : "no tool calls";
  return view.state === "running" ? `${view.tools}…` : view.tools;
}

function outcome(view: CodemodeView): string {
  const calls = view.calls.length;
  const cancelled = view.calls.filter((call) => call.status === "cancelled").length;
  const parts = [`${calls} call${calls === 1 ? "" : "s"}`, ...(view.failedCalls ? [`${view.failedCalls} failed`] : []), ...(cancelled ? [`${cancelled} cancelled`] : [])].join(", ");
  if (view.state === "running") return `Running · ${parts} so far`;
  const time = view.wallSeconds ? ` ${view.state === "failed" ? "after" : "in"} ${view.wallSeconds}s` : "";
  return `${view.state === "failed" ? "Failed" : "Completed"}${time} · ${parts}`;
}

const STATUS_LABEL: Record<CodemodeCall["status"], string> = { running: "Running", ok: "Done", error: "Failed", cancelled: "Cancelled" };
const STATUS_GLYPH: Record<CodemodeCall["status"], string> = { running: "…", ok: "✓", error: "✗", cancelled: "⊘" };

/** JavaScript colours from the Files editor's parser, loaded on first use; the plain script until then. A script is
 * shown for as long as its card exists, so a few recent ones are kept. */
const highlighted = new Map<string, Promise<TemplateResult | string>>();
function renderScript(code: string) {
  let pending = highlighted.get(code);
  if (!pending) {
    if (highlighted.size >= 20) highlighted.delete(highlighted.keys().next().value!);
    pending = Promise.all([import("../../lib/code-languages.ts"), import("../../lib/diff/highlight.ts")])
      .then(async ([languages, { highlightBlock }]) => {
        const parser = await languages.loadLanguageParser("javascript");
        if (!parser) return code;
        return html`${highlightBlock(parser, code.split("\n")).map((segments, index) => html`${index ? "\n" : ""}${segments.map((segment) =>
          segment.className ? html`<span class=${segment.className}>${segment.text}</span>` : segment.text)}`)}`;
      })
      .catch(() => code);
    highlighted.set(code, pending);
  }
  return until(pending, code);
}

function renderCall(call: CodemodeCall) {
  return html`<li class="chat-tool-codemode__call" data-status=${call.status}>
    <span class="chat-tool-codemode__status" role="img" aria-label=${STATUS_LABEL[call.status]} title=${STATUS_LABEL[call.status]}>${STATUS_GLYPH[call.status]}</span>
    <span class="chat-tool-codemode__name">${call.name}</span>
    <code class="chat-tool-codemode__args">${call.args}</code>
    <span class="chat-tool-codemode__duration">${call.durationMs === undefined ? "" : formatCallDuration(call.durationMs)}</span>
    ${call.error ? html`<span class="chat-tool-codemode__error">${call.error}</span>` : nothing}
  </li>`;
}

export function renderCodemodeToolCard(item: Tool, options: {
  expanded: boolean;
  onToggle: () => void;
  onCopy: (text: string) => Promise<boolean>;
}) {
  const view = codemodeToolPresentation(item);
  if (!view) return html``;
  const failed = view.state === "failed";
  const copy = (text: string) => (event: MouseEvent | KeyboardEvent) => openMessageContextMenu(event, text, options.onCopy);
  const errorAt = view.output.search(/^Script error:/mu);
  return html`<div class="chat-tool-msg-collapse chat-tool-msg-collapse--manual chat-tool-codemode ${options.expanded ? "is-open" : ""}" data-tool-id=${item.id}>
    <button class="chat-inline-disclosure chat-tool-msg-summary chat-tool-row ${view.state === "running" ? "chat-tool-row--running" : ""}"
      type="button" aria-expanded=${String(options.expanded)}
      @pointerenter=${syncToolOverflow} @focus=${syncToolOverflow}
      @click=${(event: MouseEvent) => { if (shouldToggleToolDisclosure(event)) options.onToggle(); }}>
      <span class="chat-tool-msg-summary__icon">${icons.zap}</span>
      <span class="chat-tool-disclosure__content"><span class="chat-tool-row__verb">codemode</span> <span class="chat-tool-row__target">${codemodeSummary(view)}</span></span>
      ${failed ? html`<span class="chat-tool-failure">failed</span>` : view.failedCalls ? html`<span class="chat-tool-failure">${view.failedCalls} failed</span>` : nothing}
      ${view.wallSeconds ? html`<span class="chat-tool-codemode__time">${view.wallSeconds}s</span>` : nothing}
      <span class="chat-tool-row__chevron" aria-hidden="true">${icons.chevron}</span>
    </button>
    ${options.expanded ? html`<div class="chat-tool-msg-body"><div class="chat-tool-card ${failed ? "chat-tool-card--error" : ""}">
      <section class="chat-tool-card__block" tabindex="0" aria-label="Script" @contextmenu=${copy(view.code)} @keydown=${copy(view.code)}>
        <div class="chat-tool-card__block-header"><span class="chat-tool-card__block-label">Script</span></div>
        <pre class="chat-tool-card__block-content chat-tool-codemode__script"><code>${renderScript(view.code)}</code></pre>
      </section>
      ${view.calls.length ? html`<section class="chat-tool-card__block">
        <div class="chat-tool-card__block-header"><span class="chat-tool-card__block-label">Calls · ${view.calls.length}</span></div>
        <ol class="chat-tool-codemode__calls" tabindex="0" aria-label="Calls">${view.calls.map(renderCall)}</ol>
      </section>` : nothing}
      ${view.output ? html`<section class="chat-tool-card__block" tabindex="0" aria-label="Output" @contextmenu=${copy(item.output ?? "")} @keydown=${copy(item.output ?? "")}>
        <div class="chat-tool-card__block-header"><span class="chat-tool-card__block-label">Output</span></div>
        <pre class="chat-tool-card__block-content"><code>${errorAt < 0 ? view.output : html`${view.output.slice(0, errorAt)}<span class="chat-tool-codemode__script-error">${view.output.slice(errorAt)}</span>`}</code></pre>
        ${view.fullOutputPath ? html`<div class="chat-tool-kv"><div class="chat-tool-kv__row"><span class="chat-tool-kv__key">Full output:</span><span class="chat-tool-kv__value">${renderToolFileReference(view.fullOutputPath)}</span></div></div>` : nothing}
      </section>` : nothing}
      <div class="chat-tool-card__outcome">${outcome(view)}</div>
    </div></div>` : nothing}
  </div>`;
}
