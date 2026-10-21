import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import { HUI_PAGES } from "../lib/pages.ts";
import { isPiSurface } from "./pi-surfaces.ts";

const source = readFileSync(new URL("./pi-surfaces.ts", import.meta.url), "utf8");

test("the HUI-05 through HUI-07 capabilities use PI-backed surfaces", () => {
  const expected = [
    "config",
    "connection",
    "model-providers",
    "model-setup",
    "plugins",
    "plugin",
    "skills",
    "skill-workshop",
    "memory-import",
  ];
  assert.deepEqual(
    HUI_PAGES.filter(isPiSurface).map((page) => page.id).toSorted(),
    expected.toSorted(),
  );
});

test("PI capability headers share the same centered frame as their body", () => {
  const css = readFileSync(new URL("../styles/openclaw-reference/settings.css", import.meta.url), "utf8");
  assert.match(
    css,
    /\.content:has\(\.settings-page\) \.content-header--settings\s*\{[^}]*max-width:\s*760px[^}]*margin-inline:\s*auto[^}]*padding-inline:\s*var\(--space-4\)/s,
  );
  assert.match(css, /\.content:has\(\.settings-page--wide\) \.content-header--settings\s*\{[^}]*max-width:\s*1120px/s);
});

test("Plugins uses the primary capability header pattern", () => {
  const css = readFileSync(new URL("../styles/openclaw-reference/page-chrome.css", import.meta.url), "utf8");
  assert.match(source, /pageHeader\(props, "Plugins", "PI packages and extensions available to HUI runtimes\."\)/);
  assert.match(source, /content-header content-header--settings content-header--page/);
  assert.match(css, /--page-toolbar-height:\s*52px/);
  assert.match(css, /\.content-header \.page-title\s*\{[^}]*font-size:\s*15px[^}]*font-weight:\s*600/s);
});

test("PI inventories use exact Settings rows, provider identities and status primitives", () => {
  assert.match(source, /settings-row settings-row--stacked model-providers__row/);
  assert.match(source, /model-providers__head[\s\S]*model-providers__identity[\s\S]*settings-row__text/);
  assert.match(source, /settings-status__dot/);
  assert.doesNotMatch(source, /pi-model-card|pi-provider-row|pi-worktree-row|surface-status/);
});

test("package and skill writes use the explicit PI mutation contract", () => {
  assert.match(source, /https:\/\/pi\.dev\/packages\/package-name/);
  assert.match(source, /onConfirmRemovePackage\(resource\.label\)/);
  assert.match(source, /class="btn danger"/);
  assert.doesNotMatch(source, /btn--danger/);
  assert.match(source, /A short-lived low-cost PI agent inspects the source/);
  assert.match(source, /operation\.status === "error" \? "alert" : "status"/);
  assert.match(source, /Creating, revising and publishing skills stays disabled/);
  assert.match(source, /Read-only inventory\. HUI does not copy OpenClaw memory/);
  assert.doesNotMatch(source, /type="password"/);
});

test("Skills exposes HUI-only enablement without presenting an uninstall action", () => {
  const appCss = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8");
  assert.match(source, /renderSettingsToggle\(/);
  assert.match(source, /Enable \$\{skill\.name\} in HUI/);
  assert.match(source, /skillIsEnabled\(skill, props\.disabledSkills\)/);
  assert.match(source, /props\.onReadSkill\(skill\)/);
  assert.match(source, /aria-label=\$\{`Read \$\{skill\.name\}`\}/);
  assert.match(source, /pi-resource-read-button/);
  assert.match(source, /\$\{icons\.eye\}/);
  assert.match(appCss, /@media \(pointer: coarse\), \(max-width: 640px\)[\s\S]*\.settings-row__control \.btn\.pi-resource-read-button[\s\S]*width: 44px;[\s\S]*height: 44px;/);
  assert.match(appCss, /\.pi-resource-read-button\s*\{[^}]*margin-inline-end:\s*var\(--space-1\)/s);
});

test("Plugins exposes HUI-only enablement by opaque configured-resource id", () => {
  assert.match(source, /props\.disabledPlugins\.some\(\(entry\) => entry\.id === resource\.id\)/);
  assert.match(source, /Enable \$\{resource\.label\} in HUI/);
  assert.match(source, /props\.onSetPluginEnabled\(resource, checked\)/);
  assert.match(source, /props\.onReadPlugin\(resource\)/);
  assert.match(source, /aria-label=\$\{`Read \$\{resource\.label\}`\}/);
});
