import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "vitest";

import { DEFAULT_SETTINGS, normalizeBranchPrefix, normalizeCalls, normalizeSettings } from "./settings.ts";

test("round-trips a complete file", () => {
  assert.deepEqual(
    normalizeSettings({
      theme: "catppuccin",
      themeMode: "dark",
      fontUi: "geist",
      fontChat: "lora",
      textScale: 125,
    }),
    {
      ...DEFAULT_SETTINGS,
      theme: "catppuccin",
      themeMode: "dark",
      fontUi: "geist",
      fontChat: "lora",
      textScale: 125,
    },
  );
});

test("ignores the retired single typeface preference", () => {
  const settings = normalizeSettings({ typeface: "serif" });
  assert.equal(settings.fontUi, DEFAULT_SETTINGS.fontUi);
  assert.equal(settings.fontChat, DEFAULT_SETTINGS.fontChat);
  assert.equal("typeface" in settings, false);
});

test("normalizes HUI-owned profile and labs", () => {
  const settings = normalizeSettings({
    profileName: "  Alex  ", profileHandle: " @alex ",
    labs: { denseObservability: true, detailedDebug: "yes" },
  });
  assert.equal(settings.profileName, "Alex");
  assert.equal(settings.profileHandle, "@alex");
  assert.deepEqual(settings.labs, { denseObservability: true, detailedDebug: false });
});

test("codemode is on unless explicitly switched off", () => {
  assert.deepEqual([undefined, {}, { codemode: "off" }, { codemode: { enabled: "no" } }, { codemode: { enabled: false } }]
    .map((raw) => normalizeSettings(raw).codemode.enabled), [true, true, true, true, false]);
});

test("the question timeout is Off unless one of its choices is saved", () => {
  assert.deepEqual(DEFAULT_SETTINGS.questions, { timeoutMinutes: 0 });
  for (const questions of [undefined, null, 10, [], { timeoutMinutes: "10" }, { timeoutMinutes: 7 }, { timeoutMinutes: -5 }, { timeoutMinutes: 120 }]) {
    assert.equal(normalizeSettings({ questions }).questions.timeoutMinutes, 0, JSON.stringify(questions));
  }
  for (const timeoutMinutes of [5, 10, 15, 30, 60]) {
    assert.deepEqual(normalizeSettings(JSON.parse(JSON.stringify(normalizeSettings({ questions: { timeoutMinutes } })))).questions, { timeoutMinutes }, "round-trips");
  }
});

test("the managed browser is on and headless unless explicitly changed", () => {
  assert.deepEqual(DEFAULT_SETTINGS.browser, { enabled: true, headless: true, executablePath: "" });
  assert.deepEqual(normalizeSettings({}).browser, DEFAULT_SETTINGS.browser);
  assert.deepEqual(normalizeSettings({ browser: { enabled: "no", headless: 0, executablePath: 7 } }).browser, DEFAULT_SETTINGS.browser);
  assert.deepEqual(
    normalizeSettings({ browser: { enabled: false, headless: false, executablePath: "  /Applications/Brave Browser.app  " } }).browser,
    { enabled: false, headless: false, executablePath: "/Applications/Brave Browser.app" },
  );
  assert.equal(normalizeSettings({ browser: { executablePath: "/usr/bin/chrome\n--flag" } }).browser.executablePath, "");
  assert.equal(normalizeSettings({ browser: { executablePath: `/${"x".repeat(5_000)}` } }).browser.executablePath, "");
});

