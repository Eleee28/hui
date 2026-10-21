/** Independent original transcript renderer for actual normalized messages.
 * Rich probes compare the current Markdown subset, never arbitrary parser
 * equivalence or media/tool support which needs separate original renderers. */
import { VISUAL_PROPERTIES } from "./visual-style-probe.js";
import { applyOriginalTheme } from "./original-theme-probe.js";

export async function compareOriginalTranscript(oracle = "http://127.0.0.1:43130", options = {}) {
  const chat = document.querySelector(".chat");
  const liveGroups = options.messageId
    ? [chat.querySelector(`[data-message-id="${CSS.escape(options.messageId)}"]`)?.closest(".chat-group")]
    : ["user", "assistant"].map((role) => [...chat.querySelectorAll(`.chat-group.${role}`)].at(-1));
  if (liveGroups.some((group) => !group)) throw new Error("Open a fixture transcript with both message roles");
  const liveMenu = document.querySelector(".chat-reply-context-menu:popover-open");
  const menuSelectors = [".chat-reply-context-menu", ".chat-reply-context-menu button", ".chat-reply-context-menu [data-copy-label]"];
  const menuSnapshot = liveMenu ? menuSelectors.map((selector) => {
    const node = document.querySelector(selector), style = getComputedStyle(node);
    return { selector, states: ["hover", "focus", "focus-visible", "focus-within"].filter((state) => node.matches(`:${state}`)), style: Object.fromEntries(VISUAL_PROPERTIES.map((key) => [key, style.getPropertyValue(key)])) };
  }) : null;
  const originalFocus = document.activeElement;
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  Object.assign(frame.style, { position: "fixed", left: "0", top: "0", width: `${innerWidth}px`, height: `${innerHeight}px`, opacity: "0", pointerEvents: "none", border: "0" });
  frame.srcdoc = `<!doctype html><html><head><link rel="stylesheet" href="${oracle}/assets/control-ui-core-DvoiO6cr.css"><link rel="stylesheet" href="${oracle}/assets/control-ui-boot-shared-BahwINek.css"><link rel="stylesheet" href="${oracle}/reference-state.css"></head><body><section class="chat"><div class="chat-main__conversation"><div class="chat-thread chat-thread--direct"><div id="fixture" class="chat-thread-inner"></div></div></div></section></body></html>`;
  const loaded = new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
  document.body.append(frame);
  try {
    await loaded;
    const doc = frame.contentDocument;
    await applyOriginalTheme(doc, oracle);
    const script = doc.createElement("script");
    script.type = "module";
    script.textContent = `try { const [chat, lit] = await Promise.all([import("${oracle}/assets/hui-original-chat-audit.js"),import("${oracle}/assets/lit-runtime-CIjzngcy.js")]); chat.auditInitTranscript(); window.transcriptOracle={chat,render:lit.et}; } catch(error) { window.transcriptOracleError=String(error.stack); } document.dispatchEvent(new Event("transcript-oracle-ready"));`;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Original transcript did not initialize")), 15000);
      doc.addEventListener("transcript-oracle-ready", () => { clearTimeout(timeout); resolve(); }, { once: true });
      doc.head.append(script);
    });
    if (doc.defaultView.transcriptOracleError) throw new Error(doc.defaultView.transcriptOracleError);
    const { chat: original, render } = doc.defaultView.transcriptOracle;
    const groups = liveGroups.map((group, index) => {
      const role = group.classList.contains("assistant") ? "assistant" : "user";
      const messageId = group.querySelector("[data-message-id]").dataset.messageId;
      // Read the actual normalized message, never reconstruct Markdown from DOM.
      const message = document.querySelector("hui-app").transcript.find((item) => item.id === messageId);
      if (!message) throw new Error(`Missing normalized message ${messageId}`);
      const text = message.text;
      if (!options.messageId && group.querySelector(".chat-text h1,.chat-text ul,.chat-text pre,.chat-assistant-attachments")) {
        throw new Error("This probe requires plain text, not lossy Markdown reconstruction");
      }
      return { role, key: `original-${index}`, messages: [{ key: `message-${index}`, message: { role, content: [{ type: "text", text }] } }], isStreaming: false };
    });
    doc.querySelector(".chat").style.width = `${chat.clientWidth}px`;
    const fixture = doc.getElementById("fixture");
    render(groups.map((group) => original.auditMessageGroup(group, {
      assistantName: "pi", userName: "You", showOwnSenderName: true,
      avatarPlacement: "none", showReasoning: true, showToolCalls: false,
      sessionKey: "fixture", onRequestUpdate: () => {},
    })), fixture);
    if (options.attachment) {
      // HUI currently retains names, not downloadable media or preview bytes.
      // Compare the original compact file card with the same supported props.
      const host = doc.createElement("div");
      host.className = "chat-assistant-attachments";
      const bubble = fixture.querySelector(".chat-bubble");
      bubble.classList.add("chat-bubble--with-files");
      bubble.prepend(host);
      render(original.auditCompactAttachment({ kind: "document", label: options.attachment }), host);
    }
    await doc.fonts.ready;
    await Promise.all([...doc.querySelectorAll("*")].map((node) => node.updateComplete).filter(Boolean));
    if (options.codeState) {
      const controls = await doc.defaultView.eval(`import("${oracle}/assets/hui-original-sidebar-audit.js")`);
      const target = fixture.querySelector(".code-block-wrapper");
      target.addEventListener("click", (event) => controls.auditCodeDisclosure(event.target));
      controls.auditCodeOverflow(target);
      if (options.codeState.expanded) target.querySelector(".code-block-expand").click();
      if (options.codeState.wrapped) target.querySelector(".code-block-wrap").click();
    }
    await new Promise((resolve) => doc.defaultView.requestAnimationFrame(() => doc.defaultView.requestAnimationFrame(resolve)));
    const selectors = options.selectors ?? [".chat-group", ".chat-group-messages", ".chat-bubble", ".chat-text", ".chat-group-footer", ".chat-group-footer__meta", ".chat-sender-name", ".chat-group-footer-actions", ".chat-copy-btn", ".chat-copy-btn svg"];
    // A pointer cannot hover both documents. Project actual pseudo-class state
    // into the oracle's state-only selectors; declarations stay original.
    for (const [index, live] of liveGroups.entries()) {
      const target = fixture.querySelector(`.chat-group.${groups[index].role}`);
      for (const selector of selectors) {
        const a = selector === ".chat-group" ? live : live.querySelector(selector);
        const b = selector === ".chat-group" ? target : target.querySelector(selector);
        if (a && b) for (const state of ["hover", "focus", "focus-visible", "focus-within"]) {
          b.toggleAttribute(`data-reference-${state}`, a.matches(`:${state}`));
        }
      }
    }
    doc.documentElement.getBoundingClientRect();
    await Promise.all(doc.getAnimations().filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime)).map((animation) => animation.finished.catch(() => {})));
    const results = liveGroups.map((live, index) => ({ role: groups[index].role, records: selectors.map((selector) => {
      const target = fixture.querySelector(`.chat-group.${groups[index].role}`);
      const a = selector === ".chat-group" ? live : live.querySelector(selector);
      const b = selector === ".chat-group" ? target : target.querySelector(selector);
      if (!a && !b) return { selector, expectedAbsent: true, differences: {} };
      if (!a || !b) return { selector, differences: { missing: { hui: !a, original: !b } } };
      const hui = getComputedStyle(a), reference = doc.defaultView.getComputedStyle(b);
      const differences = Object.fromEntries(VISUAL_PROPERTIES.filter((key) => hui.getPropertyValue(key) !== reference.getPropertyValue(key)).map((key) => [key, { hui: hui.getPropertyValue(key), original: reference.getPropertyValue(key) } ]));
      const adaptations = [];
      if (selector === ".chat-group-footer__meta" && differences.width) {
        // HUI's current normalized transcript has no timestamp capability.
        // Retain the original timestamp DOM and account only for its measured
        // intrinsic width plus the original gap, never hide an arbitrary diff.
        const time = b.querySelector(".chat-group-timestamp");
        const omitted = time?.getBoundingClientRect().width + parseFloat(reference.gap);
        const delta = parseFloat(reference.width) - parseFloat(hui.width);
        if (Number.isFinite(omitted) && Math.abs(delta - omitted) < 0.02) {
          adaptations.push({ property: "width", omittedTimestampAndGap: omitted, reason: "Timestamp is absent from the current PI/HUI transcript contract" });
          delete differences.width;
        }
      }
      return { selector, differences, ...(adaptations.length ? { adaptations } : {}) };
    }) }));
    if (menuSnapshot) {
      const bubble = fixture.querySelector(".chat-group.user .chat-bubble");
      bubble.addEventListener("contextmenu", (event) => original.auditMessageContextMenu(event, { paneId: "fixture" }));
      bubble.dispatchEvent(new doc.defaultView.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }));
      for (const { selector, states } of menuSnapshot) for (const state of states) {
        doc.querySelector(selector)?.setAttribute(`data-reference-${state}`, "");
      }
      await Promise.all([...doc.querySelectorAll("*")].map((node) => node.updateComplete).filter(Boolean));
      doc.documentElement.getBoundingClientRect();
      await Promise.all(doc.getAnimations().filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime)).map((animation) => animation.finished.catch(() => {})));
      results.push({ role: "context-menu", records: menuSnapshot.map(({ selector, style: hui }) => {
        const target = doc.querySelector(selector);
        if (!target) return { selector, differences: { missing: true } };
        const style = doc.defaultView.getComputedStyle(target);
        return { selector, differences: Object.fromEntries(VISUAL_PROPERTIES.filter((key) => hui[key] !== style.getPropertyValue(key)).map((key) => [key, { hui: hui[key], original: style.getPropertyValue(key) }])) };
      }) });
    }
    return options.includeMarkup ? { results, originalMarkup: fixture.innerHTML } : results;
  } finally {
    frame.remove();
    if (originalFocus instanceof HTMLElement && originalFocus.isConnected) originalFocus.focus({ preventScroll: true });
  }
}

