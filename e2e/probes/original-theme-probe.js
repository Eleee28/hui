/** Independent palette oracle. Never copy HUI's derived color declarations. */
export async function applyOriginalTheme(doc, oracle = "http://127.0.0.1:43130") {
  const read = async (path) => {
    const response = await fetch(path, { headers: { "x-hui": "1" } });
    if (!response.ok) throw new Error(`Cannot read theme input: ${response.status}`);
    return response.json();
  };
  const [{ themes }, settingsResponse] = await Promise.all([read("/__hui/themes"), read("/__hui/settings")]);
  const settings = settingsResponse.settings ?? settingsResponse;
  const family = document.documentElement.dataset.themeFamily;
  const mode = document.documentElement.dataset.themeMode;
  const theme = themes.find((item) => item.id === family);
  if (!theme || settings.theme !== family) throw new Error("Wait for the selected theme to persist before comparing");
  if (!doc.defaultView.originalThemeAudit) {
    const script = doc.createElement("script");
    script.type = "module";
    script.textContent = `try { const [theme, accent] = await Promise.all([import(${JSON.stringify(oracle + "/assets/hui-original-theme-audit.js")}), import(${JSON.stringify(oracle + "/assets/hui-original-accent-audit.js")})]); window.originalThemeAudit = {...theme,...accent}; document.dispatchEvent(new Event("theme-oracle-ready")); } catch(error) { window.originalThemeError = String(error.stack); document.dispatchEvent(new Event("theme-oracle-ready")); }`;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Original theme module did not load")), 15000);
      doc.addEventListener("theme-oracle-ready", () => { clearTimeout(timeout); resolve(); }, { once: true });
      doc.head.append(script);
    });
    if (doc.defaultView.originalThemeError) throw new Error(doc.defaultView.originalThemeError);
  }
  const original = doc.defaultView.originalThemeAudit;
  const root = doc.documentElement;
  root.removeAttribute("style");
  root.dataset.themeMode = mode;
  root.style.colorScheme = mode;
  const native = ["claw", "rose", "miami"].includes(family) && theme.url === `/__hui/themes/file/builtin/${family}.json`;
  if (native) {
    root.dataset.theme = family === "claw" ? mode : mode === "light" ? `${family}-light` : family;
    if (family !== "claw") {
      const link = doc.createElement("link");
      link.rel = "stylesheet";
      link.href = `${oracle}/themes/${family}.css`;
      await new Promise((resolve, reject) => {
        link.onload = resolve;
        link.onerror = () => reject(new Error(`Original ${family} palette did not load`));
        doc.head.append(link);
      });
    }
  } else {
    const payload = await read(theme.url);
    const tokens = original.auditThemeMode(mode, payload.cssVars?.[mode] ?? payload[mode], payload.cssVars?.theme);
    root.dataset.theme = mode === "light" ? "custom-light" : "custom";
    for (const [key, value] of Object.entries(tokens)) root.style.setProperty(`--${key}`, value);
  }
  // These are explicit user inputs, not derived palette values. HUI currently
  // offers a single UI/chat typeface setting; compare with that same choice.
  for (const property of ["--font-body", "--font-display", "--control-ui-text-scale"]) {
    const value = document.documentElement.style.getPropertyValue(property);
    if (value) root.style.setProperty(property, value);
  }
  if (settings.accent) original.auditApplyAccent(settings.accent);
  root.classList.toggle("wa-light", mode === "light");
  root.classList.toggle("wa-dark", mode === "dark");
  return { family, mode, accent: settings.accent, source: native ? "original-palette-css" : "original-tweakcn-mapper" };
}

export async function compareOriginalTheme(oracle = "http://127.0.0.1:43130") {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  Object.assign(frame.style, { position: "fixed", width: "1px", height: "1px", opacity: "0", pointerEvents: "none", border: "0" });
  frame.srcdoc = `<!doctype html><html><head><link rel="stylesheet" href="${oracle}/reference.css"></head><body></body></html>`;
  const loaded = new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
  document.body.append(frame);
  try {
    await loaded;
    const doc = frame.contentDocument;
    const selection = await applyOriginalTheme(doc, oracle);
    const { THEME_COLOR_TOKENS } = await import("/src/lib/theme/shadcn-theme.ts");
    // HUI-only hover tokens are not upstream roles.
    const excluded = ["--primary-hover", "--destructive-hover"];
    const colors = THEME_COLOR_TOKENS.filter((token) => !excluded.includes(token));
    const shadows = ["--focus-ring", "--focus-glow", "--shadow-sm", "--shadow-md", "--shadow-lg", "--overlay-shadow"];
    const measure = (owner, token, property) => {
      const node = owner.createElement("i");
      node.style.setProperty(property, `var(${token})`);
      owner.body.append(node);
      const value = owner.defaultView.getComputedStyle(node).getPropertyValue(property);
      node.remove();
      return value;
    };
    const records = [...colors.map((token) => [token, "color"]), ...shadows.map((token) => [token, "box-shadow"])].map(([token, property]) => {
      const hui = measure(document, token, property);
      const original = measure(doc, token, property);
      return { token, ...(hui === original ? {} : { differences: { hui, original } }) };
    });
    return { ...selection, records };
  } finally {
    frame.remove();
  }
}

/** Change real Settings controls, then wait for the observable saved values. */
export async function auditOriginalPalettes(themeLabel, accents = ["Theme default", "Blue", "Violet"]) {
  const { click } = await import("./visual-journey-probe.js");
  const results = [];
  await click(themeLabel, ".settings-theme-card");
  for (const mode of ["Light", "Dark"]) {
    await click(mode, '[aria-label="Color mode"] button');
    for (const accent of accents) {
      await click(accent, '[aria-label="Accent color"] button');
      const root = document.documentElement;
      const expectedAccent = accent === "Theme default" ? "" : root.style.getPropertyValue("--accent");
      const deadline = performance.now() + 10000;
      for (;;) {
        const response = await fetch("/__hui/settings", { headers: { "x-hui": "1" } });
        if (!response.ok) throw new Error("Cannot verify Settings persistence");
        const saved = await response.json();
        if (saved.theme === root.dataset.themeFamily && saved.themeMode === mode.toLowerCase() && saved.accent === expectedAccent) break;
        if (performance.now() >= deadline) throw new Error("Theme selection did not persist");
        await new Promise(requestAnimationFrame);
      }
      results.push(await compareOriginalTheme());
    }
  }
  return results;
}
