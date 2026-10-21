/** Runs UI-only navigation through HUI's actual command palette. No private
 * app methods, fixtures injected into application state, or direct API writes. */
export async function rendered() {
  await document.querySelector("hui-app").updateComplete;
  await document.fonts.ready;
}

/** Observable-state synchronization only: no timing sleeps or app internals. */
export async function waitFor(predicate, description, timeoutMs = 15000) {
  if (predicate()) return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { observer.disconnect(); reject(new Error(description)); }, timeoutMs);
    const check = () => {
      try {
        if (predicate()) { clearTimeout(timeout); observer.disconnect(); resolve(); }
      } catch (error) {
        // A bad assertion must reject this journey, not escape its observer as
        // an unrelated page error and leave an abandoned waiter behind.
        clearTimeout(timeout);
        observer.disconnect();
        reject(error);
      }
    };
    const observer = new MutationObserver(check);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    check();
  });
}

export function control(name, selector = "button,a,input,select,summary,textarea") {
  const matches = [...document.querySelectorAll(selector)].filter((node) =>
    node.getClientRects().length && (node.getAttribute("aria-label") || node.textContent.trim()) === name);
  if (matches.length !== 1) throw new Error(`Expected one visible control ${name}; got ${matches.length}`);
  return matches[0];
}

export async function click(name, selector) {
  const target = control(name, selector);
  target.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
  target.click();
  await rendered();
}

export async function fill(selector, value) {
  const input = document.querySelector(selector);
  if (!input) throw new Error(`Missing input: ${selector}`);
  if (input.disabled || input.readOnly) throw new Error(`Input is not editable: ${selector}`);
  input.focus();
  input.value = value;
  input.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await rendered();
}

export async function choose(name, option) {
  await click(name, "button");
  await click(option, '[role="option"]');
  await waitFor(() => control(name, "button").textContent.trim() === option, `${name} did not select ${option}`);
}

async function loaded() {
  const loading = () => [...document.querySelectorAll(".settings-loading,.settings-page__note[role=status],.observability-feedback[role=status]")]
    .some((node) => /^(Reading|Loading|Connecting)/.test(node.textContent.trim()));
  if (!loading()) return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { observer.disconnect(); reject(new Error("Route did not finish loading")); }, 15000);
    const observer = new MutationObserver(() => {
      if (!loading()) { clearTimeout(timeout); observer.disconnect(); resolve(); }
    });
    observer.observe(document.querySelector("hui-app"), { childList: true, subtree: true, characterData: true });
  });
}

export async function openFromPalette(label, description) {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
  await rendered();
  const input = document.querySelector(".command-palette-dialog[open] input");
  if (!input) throw new Error("Command palette did not open");
  input.value = label;
  input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: label }));
  await rendered();
  const matches = [...document.querySelectorAll(".cmd-palette__item")].filter((item) =>
    item.children[1]?.textContent.trim() === label && (!description || item.querySelector(".cmd-palette__item-desc")?.textContent.trim() === description));
  if (matches.length !== 1) throw new Error(`Expected one command for ${label}; got ${matches.length}`);
  matches[0].click();
  await rendered();
  await loaded();
  return routeEvidence();
}

export function routeEvidence() {
  const containers = [...document.querySelectorAll("main.content,.settings-main,.settings-page,.content-header")];
  return {
    path: location.pathname,
    headings: [...document.querySelectorAll("main h1,.page-title,.settings-main h2")].map((node) => node.textContent.trim()),
    overflow: containers.map((node) => ({ selector: node.className, overflow: node.scrollWidth - node.clientWidth })).filter((item) => item.overflow > 1),
    alerts: [...document.querySelectorAll('[role="alert"]')].map((node) => node.textContent.trim()),
    controls: [...document.querySelectorAll("main button,main a,main input,main select,main wa-select,main wa-switch,main wa-tab,.settings-main button,.settings-main input,.settings-main select")]
      .filter((node) => node.getClientRects().length).map((node) => ({ name: node.getAttribute("aria-label") || node.textContent.trim().slice(0,70) || node.name, disabled: !!node.disabled })),
  };
}

export async function auditRoutes(width, height) {
  const { HUI_PAGES } = await import("/src/lib/pages.ts");
  const { SETTINGS_PAGES } = await import("/src/views/settings.ts");
  const output = [];
  const check = () => {
    if (innerWidth !== width || innerHeight !== height) {
      throw new Error(`Viewport changed: expected ${width}×${height}; received ${innerWidth}×${innerHeight}`);
    }
    const { path, overflow, alerts } = routeEvidence();
    // Original glyphs are sized by their owning component, not inline SVG
    // attributes. Catch missing component constraints after a shared-icon port.
    const oversizedIcons = [...document.querySelectorAll("svg")].map((icon) => {
      const bounds = icon.getBoundingClientRect();
      return { owner: icon.parentElement?.className, width: bounds.width, height: bounds.height };
    }).filter((icon) => icon.width > 96 || icon.height > 96);
    output.push({ path, overflow, alerts, oversizedIcons });
  };
  for (const page of HUI_PAGES) {
    await openFromPalette(page.label, page.summary);
    check();
  }
  for (const page of SETTINGS_PAGES) {
    await openFromPalette(page.label, page.group || "Settings");
    check();
  }
  return { viewport: [width, height], routes: output };
}

/** Isolated provider fixture only: runs a real abortable PI request between
 * independent original-renderer comparisons. Never run on an operator chat. */
export async function auditOriginalComposerStates() {
  const { compareOriginalComposer } = await import("./original-component-probe.js");
  const textarea = document.querySelector(".chat textarea");
  if (!textarea || textarea.value || document.querySelector('[aria-label="Stop"]')) {
    throw new Error("Open an idle fixture chat with an empty draft first");
  }
  const open = document.querySelector(".chat-controls__effort-picker[open]");
  if (open) { open.querySelector("summary").click(); await rendered(); }
  const states = [{ state: "idle", components: await compareOriginalComposer() }];
  await fill(".chat textarea", "Check the composer");
  states.push({ state: "draft-focused", components: await compareOriginalComposer() });
  await fill(".chat textarea", "E2E_ABORT");
  await click("Send message", "button");
  await waitFor(() => !!document.querySelector('[aria-label="Stop"]') && !textarea.disabled, "PI did not accept the prompt");
  states.push({ state: "running-stop; effort disabled by PI", components: await compareOriginalComposer({ running: true, effortDisabled: true }) });
  await fill(".chat textarea", "Next instruction");
  states.push({ state: "running-follow-up; effort disabled by PI", components: await compareOriginalComposer({ running: true, effortDisabled: true }) });
  await fill(".chat textarea", "");
  await click("Stop", "button");
  await waitFor(() => !!document.querySelector('[aria-label="Send message"]') && !textarea.disabled, "Stop did not settle");
  document.querySelector(".chat-controls__effort-trigger").click();
  await rendered();
  states.push({ state: "effort-open", components: await compareOriginalComposer({ openEffort: true }) });
  return { viewport: [innerWidth, innerHeight], coarsePointer: matchMedia("(pointer: coarse)").matches, states };
}
