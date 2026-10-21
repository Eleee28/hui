/** Independent control oracle: original OpenClaw render functions/components,
 * loaded only in an isolated frame. Never import HUI renderers into the oracle.
 * Parent dimensions and option text are fixture inputs, not copied control DOM.
 */
import { VISUAL_PROPERTIES } from "./visual-style-probe.js";
import { applyOriginalTheme } from "./original-theme-probe.js";

const properties = [...VISUAL_PROPERTIES, "border-bottom-width", "border-bottom-color", "translate"];
const read = (element) => {
  const css = element.ownerDocument.defaultView.getComputedStyle(element);
  return Object.fromEntries(properties.map((key) => [key, css.getPropertyValue(key)]));
};
const deep = (root) => [
  ...(root.shadowRoot ? deep(root.shadowRoot) : []),
  ...[...root.querySelectorAll("*")].flatMap((node) => [node, ...(node.shadowRoot ? deep(node.shadowRoot) : [])]),
];
async function settle(root) {
  await root.ownerDocument?.fonts.ready;
  await Promise.all([root, ...deep(root)].map((node) => node.updateComplete).filter(Boolean));
  root.getBoundingClientRect?.();
  // Rendering can request a font that the initially empty oracle did not need.
  await root.ownerDocument?.fonts.ready;
  await Promise.all([root, ...deep(root)].flatMap((node) => node.getAnimations?.() ?? [])
    .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime))
    .map((animation) => animation.finished.catch(() => {})));
  await Promise.all(deep(root).filter((node) => node.localName === "wa-popup" && node.active)
    .map((popup) => popup.reposition()));
  // Scrolling an already-open select schedules a ResizeObserver/auto-update
  // pass after reposition resolves. Observe stable layout, not stale clipping.
  let previous;
  let stableFrames = 0;
  for (let frame = 0; frame < 60; frame++) {
    await new Promise(root.ownerDocument.defaultView.requestAnimationFrame);
    const layout = JSON.stringify(subjects(root).map(([key, node]) => [key, read(node)]));
    stableFrames = layout === previous ? stableFrames + 1 : 0;
    if (stableFrames >= 2) return;
    previous = layout;
  }
  throw new Error("Control styles did not settle across animation frames");
}
function subjects(host) {
  const nodes = [["host", host]];
  const visit = (root, prefix) => {
    for (const [index, node] of [...root.children].entries()) {
      // Empty, hidden transport inputs and SVG geometry have separate coverage.
      if (["STYLE", "SCRIPT", "SVG"].includes(node.tagName) || node.hidden || node.getAttribute("aria-hidden") === "true") continue;
      const key = `${prefix}/${node.localName}[${index}]`;
      if (node.getBoundingClientRect().width || node.getBoundingClientRect().height) nodes.push([key, node]);
      if (node.shadowRoot) visit(node.shadowRoot, `${key}::shadow`);
      visit(node, key);
    }
  };
  if (host.shadowRoot) visit(host.shadowRoot, "shadow");
  visit(host, "light");
  return nodes;
}
export async function compareWebAwesomeControls(oracle = "http://127.0.0.1:43130") {
  const hosts = [...document.querySelectorAll('hui-select-picker, wa-switch, wa-select, wa-tab-group, wa-dropdown[open]')];
  if (!hosts.length) throw new Error("Open a migrated control first");
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  Object.assign(frame.style, { position: "fixed", left: "0", top: "0", width: `${innerWidth}px`, height: `${innerHeight}px`, opacity: "0", pointerEvents: "none", border: "0" });
  frame.srcdoc = `<!doctype html><html><head><link rel="stylesheet" href="${oracle}/assets/control-ui-core-DvoiO6cr.css"><link rel="stylesheet" href="${oracle}/assets/control-ui-boot-shared-BahwINek.css"><link rel="stylesheet" href="${oracle}/reference.css"><link rel="stylesheet" href="${oracle}/reference-state.css"><link rel="stylesheet" href="${oracle}/source/hub-tabs.css"></head><body></body></html>`;
  const loaded = new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
  document.body.append(frame);
  const scroll = document.querySelector(".settings-main");
  const scrollTop = scroll?.scrollTop;
  const focus = document.activeElement;
  try {
    await loaded;
    const doc = frame.contentDocument;
    // Mobile touch targets and stacked rows are scoped to the Settings shell.
    if (document.querySelector(".shell--settings")) doc.body.className = "shell--settings";
    await applyOriginalTheme(doc, oracle);
    const script = doc.createElement("script");
    script.type = "module";
    script.textContent = `try { const [ui, lit, switches] = await Promise.all([import("${oracle}/assets/control-ui-boot-shared-DpHhsTHW.js"), import("${oracle}/assets/lit-runtime-CIjzngcy.js"), import("${oracle}/assets/control-ui-boot-shared-DwSLfX8E.js"), import("${oracle}/assets/settings-sidebar-DTNMF0OK.js")]); ui.pr(); ui.p(); switches.h(); window.controlOracle={ui,render:lit.et}; } catch(error) { window.controlError=error.stack; } finally { document.dispatchEvent(new Event("control-oracle-ready")); }`;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Original controls did not initialize")), 15000);
      doc.addEventListener("control-oracle-ready", () => { clearTimeout(timeout); resolve(); }, { once: true });
      doc.head.append(script);
    });
    if (doc.defaultView.controlError) throw new Error(doc.defaultView.controlError);
    const { ui, render } = doc.defaultView.controlOracle;
    const records = [];
    const controls = [];
    for (const [index, host] of hosts.entries()) {
      if (!host.isConnected) throw new Error("HUI changed during measurement");
      host.scrollIntoView({ block: "center", behavior: "instant" });
      await settle(host);
      const tag = host.localName;
      const id = `${tag}[${index}]`;
      const activeValue = host.querySelector("[data-active]")?.dataset.value;
      const liveState = { id, open: Boolean(host.open || host.querySelector('[aria-expanded="true"]')), checked: host.checked, disabled: host.disabled };
      const states = new Map(subjects(host).map(([key, node]) => [key,
        ["hover", "focus", "focus-visible", "focus-within"].filter((state) => node.matches(`:${state}`)),
      ]));
      let actual = subjects(host).map(([key, node]) => [key.replaceAll("hui-select-picker", "openclaw-select-picker"), read(node)]);
      const mount = doc.createElement("div");
      // Match the original sidebar row's inherited foreground for inline HUI
      // triggers. Popup positioning itself is a documented transport adapter.
      if (host.closest(".session-row-wrap")) mount.className = "sidebar-recent-session";
      // Keep the original parent selector context, not a clone of HUI markup.
      const liveRow = host.closest(".settings-row");
      const parentBounds = (liveRow ?? host.parentElement).getBoundingClientRect();
      Object.assign(mount.style, {
        position: "absolute", left: `${parentBounds.x}px`, top: `${parentBounds.y}px`,
        width: `${parentBounds.width}px`,
      });
      const control = doc.createElement("div");
      control.className = host.parentElement.className;
      mount.append(control);
      doc.body.replaceChildren(mount);
      let source;
      if (tag === "hui-select-picker") {
        render(ui.mr({ ...host.params, onChange: () => {}, onChangeTarget: undefined, onOpen: undefined }), control);
        source = control.querySelector("openclaw-select-picker");
        await settle(source);

      } else if (tag === "wa-switch") {
        render(ui.yt({ checked: host.checked, disabled: host.disabled, ariaLabel: host.textContent.trim(), onChange: () => {} }), control);
        source = control.querySelector(tag);
      } else if (tag === "wa-tab-group") {
        render(ui.m({ id: "sessions", active: host.active, tabs: [...host.querySelectorAll("wa-tab")].map((tab) => ({ value: tab.panel, label: tab.textContent.trim(), disabled: tab.disabled })), ariaLabel: host.getAttribute("aria-label"), panelId: "sessions-hub-panel", onSelect: () => {} }), control);
        source = control.querySelector(tag);
      } else {
        source = doc.createElement(tag);
        source.className = host.className;
        source.size = host.size;
        if (tag === "wa-select") {
          source.value = host.value;
          source.disabled = host.disabled;
          source.placeholder = host.placeholder;
          const label = doc.createElement("span"); label.slot = "label"; label.className = "settings-control__sr-label"; label.textContent = host.querySelector('[slot="label"]')?.textContent;
          source.append(label);
          for (const option of host.querySelectorAll("wa-option")) {
            const node = doc.createElement("wa-option"); node.value = option.value; node.textContent = option.textContent; source.append(node);
          }
        } else {
          source.placement = host.placement;
          source.distance = host.distance;
          const button = doc.createElement("button"); button.slot = "trigger"; button.type = "button"; button.textContent = "Actions"; source.append(button);
          for (const option of host.children) {
            if (option.getAttribute("role") === "separator") {
              const separator = doc.createElement("div"); separator.className = "session-menu__separator"; separator.setAttribute("role", "separator"); source.append(separator); continue;
            }
            if (option.localName !== "wa-dropdown-item") continue;
            const item = doc.createElement("wa-dropdown-item"); item.className = option.className; item.value = option.value; item.disabled = option.disabled; item.variant = option.variant;
            if (option.querySelector(".session-menu__text")) {
              const text = doc.createElement("span"); text.className = "session-menu__text"; text.textContent = option.textContent.trim(); item.append(text);
            } else item.textContent = option.textContent.trim();
            const icon = option.querySelector('[slot="icon"]');
            if (icon) { const slot = doc.createElement("span"); slot.slot = "icon"; slot.className = icon.className; slot.setAttribute("aria-hidden", "true"); slot.innerHTML = icon.innerHTML; item.prepend(slot); }
            source.append(item);
          }
        }
        control.append(source);
        await settle(source);

      }
      if (liveRow) {
        render(ui.pt({
          title: liveRow.querySelector('.settings-row__title')?.textContent.trim(),
          description: liveRow.querySelector('.settings-row__desc')?.textContent.trim(),
          stacked: liveRow.classList.contains('settings-row--stacked'),
          control: host.parentElement.classList.contains("cron-control") ? control : source,
        }), mount);
      }
      await settle(source);
      if (liveState.open) {
        if (tag === "hui-select-picker") {
          source.querySelector("button").click();
          await settle(source);
          source.querySelector(`[data-value="${CSS.escape(activeValue ?? "")}"]`)?.dispatchEvent(new doc.defaultView.MouseEvent("mousemove"));
          await settle(source);
          await source.querySelector("wa-popup").reposition();
        } else {
          const shown = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("Original popup did not open")), 5000);
            source.addEventListener("wa-after-show", () => { clearTimeout(timeout); resolve(); }, { once: true });
          });
          source.open = true;
          await shown;
        }
        await settle(source);
      }
      if (tag === "wa-dropdown") {
        // Programmatic oracle opening may give its first item focus even when
        // the live pointer-opened menu leaves focus on its trigger.
        const liveItems = [...host.querySelectorAll("wa-dropdown-item")];
        [...source.querySelectorAll("wa-dropdown-item")].forEach((item, itemIndex) => {
          if (!liveItems[itemIndex]?.matches(":focus-within")) item.blur();
        });
        await settle(source);
      }
      let expected = subjects(source);
      // A pointer cannot hover two documents simultaneously. Mirror observed
      // selector states using the pinned source declarations, never HUI CSS.
      // This changes only reference selectors, not their property values.
      for (const [key, node] of expected) {
        for (const state of states.get(key) ?? []) node.setAttribute(`data-reference-${state}`, "");
      }
      await settle(source);
      // Dropdown trigger presentation belongs to the shell; audit the original
      // WA menu and item parts here, not this independently supplied trigger.
      if (tag === "wa-dropdown") {
        actual = actual.filter(([key]) => key.startsWith("shadow") && !key.includes("trigger") || key.startsWith("light/wa-dropdown-item"));
        expected = expected.filter(([key]) => key.startsWith("shadow") && !key.includes("trigger") || key.startsWith("light/wa-dropdown-item"));
      }
      const original = new Map(expected.map(([key, node]) => [key, read(node)]));
      for (const [key, hui] of actual) {
        const upstream = original.get(key);
        records.push({ control: id, part: key, differences: upstream ? Object.fromEntries(properties.filter((property) => hui[property] !== upstream[property]).map((property) => [property, { hui: hui[property], original: upstream[property] }])) : { missingOriginalPart: true } });
        original.delete(key);
      }
      for (const key of original.keys()) records.push({ control: id, part: key, differences: { missingHuiPart: true } });
      controls.push(liveState);
    }
    return { path: location.pathname, viewport: [innerWidth, innerHeight], controls, records };
  } finally {
    frame.remove();
    if (scroll) scroll.scrollTop = scrollTop;
    if (focus?.isConnected) focus.focus({ preventScroll: true });
  }
}
