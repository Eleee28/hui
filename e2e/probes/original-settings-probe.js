/** Original Settings sidebar and design-language renderers, with matched text.
 * Child control slots are supplied as data and audited separately (e.g. switch).
 * The reference row/section/header DOM is never cloned from HUI. */
import { VISUAL_PROPERTIES } from "./visual-style-probe.js";
import { applyOriginalTheme } from "./original-theme-probe.js";

export async function compareOriginalSettings(oracle = "http://127.0.0.1:43130") {
  const liveSidebar = document.querySelector(".settings-sidebar");
  const liveMain = document.querySelector(".settings-main");
  if (!liveSidebar || !liveMain) throw new Error("Open Settings first");
  const focused = document.activeElement;
  const scrollTop = liveMain.scrollTop;
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  Object.assign(frame.style, { position: "fixed", left: "0", top: "0", width: `${innerWidth}px`, height: `${innerHeight}px`, opacity: "0", pointerEvents: "none", border: "0" });
  frame.srcdoc = `<!doctype html><html><head><link rel="stylesheet" href="${oracle}/assets/control-ui-core-DvoiO6cr.css"><link rel="stylesheet" href="${oracle}/assets/control-ui-boot-shared-BahwINek.css"><link rel="stylesheet" href="${oracle}/reference.css"></head><body></body></html>`;
  const loaded = new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
  document.body.append(frame);
  try {
    await loaded;
    const doc = frame.contentDocument;
    doc.body.className = "shell--settings";
    await applyOriginalTheme(doc, oracle);
    const script = doc.createElement("script");
    script.type = "module";
    script.textContent = `try { const [ui, sidebar, lit] = await Promise.all([import("${oracle}/assets/control-ui-boot-shared-DpHhsTHW.js"),import("${oracle}/assets/settings-sidebar-DTNMF0OK.js"),import("${oracle}/assets/lit-runtime-CIjzngcy.js")]); window.settingsOracle = {ui,sidebar,render:lit.et}; document.dispatchEvent(new Event("settings-oracle-ready")); } catch(error) { window.settingsOracleError = String(error.stack); document.dispatchEvent(new Event("settings-oracle-ready")); }`;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Original Settings did not load")), 15000);
      doc.addEventListener("settings-oracle-ready", () => { clearTimeout(timeout); resolve(); }, { once: true });
      doc.head.append(script);
    });
    if (doc.defaultView.settingsOracleError) throw new Error(doc.defaultView.settingsOracleError);
    const { ui, sidebar, render } = doc.defaultView.settingsOracle;
    ui.pr(); // Register the original light-DOM picker for the migrated slot.
    const noop = () => {};
    const sidebarMount = doc.createElement("div");
    // Parent layout supplies available width; child geometry remains original.
    sidebarMount.style.width = `${liveSidebar.querySelector(".settings-sidebar__drawer").clientWidth}px`;
    doc.body.append(sidebarMount);
    render(sidebar.renderSettingsSidebar({
      basePath: "", activeRouteId: "config", agents: [],
      agentIdentity: { entries: () => [], ensure: noop },
      settingsAgentSelection: { state: { selectedId: null }, set: noop },
      offline: false, phase: "connected", lastError: null, gatewayVersion: "2026.9.5",
      updateAvailable: null, updateBusy: false, onUpdate: noop, refreshRequired: false, onRefresh: async () => true,
      searchQuery: document.querySelector(".settings-sidebar__search-input").value,
      onExit: noop, onRetryConnect: noop, onNavigate: noop, onSearchQueryChange: noop,
      preloadTimers: new Map(), saveIndicator: { state: "saved" }, canAdmin: true,
    }), sidebarMount);
    const properties = [...VISUAL_PROPERTIES, "stroke", "stroke-width"];
    const read = (node) => {
      if (!node) throw new Error("Missing original Settings comparison subject");
      const css = node.ownerDocument.defaultView.getComputedStyle(node);
      return Object.fromEntries(properties.map((key) => [key, css.getPropertyValue(key)]));
    };
    const records = [];
    const inactiveRows = [];
    const compare = async (selector, live, source) => {
      const hui = read(live);
      if (live === focused) {
        source.focus({ preventScroll: true });
        source.getBoundingClientRect();
        await Promise.all(doc.getAnimations().filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime))
          .map((animation) => animation.finished.catch(() => {})));
      }
      const original = read(source);
      records.push({ selector, differences: Object.fromEntries(properties.filter((key) => hui[key] !== original[key]).map((key) => [key, { hui: hui[key], original: original[key] }])) });
    };
    await doc.fonts.ready;
    await Promise.all([...doc.querySelectorAll("*")].map((node) => node.updateComplete).filter(Boolean));
    for (const selector of [".settings-sidebar__header", ".settings-sidebar__back", ".settings-sidebar__back-icon svg", ".settings-sidebar__title", ".settings-sidebar__esc", ".settings-sidebar__search", ".settings-sidebar__search-icon svg", ".settings-sidebar__search-input"] ) {
      await compare(selector, document.querySelector(selector), sidebarMount.querySelector(selector));
    }
    const page = doc.createElement("div");
    page.className = "settings-page";
    page.classList.toggle("settings-page--wide", liveMain.querySelector(".settings-page").classList.contains("settings-page--wide"));
    page.style.width = `${liveMain.querySelector(".settings-page").getBoundingClientRect().width}px`;
    doc.body.append(page);
    for (const [index, section] of [...liveMain.querySelectorAll(".settings-section")].entries()) {
      const heading = section.querySelector(".settings-section__heading")?.textContent.trim();
      const description = section.querySelector(".settings-section__desc")?.textContent.trim();
      render(ui.ht({ title: heading, description }, ""), page);
      for (const selector of [".settings-section__header", ".settings-section__copy", ".settings-section__heading", ".settings-section__desc"]) {
        if (section.querySelector(selector) && page.querySelector(selector)) await compare(`section[${index}] ${selector}`, section.querySelector(selector), page.querySelector(selector));
      }
      for (const [rowIndex, row] of [...section.querySelectorAll(".settings-row")].entries()) {
        if (!row.getClientRects().length) {
          inactiveRows.push(row.querySelector(".settings-row__title")?.textContent.trim());
          continue;
        }
        // Source list rows use content-visibility:auto. Measure rendered rows,
        // not their offscreen intrinsic placeholder height.
        row.scrollIntoView({ block: "center", behavior: "instant" });
        await new Promise(requestAnimationFrame);
        const text = row.querySelector(".settings-row__text");
        if (!text) continue;
        // The control is an opaque input slot, not the subject of this check.
        // Original renderSettingsRow owns all row/text/control-wrapper markup.
        const slot = row.querySelector(".settings-row__control");
        const toggle = slot?.querySelector('wa-switch');
        const picker = slot?.querySelector('hui-select-picker');
        const controls = toggle ? ui.yt({ checked: toggle.checked, disabled: toggle.disabled, ariaLabel: toggle.textContent.trim(), onChange: noop })
          : picker ? ui.mr({ ...picker.params, onChange: noop })
          : slot ? [...slot.childNodes].map((node) => {
            const copy = doc.importNode(node, true);
            // Property-bound WA form values are not serialized attributes.
            const liveSelects = node.nodeType === Node.ELEMENT_NODE
              ? [node, ...node.querySelectorAll('wa-select')].filter((element) => element.localName === 'wa-select') : [];
            const copiedSelects = copy.nodeType === Node.ELEMENT_NODE
              ? [copy, ...copy.querySelectorAll('wa-select')].filter((element) => element.localName === 'wa-select') : [];
            copiedSelects.forEach((select, index) => { select.value = liveSelects[index].value; });
            return copy;
          }) : undefined;
        const rowDescription = row.querySelector(".settings-row__desc");
        const descriptionContent = rowDescription ? [...rowDescription.childNodes].map((node) => doc.importNode(node, true)) : undefined;
        render(ui.ht({ title: heading, description }, [
          // Preserve first/subsequent-row state without copying any HUI row.
          ...Array.from({ length: rowIndex }, () => ui.pt({ title: "Fixture preceding row" })), ui.pt({
          title: text.querySelector(".settings-row__title")?.textContent.trim(),
          description: descriptionContent, control: controls,
          stacked: row.classList.contains("settings-row--stacked"),
          stackedOnNarrow: row.classList.contains("settings-row--stacked-on-narrow"),
        })]), page);
        await Promise.all([...page.querySelectorAll("*")].map((node) => node.updateComplete).filter(Boolean));
        const sourceRow = page.querySelector(".settings-group > .settings-row:last-child");
        for (const selector of [".settings-row", ".settings-row__text", ".settings-row__title", ".settings-row__desc", ".settings-row__control"]) {
          const live = selector === ".settings-row" ? row : row.querySelector(selector);
          const source = selector === ".settings-row" ? sourceRow : sourceRow.querySelector(selector);
          if (live && source) await compare(`section[${index}] row[${rowIndex}] ${selector}`, live, source);
        }
      }
    }
    return { path: location.pathname, records, inactiveRows, limitations: ["Original row/section/sidebar markup with matched text; control contents are inputs, except switches and pickers rendered by original functions. Control internals are measured separately by webawesome-controls-probe.js. Inactive schedule rows are reported separately and require selecting their schedule. Upstream-only agent selector/navigation destinations remain rendered but are not claimed as HUI capabilities."] };
  } finally {
    frame.remove();
    liveMain.scrollTop = scrollTop;
    if (focused instanceof HTMLElement && focused.isConnected) focused.focus({ preventScroll: true });
  }
}
