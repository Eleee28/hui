/**
 * The agent's browser as a card in the transcript. It decides between streaming and a single snapshot from the turn
 * and the card's visibility; the browser itself and its frames stay with the gateway and the shared view controller.
 */
import { html, nothing, type PropertyValues } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { HuiElement } from "../lit/hui-element.ts";
import { icons } from "../lib/icons.ts";
import { connectBrowserView } from "../api/browser.ts";
import { BrowserViewController } from "../controllers/browser-view-controller.ts";
import { browserPreviewDisplay, relativeTime } from "../lib/browser-view.ts";

const CHIP_TEXT = { live: "Live", connecting: "Connecting…", closed: "Closed" } as const;

/**
 * What the agent's browser shows, in the chat under its latest browser
 * activity. It streams while the agent's turn runs and the card is on screen,
 * then keeps the last frame; an idle card takes one fresh frame when it first
 * appears. View-only: selecting it opens the conversation's browser view in the Work pane.
 *
 * No decorators: the chat view (and so this module) also loads in Node tests.
 */
export class BrowserPreview extends HuiElement {
  static override properties = {
    sessionId: { type: String },
    live: { type: Boolean },
    pending: { type: Boolean },
    visible: { type: Boolean },
    onExpand: { attribute: false },
    onScreen: { state: true },
    now: { state: true },
  };
  declare sessionId: string;
  /** The agent is working in the turn this preview belongs to. */
  declare live: boolean;
  /** The latest browser call is still running. */
  declare pending: boolean;
  /** False while the chat pane itself is hidden. */
  declare visible: boolean;
  declare onExpand: (() => void) | undefined;
  /** Internal: the card intersects the viewport (with a margin). */
  declare onScreen: boolean;
  /** Internal: clock for the action's relative time. */
  declare now: number;
  private readonly browser = new BrowserViewController(this, connectBrowserView);
  private observer: IntersectionObserver | undefined;
  private clock: ReturnType<typeof setInterval> | undefined;
  /** An idle preview refreshes once per mount, then stays still. */
  private snapshotTaken = false;

  constructor() {
    super();
    this.sessionId = "";
    this.live = false;
    this.pending = false;
    this.visible = true;
    this.onExpand = undefined;
    this.onScreen = false;
    this.now = Date.now();
  }

  override connectedCallback() {
    super.connectedCallback();
    if (typeof IntersectionObserver === "function") {
      this.observer = new IntersectionObserver(([entry]) => { this.onScreen = Boolean(entry?.isIntersecting); }, { rootMargin: "160px 0px" });
      this.observer.observe(this);
    } else this.onScreen = true;
    this.clock = setInterval(() => { if (this.onScreen) this.now = Date.now(); }, 15_000);
  }

  override disconnectedCallback() {
    this.observer?.disconnect();
    this.observer = undefined;
    clearInterval(this.clock);
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: PropertyValues) {
    if (!changed.has("sessionId") && !changed.has("live") && !changed.has("visible") && !changed.has("onScreen")) return;
    if (changed.has("sessionId")) this.snapshotTaken = false;
    const shown = Boolean(this.sessionId) && this.visible && this.onScreen;
    if (shown && this.live) {
      this.browser.connect(this.sessionId, "stream");
    } else if (this.browser.mode === "stream") {
      // The turn ended or the card left the screen: keep the frame, stop streaming.
      this.browser.disconnect();
      if (!this.live) this.snapshotTaken = true;
    } else if (shown && !this.snapshotTaken) {
      this.snapshotTaken = true;
      this.browser.connect(this.sessionId, "snapshot");
    }
  }

  override render() {
    const { view, frame, action, pointer, connection } = this.browser;
    const display = browserPreviewDisplay({ view, frame, connection, live: this.live, pending: this.pending });
    if (display.body === "none") return nothing;
    const expand = this.onExpand;
    const screen = frame
      ? html`<img src=${frame.src} width=${frame.width} height=${frame.height} draggable="false"
          alt=${`What the agent's browser shows: ${display.title}`} />
        ${pointer ? keyed(pointer.key, html`<span class="hui-browser-pointer" aria-hidden="true" style=${`left:${pointer.left}%;top:${pointer.top}%`}></span>`) : nothing}`
      : html`<span class="hui-browser-preview__loading" role="status"><span class="session-run-spinner" aria-hidden="true"></span>${this.pending ? "Opening the page…" : "Waiting for the page…"}</span>`;
    return html`<div class="chat-assistant-attachment-card hui-browser-preview ${display.chip === "closed" ? "hui-browser-preview--closed" : ""}">
      <div class="chat-assistant-attachment-card__header chat-assistant-attachment-card__header--preview hui-browser-preview__header">
        <div class="chat-assistant-attachment-card__identity hui-browser-preview__identity">
          <span class="hui-browser-preview__icon" aria-hidden="true">${icons.globe}</span>
          <span class="chat-assistant-attachment-card__details">
            <span class="chat-assistant-attachment-card__title" title=${display.title}>${display.title}</span>
            ${display.url ? html`<span class="chat-assistant-attachment-card__meta hui-browser-preview__url" title=${display.url}>${display.url}</span>` : nothing}
          </span>
        </div>
        <span class="chat-assistant-attachment-card__actions">
          ${display.chip ? html`<span class="hui-browser-preview__chip hui-browser-preview__chip--${display.chip}">${display.chip === "live" ? html`<span class="hui-browser-preview__dot" aria-hidden="true"></span>` : nothing}${CHIP_TEXT[display.chip]}</span>` : nothing}
          ${expand ? html`<button type="button" class="chat-assistant-attachment-card__action hui-browser-preview__expand" aria-label="Open browser view" data-hui-tooltip="Open browser view" @click=${expand}>${icons.panelRightOpen}</button>` : nothing}
        </span>
      </div>
      ${expand && frame
        ? html`<button type="button" class="hui-browser-preview__screen" aria-label=${`Open ${display.title} in the browser view`} @click=${expand}>${screen}</button>`
        : html`<div class="hui-browser-preview__screen">${screen}</div>`}
      ${action ? html`<div class="hui-browser-preview__footer">
          <span class="hui-browser-preview__action" title=${action.text}>${action.text}</span>
          <time datetime=${action.at}>${relativeTime(action.at, Math.max(this.now, Date.parse(action.at) || 0))}</time>
        </div>` : nothing}
    </div>`;
  }
}

if (typeof customElements !== "undefined" && !customElements.get("hui-browser-preview")) customElements.define("hui-browser-preview", BrowserPreview);
