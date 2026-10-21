// OpenClaw 2026.9.5 provider: interactions retained; Gateway stores replaced by HUI session rows.
import { nothing, ReactiveElement, render } from "lit";
import type { SessionView } from "../../api/sessions.ts";
import { huiHovercardRow, t, type ProgressCard } from "./hui-hovercard-adapter.ts";
import { createPortaledHovercard, PortaledHovercardController } from "./portaled-hovercard.ts";
import { renderSessionHovercard } from "./session-hovercard.ts";
import { SESSION_MENU_OPEN_EVENT, sessionProgressHoverPlacementForTarget, sessionProgressHoverTargetFromEvent } from "./session-progress-hovercard-target.ts";
import "./session-hovercard.css";
const OPEN_DELAY_MS = 450;
const SWEEP_OPEN_DELAY_MS = 80;
const SKIP_DELAY_MS = 300;
const CLOSE_DELAY_MS = 100;
const EXIT_DURATION_MS = 100;
let nextHovercardId = 0;

function sessionHovercardMenuOpen(owner: ParentNode): boolean {
  return (
    owner.querySelector(
      '[data-session-menu][aria-expanded="true"], [data-catalog-session-menu][aria-expanded="true"], wa-dropdown.session-menu[open]',
    ) !== null
  );
}

export class SessionProgressHovercardProvider extends ReactiveElement {
  static override properties = { sessions: { attribute: false, noAccessor: true } };
  private sessionRows: readonly SessionView[] = [];
  set sessions(value: readonly SessionView[]) {
    this.sessionRows = value;
    if (this.open && this.hovercard.held) this.showCurrent();
  }
  get sessions(): readonly SessionView[] { return this.sessionRows; }
  private activeTarget: HTMLElement | null = null;
  private activeTrigger: HTMLElement | null = null;
  private activeSession: { sessionKey: string } | null = null;

