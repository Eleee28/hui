/** Browser-tool diagnostic: compare the rendered HUI DOM under HUI's cascade
 * with the SAME DOM under the original upstream cascade in an isolated frame.
 * This catches divergent overrides; it does not prove original DOM equivalence.
 * Always combine it with source anatomy review and actual Browser journeys. */
export const VISUAL_PROPERTIES = [
  "display", "box-sizing", "font-family", "font-size", "font-weight", "line-height", "letter-spacing",
  "color", "background-color", "border-top-color", "border-top-width", "border-top-style",
  "border-radius", "corner-shape", "box-shadow", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "gap", "min-height", "height", "width", "max-width", "opacity", "align-items", "justify-content",
];

export async function compareReferenceStyles(selectors, oracle = "http://127.0.0.1:43128/reference-state.css") {
  const root = document.querySelector("hui-app");
  if (!root) throw new Error("HUI is not mounted");
  const originalFocus = document.activeElement;
  const settle = async (doc) => {
    await doc.fonts.ready;
    await Promise.all(doc.getAnimations().filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime))
      .map((animation) => animation.finished.catch(() => {})));
  };
  await settle(document);
  const clone = root.cloneNode(true);
  const liveElements = [root, ...root.querySelectorAll("*")];
  [clone, ...clone.querySelectorAll("*")].forEach((element, index) => {
    element.toggleAttribute("data-reference-popover-open", liveElements[index].matches(":popover-open"));
    for (const state of ["hover", "focus", "focus-visible", "focus-within"]) {
      element.toggleAttribute(`data-reference-${state}`, liveElements[index].matches(`:${state}`));
    }
  });
  // Control values are properties, not attributes; keep the actual visible state.
  const liveControls = root.querySelectorAll("input,textarea,select");
  clone.querySelectorAll("input,textarea,select").forEach((element, index) => {
    const live = liveControls[index];
    if (element instanceof HTMLInputElement) { element.setAttribute("value", live.value); element.toggleAttribute("checked", live.checked); }
    if (element instanceof HTMLTextAreaElement) element.textContent = live.value;
  });
  const read = (element) => {
    const css = element.ownerDocument.defaultView.getComputedStyle(element);
    return Object.fromEntries(VISUAL_PROPERTIES.map((property) => [property, css.getPropertyValue(property)]));
  };
  const expected = selectors.map((selector) => {
    const element = root.querySelector(selector);
    if (!element) throw new Error(`Missing visible test subject: ${selector}`);
    return { selector, actual: read(element), state: ["hover", "focus", "focus-visible", "disabled"].filter((state) => element.matches(`:${state}`)) };
  });
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  // Keep the oracle in the viewport: content-visibility:auto would otherwise
  // substitute intrinsic placeholder heights for real offscreen row geometry.
  Object.assign(iframe.style, { position: "fixed", left: "0", top: "0", opacity: "0", pointerEvents: "none", width: `${innerWidth}px`, height: `${innerHeight}px`, border: "0" });
  iframe.srcdoc = `<!doctype html><html><head><link rel="stylesheet" href="${oracle}"><style>hui-app{display:block;height:100dvh}hui-app [hidden]{display:none!important}</style></head><body></body></html>`;
  const loaded = new Promise((resolve) => iframe.addEventListener("load", resolve, { once: true }));
  document.body.append(iframe);
  try {
    await loaded;
    const reference = iframe.contentDocument;
    if (!reference.defaultView.getComputedStyle(reference.documentElement).getPropertyValue("--bg").trim()) {
      throw new Error("Upstream styles did not load; comparison is invalid");
    }
    for (const attr of document.documentElement.attributes) reference.documentElement.setAttribute(attr.name, attr.value);
    reference.body.append(reference.importNode(clone, true));
    // Top-layer state is not an HTML attribute and cloneNode cannot carry it.
    for (const popover of reference.querySelectorAll("[data-reference-popover-open]")) popover.showPopover();
    await settle(reference);
    return expected.map(({ selector, actual, state }) => {
      const upstream = read(reference.querySelector(selector));
      const differences = Object.fromEntries(VISUAL_PROPERTIES.filter((property) => actual[property] !== upstream[property])
        .map((property) => [property, { hui: actual[property], upstream: upstream[property] }]));
      return { selector, state, differences };
    });
  } finally {
    iframe.remove();
    if (originalFocus instanceof HTMLElement && originalFocus.isConnected && document.activeElement !== originalFocus) {
      originalFocus.focus({ preventScroll: true });
    }
  }
}