export const MARKDOWN_SELECTORS = [
  ".chat-bubble", ".chat-text", ".chat-text h1", ".chat-text h2", ".chat-text strong",
  ".chat-text em", ".chat-text s", ".chat-text a", ".chat-text ul", ".chat-text ol",
  ".chat-text li", ".chat-text blockquote", ".chat-text blockquote p", ".chat-text hr",
  ".code-block-wrapper", ".code-block-header", ".code-block-lang", ".code-block-actions",
  ".code-block-copy", ".code-block-copy__idle", ".code-block-viewport", ".chat-text pre",
  ".chat-text pre code", ".code-block-wrap",
];

export async function compareOriginalMarkdown() {
  const message = document.querySelector("hui-app").transcript.find((item) =>
    item.kind === "message" && item.role === "assistant" && item.text.startsWith("# Markdown parity"));
  if (!message) throw new Error("Send E2E_MARKDOWN_PARITY through the fixture composer first");
  return compareOriginalTranscript(undefined, { messageId: message.id, selectors: MARKDOWN_SELECTORS });
}

export async function compareOriginalCode() {
  const message = document.querySelector("hui-app").transcript.find((item) =>
    item.kind === "message" && item.role === "assistant" && item.text.startsWith("```unknown\nline 1:"));
  if (!message) throw new Error("Send E2E_CODE_PARITY through the fixture composer first");
  const wrapper = document.querySelector(`[data-message-id="${message.id}"] .code-block-wrapper`);
  return compareOriginalTranscript(undefined, {
    messageId: message.id,
    selectors: [".chat-bubble", ".chat-text", ".code-block-wrapper", ".code-block-header", ".code-block-actions", ".code-block-copy", ".code-block-wrap", ".code-block-viewport", ".code-block-viewport pre", ".code-block-viewport code", ".code-block-expand", ".code-block-chevron"],
    codeState: { expanded: wrapper.classList.contains("is-expanded"), wrapped: wrapper.classList.contains("is-wrapped") },
  });
}

