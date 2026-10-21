/**
 * Host side of agent widgets (`show_widget`). It owns the card, the frame's size and theme and the message channel to
 * the sandbox page; the widget's own code only ever runs inside that opaque-origin frame, never in HUI's page.
 */
import { html, nothing, type PropertyValues } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { ref } from "lit/directives/ref.js";
import { HuiElement } from "../lit/hui-element.ts";
import { icons } from "../lib/icons.ts";
import {
  buildWidgetDocument, WIDGET_SANDBOX_METHOD_PREFIX, WIDGET_SANDBOX_PATH,
  clampWidgetHeight,
  currentWidgetTheme,
  openableWidgetUrl,
  parseWidgetFrameMessage,
  widgetErrorText,
  widgetHostContext,
  type WidgetError,
  type WidgetFrameMessage,
} from "../lib/widgets.ts";

/** Lucide maximize-2 and minimize-2, like the diagram viewer's expand control. */
const expandIcon = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></svg>`;
const collapseIcon = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" /></svg>`;

/** The sandbox page posts its ready message while it loads; silence after its
 * load event means it refused to run (not framed by HUI, or not isolated). */
const SANDBOX_READY_MS = 5_000;

const cards = new Set<WidgetCard>();
let watching = false;
let themeFrame = 0;

/** One window listener routes each message to the card whose sandbox page sent
 * it; one observer re-themes every card when the root's theme changes. */
