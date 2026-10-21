import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

const settingsSource = readFileSync(new URL("./settings.ts", import.meta.url), "utf8");
const homeSource = readFileSync(new URL("./home.ts", import.meta.url), "utf8");
const workspaceCss = readFileSync(
  new URL("../styles/openclaw-workspaces.css", import.meta.url),
  "utf8",
);
const settingsControlsCss = readFileSync(new URL("../styles/openclaw-reference/settings-controls.css", import.meta.url), "utf8");
const settingsCss = readFileSync(new URL("../styles/openclaw-reference/settings.css", import.meta.url), "utf8");
const newSessionCss = readFileSync(new URL("../styles/openclaw-reference/new-session.css", import.meta.url), "utf8");
const pluginsCss = readFileSync(new URL("../styles/openclaw-reference/plugins.css", import.meta.url), "utf8");

test("settings render the OpenClaw takeover regions", () => {
  assert.doesNotMatch(settingsSource, /settingsGlyph/);
  assert.match(settingsSource, /settings-sidebar__back-icon[^\n]*icons\.arrowLeft/);
  assert.match(settingsSource, /settings-sidebar__search-icon[^\n]*icons\.search/);
  assert.match(settingsSource, /aside class="shell-nav settings-sidebar settings-nav"/);
  assert.match(settingsSource, /main class="content settings-main"/);
  assert.match(settingsSource, /class="settings-workspace"><div class="settings-workspace__body"/);
  assert.match(settingsSource, /header class="settings-sidebar__header"/);
  assert.match(settingsSource, /class="settings-sidebar__search" role="search"/);
  assert.match(settingsSource, /class="settings-sidebar__nav settings-nav__list"/);
  assert.match(settingsSource, /footer class="settings-sidebar__footer"/);
  assert.match(settingsSource, /class="content-header content-header--settings"/);
  assert.match(settingsSource, /class="settings-workspace__body"/);
});

test("settings sections retain the one-surface OpenClaw anatomy", () => {
  assert.match(settingsSource, /description \? html`<p class="settings-section__desc"/);
  assert.match(
    settingsSource,
    /settings-section[\s\S]*settings-section__header[\s\S]*settings-section__copy[\s\S]*settings-group/,
  );
  assert.match(
    settingsSource,
    /settings-row[\s\S]*settings-row__text[\s\S]*settings-row__title[\s\S]*settings-row__control/,
  );
});

test("settings expose actionable PI package and skill lifecycle controls", () => {
  assert.match(settingsSource, /renderPiUrlForm\(props, "pi\.dev package URL"/);
  assert.match(settingsSource, /renderPiUrlForm\(props, "Skill URL"/);
  assert.match(settingsSource, /onConfirmRemovePackage\(resource\.label\)/);
  assert.match(settingsSource, /class="btn danger"/);
  assert.doesNotMatch(settingsSource, /btn--danger/);
  assert.match(settingsSource, /operation\.status === "error" \? "alert" : "status"/);
  assert.doesNotMatch(settingsSource, /Install, update and remove stay disabled/);
});

test("plugins settings can disable packages and direct extensions without removing them", () => {
  assert.match(settingsSource, /props\.settings\.disabledPlugins\.some\(\(entry\) => entry\.id === resource\.id\)/);
  assert.match(settingsSource, /props\.onSetPluginEnabled\(resource, checked\)/);
  assert.match(settingsSource, /props\.onReadPlugin\(resource\)/);
  assert.match(settingsSource, /props\.onReadSkill\(skill\)/);
  assert.match(settingsSource, /aria-label=\$\{`Read \$\{skill\.name\}`\}/);
  assert.match(settingsSource, /aria-label=\$\{`Read \$\{resource\.label\}`\}/);
  assert.match(settingsSource, /\$\{icons\.eye\}/);
  assert.match(settingsSource, /exclude it from new HUI SDK runtimes without uninstalling it/);
  assert.match(pluginsCss, /@media \(max-width: 768px\)[\s\S]*\.plugins-item > \.settings-row__control[\s\S]*width: auto;[\s\S]*margin-left: auto;[\s\S]*flex-wrap: nowrap;[\s\S]*justify-content: flex-end;/);
  assert.match(pluginsCss, /@media \(pointer: coarse\), \(max-width: 640px\)[\s\S]*\.plugins-item wa-switch\.settings-toggle::part\(base\)[\s\S]*min-height: 44px;/);
});

test("a touch-sized switch toggles from its whole 44px target", () => {
  // settings.css grows the host to 44px in touch contexts; the label inside it (part base) is what toggles.
  assert.match(settingsCss, /@media \(pointer: coarse\), \(max-width: 640px\)[\s\S]*:is\(button, \.btn, summary, wa-switch, \.settings-segmented__btn\) \{\s*min-width: 44px;\s*min-height: 44px;/);
  assert.match(settingsCss, /\.shell--embed-settings \{[\s\S]*:is\(button, \.btn, summary, wa-switch, \.settings-segmented__btn\) \{\s*min-width: 44px;\s*min-height: 44px;/);
  // Every switch's label takes the host's minimum, wherever a context sizes the host.
  assert.match(workspaceCss, /(^|\n)wa-switch::part\(base\) \{ min-width: inherit; min-height: inherit; \}/);
});

test("new-session styling keeps HUI submission markup inside the OpenClaw composition", () => {
  assert.match(newSessionCss, /\.new-session-page \.agent-chat__welcome/);
  assert.match(newSessionCss, /margin-top: 34px/);
  assert.match(newSessionCss, /max-width: 48rem/);
  assert.match(newSessionCss, /\.new-session-page__composer/);
  assert.match(newSessionCss, /@media \(max-width: 560px\)/);
});

test("New Session exposes explicit worktree creation and Settings owns its branch prefix", () => {
  assert.match(homeSource, /New worktree from/);
  assert.match(homeSource, /Current checkout/);
  assert.match(homeSource, /Isolated copy of the repo/);
  assert.match(homeSource, /Starts by switching this checkout to the selected branch or commit/);
  assert.match(homeSource, /baseRef: props\.workspaceBaseRef/);
  assert.match(homeSource, /Suggestions are limited/);
  assert.match(homeSource, /defaultBranchSuggestion/);
  assert.match(homeSource, /\.\.\.\(defaultBranchSuggestion \? \[defaultBranchSuggestion\] : \[\]\)/);
  assert.match(homeSource, /new-session-page__branch-suggestions/);
  assert.match(homeSource, /Branch suggestions/);
  assert.match(homeSource, /new-session-page__branch-option/);
  assert.match(homeSource, /workspaceBranchSuggestionsOpen/);
  assert.match(homeSource, /aria-expanded=\$\{String\(props\.workspaceBranchSuggestionsOpen\)\}/);
  assert.match(homeSource, /props\.onWorkspaceBranchSuggestionsOpen\(false\)/);
  assert.doesNotMatch(homeSource, /new-session-branches/);
  assert.match(homeSource, /Generated from the prompt/);
  assert.match(homeSource, /Configure default prefix/);
  assert.match(homeSource, /Open workspace settings/);
  assert.match(homeSource, /new-session-page__checkout-option--action/);
  assert.doesNotMatch(homeSource, /new-session-page__menu-link/);
  assert.doesNotMatch(homeSource, /new-session-page__branch-prefix/);
  assert.match(homeSource, /onOpenBranchPrefixSettings/);
  assert.match(homeSource, /class="new-session-page__group-picker"/);
  assert.doesNotMatch(homeSource, /list="launch-groups"/);
  assert.match(homeSource, /class="new-session-page__select new-session-page__checkout-popover/);
  assert.match(homeSource, /worktreeProgressLabel\(props\.worktreeProgress\)/);
  assert.match(homeSource, /wa-progress-bar/);
  assert.match(homeSource, /branchName: props\.workspaceBranch/);
  assert.match(homeSource, /baseRef: props\.workspaceBaseRef/);
  assert.match(homeSource, /worktree: true/);
  assert.match(settingsSource, /renderSection\("Git worktrees",[\s\S]*?name="branchPrefix"[\s\S]*?`, "branch-prefix"\)/);
  assert.match(settingsSource, /name="branchPrefix"/);
  assert.match(settingsSource, /class="settings-input settings-input--prefix"/);
  assert.match(settingsControlsCss, /\.settings-input:focus-visible/);
  assert.match(settingsControlsCss, /box-shadow: 0 0 0 2px/);
});

