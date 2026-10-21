/**
 * The split workspace: lays out the layout's columns and stacks, and handles pane focus, resizing and drag and drop
 * of sessions and panes. It keeps recently shown sessions mounted per pane so switching back does not rebuild them.
 * The layout and each pane's contents belong to the caller, which renders panes and applies changes via callbacks.
 */
import { html, nothing, render, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { HuiElement } from "../lit/hui-element.ts";
import { SessionViewCache } from "../lib/session/view-cache.ts";
import { HUI_PANE_DRAG_TYPE, HUI_SESSION_DRAG_TYPE, readSessionDragId } from "../lib/session/pane-layout.ts";
import { SESSION_SPLIT_MEDIA, sessionDropRect, sessionDropZone, sessionPanes, sessionPaneMoveTarget, spotTabs, visibleSessionPanes, type DropZone, type PaneRect, type SessionLayout, type SessionPane, type SplitDirection } from "../lib/session/multiplexer.ts";
import { icons } from "../lib/icons.ts";
import { PANE_COLUMN_MIN_WIDTH, sessionPaneGeometry } from "../lib/session/pane-geometry.ts";
import "./resizable-divider.ts";

export type PanePresentation = { active: boolean; visible: boolean; narrow: boolean; split: boolean };
type DropPreview = { paneId: string; zone: DropZone; rect: PaneRect; moving: boolean };
const rectStyle = (rect: PaneRect) => `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px`;

/** Same columns/stacks, focus, drop geometry and narrow-layout policy as the
 * installed OpenClaw chat page. Session contents remain HUI/PI-owned. */
@customElement("hui-session-multiplexer")
export class SessionMultiplexer extends HuiElement {
  @property({ attribute: false }) layout!: SessionLayout;
  @property({ attribute: false }) renderPane!: (pane: SessionPane, state: PanePresentation) => TemplateResult;
  @property({ attribute: false }) onFocusPane!: (id: string) => void;
  @property({ attribute: false }) onDropSession!: (sessionId: string, paneId: string, zone: DropZone) => void;
  @property({ attribute: false }) onMovePane!: (sourceId: string, targetId: string, zone: DropZone) => void;
  @property({ attribute: false }) onResize!: (columnId: string | undefined, index: number, ratio: number) => void;
  @property({ attribute: false }) onResizeEnd!: () => void;
  @property({ attribute: false }) onClosePane!: (id: string) => void;
  @property({ attribute: false }) paneLabel!: (pane: SessionPane) => string;
  @property() draggingSessionId = "";
  @property({ attribute: false }) sessionIds: ReadonlySet<string> | undefined;
  /** The narrowest a chat column may get while there is room for it (420px beside an open Work pane). */
  @property({ type: Number }) columnMinimum = PANE_COLUMN_MIN_WIDTH;
  @state() narrow = false;
  @state() private viewportWidth = 0;
  @state() private viewportHeight = 0;
  @state() private announcement = "";
  private draggingPaneId = "";
  /** A tab activated from the keyboard moves to another cell; refocus it there. */
  private focusTab = "";
  private dragFromControl = false;
  private resizeObserver: ResizeObserver | undefined;
  private resizeFrame: number | undefined;
  private media: MediaQueryList | undefined;
  private readonly retained = new Map<string, SessionViewCache>();
  private readonly viewport = (event: MediaQueryListEvent) => { this.narrow = event.matches; this.clearDrag(); };
  private readonly clearDrop = () => { this.showDrop(undefined); };
  private readonly clearDrag = () => {
    this.draggingPaneId = "";
    this.querySelectorAll(".hui-pane-dragging").forEach((cell) => cell.classList.remove("hui-pane-dragging"));
    this.clearDrop();
  };
  private readonly escapeDrag = (event: KeyboardEvent) => {
    if (event.key === "Escape" && this.draggingPaneId) {
      // Cancel layout dragging, not the running agent's turn.
      event.stopPropagation();
      this.clearDrag();
    }
  };
  private readonly refreshRetention = () => { this.requestUpdate(); };

  override connectedCallback() {
    super.connectedCallback();
    this.media = window.matchMedia(SESSION_SPLIT_MEDIA);
    this.narrow = this.media.matches;
    this.media.addEventListener("change", this.viewport);
    window.addEventListener("dragend", this.clearDrag);
    window.addEventListener("blur", this.clearDrag);
    window.addEventListener("keydown", this.escapeDrag, true);
    this.addEventListener("dragstart", this.dragStart);
    this.addEventListener("pointerdown", this.prepareDrag, true);
    this.addEventListener("keydown", this.moveKey);
    this.addEventListener("dragover", this.dragOver);
    this.addEventListener("drop", this.drop);
    this.addEventListener("dragleave", this.dragLeave);
    this.addEventListener("hui-queue-edit-retention", this.refreshRetention);
  }

  override disconnectedCallback() {
    this.resizeObserver?.disconnect();
    if (this.resizeFrame !== undefined) cancelAnimationFrame(this.resizeFrame);
    this.resizeFrame = undefined;
    this.media?.removeEventListener("change", this.viewport);
    window.removeEventListener("dragend", this.clearDrag);
    window.removeEventListener("blur", this.clearDrag);
    window.removeEventListener("keydown", this.escapeDrag, true);
    this.removeEventListener("dragstart", this.dragStart);
    this.removeEventListener("pointerdown", this.prepareDrag, true);
    this.removeEventListener("keydown", this.moveKey);
    this.removeEventListener("dragover", this.dragOver);
    this.removeEventListener("drop", this.drop);
    this.removeEventListener("dragleave", this.dragLeave);
    this.removeEventListener("hui-queue-edit-retention", this.refreshRetention);
    super.disconnectedCallback();
  }

  override firstUpdated() {
    const viewport = this.querySelector<HTMLElement>(".hui-pane-viewport")!;
    this.resizeObserver = new ResizeObserver(() => {
      // Geometry can add/remove scrollbars. Defer writes out of observer
      // delivery so the resulting viewport change starts a new resize cycle.
      if (this.resizeFrame !== undefined) return;
      this.resizeFrame = requestAnimationFrame(() => {
        this.resizeFrame = undefined;
        this.viewportWidth = viewport.clientWidth;
        this.viewportHeight = viewport.clientHeight;
      });
    });
    this.resizeObserver.observe(viewport);
  }

  private prepareDrag = (event: PointerEvent) => {
    // dragstart's target is the draggable header, not necessarily the button
    // under the original pointer. Preserve ordinary header controls.
    this.dragFromControl = event.composedPath().some((node) => node instanceof Element
      && node.matches("button,a,input,textarea,select,wa-dropdown,[contenteditable=true]")
      && !node.matches(".hui-pane-move-handle"));
  };

  private dragStart = (event: DragEvent) => {
    const target = event.target instanceof Element ? event.target : undefined;
    const tab = target?.closest<HTMLElement>("[data-tab-pane]");
    const header = tab ?? target?.closest(".chat-pane__header");
    if (!header) return;
    const cell = header.closest<HTMLElement>("[data-session-pane]");
    const control = event.composedPath().find((node) => node instanceof Element && node.matches("button,a,input,textarea,select,wa-dropdown,[contenteditable=true]"));
    if (this.narrow || this.dragFromControl || !cell || !event.dataTransfer || sessionPanes(this.layout).length < 2
      || (control instanceof Element && !control.matches(".hui-pane-move-handle"))) {
      event.preventDefault();
      return;
    }
    this.draggingPaneId = tab?.dataset.tabPane ?? cell.dataset.sessionPane!;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(HUI_PANE_DRAG_TYPE, this.draggingPaneId);
    (tab ?? cell).classList.add("hui-pane-dragging");
    event.stopPropagation();
  };

  private moveKey = (event: KeyboardEvent) => {
    if (this.narrow || !(event.target instanceof Element) || !event.target.closest(".hui-pane-move-handle")) return;
    const direction = ({ ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" } as Record<string, SplitDirection>)[event.key];
    if (!direction) return;
    event.preventDefault();
    event.stopPropagation();
    const source = event.target.closest<HTMLElement>("[data-session-pane]")?.dataset.sessionPane;
    const target = source && sessionPaneMoveTarget(this.layout, source, direction);
    if (source && target) {
      this.onMovePane(source, target, { kind: "edge", edge: direction });
      this.announcement = `Panel moved ${direction}.`;
    }
  };

  private preview(event: DragEvent): DropPreview | undefined {
    const moving = Boolean(this.draggingPaneId && event.dataTransfer?.types.includes(HUI_PANE_DRAG_TYPE));
    if (this.narrow || (!moving && !event.dataTransfer?.types.includes(HUI_SESSION_DRAG_TYPE))) return;
    const cell = (event.target as Element | null)?.closest<HTMLElement>("[data-session-pane]");
    const container = this.querySelector(".chat-split-view__drop-container");
    if (!cell || !container || !this.contains(cell)) return;
    const bounds = cell.getBoundingClientRect();
    // The tab row, or the header when there is none, adds the dragged view as a tab.
    const strip = (cell.querySelector(".hui-pane-tabs") ?? cell.querySelector(".chat-pane-cache__pane--visible .chat-pane__header"))?.getBoundingClientRect();
    const zone: DropZone = strip && event.clientY <= strip.bottom ? { kind: "tab" } : sessionDropZone(bounds, event.clientX, event.clientY);
    if (moving) {
      const spot = visibleSessionPanes(this.layout).find(({ id }) => id === cell.dataset.sessionPane);
      const tabs = spot ? spotTabs(spot) : [];
      // In its own spot a view can only be split out, and only if other tabs stay.
      if (tabs.some(({ id }) => id === this.draggingPaneId) && (zone.kind !== "edge" || tabs.length < 2)) return;
    }
    // DOMRect sizes are prototype getters, so copy them rather than spreading.
    const rect = zone.kind === "tab" ? { left: strip!.left, top: strip!.top, width: strip!.width, height: strip!.height } : sessionDropRect(bounds, zone);
    const origin = container.getBoundingClientRect();
    return { paneId: cell.dataset.sessionPane!, zone, moving, rect: { ...rect, left: rect.left - origin.left, top: rect.top - origin.top } };
  }

  private dragOver = (event: DragEvent) => {
    const preview = this.preview(event);
    if (!preview) { this.clearDrop(); return; }
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = preview.moving ? "move" : "copy";
    this.showDrop(preview);
  };

  /** Dragover fires continuously. Rendering its preview apart from the panes
   * keeps every pointer move from re-rendering each open session. */
  private showDrop(preview: DropPreview | undefined) {
    const host = this.querySelector<HTMLElement>(".hui-pane-drop-host");
    if (host) render(preview ? html`<div class="chat-split-view__drop-indicator ${preview.zone.kind === "center" ? "chat-split-view__drop-indicator--center" : ""}" style=${rectStyle(preview.rect)}>
      <span class="chat-split-view__drop-indicator-label">${preview.zone.kind === "tab" ? "Add as tab" : preview.moving ? preview.zone.kind === "center" ? "Swap panels" : "Move panel" : preview.zone.kind === "center" ? "Open here" : "Split"}</span>
    </div>` : nothing, host);
  }

  private dragLeave = (event: DragEvent) => {
    if (!(event.relatedTarget instanceof Node) || !this.contains(event.relatedTarget)) this.clearDrop();
  };

  private drop = (event: DragEvent) => {
    const preview = this.preview(event);
    const id = readSessionDragId(event.dataTransfer) || this.draggingSessionId;
    const source = this.draggingPaneId;
    this.clearDrag();
    if (!preview) return;
    event.preventDefault();
    event.stopPropagation();
    if (preview.moving && source === event.dataTransfer?.getData(HUI_PANE_DRAG_TYPE)) {
      this.onMovePane(source, preview.paneId, preview.zone);
      this.announcement = preview.zone.kind === "center" ? "Panels swapped." : preview.zone.kind === "tab" ? "Panel added as a tab." : `Panel moved ${preview.zone.edge}.`;
    } else if (!preview.moving && id) this.onDropSession(id, preview.paneId, preview.zone);
  };

  override updated() {
    if (!this.focusTab) return;
    this.querySelector<HTMLElement>(`[data-tab-pane="${CSS.escape(this.focusTab)}"] [role="tab"]`)?.focus();
    this.focusTab = "";
  }

  private renderTabs(tabs: SessionPane[], shownId: string) {
    const activate = (id: string, focus = false) => {
      // Showing another tab moves the tab row to that tab's cell; refocus it there.
      if (focus && id !== shownId) this.focusTab = id;
      this.onFocusPane(id);
    };
    return html`<div class="hui-pane-tabs" role="tablist" aria-label="Panel tabs">${tabs.map((tab, index) => {
      const label = this.paneLabel(tab);
      const shown = tab.id === shownId;
      return html`<div class="hui-pane-tab ${shown ? "hui-pane-tab--active" : ""}" role="presentation" draggable="true" data-tab-pane=${tab.id} title=${label}>
        <div class="hui-pane-tab__select" role="tab" aria-selected=${String(shown)} tabindex=${shown ? "0" : "-1"}
          @click=${() => activate(tab.id)}
          @keydown=${(event: KeyboardEvent) => {
            const next = event.key === "ArrowLeft" ? tabs[index - 1] : event.key === "ArrowRight" ? tabs[index + 1] : event.key === "Enter" || event.key === " " ? tab : undefined;
            if (!next) return;
            event.preventDefault();
            activate(next.id, true);
          }}
        >${icons.messageSquare}<span class="hui-pane-tab__label">${label}</span></div>
        <button type="button" class="hui-pane-tab__close" aria-label=${`Close ${label}`} title="Close tab"
          @click=${(event: Event) => { event.stopPropagation(); this.onClosePane(tab.id); }}>${icons.close}</button>
      </div>`;
    })}</div>`;
  }

  override render() {
    if (!this.layout) return nothing;
    const layout = this.layout;
    const panes = sessionPanes(layout);
    const split = panes.length > 1;
    for (const id of this.retained.keys()) if (!panes.some((pane) => pane.id === id)) this.retained.delete(id);
    const slots = new Map<string, readonly string[]>(panes.map((pane) => {
      const cache = this.retained.get(pane.id) ?? new SessionViewCache();
      this.retained.set(pane.id, cache);
      if (this.sessionIds) cache.removeMissing(this.sessionIds);
      const protectedIds = new Set([...this.querySelectorAll<HTMLElement & { hasQueuedMessageEdit: boolean; paneSessionId: string }>(
        `[data-session-pane="${CSS.escape(pane.id)}"] hui-app`,
      )].filter((app) => app.hasQueuedMessageEdit).map((app) => app.paneSessionId));
      return [pane.id, cache.retain(pane.sessionId, protectedIds)] as const;
    }));
    const geometry = sessionPaneGeometry(layout, this.viewportWidth, this.viewportHeight, this.columnMinimum);
    const canvas = this.narrow ? { width: this.viewportWidth, height: this.viewportHeight } : geometry;
    // DOM order never follows layout order: even Lit's keyed reparenting would
    // disconnect custom elements and tear down their streams/terminal canvases.
    const stablePanes = [...panes].sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
    const spots = new Map(visibleSessionPanes(layout).map((spot) => [spot.id, spot]));
    return html`<div class="chat-split-view__drop-container">
      <div class="chat-split-view hui-pane-viewport ${this.narrow ? "chat-split-view--narrow" : ""}"
        role="region" aria-label="Session workspace" @scroll=${this.clearDrop}>
        <div class="hui-pane-canvas" style=${`width:${canvas.width}px;height:${canvas.height}px`}>
          ${repeat(stablePanes, (pane) => pane.id, (pane) => {
            const active = pane.id === layout.activePaneId;
            const spot = spots.get(pane.id);
            const visible = this.narrow ? active : Boolean(spot);
            const rect = this.narrow ? { left: 0, top: 0, ...canvas } : geometry.panes.get(pane.id)!;
            return html`<div
              class="chat-split-view__cell ${split && active ? "chat-split-view__cell--active" : ""} ${!visible ? this.narrow ? "chat-split-view__cell--narrow-hidden" : "chat-split-view__cell--tab-hidden" : ""} ${rect.left === 0 && rect.top === 0 ? "chat-split-view__cell--origin" : ""}"
              data-session-pane=${pane.id} aria-current=${split && active ? "true" : nothing}
              style=${rectStyle(rect)}
              @pointerdown=${() => this.onFocusPane(pane.id)} @focusin=${() => this.onFocusPane(pane.id)}
            >${!this.narrow && spot?.tabs ? this.renderTabs(spotTabs(spot), pane.id) : nothing}<div class="chat-pane-cache">
              ${repeat(slots.get(pane.id) ?? [], (id) => id, (id) => {
                const current = id === pane.sessionId;
                return html`<div class="chat-pane-cache__pane ${current ? "chat-pane-cache__pane--visible" : ""} ${current && active ? "chat-pane-cache__pane--active" : ""}"
                  ?inert=${!visible || !current} aria-hidden=${String(!visible || !current)}
                >${this.renderPane({ ...pane, sessionId: id }, { active: current && active, visible: current && visible, narrow: this.narrow, split })}</div>`;
              })}
            </div></div>`;
          })}
          ${this.narrow ? nothing : repeat(geometry.dividers, (divider) => divider.id, (divider) => html`<resizable-divider
            style=${rectStyle(divider)} orientation=${divider.columnId ? "horizontal" : "vertical"}
            .splitRatio=${divider.ratio} .resizeExtent=${divider.extent} .minRatio=${divider.minRatio} .maxRatio=${divider.maxRatio} label="Resize"
            @resize=${(event: CustomEvent<{ splitRatio: number }>) => this.onResize(divider.columnId, divider.index, event.detail.splitRatio)}
            @resize-end=${this.onResizeEnd}
          ></resizable-divider>`)}
        </div>
      </div>
      <div class="hui-pane-drop-host"></div>
      <span class="hui-pane-announcement" role="status">${this.announcement}</span>
    </div>`;
  }
}
