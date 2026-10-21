/**
 * Read-only dialog for a PI resource such as a skill or plugin file: Markdown rendered, anything else shown as
 * source. Loading, copying and closing belong to the caller.
 */
import { html, nothing } from "lit";

import type { PiResourceDocument } from "../lib/pi.ts";
import { icons } from "../lib/icons.ts";
import { renderMarkdown } from "../lib/markdown/markdown.ts";

export type PiResourceReaderState = {
  title: string;
  status: "loading" | "ready" | "error";
  document?: PiResourceDocument;
  error?: string;
  copied?: boolean;
};

export function renderPiResourceReader(
  state: PiResourceReaderState | undefined,
  onClose: () => void,
  onCopy: () => void,
) {
  if (!state) return nothing;
  const document = state.document;
  const title = document?.title ?? state.title;
  return html`<dialog
    class="hui-modal-dialog pi-resource-reader-modal"
    aria-labelledby="pi-resource-reader-title"
    @cancel=${(event: Event) => { event.preventDefault(); onClose(); }}
  >
    <section class="md-preview-dialog__panel">
      <header class="md-preview-dialog__header">
        <div class="md-preview-dialog__header-main">
          <div class="md-preview-dialog__eyebrow">${document?.kind ?? "PI resource"}</div>
          <div class="md-preview-dialog__title-wrap">
            <h2 class="md-preview-dialog__title" id="pi-resource-reader-title">${title}</h2>
            ${document ? html`<div class="md-preview-dialog__path">${document.fileName}</div>` : nothing}
          </div>
        </div>
        <div class="md-preview-dialog__actions">
          ${document ? html`<button
            type="button"
            class="btn btn--icon md-preview-icon-btn pi-resource-reader__copy"
            aria-label=${state.copied ? "Copied" : `Copy ${document.fileName}`}
            title=${state.copied ? "Copied" : `Copy ${document.fileName}`}
            @click=${onCopy}
          >${state.copied ? icons.check : icons.copy}</button>` : nothing}
          <button type="button" class="btn btn--icon md-preview-icon-btn" aria-label="Close reader" @click=${onClose}>${icons.close}</button>
        </div>
      </header>
      ${document ? html`<div class="md-preview-dialog__meta">
        <span class="md-preview-dialog__chip"><strong>${document.format === "markdown" ? "Rendered" : "Source"}</strong> ${document.fileName}</span>
        ${document.truncated ? html`<span class="md-preview-dialog__chip is-missing"><strong>Limited</strong> first 256 KiB</span>` : nothing}
      </div>` : nothing}
      <div class="md-preview-dialog__body" role=${state.status === "error" ? "alert" : "status"} aria-live="polite">
        ${state.status === "loading"
          ? html`<div class="pi-resource-reader__status">Reading ${state.title}…</div>`
          : state.status === "error"
            ? html`<div class="callout danger">${state.error ?? "Could not read this resource."}</div>`
            : document?.format === "markdown"
              ? html`<article class="md-preview-dialog__reader sidebar-markdown">${renderMarkdown(document.content)}</article>`
              : html`<pre class="md-preview-dialog__reader pi-resource-reader__source"><code>${document?.content ?? ""}</code></pre>`}
      </div>
    </section>
  </dialog>`;
}
