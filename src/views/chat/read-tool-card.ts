/** Read-tool presentation port from OpenClaw 2026.9.5 chat-tool-cards.ts and
 * chat-tool-content.ts, ec9c1a13. No workspace/approval actions are fabricated. The path a read, edit or write tool
 * names is a file reference (`components/file-link.ts`) that opens it in the Files view once it is confirmed. */
import { html, nothing } from "lit";
import { icons } from "../../lib/icons.ts";
import { openMessageContextMenu } from "../../lib/message-context-menu.ts";
import type { TranscriptItem } from "../../api/sessions.ts";

type Tool = Extract<TranscriptItem, { kind: "tool" }>;

const READ_TOOLS = ["read", "read_file", "readfile", "notebookread", "notebook_read"];
/** Tools whose path argument names the one file they change. */
const FILE_TOOLS = [...READ_TOOLS, "edit", "edit_file", "multiedit", "multi_edit", "write", "write_file", "create_file", "notebookedit", "notebook_edit"];
const PATH_KEYS = ["path", "file_path", "filePath", "file", "filepath", "filename", "notebook_path"];

function toolArgs(item: Tool): Record<string, unknown> | null {
  return item.args && typeof item.args === "object" && !Array.isArray(item.args) ? item.args as Record<string, unknown> : null;
}

/** The file a read, edit or write tool call names, as the agent passed it. */
export function toolFilePath(item: Tool): string | undefined {
  if (!FILE_TOOLS.includes(item.name.trim().toLowerCase())) return undefined;
  const args = toolArgs(item);
  return PATH_KEYS.map((key) => args?.[key]).find((value): value is string => typeof value === "string" && !!value.trim());
}

/** A tool's path as a file reference; `label` is what to show (by default the path itself). */
export function renderToolFileReference(path: string, label: string = path) {
  return html`<hui-file-ref data-path=${path.trim()}>${label}</hui-file-ref>`;
}

export function readToolPresentation(item: Tool) {
  if (!READ_TOOLS.includes(item.name.trim().toLowerCase())) return null;
  const args = toolArgs(item);
  const path = toolFilePath(item);
  if (!path) return null;
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const target = normalized.slice(normalized.lastIndexOf("/") + 1) || path;
  const shortPath = path.replace(/^\/(?:Users|home)\/[^/]+(\/|$)/, "~$1").replace(/^C:\\Users\\[^\\]+(\\|$)/i, "~$1");
  // These are the exact row-summarized fields in upstream tool content.
  const summarizedKeys = new Set(["path", "file_path", "filePath", "notebook_path"]);
  const extras = Object.entries(args ?? {}).filter(([key]) => !summarizedKeys.has(key));
  return { target, path, shortPath, detail: `from ${shortPath}`, extras };
}

export function displayToolValue(value: unknown): string {
  const text = typeof value === "string" ? value : value === null || value === undefined ? String(value)
    : typeof value === "object" ? JSON.stringify(value) : String(value);
  // Avoid cutting a UTF-16 surrogate pair, as in the upstream display helper.
  const end = text.length > 400 && /[\uD800-\uDBFF]/.test(text[399] ?? "") && /[\uDC00-\uDFFF]/.test(text[400] ?? "") ? 399 : 400;
  return text.slice(0, end);
}

export function syncToolOverflow(event: Event) {
  const target = event.currentTarget as HTMLElement;
  const content = target.querySelector<HTMLElement>(".chat-tool-disclosure__content");
  target.classList.toggle("chat-tool-disclosure--overflowing", !!content && content.scrollWidth > content.clientWidth);
}

export function renderReadToolCard(item: Tool, options: {
  expanded: boolean;
  onToggle: () => void;
  onCopy: (text: string) => Promise<boolean>;
}) {
  const view = readToolPresentation(item);
  if (!view) return html``;
  const running = (item.status ?? "running") === "running";
  const failed = item.failed || item.status === "failed";
  const output = item.output?.trim() ? item.output : failed ? "No output — tool failed." : "";
  const copy = (event: MouseEvent | KeyboardEvent) => openMessageContextMenu(event, item.output ?? "", options.onCopy);
  return html`<div class="chat-tool-msg-collapse chat-tool-msg-collapse--manual ${options.expanded ? "is-open" : ""}" data-tool-id=${item.id}>
    <div class="chat-inline-disclosure chat-tool-msg-summary chat-tool-row chat-tool-row--file ${running ? "chat-tool-row--running" : ""}"
      @pointerenter=${syncToolOverflow} @focusin=${syncToolOverflow}>
      <button class="chat-tool-row__toggle" type="button" aria-expanded=${String(options.expanded)} aria-label=${`Read ${view.target}`} @click=${options.onToggle}></button>
      <span class="chat-tool-msg-summary__icon">${icons.fileText}</span>
      <span class="chat-tool-disclosure__content"><span class="chat-tool-row__verb">Read</span> <span class="chat-tool-row__target">${view.target}</span></span>
      ${failed && !options.expanded ? html`<span class="chat-tool-failure">failed</span>` : nothing}
      <span class="chat-tool-row__chevron" aria-hidden="true">${icons.chevron}</span>
    </div>
    ${options.expanded ? html`<div class="chat-tool-msg-body"><div class="chat-tool-card ${failed ? "chat-tool-card--error" : ""}"
      tabindex="0" @contextmenu=${copy} @keydown=${copy}>
      <div class="chat-tool-card__header"><div class="chat-tool-card__detail">from ${renderToolFileReference(view.path, view.shortPath)}</div><div class="chat-tool-card__actions"></div></div>
      ${view.extras.length > 12 ? html`<div class="chat-tool-card__block"><div class="chat-tool-card__block-header"><span class="chat-tool-card__block-icon">${icons.zap}</span><span class="chat-tool-card__block-label">Tool input</span></div><pre class="chat-tool-card__block-content"><code>${JSON.stringify(item.args, null, 2)}</code></pre></div>`
        : view.extras.length > 0 ? html`<div class="chat-tool-kv">${view.extras.map(([key, value]) => html`<div class="chat-tool-kv__row"><span class="chat-tool-kv__key">${key}:</span><span class="chat-tool-kv__value">${displayToolValue(value)}</span></div>`)}</div>` : nothing}
      ${output ? html`<div class="chat-tool-card__block">
        ${failed ? html`<div class="chat-tool-card__block-header"><span class="chat-tool-card__block-icon">${icons.zap}</span><span class="chat-tool-card__block-label">Tool error</span></div>` : nothing}
        <pre class="chat-tool-card__block-content"><code>${output}</code></pre>
      </div>` : nothing}
      <div class="chat-tool-card__outcome">${failed ? "failed" : running ? "Running" : "Completed"}</div>
    </div></div>` : nothing}
  </div>`;
}