test("settings text entry uses the canonical OpenClaw control treatment", () => {
  assert.match(settingsSource, /class="settings-theme-import__input"/);
  assert.match(settingsSource, /class="settings-input" name="url"/);
  assert.match(settingsControlsCss, /--settings-control-height: 32px/);
  assert.match(settingsControlsCss, /background-color: color-mix\(in srgb, var\(--bg\) 80%, var\(--bg-elevated\) 20%\)/);
  assert.match(settingsControlsCss, /border-radius: var\(--radius-md\)/);
  assert.doesNotMatch(workspaceCss, /\.settings-text-field \{/);
});

test("Appearance exposes functional OpenClaw chat preferences", () => {
  for (const label of ["Message width", "Collapse task progress", "Send shortcut"]) {
    assert.match(settingsSource, new RegExp(label));
  }
  assert.match(settingsSource, /props\.onChangeChat/);
  assert.match(settingsSource, /renderSettingsToggle\("Collapse task progress"/);
  for (const label of ["Message width", "Send shortcut"]) {
    assert.ok(settingsSource.includes(`renderSettingsPicker("${label}"`));
  }
});

test("Appearance selects interface and chat prose fonts independently", () => {
  for (const label of ["Typography", "Interface", "Chat prose", "Interface font", "Chat prose font"]) {
    assert.match(settingsSource, new RegExp(label));
  }
  assert.match(settingsSource, /id: "settings-font-ui"/);
  assert.match(settingsSource, /value: props\.settings\.fontUi/);
  assert.match(settingsSource, /id: "settings-font-chat"/);
  assert.match(settingsSource, /value: props\.settings\.fontChat/);
  assert.match(settingsSource, /class="settings-typography-preview"/);
  assert.match(settingsCss, /\.settings-typography-preview__caption[\s\S]*var\(--font-body\)/);
  assert.match(settingsCss, /\.settings-typography-preview__prose[\s\S]*var\(--font-chat\)/);
});

test("the terminal font uses the themed settings picker instead of a native datalist", () => {
  assert.match(settingsSource, /id: "settings-font-terminal"/);
  assert.match(settingsSource, /customOption: \(query\) => normalizeTerminalFont\(query\) === query/);
  assert.doesNotMatch(settingsSource, /<datalist id="terminal-fonts"/);
});
