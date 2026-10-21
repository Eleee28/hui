/** Independent OpenClaw render proof, not a clone of HUI's DOM.
 * The read-only oracle exposes unmodified private render functions from the
 * hash-pinned shipped module. Only deterministic props and no-op callbacks are
 * supplied here. No Gateway, PI write or production dependency is involved. */
import { VISUAL_PROPERTIES } from "./visual-style-probe.js";
import { applyOriginalTheme } from "./original-theme-probe.js";

export async function compareOriginalComposer({ running = false, effortDisabled = false, openEffort = false } = {}, oracle = "http://127.0.0.1:43130") {
  const live = document.querySelector(".chat .agent-chat__composer-shell");
  if (!live) throw new Error("Open a chat before checking its original renderer");
  const settle = async (doc) => {
    await doc.fonts.ready;
    for (;;) {
      doc.documentElement.getBoundingClientRect();
      const active = doc.getAnimations().filter((animation) =>
        (animation.playState === "running" || animation.pending)
        && Number.isFinite(animation.effect?.getComputedTiming().endTime));
      if (!active.length) break;
      await Promise.all(active.map((animation) => animation.finished.catch(() => {})));
    }
  };
  await settle(document);
  const originalFocus = document.activeElement;
  const selectors = [".agent-chat__input", ".agent-chat__composer-input-row", ".agent-chat__composer-combobox", "textarea", ".agent-chat__composer-footer", ".agent-chat__input-btn--attach", ".agent-chat__input-btn--attach svg", ".chat-send-btn", ".chat-send-btn svg", ".chat-controls__effort-trigger", ".chat-controls__effort-gauge svg"];
  if (openEffort) selectors.push(".chat-controls__effort-menu", ".chat-controls__reasoning-panel", ".chat-controls__reasoning-head", ".chat-controls__reasoning-range", ".chat-controls__effort-scale");
  const properties = [...VISUAL_PROPERTIES, "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin"];
  const read = (node, selector, side) => {
    if (!node) throw new Error(`Missing ${side} comparison subject: ${selector}`);
    const style = node.ownerDocument.defaultView.getComputedStyle(node);
    return Object.fromEntries(properties.map((key) => [key, style.getPropertyValue(key)]));
  };
  // Capture before mounting the original: its real lifecycle can focus a
  // control, which would blur HUI and change the very state being measured.
  const subjects = selectors.map((selector) => ({ selector, hui: read(live.querySelector(selector), selector, "HUI") }));
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  Object.assign(frame.style, { position: "fixed", left: "0", top: "0", width: `${innerWidth}px`, height: `${innerHeight}px`, opacity: "0", pointerEvents: "none", border: "0" });
  frame.srcdoc = `<!doctype html><html><head><link rel="stylesheet" href="${oracle}/assets/control-ui-core-DvoiO6cr.css"><link rel="stylesheet" href="${oracle}/assets/control-ui-boot-shared-BahwINek.css"><link rel="stylesheet" href="${oracle}/reference.css"></head><body><div id="fixture"></div><script type="module">try { const [m, lit] = await Promise.all([import("${oracle}/assets/hui-original-chat-audit.js"), import("${oracle}/assets/lit-runtime-CIjzngcy.js")]); m.auditInit(); window.original = m; window.renderOriginal = lit.et; document.body.dataset.ready = "true"; } catch(error) { document.body.dataset.error = error.stack; }</script></body></html>`;
  const loaded = new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
  document.body.append(frame);
  try {
    await loaded;
    const doc = frame.contentDocument;
    if (doc.body.dataset.error) throw new Error(doc.body.dataset.error);
    if (!doc.body.dataset.ready) await new Promise((resolve, reject) => {
      const observer = new MutationObserver(() => {
        if (doc.body.dataset.error || doc.body.dataset.ready) {
          observer.disconnect(); clearTimeout(timeout);
          doc.body.dataset.error ? reject(new Error(doc.body.dataset.error)) : resolve();
        }
      });
      const timeout = setTimeout(() => { observer.disconnect(); reject(new Error("Original renderer did not initialize")); }, 15000);
      observer.observe(doc.body, { attributes: true });
    });
    for (const attr of document.documentElement.attributes) doc.documentElement.setAttribute(attr.name, attr.value);
    await applyOriginalTheme(doc, oracle);
    doc.documentElement.classList.toggle("wa-light", doc.documentElement.dataset.themeMode === "light");
    doc.documentElement.classList.toggle("wa-dark", doc.documentElement.dataset.themeMode === "dark");
    const m = doc.defaultView.original;
    const { html, nothing } = m.auditPrimitives();
    const noop = () => {};
    const draft = live.querySelector("textarea").value;
    const level = document.querySelector(".chat-controls__reasoning-range")?.value ?? "3";
    const values = ["off", "minimal", "low", "medium", "high", "xhigh"];
    const labels = ["Off", "Minimal", "Low", "Medium", "High", "Maximum"];
    const effort = m.auditEffort({
      disabled: effortDisabled, thinkingDisabled: effortDisabled, sessionKey: "fixture",
      fastMode: { supported: false, active: false },
      thinking: { options: values.map((value, index) => ({ value, label: labels[index] })), inherited: { displayLabel: "Low" }, selection: { kind: "anchored", source: "override", value: values[Number(level)], index: Number(level), displayLabel: labels[Number(level)] } },
      onThinkingSelect: async () => {}, onFastModeSelect: async () => {}, onRequestUpdate: noop,
    });
    const context = {
      props: { paneId: "fixture", attachments: [], draft, queue: [], connected: true, onDraftChange: noop, onAttachmentsChange: noop, onPendingReadsChange: noop },
      state: { emojiMenu: { render: () => nothing }, mentionMenu: { close: noop }, textareaRef: (element) => {
        if (element instanceof doc.defaultView.HTMLTextAreaElement) {
          m.auditObserveTextarea(element);
          m.auditScheduleTextarea(element);
        }
      } },
      canCompose: true, showAbortableUi: running, visibleDraft: draft, contextNotice: nothing,
      composerControls: html`<div class="chat-controls__session chat-controls__model chat-controls__model-settings">${effort}</div>`, composerLeadControl: nothing,
      runStatusAnnouncement: "", composerRunStatus: null, requestUpdate: noop,
      sendShortcut: "enter", questionPanelProps: null, showComposer: true, placeholder: "Send a message…",
      handleKeyDown: noop, handleBeforeInput: noop, handleInput: noop, handleSelect: noop,
      handleCompositionEnd: noop, handleBlur: noop, draftKey: "fixture", mentionError: null,
      activeSlashMenuOptionLabel: "", slashMenuAnnouncementId: "fixture-announcement",
      runControlsProps: { canAbort: running, canSend: true, connected: true, draft, isBusy: false, sending: false, onSend: noop, onAbort: noop, followUpMode: "steer" },
      goalComposer: { render: () => nothing, pending: false },
    };
    const chat = live.closest(".chat");
    const fixture = doc.getElementById("fixture");
    // Fixed fixture ancestors are taken from upstream chat-view.ts. Width is
    // supplied as a constraint, not copied child markup or computed styling.
    fixture.className = document.querySelector(".shell--mobile-nav") ? "shell--mobile-nav" : "";
    doc.defaultView.renderOriginal(html`<section class="chat" style=${`width:${chat.getBoundingClientRect().width}px;height:${chat.getBoundingClientRect().height}px`}><div class="chat-compose">${m.auditComposer(context)}</div></section>`, fixture);
    await doc.fonts.ready;
    await Promise.all([...doc.querySelectorAll("*")].map((node) => node.updateComplete).filter(Boolean));
    if (openEffort) {
      fixture.querySelector(".chat-controls__effort-trigger").click();
      const popup = fixture.querySelector(".chat-controls__effort-picker wa-popup");
      await new Promise((resolve, reject) => {
        const ready = () => popup.active && fixture.querySelector(".chat-controls__effort-menu").getBoundingClientRect().height > 0;
        if (ready()) { resolve(); return; }
        const observer = new MutationObserver(() => {
          if (ready()) { observer.disconnect(); clearTimeout(timeout); resolve(); }
        });
        const timeout = setTimeout(() => { observer.disconnect(); reject(new Error("Original Effort popup did not open")); }, 5000);
        observer.observe(fixture, { subtree: true, attributes: true, childList: true });
      });
      await popup.updateComplete;
    }
    // Match the real focused control using native focus in the reference frame.
    // Capture HUI first: focus cannot belong to two documents simultaneously.
    const focusedSelector = selectors.find((selector) => live.querySelector(selector) === originalFocus);
    if (focusedSelector) fixture.querySelector(focusedSelector).focus({ preventScroll: true });
    else doc.activeElement?.blur?.();
    await settle(doc);
    return subjects.map(({ selector, hui }) => {
      const original = read(fixture.querySelector(selector), selector, "original");
      const differences = Object.fromEntries(properties.filter((key) => hui[key] !== original[key]).map((key) => [key, { hui: hui[key], original: original[key] }]));
      const adaptations = [];
      if (selector === ".chat-controls__effort-menu") {
        // Upstream unconditionally renders Fast mode even when unsupported.
        // PI has no such capability. Account for its measured row explicitly;
        // never mutate/delete the original DOM to hide this product difference.
        const row = fixture.querySelector(".chat-controls__fast-mode-row").getBoundingClientRect().height;
        const delta = parseFloat(original.height) - parseFloat(hui.height);
        if (Math.abs(delta - row) < 0.02) {
          adaptations.push({ property: "height", hui: hui.height, original: original.height, omittedFastModeRow: row });
          delete differences.height;
        }
      }
      return { selector, differences, ...(adaptations.length ? { adaptations } : {}) };
    });
  } finally {
    frame.remove();
    if (originalFocus instanceof HTMLElement && originalFocus.isConnected && document.activeElement !== originalFocus) originalFocus.focus({ preventScroll: true });
  }
}