function watchFrames(): void {
  if (watching) return;
  watching = true;
  window.addEventListener("message", (event) => {
    for (const card of cards) if (card.receive(event)) return;
  });
  new MutationObserver(() => {
    if (themeFrame) return;
    themeFrame = requestAnimationFrame(() => {
      themeFrame = 0;
      for (const card of cards) card.themeChanged();
    });
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-theme-mode", "data-theme-palette"] });
}

let sequence = 0;
const renderId = (): string => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${(++sequence).toString(36)}`;
const themeMode = (): "light" | "dark" => document.documentElement.dataset["themeMode"] === "light" ? "light" : "dark";
const userClicked = (frame: HTMLIFrameElement | undefined): boolean =>
  Boolean(frame) && document.activeElement === frame && navigator.userActivation?.isActive === true;

type FrameState = "loading" | "ready" | "failed";

/**
 * One agent widget in the transcript: a titled card whose sandbox page
 * (server/agent-tools/widget-sandbox.ts) hosts the call's fragment in an opaque-origin
 * frame. The card fits the frame to the reported height, keeps the widget on
 * HUI's live theme, shows its runtime errors and opens its links in a new tab
 * after a click inside it. Full screen promotes this same card to the top
 * layer, so the widget keeps its state.
 *
 * No decorators: the chat view (and so this module) also loads in Node tests.
 */
export class WidgetCard extends HuiElement {
  static override properties = {
    widgetTitle: { type: String },
    code: { type: String },
    pending: { type: Boolean },
    unavailable: { type: Boolean },
    frameState: { state: true },
    failure: { state: true },
    errors: { state: true },
    errorCount: { state: true },
    frameHeight: { state: true },
    expanded: { state: true },
  };
  declare widgetTitle: string;
  /** The accepted fragment; empty while the call runs. */
  declare code: string;
  /** The call is still running. */
  declare pending: boolean;
  /** The call succeeded but its code is missing or invalid in this transcript. */
  declare unavailable: boolean;
  declare frameState: FrameState;
  declare failure: string;
  /** The first notices, already worded for the card. */
  declare errors: readonly string[];
  declare errorCount: number;
  declare frameHeight: number;
  declare expanded: boolean;

  #frame: HTMLIFrameElement | undefined;
  #generation = 0;
  #src: string = WIDGET_SANDBOX_PATH;
  #renderId = "";
  #fragmentLine = 1;
  #proxyReady = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #context = "";
  #returnFocus: HTMLElement | undefined;

  constructor() {
    super();
    this.widgetTitle = "Widget";
    this.code = "";
    this.pending = false;
    this.unavailable = false;
    this.frameState = "loading";
    this.failure = "";
    this.errors = [];
    this.errorCount = 0;
    this.frameHeight = 0;
    this.expanded = false;
  }

  override connectedCallback() {
    super.connectedCallback();
    cards.add(this);
    watchFrames();
  }

  override disconnectedCallback() {
    cards.delete(this);
    this.#clearTimer();
    if (this.expanded) this.#leaveFullScreen(false);
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: PropertyValues) {
    if (changed.has("code") || changed.has("widgetTitle") || changed.has("pending") || changed.has("unavailable")) this.#restart();
  }

  /** Handles a message from this card's own sandbox page; false for any other source. */
  receive(event: MessageEvent): boolean {
    const frame = this.#frame;
    if (!frame || event.source !== frame.contentWindow) return false;
    const message = parseWidgetFrameMessage(event.data);
    if (message) this.#handle(message, event.origin);
    return true;
  }

  /** The root's theme attributes changed: send the widget its new tokens. */
  themeChanged(): void {
    this.#sendContext();
  }

  #restart(): void {
    this.#generation += 1;
    this.#frame = undefined;
    this.#proxyReady = false;
    this.#renderId = "";
    this.#context = "";
    this.#clearTimer();
    this.frameState = "loading";
    this.failure = "";
    this.errors = [];
    this.errorCount = 0;
    this.frameHeight = 0;
    // Fixed for the frame's life: later theme changes go by message, never navigation.
    this.#src = `${WIDGET_SANDBOX_PATH}#scheme=${themeMode()}`;
  }

  #handle(message: WidgetFrameMessage, origin: string): void {
    switch (message.kind) {
      case "proxy-ready":
        this.#proxyReady = true;
        this.#clearTimer();
        // An opaque origin posts as "null"; anything else is not isolated.
        if (origin !== "null") this.#fail("The widget sandbox is not isolated in this browser, so the widget was not loaded.");
        else this.#deliver();
        return;
      case "loaded":
        if (message.renderId !== this.#renderId) return;
        this.frameState = "ready";
        this.#sendContext(true);
        return;
      case "navigated":
        if (message.renderId === this.#renderId) this.#fail("The widget tried to navigate away from its frame and was stopped.");
        return;
      case "size":
        if (this.frameState !== "failed") this.frameHeight = clampWidgetHeight(message.height);
        return;
      case "error":
        this.#addError(message);
        return;
      case "open-link":
        this.#openLink(message.url, message.id);
        return;
      case "display-mode":
        if (message.mode === "inline") this.#leaveFullScreen(true);
        else if (userClicked(this.#frame)) this.#enterFullScreen();
        this.#respond(message.id, { mode: this.expanded ? "fullscreen" : "inline" });
        return;
    }
  }

  #deliver(): void {
    const target = this.#frame?.contentWindow;
    if (!target || this.pending || this.unavailable || !this.code) return;
    const built = buildWidgetDocument({ title: this.widgetTitle, code: this.code, theme: currentWidgetTheme() });
    this.#fragmentLine = built.fragmentLine;
    this.#renderId = renderId();
    // The page is opaque, so it cannot be addressed by origin; the document is
    // the call's own code and nothing private.
    target.postMessage({
      jsonrpc: "2.0",
      method: `${WIDGET_SANDBOX_METHOD_PREFIX}resource-ready`,
      params: { html: built.html, renderId: this.#renderId, title: this.widgetTitle },
    }, "*");
  }

  #sendContext(force = false): void {
    const target = this.#frame?.contentWindow;
    if (!target || this.frameState !== "ready") return;
    const context = widgetHostContext(currentWidgetTheme(), this.expanded ? "fullscreen" : "inline");
    const serialized = JSON.stringify(context);
    if (!force && serialized === this.#context) return;
    this.#context = serialized;
    target.postMessage(context, "*");
  }

  #addError(error: WidgetError): void {
    this.errorCount += 1;
    if (this.errors.length < 3) this.errors = [...this.errors, widgetErrorText(error, this.#fragmentLine)];
  }

  #openLink(raw: string, id: string | number | undefined): void {
    const url = openableWidgetUrl(raw);
    if (!url) {
      this.#respond(id, undefined, "Only http and https links can be opened.");
      return;
    }
    if (!userClicked(this.#frame)) {
      this.#respond(id, undefined, "Links open only from a click inside the widget.");
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
    this.#respond(id, {});
  }

  #respond(id: string | number | undefined, result: object | undefined, error = ""): void {
    if (id === undefined) return;
    this.#frame?.contentWindow?.postMessage(result
      ? { jsonrpc: "2.0", id, result }
      : { jsonrpc: "2.0", id, error: { code: -32000, message: error } }, "*");
  }

  #fail(reason: string): void {
    this.#clearTimer();
    if (this.expanded) this.#leaveFullScreen(false);
    this.frameState = "failed";
    this.failure = reason;
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #card(): HTMLElement | null {
    return this.querySelector<HTMLElement>(".hui-widget-card");
  }

  #enterFullScreen(): void {
    if (this.expanded || this.frameState !== "ready") return;
    this.#returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    this.expanded = true;
    void this.updateComplete.then(() => {
      const card = this.#card();
      // The top layer escapes every containing block without moving the
      // frame, which would reload the widget; fixed positioning is the fallback.
      try { card?.showPopover(); } catch { /* in-flow fallback */ }
      this.#sendContext(true);
      this.querySelector<HTMLElement>(".hui-widget-card__toggle")?.focus();
    });
  }

  #leaveFullScreen(restoreFocus: boolean): void {
    if (!this.expanded) return;
    const card = this.#card();
    try { if (card?.matches(":popover-open")) card.hidePopover(); } catch { /* not in the top layer */ }
    this.expanded = false;
    const returnTo = this.#returnFocus;
    this.#returnFocus = undefined;
    void this.updateComplete.then(() => {
      this.#sendContext(true);
      if (restoreFocus) (returnTo?.isConnected ? returnTo : this.querySelector<HTMLElement>(".hui-widget-card__toggle"))?.focus();
    });
  }

  #onKeydown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || !this.expanded) return;
    event.preventDefault();
    event.stopPropagation();
    this.#leaveFullScreen(true);
  };

  #onFrameLoad = (): void => {
    if (this.#proxyReady || this.frameState !== "loading") return;
    this.#clearTimer();
    this.#timer = setTimeout(() => {
      if (!this.#proxyReady) this.#fail("The widget sandbox did not start. Reload the page to try again.");
    }, SANDBOX_READY_MS);
  };

  #bindFrame = (element?: Element): void => {
    if (element instanceof HTMLIFrameElement) this.#frame = element;
  };

  #retry = (): void => {
    this.#restart();
  };

  #toggle = (): void => {
    if (this.expanded) this.#leaveFullScreen(true);
    else this.#enterFullScreen();
  };

  /** Keeps Tab inside the full-screen card, whose frame cannot trap focus itself. */
  #guard(position: "start" | "end") {
    return html`<span class="hui-widget-card__guard" tabindex="0" @focus=${() => {
      if (position === "end") this.querySelector<HTMLElement>(".hui-widget-card__toggle")?.focus();
      else this.#frame?.focus();
    }}></span>`;
  }

  #renderBody() {
    if (this.pending) {
      return html`<div class="hui-widget-card__placeholder" role="status"><span class="session-run-spinner" aria-hidden="true"></span>Preparing widget…</div>`;
    }
    if (this.unavailable) {
      return html`<p class="hui-widget-card__message">This widget's code is not available in this transcript.</p>`;
    }
    if (this.frameState === "failed") {
      return html`<div class="hui-widget-card__message" role="alert"><span>${this.failure}</span><button type="button" class="btn btn--sm" @click=${this.#retry}>Retry</button></div>`;
    }
    return html`${keyed(this.#generation, html`<iframe
        class="hui-widget-card__frame"
        src=${this.#src}
        title=${this.widgetTitle}
        sandbox="allow-scripts allow-forms"
        referrerpolicy="origin"
        loading="lazy"
        style=${`--hui-widget-height:${this.frameHeight || 160}px`}
        ${ref(this.#bindFrame)}
        @load=${this.#onFrameLoad}
      ></iframe>`)}
      ${this.frameState === "loading" ? html`<div class="hui-widget-card__loading" role="status"><span class="session-run-spinner" aria-hidden="true"></span>Loading widget…</div>` : nothing}`;
  }

  override render() {
    const title = this.widgetTitle || "Widget";
    const ready = !this.pending && !this.unavailable && this.frameState === "ready";
    const meta = this.pending ? "Preparing…"
      : this.unavailable ? "Unavailable"
        : this.frameState === "failed" ? "Stopped"
          : this.frameState === "loading" ? "Loading…"
            : "Interactive widget · sandboxed";
    return html`<section
      class="chat-assistant-attachment-card hui-widget-card"
      data-state=${this.pending ? "pending" : this.unavailable ? "unavailable" : this.frameState}
      ?data-expanded=${this.expanded}
      role=${this.expanded ? "dialog" : "group"}
      aria-modal=${this.expanded ? "true" : nothing}
      aria-label=${`Widget: ${title}`}
      popover=${this.expanded ? "manual" : nothing}
      @keydown=${this.#onKeydown}
    >
      ${this.expanded ? this.#guard("start") : nothing}
      <header class="chat-assistant-attachment-card__header chat-assistant-attachment-card__header--preview hui-widget-card__header">
        <div class="chat-assistant-attachment-card__identity">
          <span class="hui-widget-card__icon" aria-hidden="true">${icons.box}</span>
          <span class="chat-assistant-attachment-card__details">
            <span class="chat-assistant-attachment-card__title" title=${title}>${title}</span>
            <span class="chat-assistant-attachment-card__meta">${meta}</span>
          </span>
        </div>
        ${ready ? html`<span class="chat-assistant-attachment-card__actions">
          <button type="button" class="chat-assistant-attachment-card__action hui-widget-card__toggle"
            aria-label=${this.expanded ? "Exit full screen" : "Open full screen"}
            title=${this.expanded ? "Exit full screen (Esc)" : "Open full screen"}
            @click=${this.#toggle}>${this.expanded ? collapseIcon : expandIcon}</button>
        </span>` : nothing}
      </header>
      <div class="hui-widget-card__body">${this.#renderBody()}</div>
      ${this.errors.length ? html`<p class="hui-widget-card__notice" role="status" title=${this.errors.join("\n")}>
        ${icons.alertTriangle}<span>${this.errors[0]}${this.errorCount > 1 ? ` (+${this.errorCount - 1} more)` : ""}</span>
      </p>` : nothing}
      ${this.expanded ? this.#guard("end") : nothing}
    </section>`;
  }
}

if (typeof customElements !== "undefined" && !customElements.get("hui-widget-card")) customElements.define("hui-widget-card", WidgetCard);
