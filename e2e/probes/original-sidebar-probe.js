/** Render the pinned original session-row function with HUI's visible data. */
import { VISUAL_PROPERTIES } from "./visual-style-probe.js";
import { applyOriginalTheme } from "./original-theme-probe.js";

export async function compareOriginalSessionRow(sessionId, oracle = "http://127.0.0.1:43130") {
  const live = document.querySelector(`[data-session-id="${CSS.escape(sessionId)}"]`);
  if (!live?.getClientRects().length) throw new Error("Open the sidebar session row first");
  const properties = [...VISUAL_PROPERTIES, "stroke", "stroke-width"];
  const read = (node) => {
    const style = node.ownerDocument.defaultView.getComputedStyle(node);
    return Object.fromEntries(properties.map((key) => [key, style.getPropertyValue(key)]));
  };
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  Object.assign(frame.style, { position: "fixed", left: "0", top: "0", width: `${innerWidth}px`, height: `${innerHeight}px`, opacity: "0", pointerEvents: "none", border: "0" });
  frame.srcdoc = `<!doctype html><html><head><link rel="stylesheet" href="${oracle}/assets/control-ui-core-DvoiO6cr.css"><link rel="stylesheet" href="${oracle}/assets/control-ui-boot-shared-BahwINek.css"><link rel="stylesheet" href="${oracle}/reference-state.css"></head><body><aside class="sidebar"><div class="sidebar-shell"><section class="sidebar-recent-sessions"><div id="fixture" class="sidebar-recent-sessions__list"></div></section></div></aside></body></html>`;
  const loaded = new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
  document.body.append(frame);
  try {
    await loaded;
    const doc = frame.contentDocument;
    await applyOriginalTheme(doc, oracle);
    const script = doc.createElement("script");
    script.type = "module";
    script.textContent = `try { const [sidebar, lit] = await Promise.all([import("${oracle}/assets/hui-original-sidebar-audit.js"),import("${oracle}/assets/lit-runtime-CIjzngcy.js")]); window.sidebarOracle={sidebar,render:lit.et}; document.dispatchEvent(new Event("sidebar-oracle-ready")); } catch(error) { window.sidebarOracleError=String(error.stack); document.dispatchEvent(new Event("sidebar-oracle-ready")); }`;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Original sidebar did not load")), 15000);
      doc.addEventListener("sidebar-oracle-ready", () => { clearTimeout(timeout); resolve(); }, { once: true });
      doc.head.append(script);
    });
    if (doc.defaultView.sidebarOracleError) throw new Error(doc.defaultView.sidebarOracleError);
    const { sidebar, render } = doc.defaultView.sidebarOracle;
    sidebar.auditInit();
    const noop = () => {};
    const status = live.querySelector("[data-status]").dataset.status;
    const session = {
      key: sessionId, label: live.querySelector(".sidebar-recent-session__name").textContent.trim(),
      pinned: !!live.querySelector(".session-row__pin") || live.classList.contains("session-row-host--pinned"),
      pinnable: true, visuallyActive: live.classList.contains("sidebar-recent-session--active"),
      status, hasActiveRun: status === "running", attention: { kind: status === "waiting" ? "question" : status === "error" ? "error" : "none" },
      runningChildCount: 0, failedChildCount: 0, childSessionKeys: [], children: [],
      hasComposerDraft: !!live.querySelector(".session-row__menu-btn--draft"),
    };
    const host = {
      sidebarAgentsMode: "chip", sessionOwnershipVisible: false, sidebarLiveActivity: false,
      sessionsShowPreview: false, sidebarNarrationLines: new Map(), sidebarObserverDigests: new Map(),
      sessionProjection: { resolveSubtitle: () => ({ subtitle: "", narration: false }) },
      selectedSessionKeys: new Set(), connected: true, sessionData: {
        presencePayload: null, approvalBadgeSnapshot: () => ({ sessionKeys: new Set() }),
      }, sessionOrganizer: {}, sidebarMenus: { sessionMenu: null },
      readSessionMutationAccess: () => ({ allowed: true }), isSessionChildrenExpanded: () => false,
      sidebarSessionHref: () => `/sessions/${sessionId}`, handleSessionRowClick: noop,
      toggleSessionPin: noop, toggleSessionMenu: noop,
    };
    const fixture = doc.getElementById("fixture");
    fixture.style.width = `${live.getBoundingClientRect().width}px`;
    render(sidebar.auditRecentSession({ host, session }), fixture);
    await doc.fonts.ready;
    await Promise.all([...doc.querySelectorAll("*")].map((node) => node.updateComplete).filter(Boolean));
    const selectors = [".sidebar-recent-session", ".sidebar-recent-session__link", ".sidebar-session-indicator", ".sidebar-recent-session__text", ".sidebar-recent-session__title-row", ".sidebar-recent-session__name", ".hover-marquee__text", ".session-row-aside", ".session-row-actions", ".session-action--pin", ".session-action:not(.session-action--pin)"];
    // A pointer/focus cannot occupy two frames. Only state selectors in the
    // original source CSS are projected to attributes; declarations and the
    // independently rendered original DOM remain untouched.
    for (const selector of selectors) {
      const a = selector === ".sidebar-recent-session" ? live : live.querySelector(selector);
      const b = fixture.querySelector(selector);
      if (a && b) for (const state of ["hover", "focus", "focus-visible", "focus-within"]) {
        b.toggleAttribute(`data-reference-${state}`, a.matches(`:${state}`));
      }
    }
    doc.documentElement.getBoundingClientRect();
    await Promise.all(doc.getAnimations().filter((animation) =>
      Number.isFinite(animation.effect?.getComputedTiming().endTime)).map((animation) => animation.finished.catch(() => {})));
    return { sessionId, status, pinned: session.pinned, records: selectors.map((selector) => {
      const a = selector === ".sidebar-recent-session" ? live : live.querySelector(selector);
      const b = fixture.querySelector(selector);
      if (!a || !b) return { selector, differences: { missing: { hui: !a, original: !b } } };
      const hui = read(a), original = read(b);
      return { selector, differences: Object.fromEntries(properties.filter((key) => hui[key] !== original[key]).map((key) => [key, { hui: hui[key], original: original[key] }])) };
    }) };
  } finally { frame.remove(); }
}