test("VS Code settings: the old opt-in switch is kept as saved, the path as typed, a provider and a license time", () => {
  const empty = { enabled: false, executable: "", provider: "auto", licenseAcceptedAt: "" };
  assert.deepEqual(DEFAULT_SETTINGS.vscode, empty);
  assert.deepEqual(normalizeSettings({}).vscode, empty);
  assert.deepEqual(normalizeSettings({ vscode: { enabled: "yes", executable: 7, provider: "vim", licenseAcceptedAt: "yesterday" } }).vscode, empty);
  // A file saved by the opt-in VS Code view: read unchanged, with the new fields at their defaults.
  assert.deepEqual(
    normalizeSettings({ vscode: { enabled: true, executable: "  /nix/store/abc-openvscode-server/bin/openvscode-server  " } }).vscode,
    { enabled: true, executable: "/nix/store/abc-openvscode-server/bin/openvscode-server", provider: "auto", licenseAcceptedAt: "" },
  );
  assert.equal(normalizeSettings({ vscode: { executable: "/usr/bin/openvscode-server\n--flag" } }).vscode.executable, "");
  assert.equal(normalizeSettings({ vscode: { executable: `/${"x".repeat(5_000)}` } }).vscode.executable, "");
  for (const provider of ["auto", "configured", "desktop", "managed", "path"]) {
    assert.equal(normalizeSettings({ vscode: { provider } }).vscode.provider, provider);
  }
  assert.equal(normalizeSettings({ vscode: { licenseAcceptedAt: "2026-10-09T08:00:00.000Z" } }).vscode.licenseAcceptedAt, "2026-10-09T08:00:00.000Z");
  const saved = { enabled: true, executable: "/x", provider: "desktop", licenseAcceptedAt: "2026-10-09T08:00:00.000Z" };
  assert.deepEqual(normalizeSettings(normalizeSettings({ vscode: saved })).vscode, saved, "round-trips");
});

test("keeping the Mac awake is opt-out and lid-close prevention is never saved", () => {
  assert.deepEqual(normalizeSettings({}).power, { keepAwake: true });
  assert.deepEqual(normalizeSettings({ power: { keepAwake: "no" } }).power, { keepAwake: true });
  assert.deepEqual(normalizeSettings({ power: { keepAwake: false, lidAwake: true } }).power, { keepAwake: false });
});

test("normalizes OpenClaw-compatible chat preferences", () => {
  assert.deepEqual(normalizeSettings({ chat: {
    messageWidth: "wide",
    collapseTaskProgress: true,
    sendShortcut: "modifierEnter",
    githubEmbeds: false,
    datadogEmbeds: false,
  } }).chat, {
    messageWidth: "wide",
    collapseTaskProgress: true,
    sendShortcut: "modifierEnter",
    githubEmbeds: false,
    datadogEmbeds: false,
  });
  assert.deepEqual(normalizeSettings({ chat: {
    messageWidth: "huge",
    collapseTaskProgress: "yes",
    sendShortcut: "space",
    githubEmbeds: "no",
    datadogEmbeds: 0,
  } }).chat, DEFAULT_SETTINGS.chat);
  assert.equal(DEFAULT_SETTINGS.chat.githubEmbeds, true);
  assert.equal(DEFAULT_SETTINGS.chat.datadogEmbeds, true);
});

test("drops the retired dashboard widget preference from legacy files", () => {
  const settings = normalizeSettings({ dashboardWidgets: ["gateway", "usage"] });
  assert.equal("dashboardWidgets" in settings, false);
});

// settings.json is meant to be hand-editable, and both the server and the
// client read it, so anything unexpected has to land on a default rather than
// reaching CSS or a lookup.
test("fills in what a partial file leaves out", () => {
  assert.deepEqual(normalizeSettings({ themeMode: "light" }), {
    ...DEFAULT_SETTINGS,
    themeMode: "light",
  });
  assert.deepEqual(normalizeSettings({}), DEFAULT_SETTINGS);
});

test("rejects junk in every field", () => {
  assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings("nope"), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings([]), DEFAULT_SETTINGS);
  assert.deepEqual(
    normalizeSettings({ theme: 42, themeMode: "chartreuse", fontUi: {}, fontChat: [], textScale: "big" }),
    DEFAULT_SETTINGS,
  );
});

