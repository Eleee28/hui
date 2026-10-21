import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";
import { voiceLanguage, voiceLanguageName } from "./voice-languages.ts";

test("language codes and names match the portable fixtures", async () => {
  const fixture = JSON.parse(await readFile(new URL("./voice-languages.fixture.json", import.meta.url), "utf8"));
  for (const item of fixture.codes) assert.equal(voiceLanguage(item.input) ?? null, item.expected);
  for (const item of fixture.whisperNames) assert.equal(voiceLanguageName(item.input, null), item.expected);
  for (const item of fixture.platformNames) assert.equal(voiceLanguageName(item.input, { of: (code) => item.names[code] }), item.expected);
});
