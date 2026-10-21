/**
 * Datadog link previews shown after a chat message, Slack-style: at most three per message, in reading order. A card
 * is an article, not a link: its title links to Datadog, its graph opens in the media viewer and, when the org's pup
 * session has ended, it offers to sign in again. Facts come from the gateway and stay absent until it answers.
 */
import { LitElement, html, nothing } from "lit";
import { datadogRefsInText } from "../lib/markdown/datadog-links.ts";
import type { DatadogOrg, DatadogPreviewResult } from "../api/schema/datadog.ts";
import type { DatadogRef } from "../lib/markdown/datadog-links.ts";
import { brandIcons } from "../lib/brand-icons.ts";
import { datadogOrgLabel, datadogPreviewMessage, formatDatadogRange } from "../lib/datadog.ts";
import { DATADOG_CHANGED, loadDatadogPreviews, settledDatadogPreview, signInToDatadog } from "../lib/datadog-store.ts";
import { SETTLE_MS } from "./github-embeds.ts";

function refLabel(ref: DatadogRef): string {
  if (ref.kind === "share") return "Datadog share link";
  return ref.widgetId ? `Widget on dashboard ${ref.dashboardId}` : `Dashboard ${ref.dashboardId}`;
}

type SignIn = { org: DatadogOrg; error?: string };

export class HuiDatadogEmbeds extends LitElement {
  static override properties = { text: { type: String } };
  declare text: string;
  #refs: DatadogRef[] = [];
  #results = new Map<string, DatadogPreviewResult>();
  #requested = "";
  /** Each lookup's number: only the latest one may fill the cards, even when an older one answers last. */
  #lookup = 0;
  #settle?: ReturnType<typeof setTimeout>;
  #signIn?: SignIn;
  readonly #reload = () => { this.#requested = ""; this.#unfurl(); };

  constructor() {
    super();
    this.text = "";
  }

  override createRenderRoot() { return this; }

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener(DATADOG_CHANGED, this.#reload);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener(DATADOG_CHANGED, this.#reload);
    if (this.#settle) clearTimeout(this.#settle);
    this.#settle = undefined;
  }

  override willUpdate(changed: Map<string, unknown>) {
    if (!changed.has("text")) return;
    // A streaming message grows a URL character by character; unfurl only once the
    // text has been stable briefly so partial links are never looked up or shown.
    if (this.#settle) clearTimeout(this.#settle);
    this.#settle = undefined;
    // A message's first render shows its cards at once, already filled in when they were seen before, so a
    // transcript that renders again does not grow card by card under the reader (as GitHub's cards do).
    if (this.#requested === "" && this.#refs.length === 0) this.#unfurl();
    else this.#settle = setTimeout(() => { this.#settle = undefined; this.#unfurl(); }, SETTLE_MS);
  }

  #unfurl() {
    const refs = datadogRefsInText(this.text ?? "");
    const signature = refs.map((ref) => ref.url).join(" ");
    if (signature === this.#requested) return;
    this.#requested = signature;
    this.#refs = refs;
    for (const ref of refs) {
      const known = settledDatadogPreview(ref);
      if (known && !this.#results.has(ref.url)) this.#results.set(ref.url, known);
    }
    const lookup = ++this.#lookup;
    this.requestUpdate();
    if (!refs.length) return;
    void loadDatadogPreviews(refs).then((results) => {
      if (lookup !== this.#lookup) return;
      for (const result of results) this.#results.set(result.url, result);
      this.requestUpdate();
    });
  }

  async #startSignIn(org: DatadogOrg) {
    this.#signIn = { org };
    this.requestUpdate();
    try {
      await signInToDatadog(org);
      this.#signIn = undefined;
    } catch (error) {
      this.#signIn = { org, error: error instanceof Error ? error.message : "The sign-in did not finish." };
    }
    this.requestUpdate();
  }

  #renderSignIn(org: DatadogOrg) {
    const current = this.#signIn && this.#signIn.org.name === org.name && this.#signIn.org.site === org.site ? this.#signIn : undefined;
    const waiting = Boolean(current && !current.error);
    return html`<div class="datadog-embed__actions">
      <button type="button" class="btn btn--sm" ?disabled=${waiting} @click=${() => void this.#startSignIn(org)}>${waiting ? "Waiting for sign-in…" : `Sign in to ${datadogOrgLabel(org)}`}</button>
      <span role="status">${current?.error ?? (waiting ? "Approve the sign-in in your browser…" : "Opens a browser on the computer running HUI.")}</span>
    </div>`;
  }

  #renderCard(ref: DatadogRef) {
    const result = this.#results.get(ref.url);
    const preview = result?.preview;
    const title = preview?.title || refLabel(ref);
    const message = result ? datadogPreviewMessage(ref, result) : "Loading Datadog preview…";
    const meta = preview && preview.kind !== "share"
      ? [preview.org === undefined ? "" : preview.org || "Default session", preview.kind === "widget" ? preview.detail ?? "" : "",
        preview.from !== undefined && preview.to !== undefined ? formatDatadogRange(preview.from, preview.to, preview.relative) : ""].filter(Boolean)
      : [];
    return html`<article role="listitem" class="datadog-embed" data-kind=${preview?.kind ?? ref.kind} data-loading=${result ? "false" : "true"} aria-label=${`Datadog: ${title}`}>
      <span class="datadog-embed__head">
        <span class="datadog-embed__mark">${brandIcons.datadog}</span>
        <a class="datadog-embed__title" href=${ref.url} target="_blank" rel="noopener noreferrer">${title}</a>
      </span>
      ${meta.length ? html`<span class="datadog-embed__meta">${meta.join(" · ")}</span>` : nothing}
      ${preview?.kind === "dashboard" && preview.detail ? html`<span class="datadog-embed__body">${preview.detail}</span>` : nothing}
      ${preview?.image ? html`<button type="button" class="datadog-embed__image" data-media-viewer data-media-name=${title} aria-label=${`Open graph: ${title}`}>
          <img src=${preview.image} alt=${`Graph: ${title}`} loading="lazy" decoding="async" />
        </button>` : nothing}
      ${message ? html`<span class="datadog-embed__body datadog-embed__body--muted">${message}</span>` : nothing}
      ${result?.error === "signed_out" && result.signIn ? this.#renderSignIn(result.signIn) : nothing}
    </article>`;
  }

  override render() {
    if (!this.#refs.length) return nothing;
    return html`<div class="datadog-embeds" role="list" aria-label="Datadog links">${this.#refs.map((ref) => this.#renderCard(ref))}</div>`;
  }
}

if (typeof customElements !== "undefined" && !customElements.get("hui-datadog-embeds")) customElements.define("hui-datadog-embeds", HuiDatadogEmbeds);
