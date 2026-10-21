/** Run the shipped OpenClaw renderer independently; never reuse HUI's card DOM. */
import { applyOriginalTheme } from "./original-theme-probe.js";
import { huiHovercardRow } from "../../src/components/openclaw/hui-hovercard-adapter.ts";

export async function compareOriginalHovercard(sessionId, oracle = "http://127.0.0.1:43229") {
  const live = document.querySelector('.session-progress-hovercard[data-open="true"]');
  if (!live) throw new Error("Hover or focus the session row before comparing");
  const response = await fetch("/__hui/sessions", { headers: { "x-hui": "1" } });
  const { groups } = await response.json();
  const session = groups.flatMap((group) => group.sessions).find((row) => row.id === sessionId);
  if (!session) throw new Error("Session unavailable");
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  Object.assign(frame.style, { position: "fixed", left: "0", top: "0", width: `${innerWidth}px`, height: `${innerHeight}px`, opacity: "0", pointerEvents: "none", border: "0" });
  frame.srcdoc = `<!doctype html><html><head><link rel="stylesheet" href="${oracle}/assets/control-ui-core-DvoiO6cr.css"><link rel="stylesheet" href="${oracle}/assets/control-ui-boot-shared-BahwINek.css"><link rel="stylesheet" href="${oracle}/assets/session-progress-hovercard-BIw1j4GS.css"><link rel="stylesheet" href="${oracle}/reference.css"></head><body><div id="fixture" class="session-progress-hovercard" data-open="true" data-instant="true"></div></body></html>`;
  const loaded = new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
  document.body.append(frame);
  try {
    await loaded;
    const doc = frame.contentDocument;
    await applyOriginalTheme(doc, oracle);
    const script = doc.createElement("script");
    script.type = "module";
    script.textContent = `try { const [card, lit] = await Promise.all([import("${oracle}/assets/hui-original-hovercard-audit.js"),import("${oracle}/assets/lit-runtime-CIjzngcy.js")]); card.auditInit(); window.hovercardOracle={card,render:lit.et}; } catch(error) {window.hovercardOracleError=String(error.stack);} document.dispatchEvent(new Event("hovercard-oracle-ready"));`;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Original hovercard did not load")), 15000);
      doc.addEventListener("hovercard-oracle-ready", () => { clearTimeout(timeout); resolve(); }, { once: true });
      doc.head.append(script);
    });
    if (doc.defaultView.hovercardOracleError) throw new Error(doc.defaultView.hovercardOracleError);
    const { card, render } = doc.defaultView.hovercardOracle;
    const fixture = doc.getElementById("fixture");
    render(card.auditHovercard({ row: huiHovercardRow(session), progressCard: session.progress ?? null }), fixture);
    await doc.fonts.ready;
    await document.fonts.ready;
    const properties = ["display", "width", "max-width", "max-height", "padding", "gap", "border-radius", "border-color", "border-width", "background-color", "box-shadow", "color", "font-family", "font-size", "font-weight", "line-height", "white-space", "overflow", "text-overflow"];
    const selectors = [".session-progress-hovercard", ".session-hovercard", ".session-hovercard__header", ".session-hovercard__title", ".session-hovercard__created-age", ".session-hovercard__context", ".session-hovercard__context-row", ".session-hovercard__plan-row", ".session-hovercard__plan-step", ".session-hovercard__plan-count", ".session-hovercard__notepad", ".session-hovercard__notepad-title", ".session-progress-card__markdown"];
    const records = selectors.map((selector) => {
      const a = live.matches(selector) ? live : live.querySelector(selector);
      const b = fixture.matches(selector) ? fixture : fixture.querySelector(selector);
      if (!a && !b) return { selector, absent: true, differences: {} };
      if (!a || !b) return { selector, differences: { missing: { hui: !a, original: !b } } };
      const hui = getComputedStyle(a), original = doc.defaultView.getComputedStyle(b);
      return { selector, differences: Object.fromEntries(properties.filter((key) => hui.getPropertyValue(key) !== original.getPropertyValue(key)).map((key) => [key, { hui: hui.getPropertyValue(key), original: original.getPropertyValue(key) }])) };
    });
    const shape = (node) => node.nodeType === 3 ? node.textContent.trim().replace(/\s+/g, " ") : node.nodeType !== 1 ? null : [node.tagName, node.getAttribute("class")?.trim() ?? "", [...node.childNodes].map(shape).filter(Boolean)];
    const huiShape = shape(live.firstElementChild), originalShape = shape(fixture.firstElementChild);
    return { version: "2026.9.5", sessionId, structuralMatch: JSON.stringify(huiShape) === JSON.stringify(originalShape), ...(JSON.stringify(huiShape) !== JSON.stringify(originalShape) ? { huiShape, originalShape } : {}), comparedRegions: records.filter(({ absent }) => !absent).length, records };
  } finally { frame.remove(); }
}
