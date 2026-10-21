import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { botCallsLabel, botModelLabel, botTaggingLabel } from "./bot-settings.ts";
import { renderBotPanel, renderBotRoster, type BotPanelProps, type BotRosterProps } from "./bots.ts";
import type { BotView } from "../lib/bots/bots.ts";
import type { AutomationRun } from "../api/schema/automation.ts";
import { formatTimestamp } from "./settings-automation.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const between = (source: string, start: string, end: string) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

function markup(value: unknown): string {
  if (Array.isArray(value)) return value.map(markup).join("");
  if (value && typeof value === "object" && "strings" in value && "values" in value) {
    const template = value as { strings: readonly string[]; values: unknown[] };
    return template.strings.map((part, i) => part + markup(template.values[i])).join("");
  }
  if (value && typeof value === "object" && "_$litDirective$" in value && "values" in value) {
    const [items, , template] = (value as { values: unknown[] }).values;
    // repeat(items, key, template) renders each item; other directives show their arguments.
    return typeof template === "function" ? [...items as Iterable<unknown>].map((item) => markup(template(item))).join("") : markup((value as { values: unknown[] }).values);
  }
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

test("routines and overview Activity explain retries and intervention without hiding the error", () => {
  const run: AutomationRun = {
    id: "r1", taskId: "t1", taskName: "Digest", sessionId: "s1", status: "queued", source: "scheduled",
    createdAt: "2026-10-18T08:00:00.000Z", attempt: 1, retryAt: "2026-10-18T08:00:30.000Z", error: "Worker is offline",
  };
  // Only the two pages under test read these states; the other pages' actions are not invoked.
  const props = {
    id: "bot-panel", view: "routines", width: 400, timezone: "UTC",
    bot: { id: "b1", name: "Ada", handle: "ada", sessionId: "s1", cwd: "/bots/b1", status: "idle" },
    routines: { automation: { scheduler: { enabled: true, activeRuns: 0, nextWakeAt: run.retryAt }, tasks: [], runs: [run] } },
    triggers: { state: { list: { triggers: [], runs: [] } } },
    settings: { models: [], call: { defaultVoice: "sol" } },
  } as unknown as BotPanelProps;
  for (const view of ["routines", "overview"] as const) {
    const retryPage = markup(renderBotPanel({ ...props, view }));
    assert.match(retryPage, /Retry scheduled/);
    assert.match(retryPage, /Attempt 1\/3 · Next retry/);
    assert.ok(retryPage.includes(formatTimestamp(run.retryAt)));
    assert.match(retryPage, /Worker is offline/);
    assert.doesNotMatch(retryPage, /A run is in progress/);
  }
  Object.assign(run, { status: "failed", retryAt: undefined, error: "Interrupted while running", failure: { kind: "interrupted", needsAttention: true } });
  for (const view of ["routines", "overview"] as const) {
    const failedPage = markup(renderBotPanel({ ...props, view }));
    assert.match(failedPage, /Needs attention/);
    assert.match(failedPage, /Check the chat for actions already taken before running again/);
    assert.match(failedPage, /Interrupted while running/);
    assert.doesNotMatch(failedPage, /Next retry/);
  }
});

test("a bot shows its face, or its emoji while it has one, always decorative beside its name in text", () => {
  const source = read("./bots.ts");
  const avatar = between(source, "export function renderBotAvatar(", "function activityBadge(");
  assert.match(avatar, /const look = botLook\(bot\);/u);
  assert.match(avatar, /if \(look\.kind === "emoji"\)/u, "an emoji wins until someone switches the bot to its face");
  assert.match(avatar, /class="bot-avatar bot-avatar--\$\{size\} bot-avatar--emoji"[^>]*aria-hidden="true"/u);
  assert.match(avatar, /class="bot-avatar bot-avatar--\$\{size\} bot-avatar--face" aria-hidden="true"><hui-bot-face size=\$\{size\} shape=\$\{look\.shape\} ears=\$\{look\.ears \?\? ""\} \.color=\$\{look\.color\}/u);
  assert.match(avatar, /\.seed=\$\{look\.seed\} state=\$\{options\.state \?\? "idle"\} \.level=\$\{options\.level\}/u);
  assert.doesNotMatch(source, /botAvatar\(|data-tone=|initial/u, "the letter avatar is gone");
});

test("roster rows: a finished turn unread is a green dot, a resting bot sleeps, a working one has no badge, the open one is awake", () => {
  const bot = (id: string, status: BotView["status"], unread: boolean, lastMessage = "2026-10-19T09:00:00.000Z") => ({
    id, name: id, handle: id, sessionId: `s-${id}`, cwd: `/bots/${id}`, createdAt: lastMessage, updatedAt: lastMessage, status, unread, soul: false, routines: 0,
  } as BotView);
  const bots = [
    bot("done", "idle", true, "2026-10-19T09:04:00.000Z"),
    bot("asleep", "idle", false, "2026-10-19T09:03:00.000Z"),
    bot("working", "running", true, "2026-10-19T09:02:00.000Z"),
    bot("open", "idle", false, "2026-10-19T09:01:00.000Z"),
  ];
  const page = markup(renderBotRoster({ bots, query: "", showHidden: false, showArchived: false, activeBotId: "open", menuFor: "", pendingId: "", now: Date.parse("2026-10-19T09:05:00.000Z") } as unknown as BotRosterProps, { navigate: () => {}, dialog: () => {} }));
  const row = (id: string) => page.slice(page.indexOf(`data-bot-id=${id}`), page.indexOf("</a>", page.indexOf(`data-bot-id=${id}`)));
  const badges = (id: string) => [...row(id).matchAll(/bot-avatar__badge--(\w+)/gu)].map((match) => match[1]);
  assert.deepEqual(badges("done"), ["done"]);
  assert.match(row("done"), /state=idle/u);
  assert.deepEqual(badges("asleep"), ["sleeping"]);
  assert.match(row("asleep"), /state=sleeping/u);
  assert.deepEqual(badges("working"), []);
  assert.match(row("working"), /state=thinking/u);
  assert.deepEqual(badges("open"), []);
  assert.match(row("open"), /state=idle/u);
  assert.doesNotMatch(page, /sidebar-session-unread-dot/u, "the green dot is the row's one unread mark");
  assert.match(read("./bots.ts"), /renderBotAvatar\(bot, "sm", \{ state: "offline" \}\)/u, "archived bots show offline");
});

test("the Settings page's Look is Face (shape and color) or Emoji, as native radio groups, each choice saved on its own", () => {
  const source = read("./bot-settings.ts");
  const look = between(source, "function renderLook(", "/** Name, title and look, edited in place");
  assert.match(look, /<details class="settings-row bot-setting bot-look" data-setting="look">/u, "a row that opens into the editor");
  assert.match(look, /\$\{props\.face\(avatar\)\}/u, "the face as it will look, a pending choice included");
  assert.match(look, /role="radiogroup" aria-label="Look"/u);
  assert.match(look, /\[\["face", "Face"\], \["emoji", "Emoji"\]\]/u);
  assert.match(look, /if \(value === "face" && botSettingOf\(bot, "emoji"\)\) props\.onChange\("emoji", ""\);/u, "Face clears the emoji");
  assert.match(look, /role="radiogroup" aria-label="Shape"/u);
  assert.match(look, /aria-label=\$\{BOT_FACE_SHAPE_LABELS\[option\]\}/u, "each shape is named");
  assert.match(look, /@change=\$\{\(\) => props\.onChange\("shape", option\)\}/u);
  assert.match(look, /role="radiogroup" aria-label="Color"/u);
  assert.match(look, /@change=\$\{\(\) => props\.onChange\("color", entry\.hex\)\}/u);
  assert.match(look, /Custom \$\{custom\}/u, "a color set through the API stays choosable");
  assert.match(look, /name="emoji" type="text" maxlength="16"/u);
  assert.match(look, /onTextKeydown\(event, "emoji", props\)/u, "an emoji saves on Enter or blur");
  const css = readFileSync(new URL("../styles/bots.css", import.meta.url), "utf8");
  assert.match(css, /\.bot-look:has\(\.bot-look__kind input\[value="emoji"\]:checked\) \.bot-look__face \{ display: none; \}/u, "Emoji shows its field before one is saved");
});

test("the chat's header and empty chat show the open chat's state; the large face follows the pointer there", () => {
  const source = read("./home.ts");
  assert.match(source, /class="agent-chat__empty bot-chat-empty" data-face-stage>\$\{renderBotAvatar\(props\.bot\.bot, "lg", \{ state: botFaceState\(props\) \}\)\}/u);
  assert.match(source, /renderBotAvatar\(bot\.bot, "md", \{ state: face \}\)/u);
  const state = between(source, "function botFaceState(", "/** A bot's chat names the bot");
  assert.match(state, /question: Boolean\(props\.question\)/u);
  assert.match(state, /memoryWaiting: Boolean\(props\.bot\?\.bot\.memory\?\.waiting\)/u);
  assert.match(state, /toolRunning: props\.streaming && hasRunningTool\(props\.transcript\)/u);
  assert.match(state, /failed: Boolean\(props\.runError\)/u);
});

test("a call shows the bot's face listening to the microphone and speaking with its voice, tinted with its color", () => {
  const source = read("./bot-voice.ts");
  const view = between(source, "export function renderCallView(", "/** The minimized call");
  assert.match(view, /style=\$\{`--bot-color: \$\{look\.color\}`\} data-face-stage/u);
  assert.match(view, /renderBotAvatar\(bot, "xl", \{ state: callFaceState\(state, props\.summarizing\), \.\.\.\(props\.level \? \{ level: props\.level \} : \{\}\) \}\)/u);
  assert.match(view, /<p class="bot-call__status" role="status" aria-live="polite">\$\{callStatusLabel\(state, props\.summarizing, bot\.name\)\}<\/p>/u, "the status stays in text");
  const bar = between(source, "export function renderCallBar(", "\n}\n");
  assert.match(bar, /renderBotAvatar\(bot, "sm", \{ state: callFaceState\(state, props\.summarizing\) \}\)/u);
  assert.match(bar, /class="bot-call-bar__pulse"/u, "the bar keeps its live dot");
});

test("faces are decorative, pause when unseen and keep still under reduced motion", () => {
  const component = read("../components/bot-face.ts");
  assert.match(component, /this\.setAttribute\("aria-hidden", "true"\);/u);
  assert.match(component, /<svg class="bot-face" viewBox=\$\{faceViewBox\(VIEW_BOX\[size\], ears\?\.top\)\} focusable="false" aria-hidden="true"/u);
  assert.match(component, /const active = this\.#connected && !prefersReducedMotion\(\) && \(typeof document === "undefined" \|\| !document\.hidden\) && onScreen\.get\(this\) !== false;/u);
  assert.match(component, /this\.toggleAttribute\("data-paused", this\.#connected && !active\);/u);
  assert.match(component, /document\.addEventListener\("visibilitychange", notifyAll\)/u);
  assert.match(component, /new IntersectionObserver\(/u, "one observer for every face");
  const styles = read("../styles/bot-face.css");
  assert.match(styles, /hui-bot-face\[data-paused\] :is\(\.fx, \.bot-face__shadow, \.bot-face__thoughts circle\) \{ animation-play-state: paused; \}/u);
  const reduced = styles.slice(styles.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(reduced, /:is\(\.fx, \.bot-face__shadow, \.bot-face__thoughts circle\) \{ animation: none !important; \}/u);
  assert.match(reduced, /:is\(\.bot-face__gaze, \.bot-face__eyes, \.e-open\) \{ transition: none; \}/u);
  assert.match(reduced, /svg\[data-state="waiting"\] \.bot-face__tilt \{ transform: rotate\(8deg\); \}/u, "waiting keeps its tilt, still");
  for (const state of ["idle", "sleeping", "thinking", "working", "waiting", "memory", "error", "done", "offline"]) assert.match(styles, new RegExp(`svg\\[data-state="${state}"\\]`, "u"), state);
});

test("emoji tiles take a face's width in rows, so names line up whichever look a bot has", () => {
  const css = readFileSync(new URL("../styles/bots.css", import.meta.url), "utf8");
  const faceCss = readFileSync(new URL("../styles/bot-face.css", import.meta.url), "utf8");
  const px = (pattern: RegExp, text: string) => Number(text.match(pattern)?.[1]);
  const tile = px(/\.bot-avatar \{[^}]*?\n  width: (\d+)px;/u, css);
  assert.equal(tile, 28);
  for (const size of ["sm", "md"]) {
    const face = px(new RegExp(String.raw`hui-bot-face\[size="${size}"\] \{ --bot-face-size: (\d+)px; \}`, "u"), faceCss);
    const margin = px(new RegExp(String.raw`\.bot-avatar--${size}\.bot-avatar--emoji \{ margin-inline: (\d+)px; \}`, "u"), css);
    assert.equal(tile + 2 * margin, face, size);
  }
});

test("+ creates a bot at once, without a name, and opens its chat, as in Grok Bot; no dialog is left", () => {
  const source = read("./bots.ts");
  const button = between(source, "export function renderNewBotButton(", "/** The menu item for this machine");
  assert.equal(button.match(/data-new-bot-trigger \?disabled=\$\{busy\} aria-busy=\$\{busy \? "true" : "false"\}/gu)?.length, 1, "+, the menu's trigger, waits for the bot it is creating");
  assert.match(read("./shell.ts"), /onCreate: botsTab\.onCreate, onImport: botsTab\.onImport, creating: botsTab\.creating,/u);
  assert.match(source, /props\.creating \? "Creating…" : "New bot"/u, "and so does the empty roster's New bot");
  assert.doesNotMatch(source, /renderBotDialog\b|bot-dialog|botDialog|botDraft/u, "the New bot and Edit dialogs are gone");
});

test("a bot chat offers a call whenever GPT-Live can run, and nothing of VoiceStudio", () => {
  const home = read("./home.ts");
  assert.match(home, /renderCallButton\(\{ botName: props\.bot\.bot\.name, inCall: props\.call\.inCall, onCall: props\.call\.onCall \}\)/u, "the phone button");
  assert.doesNotMatch(home, /renderVoiceNoteButton|renderVoiceNoteStatus|renderReadAloud|chat-read-aloud|chat-voice-btn/u, "no microphone in the composer, no Read aloud under replies");
});

test("the Settings page: Profile, Tagging, Model, Calls and Workspace, each change saved on its own", () => {
  const source = read("./bot-settings.ts");
  const tab = between(source, "export function renderBotSettings(", "\n}\n");
  assert.ok(tab.indexOf("renderProfile(props)") < tab.indexOf("renderTagging(props)") && tab.indexOf("renderTagging(props)") < tab.indexOf("renderModels(props)")
    && tab.indexOf("renderModels(props)") < tab.indexOf("renderCalls(props)") && tab.indexOf("renderCalls(props)") < tab.indexOf("renderWorkspace(props)"),
    "Profile on top, then Tagging, Model, Calls and Workspace");
  const tagging = between(source, "function renderTagging(", "function renderModels(");
  assert.match(tagging, /setting: "description", keys: \["description"\], stacked: true, title: "When to tag it"/u);
  assert.match(tagging, /<textarea class="settings-input bot-settings__description"[^>]*maxlength=\$\{BOT_LIMITS\.description\}/u);
  assert.match(tagging, /onTextKeydown\(event, "description", props\)\} @blur=\$\{\(event: FocusEvent\) => onTextBlur\(event, "description", props\)\}/u, "the description saves on Enter or blur");
  assert.match(tagging, /setting: "tagging", keys: \["tagging"\], title: "Who can tag it"/u);
  assert.match(tagging, /onChange: \(next\) => props\.onChange\("tagging", next\)/u, "who can tag it saves as it changes");
  assert.match(source, /\{ value: "anyone", label: "Anyone"[\s\S]*\{ value: "mention", label: "Only when @mentioned"[\s\S]*\{ value: "nobody", label: "Nobody"/u);
  assert.match(source, /if \(!value && key !== "title" && key !== "description"\)/u, "a description can be cleared, as a title can");
  const profile = between(source, "/** Name, title and look, edited in place", "function renderModels(");
  assert.match(profile, /setting: "name", keys: \["name"\]/u);
  assert.match(profile, /setting: "title", keys: \["title"\]/u);
  assert.match(profile, /onTextKeydown\(event, "name", props\)\} @blur=\$\{\(event: FocusEvent\) => onTextBlur\(event, "name", props\)\}/u, "the name saves on Enter or blur");
  assert.match(profile, /\$\{renderLook\(props\)\}/u, "then the look");
  const models = between(source, "function renderModels(", "/** The call voice:");
  for (const [setting, key] of [["model", "model"], ["thinking", "thinking"], ["utility", "memoryModel"]]) {
    assert.match(models, new RegExp(`setting: "${setting}", keys: \\["${key}"\\]`, "u"));
    assert.match(models, new RegExp(`props\\.onChange\\("${key}", next\\)`, "u"), `${key} saves as it changes`);
  }
  assert.match(models, /"Applies from its next turn"/u);
  assert.match(models, /modelOptions\(props\.models, "Gateway default", model\)/u, "Gateway default clears the model");
  const calls = between(source, "/** The call voice:", "/** The text controls");
  assert.doesNotMatch(between(source, "function renderCalls(", "/** The text controls"), /return nothing/u, "Calls always show: calls run on GPT-Live");
  assert.match(calls, /sectionHead\(props, "calls", "Calls", props\.call\.ready === false \? "Needs a ChatGPT login" : undefined\)/u,
    "without a ChatGPT login the head says what calls need, and nothing while the gateway has not said");
  assert.match(calls, /renderCallVoiceRow\(props, props\.call\)\}[\s\S]*renderLanguageRow\(props\)/u, "the call voice, then the language");
  assert.match(calls, /How it sounds on calls\. Default follows Settings → Models → Calls\./u);
  assert.doesNotMatch(source, /VoiceStudio|Read-aloud|Preview|voiceSpeed/u, "nothing of VoiceStudio");
  const workspace = between(source, "function renderWorkspace(", "export function renderBotSettings(");
  assert.match(workspace, /const busy = botIsBusy\(props\.bot\);/u);
  assert.match(workspace, /disabled: busy/u, "the directory can move only while the bot is idle");
  assert.match(source, /if \(event\.key === "Enter"\) \{\n\s+event\.preventDefault\(\);\n\s+commitText\(input, key, props, true\);/u, "Enter saves a text control, the directory too");
  assert.match(source, /@focusout=\$\{\(event: FocusEvent\) => onDirectoryFocusOut\(event, props\)\}/u, "and so does leaving it");
  assert.match(between(source, "function renderRow(", "function sectionHead("), /<span class="bot-setting__status" role="status">\$\{pending \? "Saving…" : ""\}<\/span>/u, "a pending save shows on its row");
  assert.match(between(source, "function renderRow(", "function sectionHead("), /<p class="bot-setting__error" role="alert">/u, "and so does a refusal");
  assert.doesNotMatch(source, /type="submit"|>Save</u, "no Save button");
});

test("the roster's Edit opens the bot's chat with its panel on Settings, docked or as the sheet", () => {
  const source = read("./bots.ts");
  assert.match(source, /<span class="session-menu__text">Edit bot…<\/span>/u, "the ellipsis of a place to make choices, as Settings… has, and as the header's ⋯ menu says");
});

test("the panel opens on the bot's overview, whose rows open its pages with a way back; Ctrl+Shift+, toggles Settings", () => {
  const source = read("./bots.ts");
  const overview = between(source, "function renderOverview(", "function renderPanelView(");
  const order = ["renderProfile(props)", "renderRoutinesSummary(props)", "renderTriggersSummary(props, now)", "renderActivity(props, now)", "renderSetup(props)"].map((part) => overview.indexOf(part));
  assert.ok(order.every((at, index) => at > (order[index - 1] ?? -1)), "who it is, what it does on its own, then how it is set up");
  assert.match(between(source, "function renderPanelHeader(", "/** The panel beside the bot's chat"), /bot-panel__back" aria-label=\$\{`Back to \$\{props\.bot\.name\}`\}/u, "every page has a way back");
  assert.doesNotMatch(between(source, "/* ── side panel", "/* ── archive confirmation"), /role="tab"|SOUL\.md/iu, "no tabs or Soul editor");
});

test("an expanded panel keeps the chat mounted underneath, and Escape brings the chat back instead of stopping its turn", () => {
  const css = readFileSync(new URL("../styles/bots.css", import.meta.url), "utf8");
  assert.match(css, /\.bot-workspace--expanded > \.bot-workspace__chat \{ position: absolute; inset: 0; visibility: hidden; pointer-events: none; \}/u, "hidden, never unmounted: its stream, draft and scroll survive");
});

test("the Settings page uses no fixed heights that could clip it", () => {
  const css = readFileSync(new URL("../styles/bots.css", import.meta.url), "utf8");
  const tab = css.slice(css.indexOf("/* ── Settings page"), css.indexOf("/* The Look:"));
  // An icon's size is no container's height.
  assert.doesNotMatch(tab.replace(/[^{}]*\bsvg \{[^}]*\}/gu, ""), /(^|[\s;{])(max-)?height: \d/mu, "no fixed or maximum height");
  assert.match(tab, /\.bot-settings \.settings-row\.bot-setting \{[^}]*min-height: 0;/u, "compact rows");
  assert.match(tab, /\.bot-settings \.bot-setting--stacked \.settings-row__control \{ display: grid; grid-template-columns: minmax\(0, 1fr\);/u, "a stacked control takes the row's width");
  assert.doesNotMatch(css, /\.bot-dialog/u, "no dialog styles are left");
});

test("the overview's Tagging, Model and Calls rows name who may tag the bot, what it runs on and how it sounds on calls", () => {
  assert.deepEqual([botTaggingLabel({}), botTaggingLabel({ tagging: "mention" }), botTaggingLabel({ tagging: "nobody" })], ["Anyone", "Only when @mentioned", "Nobody"]);
  assert.match(between(read("./bots.ts"), "function renderSetup(", "function renderOverview("), /row\("settings-tagging", "settings", "Tagging", botTaggingLabel\(bot\), bot\.description \?\? botTaggingLabel\(bot\)\)/u,
    "it opens Settings at Tagging, its description as the title");
  const models = [{ provider: "anthropic", id: "claude-x", name: "Claude X" }];
  assert.equal(botModelLabel({}, models), "Gateway default");
  assert.equal(botModelLabel({ model: "anthropic/claude-x", thinking: "xhigh" }, models), "Claude X · Extra high");
  assert.equal(botModelLabel({ model: "openai/gone", thinking: "dancing" }, models), "openai/gone", "a model gone from the catalog still shows; an unknown thinking level doesn't");
  assert.equal(botCallsLabel({}, { defaultVoice: "sol" }), "Sol · Auto", "Settings' voice while it has none of its own");
  assert.equal(botCallsLabel({ voice: { live: "maple", language: "es" } }, { defaultVoice: "sol" }), "Maple · Spanish");
});

test("the roster's + is a menu, New bot (on Local or on each worker while a worker exists) then Import bot…, and a choice creates the bot there at once", () => {
  const source = read("./bots.ts");
  const button = between(source, "export function renderNewBotButton(", "/** The menu item for this machine");
  assert.match(button, /if \(value === IMPORT_BOT\) props\.onImport\(\);\n\s+else if \(!props\.workers\.length\) props\.onNew\(\);/u, "without workers, New bot creates it here");
  assert.match(button, /<span class="session-menu__text">New bot<\/span><\/wa-dropdown-item>/u);
  assert.match(button, /<div class="session-menu__separator" role="separator"><\/div>\n\s+<wa-dropdown-item value=\$\{IMPORT_BOT\} class="session-menu__item">[^\n]*<span class="session-menu__text">Import bot…<\/span>/u, "Import bot… after a separator, always");
  assert.match(button, /<wa-dropdown class="session-menu new-bot-menu" placement="bottom-end"/u);
  assert.match(button, /<button slot="trigger" type="button" aria-label="New bot" title="New bot" data-new-bot-trigger /u, "the same + opens the menu");
  assert.match(button, /props\.onCreate\(value === NEW_BOT_LOCAL \? undefined : value\);/u, "a choice creates the bot there");
  assert.match(button, /New bot on Local<\/span><\/wa-dropdown-item>/u);
  assert.match(button, /New bot on \$\{worker\.name\}\$\{worker\.state === "connected"/u, "each worker, with its state while not connected");
  assert.match(button, /props\.onOpen\?\.\(\);/u, "opening it reads the workers again");
  const css = readFileSync(new URL("../styles/bots.css", import.meta.url), "utf8");
  assert.match(css, /\.sidebar-recent-sessions__toolbar \.new-bot-menu \{[^}]*text-transform: none;/u, "its items are not the toolbar's small caps");
  const shell = read("./shell.ts");
  assert.match(shell, /\$\{botsTab \? renderNewBotButton\(\{\n\s+workers: botsTab\.workers, onNew: botsTab\.onNew, onCreate: botsTab\.onCreate,/u);
});

test("Settings → Workspace shows the machine a bot runs on, read-only, and offers only that machine's folders", () => {
  const source = read("./bot-settings.ts");
  assert.match(between(source, "export function renderBotMachine(", "/**\n * Runs on:"),
    /data-bot-machine>\$\{worker \? icons\.globe : icons\.terminal\}<span>\$\{worker\?\.name \?\? "Local"\}<\/span>/u, "a helper any view can show read-only");
  const field = between(source, "export function renderBotMachineField(", "/** What the directory row says");
  assert.match(field, /if \(!worker && !props\.workersExist\) return undefined;/u, "for a bot on a worker, and for one here while a worker exists");
  assert.match(field, /return html`Runs on \$\{renderBotMachine\(worker\)\}`;/u, "read-only: nothing to change it with");
  assert.match(field, /bot\.worker\n\s+\? html`<p class="bot-panel__hint bot-settings__machine-hint">A bot stays on the machine it was created on: its chat and memory live there\. Terminals, the browser and watchers stay on this machine, so it can't use them\.<\/p>`/u, "a remote bot's limits");
  assert.match(between(source, "function directoryHint(", "function renderWorkspace("), /A folder on \$\{bot\.worker\.name\}\. Can change only while it is idle\./u);
  const workspace = between(source, "function renderWorkspace(", "export function renderBotSettings(");
  assert.match(workspace, /\$\{sectionHead\(props, "workspace", "Workspace", renderBotMachineField\(props\)\)\}/u, "Runs on beside the heading, as Model's note: no height, so the tab still fits 1440×900 with a worker around");
  assert.match(workspace, /<\/div>\n\s+\$\{renderMachineHint\(props\.bot\)\}\n\s+<\/section>/u, "a bot on a worker says why under the section");
  assert.doesNotMatch(source, /renderPicker\(\{ label: "Runs on"/u, "a bot's machine is chosen with +, never changed");
});

test("a bot on a worker shows the machine compactly in its roster row, its chat header and its confirmations", () => {
  const source = read("./bots.ts");
  assert.match(between(source, "function botRow(", "function archivedRow("),
    /\$\{bot\.worker \? html`<span class="bot-row__tag bot-row__machine" title=\$\{`Runs on \$\{bot\.worker\.name\}`\}>\$\{icons\.globe\}<span>\$\{bot\.worker\.name\}<\/span><\/span>` : nothing\}/u);
  assert.match(read("../lib/bots/roster.ts"), /\.\.\.\(bot\.worker \? \[`on \$\{bot\.worker\.name\}`\] : \[\]\)/u, "the row's accessible name says where it runs");
  const identity = between(read("./home.ts"), "function renderBotIdentity(", "function renderHeader(");
  assert.match(identity, /<span class="bot-chat-identity__machine" title=\$\{`Runs on \$\{worker\.name\}`\}><span class="sr-only">on <\/span>\$\{icons\.globe\}<span>\$\{worker\.name\}<\/span><\/span> · /u);
  assert.match(identity, /title=\$\{worker \? `\$\{worker\.name\}:\$\{session\.cwd\}` : session\.cwd\}/u, "its folder reads devbox:/path");
  const css = readFileSync(new URL("../styles/bots.css", import.meta.url), "utf8");
  assert.match(css, /\.app-shell \.bot-row__machine \{[^}]*max-width: 45%;/u, "a long name never crowds the preview out");
  assert.match(css, /\.bot-chat-identity__machine svg \{ flex: none; width: 11px; height: 11px; \}/u);
  assert.match(between(source, "export function renderBotArchiveDialog(", "/* ── delete confirmation"), /stay on \$\{bot\.worker\?\.name \?\? "this machine"\}/u);
  assert.match(between(source, "function renderProfile(", "function renderRoutinesSummary("), /bot\.worker \? `on \$\{bot\.worker\.name\}` : ""/u, "its profile says where it runs");
  const deleting = source.slice(source.indexOf("export function renderBotDeleteDialog("));
  assert.match(deleting, /its memory and its folder\$\{bot\.worker \? ` on \$\{bot\.worker\.name\}` : ""\} \(SOUL\.md and every file in it\) go/u, "its folder on the worker");
  assert.match(deleting, /bot\.status === "disconnected" \? `; HUI is not connected to \$\{bot\.worker\.name\} now, so those go there when it reconnects` : ""/u, "and when they go while the worker is offline");
});
