import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { BOOT_LOOK_KEY, bootFailureMessage, nextBootLook } from "./boot-screen.ts";

test("a chunk that did not download reads as a connection problem", () => {
  assert.equal(bootFailureMessage(new TypeError("Failed to fetch dynamically imported module: https://hui/assets/hui-app.js")), "HUI could not load over this connection.");
  assert.equal(bootFailureMessage(new TypeError("error loading dynamically imported module")), "HUI could not load over this connection.");
  assert.equal(bootFailureMessage(new TypeError("Importing a module script failed.")), "HUI could not load over this connection.");
  assert.equal(bootFailureMessage(new Error("x is not a function")), "HUI could not start.");
});

test("the page paints the boot screen before the app's script, and the app replaces it", () => {
  const page = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  const boot = page.indexOf('id="hui-boot"');
  assert(boot > 0 && boot < page.indexOf("<hui-app>"), "the boot screen is markup ahead of the app");
  assert.match(page, /<style>[\s\S]*#hui-boot[\s\S]*<\/style>/u, "its styles are inline");
  assert.match(page, /class="hui-boot__slow">[^<]*<a href="">Reload<\/a>/u, "a reload stays possible without script");
  const main = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
  assert.match(main, /Promise\.all\(\[import\("\.\/hui-app\.ts"\), resolveAppearance\(\)\]\)/u, "the app's code downloads while the appearance resolves");
});

test("the boot screen remembers each mode's colours and the preference, and drops anything malformed", () => {
  const dark = { bg: "#1e1e2e", text: "#cdd6f4", muted: "#a6adc8", accent: "#a78bfa" };
  const light = { bg: "#eff1f5", text: "#4c4f69", muted: "#6c6f85", accent: "#8839ef" };
  const first = nextBootLook(null, "system", "dark", dark);
  assert.deepEqual(first, { preference: "system", dark });
  assert.deepEqual(nextBootLook(first, "system", "light", light), { preference: "system", light, dark });
  assert.deepEqual(nextBootLook({ dark: { bg: 3 }, light: "x" }, "light", "light", light), { preference: "light", light });
  assert.deepEqual(nextBootLook(null, "dark", "dark", { ...dark, bg: "" }), { preference: "dark" });
});

/** Runs index.html's inline head script against a fake page. */
function bootScript(stored: unknown, systemLight: boolean) {
  const page = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  // index.html is our own file with exactly one inline script, opened by a bare
  // tag in the head: slice it out by position rather than parse HTML.
  const start = page.indexOf("<script>") + "<script>".length;
  const source = page.slice(start, page.indexOf("</script>", start));
  assert(start > "<script>".length - 1 && source.includes("hui.boot-look"), "found the inline boot script");
  const attributes: Record<string, string> = {};
  const properties: Record<string, string> = {};
  const root = { setAttribute: (name: string, value: string) => { attributes[name] = value; }, style: { colorScheme: "", setProperty: (name: string, value: string) => { properties[name] = value; } } };
  const fake = {
    document: { documentElement: root },
    localStorage: { getItem: (key: string) => key === BOOT_LOOK_KEY && stored !== undefined ? JSON.stringify(stored) : null },
    matchMedia: (query: string) => ({ matches: query.includes("light") ? systemLight : !systemLight }),
    CSS: { supports: (_: string, value: string) => !value.includes(";") },
  };
  new Function(...Object.keys(fake), "window", source)(...Object.values(fake), fake);
  return { mode: attributes["data-theme-mode"], scheme: root.style.colorScheme, properties };
}

test("before any script loads, the boot screen takes the remembered colours, else HUI's palette for the mode — never a bare white page", () => {
  const dark = { bg: "#1e1e2e", text: "#cdd6f4", muted: "#a6adc8", accent: "#a78bfa" };
  assert.deepEqual(bootScript(undefined, true), { mode: "light", scheme: "light", properties: {} });
  assert.deepEqual(bootScript(undefined, false), { mode: "dark", scheme: "dark", properties: {} });
  assert.deepEqual(bootScript({ preference: "system", dark }, false).properties, { "--hui-boot-bg": "#1e1e2e", "--hui-boot-text": "#cdd6f4", "--hui-boot-muted": "#a6adc8", "--hui-boot-accent": "#a78bfa" });
  // System light with only dark colours remembered: HUI's light palette, not dark colours.
  assert.deepEqual(bootScript({ preference: "system", dark }, true), { mode: "light", scheme: "light", properties: {} });
  assert.equal(bootScript({ preference: "dark", dark }, true).mode, "dark", "an explicit preference beats the system");
  assert.deepEqual(bootScript({ preference: "dark", dark: { ...dark, bg: "red;}" } }, false).properties["--hui-boot-bg"], undefined);
  const page = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  assert.match(page, /#hui-boot \{ --boot-bg: #0e1015;[\s\S]*:root\[data-theme-mode="light"\] #hui-boot \{ --boot-bg: #faf9f7;/u, "HUI's own dark and light backgrounds");
  assert.doesNotMatch(page, /Canvas/u);
  assert.match(page, /<img class="hui-boot__logo" [^>]*src="data:image\/webp;base64,/u, "the logo is inline: no request before it shows");
});