  private get activeArtifactKey(): string | null {
    return this.activeSession?.sessionKey ?? null;
  }
  private open = false;
  private delayed = true;
  private animateNextOpen = true;
  private skipDelayTimer: number | null = null;
  private lastProgressCard: ProgressCard | null = null;
  private readonly hovercard = new PortaledHovercardController(
    () => this.close(true),
    CLOSE_DELAY_MS,
    () => this.close(),
  );
  private loadGeneration = 0;
  private readonly activeTargetObserver = new MutationObserver(() => {
    if (
      this.activeTarget &&
      (!this.contains(this.activeTarget) || sessionHovercardMenuOpen(this))
    ) {
      this.close();
      return;
    }
    if (this.open) {
      this.showCurrent();
    }
  });

  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.style.display = "contents";
    this.addEventListener("pointerover", this.handlePointerOver);
    this.addEventListener("pointerout", this.handlePointerOut);
    this.addEventListener("focusin", this.handleFocusIn);
    this.addEventListener("focusout", this.handleFocusOut);
    this.addEventListener("keydown", this.hovercard.handleTriggerKeyDown);
    this.addEventListener("click", this.handleClick);
    this.addEventListener(SESSION_MENU_OPEN_EVENT, this.handleSessionMenuOpen);
  }

  override disconnectedCallback(): void {
    this.removeEventListener("pointerover", this.handlePointerOver);
    this.removeEventListener("pointerout", this.handlePointerOut);
    this.removeEventListener("focusin", this.handleFocusIn);
    this.removeEventListener("focusout", this.handleFocusOut);
    this.removeEventListener("keydown", this.hovercard.handleTriggerKeyDown);
    this.removeEventListener("click", this.handleClick);
    this.removeEventListener(SESSION_MENU_OPEN_EVENT, this.handleSessionMenuOpen);
    this.close();
    this.clearSkipDelayTimer();
    super.disconnectedCallback();
  }

  private readonly handlePointerOver = (event: PointerEvent) => {
    if (event.pointerType === "touch" || !globalThis.matchMedia?.("(hover: hover)").matches) {
      return;
    }
    const target = sessionProgressHoverTargetFromEvent(event);
    if (!target || sessionHovercardMenuOpen(this)) {
      return;
    }
    const delayed = this.delayed;
    this.activate(target, target, delayed ? OPEN_DELAY_MS : SWEEP_OPEN_DELAY_MS, delayed);
    this.hovercard.pointerInside = true;
  };

  private readonly handlePointerOut = (event: PointerEvent) => {
    const target = sessionProgressHoverTargetFromEvent(event);
    if (!target || target !== this.activeTarget) {
      return;
    }
    if (event.relatedTarget instanceof Node && target.contains(event.relatedTarget)) {
      return;
    }
    this.hovercard.schedulePointerExit();
  };

  private readonly handleFocusIn = (event: FocusEvent) => {
    if (this.hovercard.restoringFocus) {
      return;
    }
    const target = sessionProgressHoverTargetFromEvent(event);
    const focused = event.target instanceof HTMLElement ? event.target : null;
    const trigger = target?.matches(".sidebar-recent-session")
      ? focused?.closest<HTMLElement>("a.sidebar-recent-session__link")
      : focused;
    if (!target || !trigger || sessionHovercardMenuOpen(this)) {
      return;
    }
    this.activate(target, trigger, 0, false);
    this.hovercard.focusInside = true;
  };

  private readonly handleFocusOut = (event: FocusEvent) => {
    if (!this.activeTarget) {
      return;
    }
    if (event.relatedTarget instanceof Node && this.activeTarget.contains(event.relatedTarget)) {
      return;
    }
    this.hovercard.focusInside = false;
    this.hovercard.scheduleClose();
  };

  private readonly handleClick = (event: Event) => {
    if (sessionProgressHoverTargetFromEvent(event)) {
      this.close();
    }
  };

  private readonly handleSessionMenuOpen = () => {
    this.close();
  };

  private activate(
    target: HTMLElement,
    trigger: HTMLElement,
    delay: number,
    animateEntry: boolean,
  ): void {
    const sessionKey = target.dataset.sessionKey;
    if (!sessionKey) {
      return;
    }
    const artifactKey = sessionKey;
    if (
      target === this.activeTarget &&
      sessionKey === this.activeSession?.sessionKey &&
      artifactKey === this.activeArtifactKey
    ) {
      if (trigger !== this.activeTrigger) {
        this.hovercard.reset();
        this.activeTrigger = trigger;
        this.hovercard.markTrigger(trigger);
        if (this.open) {
          this.showCurrent();
        } else {
          this.animateNextOpen = animateEntry;
          const generation = ++this.loadGeneration;
          this.hovercard.scheduleOpen(delay, () => void this.loadAndShow(sessionKey, generation));
        }
      }
      return;
    }
    this.close(delay > 0);
    this.activeTarget = target;
    this.activeTrigger = trigger;
    this.activeSession = { sessionKey };
    this.open = false;
    this.animateNextOpen = animateEntry;
    this.lastProgressCard = null;
    this.hovercard.markTrigger(trigger);
    this.activeTargetObserver.observe(this, {
      attributes: true,
      attributeFilter: ["aria-expanded"],
      childList: true,
      subtree: true,
    });
    const generation = ++this.loadGeneration;
    this.hovercard.scheduleOpen(delay, () => void this.loadAndShow(sessionKey, generation));
  }

  private async loadAndShow(sessionKey: string, generation: number): Promise<void> {
    const target = this.activeTarget;
    const artifactKey = this.activeArtifactKey;
    const session = this.activeSession;
    if (
      generation !== this.loadGeneration ||
      session?.sessionKey !== sessionKey ||
      !artifactKey ||
      !session ||
      !target ||
      sessionHovercardMenuOpen(this) ||
      !this.hovercard.held
    ) {
      return;
    }
    this.open = true;
    this.delayed = false;
    this.clearSkipDelayTimer();
    this.showCurrent();
  }

  private showCurrent(): void {
    const target = this.activeTarget;
    const session = this.activeSession;
    const sessionKey = session?.sessionKey;
    const artifactKey = this.activeArtifactKey;
    if (!target || !session || !sessionKey || !artifactKey || !this.open) {
      return;
    }
    const sessionView = this.sessionRows.find((row) => row.id === sessionKey);
    if (!sessionView) { this.close(); return; }
    const sidebarRow = huiHovercardRow(sessionView);
    this.lastProgressCard = sessionView.progress ?? null;
    const revision = JSON.stringify({ progress: this.lastProgressCard, row: sidebarRow });
    if (this.hovercard.card?.dataset.revision === revision) {
      return;
    }
    const mountedCard = this.hovercard.card;
    const focusedCardElement =
      mountedCard?.contains(document.activeElement) && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const focusedCardIndex = focusedCardElement
      ? this.hovercard.focusables().indexOf(focusedCardElement)
      : -1;
    const focusedHref =
      focusedCardElement instanceof HTMLAnchorElement ? focusedCardElement.href : null;
    const animateEntry = !mountedCard && this.animateNextOpen;
    let card = mountedCard;
    if (!card) {
      nextHovercardId += 1;
      card = createPortaledHovercard(
        `openclaw-session-progress-hovercard-${nextHovercardId}`,
        "session-progress-hovercard",
      );
      this.animateNextOpen = false;
      if (animateEntry) {
        card.dataset.open = "false";
      } else {
        card.dataset.instant = "true";
      }
    }
    card.dataset.revision = revision;
    card.setAttribute("aria-label", t("sessionHovercard.ariaLabel"));
    render(
      renderSessionHovercard({
        row: sidebarRow,
        progressCard: this.lastProgressCard,
      }),
      card,
    );
    if (!card.firstElementChild) {
      this.hovercard.clearCard();
      this.hovercard.pointerOverCard = false;
      this.hovercard.cardFocusInside = false;
      return;
    }
    if (mountedCard) {
      if (focusedCardElement && !card.contains(document.activeElement)) {
        const focusables = this.hovercard.focusables();
        const nextFocused =
          (focusedHref
            ? focusables.find(
                (element) => element instanceof HTMLAnchorElement && element.href === focusedHref,
              )
            : undefined) ?? focusables[focusedCardIndex];
        if (nextFocused) {
          nextFocused.focus({ preventScroll: true });
        } else {
          this.hovercard.cardFocusInside = false;
          this.hovercard.returnFocus(this.activeTrigger);
          this.hovercard.focusInside = document.activeElement === this.activeTrigger;
        }
      }
      this.hovercard.position();
      return;
    }
    card.addEventListener("pointerleave", this.handleCardPointerLeave);
    card.addEventListener("keydown", this.hovercard.handleCardKeyDown);
    this.hovercard.mount(target, card, sessionProgressHoverPlacementForTarget(target), false, () =>
      render(nothing, card),
    );
    if (animateEntry) {
      void card.offsetWidth;
      window.setTimeout(() => {
        if (this.hovercard.card === card && this.open) {
          card.dataset.open = "true";
        }
      }, 0);
    }
  }

  private readonly handleCardPointerLeave = () => {
    this.hovercard.pointerOverCard = false;
    this.hovercard.scheduleClose();
  };

  private close(animateExit = false): void {
    const wasOpen = this.open;
    this.hovercard.reset(animateExit ? EXIT_DURATION_MS : 0);
    this.loadGeneration += 1;
    this.open = false;
    this.animateNextOpen = true;
    this.lastProgressCard = null;
    this.activeTargetObserver.disconnect();
    this.activeTarget = null;
    this.activeTrigger = null;
    this.activeSession = null;
    if (wasOpen) {
      this.clearSkipDelayTimer();
      this.skipDelayTimer = window.setTimeout(() => {
        this.skipDelayTimer = null;
        this.delayed = true;
      }, SKIP_DELAY_MS);
    }
  }

  private clearSkipDelayTimer(): void {
    if (this.skipDelayTimer !== null) {
      window.clearTimeout(this.skipDelayTimer);
      this.skipDelayTimer = null;
    }
  }
}

customElements.define("hui-session-hovercard-provider", SessionProgressHovercardProvider);
