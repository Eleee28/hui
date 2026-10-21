import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { discoverThemes, mergeThemes, registryUrlFor, type ThemeEntry, mapTheme } from "./themes.ts";

async function dirOf(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hui-themes-"));
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(dir, name), contents, "utf8");
  }
  return dir;
}

const entry = (id: string, source: ThemeEntry["source"]): ThemeEntry => ({
  id,
  name: id,
  source,
  file: `${id}.json`,
});

const THEME = JSON.stringify({
  name: "My Theme",
  light: { background: "#fff", foreground: "#000" },
  dark: { background: "#000", foreground: "#fff" },
});

test("a dropped-in file needs no manifest and labels itself", async () => {
  const dir = await dirOf({ "my-theme.json": THEME });
  assert.deepEqual(await discoverThemes(dir, "user"), [
    { id: "my-theme", name: "My Theme", source: "user", file: "my-theme.json" },
  ]);
});

test("files that are not usable themes are skipped, not fatal", async () => {
  const dir = await dirOf({
    "broken.json": "{ not json",
    "empty.json": JSON.stringify({ name: "Nothing" }),
    "notes.txt": "hello",
    "good.json": THEME,
  });
  assert.deepEqual(
    (await discoverThemes(dir, "user")).map((theme: ThemeEntry) => theme.id),
    ["good"],
  );
});

test("a missing directory is empty, not an error", async () => {
  assert.deepEqual(await discoverThemes(join(tmpdir(), "hui-does-not-exist"), "user"), []);
});

// This is what makes "copy a built-in into ~/.config/hui/themes to customise it"
// work, and it is easy to invert by accident.
test("a user theme replaces a built-in with the same id", () => {
  const merged = mergeThemes(
    [entry("dracula", "user")],
    [entry("dracula", "builtin"), entry("hui", "builtin")],
  );
  assert.deepEqual(
    merged.map((theme) => [theme.id, theme.source]),
    [
      ["dracula", "user"],
      ["hui", "builtin"],
    ],
  );
});

/* ── import ──────────────────────────────────────────────────────────────── */

test("accepts a bare theme id, editor link, share link and registry link", () => {
  const expected = "https://tweakcn.com/r/themes/amethyst-haze";
  for (const input of [
    "amethyst-haze",
    "  amethyst-haze  ",
    "https://tweakcn.com/themes/amethyst-haze",
    "https://www.tweakcn.com/themes/amethyst-haze",
    "https://tweakcn.com/r/themes/amethyst-haze",
    "https://tweakcn.com/editor/theme?theme=amethyst-haze",
    "https://www.tweakcn.com/editor/theme?theme=amethyst-haze",
    "https://tweakcn.com/themes/amethyst-haze.",
    "check out https://tweakcn.com/themes/amethyst-haze",
  ]) {
    assert.equal(registryUrlFor(input).href, expected, input);
  }
});

// Import is the only thing here that reaches the network, so it must not be
// pointable at anything else.
test("refuses every host but tweakcn", () => {
  for (const input of [
    "https://example.com/themes/evil",
    "https://tweakcn.com.evil.test/themes/evil",
    "http://169.254.169.254/latest/meta-data/",
    "https://raw.githubusercontent.com/x/y/main/theme.json",
    "not a url at all!",
    "",
  ]) {
    assert.throws(() => registryUrlFor(input), Error, input);
  }
});

test("refuses a tweakcn link that is not a theme link", () => {
  for (const input of [
    "https://tweakcn.com/editor/theme",
    "https://tweakcn.com/editor/theme?theme=../../etc/passwd",
    "https://tweakcn.com/",
    "https://tweakcn.com/themes/../../etc/passwd",
    "https://tweakcn.com/themes/",
  ]) {
    assert.throws(() => registryUrlFor(input), Error, input);
  }
});

const fixtures: { input: Parameters<typeof mapTheme>[0]; expected: ReturnType<typeof mapTheme> | null }[] = JSON.parse(readFileSync(new URL("./themes.fixture.json", import.meta.url), "utf8"));

test("themes preserves the shared runtime fixtures", () => {
  for (const fixture of fixtures) {
    assert.deepEqual(mapTheme(fixture.input) ?? null, fixture.expected);
  }
});