export async function auditOriginalRichTranscript() {
  const { click, waitFor } = await import("./visual-journey-probe.js");
  await waitFor(() => document.querySelector(".code-block-expand"), "Fixture code block not loaded");
  const expanded = document.querySelector(".code-block-expand");
  if (expanded.getAttribute("aria-expanded") !== "false") throw new Error("Reload the fixture session to start with the original collapsed state");
  const records = { markdown: await compareOriginalMarkdown(), collapsed: await compareOriginalCode() };
  await click("Show 3 hidden lines");
  if (expanded.getAttribute("aria-expanded") !== "true" || !document.getElementById(expanded.getAttribute("aria-controls"))) {
    throw new Error("Code expansion did not update its accessible region");
  }
  records.expanded = await compareOriginalCode();
  await click("Enable word wrap");
  const wrapped = document.querySelector(".code-block-wrapper.is-wrapped");
  if (!wrapped || wrapped.querySelector(".code-block-wrap").getAttribute("aria-pressed") !== "true") throw new Error("Word wrap did not enable");
  const viewport = wrapped.querySelector(".code-block-viewport");
  if (viewport.scrollWidth > viewport.clientWidth + 1) throw new Error("Wrapped code still overflows horizontally");
  records.wrapped = await compareOriginalCode();
  await click("Disable word wrap");
  if (wrapped.classList.contains("is-wrapped")) throw new Error("Word wrap did not disable");
  return { viewport: [innerWidth, innerHeight], records, actions: ["expand", "wrap", "unwrap"], wrappedOverflow: 0 };
}

export async function compareOriginalAttachment() {
  const message = document.querySelector("hui-app").transcript.find((item) =>
    item.kind === "message" && item.attachments?.length);
  if (!message) throw new Error("Open a fixture transcript containing a sent attachment");
  return compareOriginalTranscript(undefined, {
    messageId: message.id, attachment: message.attachments[0],
    selectors: [".chat-assistant-attachment-card", ".chat-assistant-attachment-card__header", ".chat-assistant-attachment-card__identity", ".chat-assistant-attachment-card__details", ".chat-assistant-attachment-card__title", ".chat-assistant-attachment-card__meta", ".chat-assistant-attachment-card__actions", ".chat-attachment-file-icon", ".chat-attachment-file-icon__overlay"],
  });
}
