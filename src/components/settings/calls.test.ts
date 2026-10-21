import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "vitest";

import { callsReady } from "../../lib/voice/calls.ts";
import { chatGptLoginSummary } from "./calls.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("Settings says which ChatGPT account calls use, or where to sign in", () => {
  const now = Date.parse("2026-10-06T14:00:00Z");
  assert.equal(chatGptLoginSummary(undefined, now), "Checking the ChatGPT login…");
  assert.equal(chatGptLoginSummary({ signedIn: true, account: { name: "Account 2", email: "dani@example.com" } }, now),
    "Calls use Account 2 (dani@example.com), the first ChatGPT account not waiting for its quota.");
  assert.equal(chatGptLoginSummary({ signedIn: true, account: { name: "Main" } }, now), "Calls use Main, the first ChatGPT account not waiting for its quota.");
  assert.match(chatGptLoginSummary({ signedIn: true, waitingUntil: Date.parse("2026-10-27T00:00:00Z") }, now), /^Every ChatGPT account is waiting for its quota until /u);
  assert.equal(chatGptLoginSummary({ signedIn: false }, now), "No ChatGPT login yet. Sign in under Providers above: OpenAI Codex, with your ChatGPT Plus or Pro account.");
});

test("calls are offered whenever GPT-Live can run: with a ChatGPT login", () => {
  assert.equal(callsReady({ chatgpt: { signedIn: true, account: { name: "Main" } } }), true);
  assert.equal(callsReady({ chatgpt: { signedIn: true, waitingUntil: Date.parse("2026-10-27T00:00:00Z") } }), true, "the call itself says the quota is spent");
  assert.equal(callsReady({ chatgpt: { signedIn: false } }), false);
  assert.equal(callsReady(undefined), false, "not read yet, or the read failed");
});

test("Settings → Models → Calls has no engine to choose, and Integrations no VoiceStudio", () => {
  const calls = read("./calls.ts");
  assert.doesNotMatch(calls, /Conversation model|engine|VoiceStudio/u, "GPT-Live is the only way calls run");
  assert.match(calls, /renderSettingsPicker\("Default GPT-Live voice"/u);
  assert.match(calls, /<span class="settings-row__title">ChatGPT login<\/span>/u);
  assert.match(calls, /GPT-Live's audio goes to OpenAI under your ChatGPT account/u, "where call audio goes stays said");
  const settings = read("../../views/settings.ts");
  assert.doesNotMatch(settings, /VoiceStudio|settings-voice|hui-voice-settings|onChangeVoice/u);
  const integrations = settings.slice(settings.indexOf("function renderIntegrationsPage("), settings.indexOf("function renderToolsPage("));
  assert.deepEqual([...integrations.matchAll(/<hui-([a-z]+)-settings>/gu)].map((match) => match[1]), ["jira", "github", "datadog"]);
  assert.equal(existsSync(new URL("./settings-voice.ts", import.meta.url)), false);
});
