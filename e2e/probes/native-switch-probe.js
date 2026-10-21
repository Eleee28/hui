/** Historical pre-migration probe. Current controls use webawesome-controls-probe.js.
 * Compare HUI's native switch with the actual, version-pinned Web Awesome
 * component shipped by OpenClaw. The reference runs only in a disposable frame;
 * no Gateway connection, package installation or HUI state injection. */
export async function compareNativeSwitch(oracle = "http://127.0.0.1:43129") {
  const subject = document.querySelector(".settings-switch");
  if (!subject) throw new Error("Open Appearance before checking the switch");
  const checked = subject.querySelector("input").checked;
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  Object.assign(frame.style, { position: "fixed", left: "0", top: "0", width: "500px", height: "500px", opacity: "0", pointerEvents: "none" });
  frame.srcdoc = `<!doctype html><html><head><link rel="stylesheet" href="${oracle}/assets/control-ui-core-DvoiO6cr.css"><link rel="stylesheet" href="${oracle}/assets/control-ui-boot-shared-BahwINek.css"></head><body><wa-switch size="small" class="settings-toggle"></wa-switch><script type="module">try { const m = await import("${oracle}/assets/control-ui-boot-shared-DwSLfX8E.js"); m.h(); await customElements.whenDefined("wa-switch"); await document.querySelector("wa-switch").updateComplete; document.body.dataset.ready = "true"; } catch (error) { document.body.dataset.error = error.message; }</script></body></html>`;
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
      const timeout = setTimeout(() => { observer.disconnect(); reject(new Error("Reference switch did not initialize")); }, 15000);
      observer.observe(doc.body, { attributes: true });
    });
    for (const attr of document.documentElement.attributes) doc.documentElement.setAttribute(attr.name, attr.value);
    // Original app/bootstrap-theme.ts sets WA's palette classes in addition
    // to data-theme-mode. HUI does not need those runtime-specific classes.
    doc.documentElement.classList.toggle("wa-light", doc.documentElement.dataset.themeMode === "light");
    doc.documentElement.classList.toggle("wa-dark", doc.documentElement.dataset.themeMode === "dark");
    const reference = doc.querySelector("wa-switch");
    reference.checked = checked;
    await reference.updateComplete;
    // Flush style before collecting transition promises; do not sample an
    // intermediate animated color immediately after changing the reference.
    reference.getBoundingClientRect();
    const settle = (root) => Promise.all(root.getAnimations().filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime)).map((a) => a.finished));
    await Promise.all([settle(doc), settle(reference.shadowRoot), settle(document)]);
    const properties = ["font-size", "width", "height", "border-top-width", "border-radius", "background-color", "translate"];
    const read = (element, pseudo) => {
      const style = element.ownerDocument.defaultView.getComputedStyle(element, pseudo);
      return Object.fromEntries(properties.map((name) => [name, style.getPropertyValue(name)]));
    };
    const control = subject.querySelector("span");
    return {
      mode: document.documentElement.dataset.themeMode,
      checked,
      comparisons: [
        { part: "control", hui: read(control), reference: read(reference.shadowRoot.querySelector(".switch")) },
        { part: "thumb", hui: read(control, "::after"), reference: read(reference.shadowRoot.querySelector(".thumb")) },
      ].map(({ part, hui, reference: source }) => ({ part, hui, reference: source, differences: Object.fromEntries(properties.filter((name) => hui[name] !== source[name]).map((name) => [name, { hui: hui[name], reference: source[name] }])) })),
    };
  } finally { frame.remove(); }
}