test("keeps an unknown theme id, so a missing theme is not a lost setting", () => {
  // The client falls back to the first available theme; dropping the id here
  // would silently forget what the user picked.
  assert.equal(normalizeSettings({ theme: "not-installed" }).theme, "not-installed");
  assert.equal(normalizeSettings({ theme: "  spaced  " }).theme, "spaced");
});

test("accepts only a complete hex accent override", () => {
  assert.equal(normalizeSettings({ accent: " #A78BFA " }).accent, "#a78bfa");
  for (const accent of ["red", "#fff", "#gg55cc", "var(--accent)", 42]) {
    assert.equal(normalizeSettings({ accent }).accent, "");
  }
});

test("disabled skills keep bounded stable identities and discard malformed entries", () => {
  assert.deepEqual(normalizeSettings({
    disabledSkills: [
      { name: "pdf", path: "/skills/pdf/SKILL.md" },
      { name: "duplicate", path: "/skills/pdf/SKILL.md" },
      { name: "", path: "/skills/empty/SKILL.md" },
      { name: "bad", path: "/skills/bad\npath" },
      "not-an-entry",
    ],
  }).disabledSkills, [{ name: "pdf", path: "/skills/pdf/SKILL.md" }]);
});

test("disabled plugins keep opaque resource identities and discard malformed entries", () => {
  assert.deepEqual(normalizeSettings({
    disabledPlugins: [
      { id: "0123456789abcdef01234567", name: "review-tools", kind: "package" },
      { id: "0123456789abcdef01234567", name: "duplicate", kind: "extension" },
      { id: "not-an-id", name: "bad", kind: "package" },
      { id: "fedcba9876543210fedcba98", name: "", kind: "extension" },
    ],
  }).disabledPlugins, [
    { id: "0123456789abcdef01234567", name: "review-tools", kind: "package" },
  ]);
});

test("normalizes a safe worktree branch prefix", () => {
  assert.equal(normalizeBranchPrefix("developer"), "developer/");
  assert.equal(normalizeBranchPrefix(" team/feature/ "), "team/feature/");
  for (const prefix of ["", "/feature", "feature//nested", "../escape", "bad prefix", "topic.lock/"]) {
    assert.equal(normalizeBranchPrefix(prefix), "feature/");
  }
});

test("settings saved while HUI had VoiceStudio load, and the next save leaves its fields out", () => {
  const older = normalizeSettings({ profileName: "Dani", voice: { sendNotesImmediately: true }, calls: { engine: "voicestudio", voice: "sol" } });
  assert.equal("voice" in older, false, "the voice-notes switch is gone");
  assert.deepEqual(older.calls, { voice: "sol" }, "the engine is gone; the default call voice stays");
  assert.equal(older.profileName, "Dani");
  assert.doesNotMatch(JSON.stringify(older), /sendNotesImmediately|engine|voicestudio/u, "what the gateway writes back");
});

test("calls take Cove unless a known GPT-Live voice is saved", () => {
  assert.deepEqual(DEFAULT_SETTINGS.calls, { voice: "cove" });
  assert.deepEqual(normalizeSettings({}).calls, { voice: "cove" });
  assert.deepEqual(normalizeSettings({ calls: { voice: "Juniper" } }).calls, { voice: "juniper" });
  for (const calls of [{ voice: "alloy" }, "gpt-live", null, [], { voice: 3 }]) {
    assert.deepEqual(normalizeSettings({ calls }).calls, { voice: "cove" }, JSON.stringify(calls));
  }
  assert.deepEqual(normalizeCalls({ voice: "marin" }), { voice: "cove" }, "a public-API voice is not one of the route's");
});

const fixtures: { input: unknown; expected: ReturnType<typeof normalizeSettings> }[] = JSON.parse(readFileSync(new URL("./settings.fixture.json", import.meta.url), "utf8"));

test("settings preserves the shared runtime fixtures", () => {
  for (const fixture of fixtures) {
    assert.deepEqual(normalizeSettings(fixture.input), fixture.expected);
  }
  assert.deepEqual(DEFAULT_SETTINGS, fixtures.find((fixture) => fixture.input === null)!.expected);
});
