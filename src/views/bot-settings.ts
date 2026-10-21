/**
 * A bot's Settings page in its panel (HUI-18), after Grok Bot's "Bot settings":
 * who the bot is, how agents and bots tag it, the models it runs on, how it
 * sounds on calls and where it works, as compact rows in the style of HUI's
 * Settings pages, and the one-line summaries the panel's overview shows of them.
 * Each change saves on its own through `PATCH /__hui/bots/:id` (owned by
 * `hui-app.ts`): its row says while the save is pending and shows a refusal.
 * There is no Save button. Rendering only.
 */
import { html, nothing, svg, type TemplateResult } from "lit";
import { icons } from "../lib/icons.ts";
import {
  BOT_FACE_COLORS, BOT_FACE_EARS, BOT_FACE_EARS_LABELS, BOT_FACE_SHAPES, BOT_FACE_SHAPE_LABELS, BOT_LIMITS, BOT_THINKING_LEVELS, botColorName, botSettingOf, isBotFaceEars, isBotFaceShape,
  type BotSettingKey, type BotSettingValue, type BotView,
} from "../lib/bots/bots.ts";
import type { RuntimeModel } from "../api/sessions.ts";
import type { BotAvatar, BotFaceEars, BotFaceShape, BotTagging } from "../api/schema/bots.ts";
import { FACE_LEAF_COLOR, faceEars, facePath, faceViewBox } from "../lib/bots/face.ts";
import { callVoice, GPT_LIVE_VOICES, gptLiveVoiceLabel } from "../lib/voice/calls.ts";
import type { GptLiveVoice } from "../api/schema/bots.ts";
import { voiceLanguageName } from "../lib/voice/languages.ts";
import { languageOptions } from "../lib/voice/voice.ts";
import { renderPicker } from "./settings-picker.ts";
import { renderDirectoryPicker } from "./directory-picker.ts";
import { THINKING_LABELS } from "../lib/thinking.ts";

export type { BotSettingKey, BotSettingValue } from "../lib/bots/bots.ts";

/** Per row: the value a save is sending (shown until the gateway answers) and the last refusal. */
export type BotSettingsSaves = {
  pending: Partial<Record<BotSettingKey, BotSettingValue>>;
  errors: Partial<Record<BotSettingKey, string>>;
};

export const NO_BOT_SETTINGS_SAVES: BotSettingsSaves = { pending: {}, errors: {} };

/** The Calls section: GPT-Live's default voice, which a bot's "Default" follows, and whether a ChatGPT login lets calls
 * run (absent until the gateway has said). */
export type BotSettingsCall = { defaultVoice: GptLiveVoice; ready?: boolean };

export type BotSettingsProps = {
  bot: BotView;
  /** Prefix of the tab's element ids. */
  id: string;
  /** Draws the bot's face, or its emoji, for a look (the one a save is sending), as the roster does. */
  face: (avatar: BotAvatar) => TemplateResult;
  models: readonly RuntimeModel[];
  /** The name of Settings' utility model, the bot's while it has none of its own. */
  utilityDefault?: string;
  saves: BotSettingsSaves;
  onChange: (key: BotSettingKey, value: BotSettingValue) => void;
  /** Drops a control's refusal, as Escape does in a text field. */
  onDismiss: (key: BotSettingKey) => void;
  /** The Calls section, always shown: calls run on GPT-Live. */
  call: BotSettingsCall;
  /** A remote worker exists (Settings → Workers): Workspace shows the machine the bot runs on, even this one. */
  workersExist?: boolean;
  /** Folder suggestions from the machine the bot runs on: a bot on a worker is never offered this machine's. */
  directory: { suggestions: readonly string[]; onInput: (value: string) => void };
};

/** "Gateway default" sends "": the bot goes back to the model and thinking level a new chat gets. */
const THINKING_CHOICES = [{ value: "", label: "Gateway default" }, ...BOT_THINKING_LEVELS.map((level) => ({ value: level, label: THINKING_LABELS[level] }))];
/** Who can tag a bot, as a skill's frontmatter says when it loads. */
const TAGGING_CHOICES: readonly { value: BotTagging; label: string; description: string }[] = [
  { value: "anyone", label: "Anyone", description: "Agents and bots, when a task fits" },
  { value: "mention", label: "Only when @mentioned", description: "When your message tags it" },
  { value: "nobody", label: "Nobody", description: "Only you, in its chat" },
];

/** `empty` labels the default choice, the empty value. */
function modelOptions(models: readonly RuntimeModel[], empty: string, current: string) {
  const options = [{ value: "", label: empty }, ...models.map((model) => ({ value: `${model.provider}/${model.id}`, label: model.name, description: model.provider }))];
  // A model no longer in the catalog still shows what the bot runs on.
  return current && !options.some((option) => option.value === current) ? [...options, { value: current, label: current }] : options;
}

/** The overview's Model row: the bot's model by its catalog name (Gateway default without one) and its thinking. */
export function botModelLabel(bot: Pick<BotView, "model" | "thinking">, models: readonly RuntimeModel[]): string {
  const name = bot.model ? models.find((model) => `${model.provider}/${model.id}` === bot.model)?.name ?? bot.model : "Gateway default";
  const thinking = BOT_THINKING_LEVELS.find((level) => level === bot.thinking);
  return thinking ? `${name} · ${THINKING_LABELS[thinking]}` : name;
}

/** The overview's Tagging row: who may tag the bot. */
export function botTaggingLabel(bot: Pick<BotView, "tagging">): string {
  return TAGGING_CHOICES.find((choice) => choice.value === (bot.tagging ?? "anyone"))!.label;
}

/** The overview's Calls row: the voice it calls with (its own, else Settings') and the language it speaks. */
export function botCallsLabel(bot: Pick<BotView, "voice">, call: BotSettingsCall): string {
  const language = bot.voice?.language ? voiceLanguageName(bot.voice.language) : "Auto";
  return `${gptLiveVoiceLabel(callVoice(bot.voice?.live, call.defaultVoice))} · ${language}`;
}

/** Every language's English name and code, read once: they never change while HUI runs. */
let languageChoices: ReturnType<typeof languageOptions> | undefined;

/** The value a row shows: the one a save is sending, else the bot's. */
export function botSettingValue(bot: BotView, saves: BotSettingsSaves, key: BotSettingKey): BotSettingValue {
  return saves.pending[key] ?? botSettingOf(bot, key);
}

/** While a turn runs, starts or waits for an answer, the bot's workspace cannot move (the gateway refuses it). */
export function botIsBusy(bot: Pick<BotView, "status">): boolean {
  return bot.status === "running" || bot.status === "starting" || bot.status === "waiting";
}

type RowOptions = {
  /** `data-setting`, for tests and styles. */
  setting: string;
  /** What the row saves: its pending state and refusals follow these keys. */
  keys?: readonly BotSettingKey[];
  title: string;
  /** Names a native control; the pickers name themselves. */
  labelFor?: string;
  desc?: unknown;
  control: unknown;
  /** The title above a full-width control, where the panel leaves the control no room beside it. */
  stacked?: boolean;
};

/** One compact row: title and short description, the control beside them (or under them when stacked), the
 * save's state on the title line, so a save never moves the rows, and a refusal under it all. */
function renderRow(props: BotSettingsProps, options: RowOptions) {
  const keys = options.keys ?? [];
  const pending = keys.some((key) => props.saves.pending[key] !== undefined);
  const errors = keys.flatMap((key) => props.saves.errors[key] ?? []);
  const title = options.labelFor
    ? html`<label class="settings-row__title" for=${options.labelFor}>${options.title}</label>`
    : html`<span class="settings-row__title">${options.title}</span>`;
  return html`<div class="settings-row bot-setting ${options.stacked ? "bot-setting--stacked" : ""}" data-setting=${options.setting} aria-busy=${pending ? "true" : "false"}>
    <div class="settings-row__text">
      <div class="bot-setting__title">${title}<span class="bot-setting__status" role="status">${pending ? "Saving…" : ""}</span></div>
      ${options.desc ? html`<span class="settings-row__desc">${options.desc}</span>` : nothing}
    </div>
    <div class="settings-row__control">${options.control}</div>
    ${errors.length ? html`<p class="bot-setting__error" role="alert">${errors.join(" ")}</p>` : nothing}
  </div>`;
}

function sectionHead(props: BotSettingsProps, section: string, title: string, note?: string | TemplateResult) {
  return html`<div class="bot-settings__head"><h3 class="bot-panel__heading" id=${`${props.id}-settings-${section}`}>${title}</h3>${note ? html`<span class="bot-settings__note">${note}</span>` : nothing}</div>`;
}

/** A shape's silhouette, small, for its chip, with the ears given on top (a sprout green, as on the face). */
function shapeIcon(shape: BotFaceShape, ears?: BotFaceEars) {
  const parts = ears ? faceEars(shape, ears) : undefined;
  return html`<svg class="bot-look__shape-icon" viewBox=${faceViewBox([16, 22, 88], parts?.top)} aria-hidden="true" focusable="false">
    ${parts?.parts.map((part) => svg`<path d=${part.d} transform=${part.transform} fill=${part.leaf ? FACE_LEAF_COLOR : nothing}></path>`)}<path d=${facePath(shape)}></path></svg>`;
}

/** The look: a summary row with the face, opening into Face (shape, ears and color) or Emoji. Each choice saves on its
 * own; choosing Emoji saves once one is typed, and Face clears the emoji. Native radio groups: Tab enters each
 * group, arrows choose. */
function renderLook(props: BotSettingsProps) {
  const { bot, saves, id } = props;
  const shape = botSettingValue(bot, saves, "shape");
  const color = botSettingValue(bot, saves, "color");
  const emoji = botSettingValue(bot, saves, "emoji");
  const value = botSettingValue(bot, saves, "ears");
  const ears = isBotFaceEars(value) ? value : undefined;
  const keys: readonly BotSettingKey[] = ["shape", "ears", "color", "emoji"];
  const pending = keys.some((key) => saves.pending[key] !== undefined);
  const errors = keys.flatMap((key) => saves.errors[key] ?? []);
  const face = isBotFaceShape(shape) ? shape : "blob";
  const custom = BOT_FACE_COLORS.some((entry) => entry.hex === color) ? undefined : color;
  const swatches = [...BOT_FACE_COLORS.map((entry) => ({ hex: entry.hex, label: entry.label })), ...(custom ? [{ hex: custom, label: `Custom ${custom}` }] : [])];
  const avatar: BotAvatar = { shape: face, color, ...(ears ? { ears } : {}), ...(emoji ? { emoji } : {}) };
  const kind = emoji ? "emoji" : "face";
  const faceName = [BOT_FACE_SHAPE_LABELS[face], ...(ears ? [BOT_FACE_EARS_LABELS[ears]] : []), botColorName(color)];
  return html`<details class="settings-row bot-setting bot-look" data-setting="look">
    <summary class="bot-look__summary" aria-label=${`Look: ${emoji ? `emoji ${emoji}` : faceName.join(", ")}`}>
      ${props.face(avatar)}
      <span class="settings-row__text">
        <span class="bot-setting__title"><span class="settings-row__title">Look</span><span class="bot-setting__status" role="status">${pending ? "Saving…" : ""}</span></span>
        <span class="settings-row__desc">${emoji ? `Emoji ${emoji}` : faceName.join(" · ")}</span>
      </span>
      <span class="bot-look__change" aria-hidden="true"></span>
    </summary>
    <div class="bot-look__editor">
      <div class="settings-segmented bot-look__kind" role="radiogroup" aria-label="Look">
        ${([["face", "Face"], ["emoji", "Emoji"]] as const).map(([value, label]) => html`<label class="settings-segmented__btn">
          <input type="radio" name=${`${id}-look`} value=${value} .checked=${kind === value}
            @change=${() => { if (value === "face" && botSettingOf(bot, "emoji")) props.onChange("emoji", ""); }} /><span>${label}</span></label>`)}
      </div>
      <div class="bot-look__face">
        <span class="settings-row__desc" aria-hidden="true">Shape</span>
        <div class="bot-look__shapes" role="radiogroup" aria-label="Shape">
          ${BOT_FACE_SHAPES.map((option) => html`<label class="bot-look__chip" style=${`--bot-look-color: ${color}`} title=${BOT_FACE_SHAPE_LABELS[option]}>
            <input type="radio" name=${`${id}-shape`} value=${option} aria-label=${BOT_FACE_SHAPE_LABELS[option]} .checked=${face === option}
              @change=${() => props.onChange("shape", option)} />${shapeIcon(option)}</label>`)}
        </div>
        <span class="settings-row__desc" aria-hidden="true">Ears</span>
        <div class="bot-look__shapes" role="radiogroup" aria-label="Ears">
          ${(["", ...BOT_FACE_EARS] as const).map((option) => {
            const label = option ? BOT_FACE_EARS_LABELS[option] : "No ears";
            return html`<label class="bot-look__chip" style=${`--bot-look-color: ${color}`} title=${label}>
              <input type="radio" name=${`${id}-ears`} value=${option} aria-label=${label} .checked=${(ears ?? "") === option}
                @change=${() => props.onChange("ears", option)} />${shapeIcon(face, option || undefined)}</label>`;
          })}
        </div>
        <div class="bot-look__colors" role="radiogroup" aria-label="Color">
          ${swatches.map((entry) => html`<label class="bot-look__swatch" style=${`--swatch: ${entry.hex}`} title=${entry.label}>
            <input type="radio" name=${`${id}-color`} value=${entry.hex} aria-label=${entry.label} .checked=${color === entry.hex}
              @change=${() => props.onChange("color", entry.hex)} /></label>`)}
        </div>
      </div>
      <label class="bot-look__emoji"><span class="settings-row__desc">Emoji</span>
        <input class="settings-input" name="emoji" type="text" maxlength="16" autocomplete="off" placeholder="🤖" .value=${botSettingOf(bot, "emoji")}
          @keydown=${(event: KeyboardEvent) => onTextKeydown(event, "emoji", props)} @blur=${(event: FocusEvent) => onTextBlur(event, "emoji", props)} /></label>
      <span class="settings-row__desc bot-look__hint">Its face shows what it is doing: thinking, using tools, waiting for you, listening and speaking on calls. An emoji has no expressions.</span>
    </div>
    ${errors.length ? html`<p class="bot-setting__error" role="alert">${errors.join(" ")}</p>` : nothing}
  </details>`;
}

/** Name, title and look, edited in place: the bot can also set them itself as it learns who it is. */
function renderProfile(props: BotSettingsProps) {
  const { bot } = props;
  const nameId = `${props.id}-settings-name`;
  const titleId = `${props.id}-settings-title`;
  return html`<section class="bot-settings__section" aria-labelledby=${`${props.id}-settings-profile`}>
    ${sectionHead(props, "profile", "Profile")}
    <div class="settings-group bot-settings__group">
      ${renderRow(props, { setting: "name", keys: ["name"], title: "Name", labelFor: nameId, desc: `@${bot.handle}`,
        control: html`<input class="settings-input" id=${nameId} name="name" type="text" required maxlength=${BOT_LIMITS.name} autocomplete="off" .value=${bot.name}
          @keydown=${(event: KeyboardEvent) => onTextKeydown(event, "name", props)} @blur=${(event: FocusEvent) => onTextBlur(event, "name", props)} />` })}
      ${renderRow(props, { setting: "title", keys: ["title"], title: "Title", labelFor: titleId,
        control: html`<input class="settings-input" id=${titleId} name="title" type="text" maxlength=${BOT_LIMITS.title} autocomplete="off" placeholder="Add a title" .value=${bot.title ?? ""}
          @keydown=${(event: KeyboardEvent) => onTextKeydown(event, "title", props)} @blur=${(event: FocusEvent) => onTextBlur(event, "title", props)} />` })}
      ${renderLook(props)}
    </div>
  </section>`;
}

/** How agents and bots hand it work: what they read to decide (its description, like a skill's) and who may tag it. */
function renderTagging(props: BotSettingsProps) {
  const { bot } = props;
  const descriptionId = `${props.id}-settings-description`;
  const tagging = botSettingValue(bot, props.saves, "tagging");
  return html`<section class="bot-settings__section" aria-labelledby=${`${props.id}-settings-tagging`}>
    ${sectionHead(props, "tagging", "Tagging", tagging === "nobody" ? undefined : `@${bot.handle} from any chat`)}
    <div class="settings-group bot-settings__group">
      ${renderRow(props, { setting: "description", keys: ["description"], stacked: true, title: "When to tag it", labelFor: descriptionId,
        desc: `What agents and bots read to decide when to tag it, as they read a skill's description.${bot.title ? " Without it, its title stands in." : ""}`,
        control: html`<textarea class="settings-input bot-settings__description" id=${descriptionId} name="description" rows="3" maxlength=${BOT_LIMITS.description}
          placeholder="What it does, and when to tag it" .value=${bot.description ?? ""}
          @keydown=${(event: KeyboardEvent) => onTextKeydown(event, "description", props)} @blur=${(event: FocusEvent) => onTextBlur(event, "description", props)}></textarea>` })}
      ${renderRow(props, { setting: "tagging", keys: ["tagging"], title: "Who can tag it",
        desc: TAGGING_CHOICES.find((choice) => choice.value === tagging)?.description,
        control: renderPicker({ label: "Who can tag it", value: tagging, options: TAGGING_CHOICES, onChange: (next) => props.onChange("tagging", next) }) })}
    </div>
  </section>`;
}

function renderModels(props: BotSettingsProps) {
  const value = (key: BotSettingKey) => botSettingValue(props.bot, props.saves, key);
  const model = value("model");
  const thinking = value("thinking");
  const utility = value("memoryModel");
  return html`<section class="bot-settings__section" aria-labelledby=${`${props.id}-settings-model`}>
    ${sectionHead(props, "model", "Model", "Applies from its next turn")}
    <div class="settings-group bot-settings__group">
      ${renderRow(props, { setting: "model", keys: ["model"], stacked: true, title: "Model", desc: "The smartest you have. Speed doesn't matter.",
        control: renderPicker({ label: "Model", value: model, searchable: true, searchPlaceholder: "Search models",
          options: modelOptions(props.models, "Gateway default", model), onChange: (next) => props.onChange("model", next) }) })}
      ${renderRow(props, { setting: "thinking", keys: ["thinking"], title: "Thinking",
        control: renderPicker({ label: "Thinking", value: thinking, options: THINKING_CHOICES, onChange: (next) => props.onChange("thinking", next) }) })}
      ${renderRow(props, { setting: "utility", keys: ["memoryModel"], stacked: true, title: "Utility model",
        desc: "The fastest you have, ideally cheap: memory summaries and quick answers on calls.",
        control: renderPicker({ label: "Utility model", value: utility, searchable: true, searchPlaceholder: "Search models",
          options: modelOptions(props.models, props.utilityDefault ? `Default (${props.utilityDefault})` : "Default (same as the bot)", utility),
          onChange: (next) => props.onChange("memoryModel", next) }) })}
    </div>
  </section>`;
}

/** The call voice: GPT-Live's own voices, "Default" following Settings → Models → Calls. */
function renderCallVoiceRow(props: BotSettingsProps, call: BotSettingsCall) {
  const value = botSettingValue(props.bot, props.saves, "callVoice");
  const options = [{ value: "", label: `Default (${gptLiveVoiceLabel(call.defaultVoice)})` }, ...GPT_LIVE_VOICES.map((voice) => ({ value: voice, label: gptLiveVoiceLabel(voice) }))];
  return renderRow(props, { setting: "call-voice", keys: ["callVoice"], stacked: true, title: "Call voice",
    desc: "How it sounds on calls. Default follows Settings → Models → Calls.",
    control: renderPicker({ label: "Call voice", value, options, onChange: (next) => props.onChange("callVoice", next) }) });
}

/** The language it speaks on calls; Auto answers in the caller's. */
function renderLanguageRow(props: BotSettingsProps) {
  languageChoices ??= languageOptions();
  const value = botSettingValue(props.bot, props.saves, "voiceLanguage");
  return renderRow(props, { setting: "language", keys: ["voiceLanguage"], title: "Language", desc: "Auto answers in yours.",
    control: renderPicker({ label: "Language", value, searchable: true, searchPlaceholder: "Search languages", options: languageChoices,
      onChange: (next) => props.onChange("voiceLanguage", next) }) });
}

/** Calls, on GPT-Live, the only engine: always shown. Without a ChatGPT login the voice and language still save, and
 * the section's head says what calls need (as Model's says when its changes apply), so the missing Call has a reason. */
function renderCalls(props: BotSettingsProps) {
  return html`<section class="bot-settings__section" aria-labelledby=${`${props.id}-settings-calls`}>
    ${sectionHead(props, "calls", "Calls", props.call.ready === false ? "Needs a ChatGPT login" : undefined)}
    <div class="settings-group bot-settings__group">
      ${renderCallVoiceRow(props, props.call)}
      ${renderLanguageRow(props)}
    </div>
  </section>`;
}

/** The text controls: they save on Enter or when the focus leaves them. */
type TextKey = "name" | "title" | "emoji" | "description" | "cwd";
type TextControl = HTMLInputElement | HTMLTextAreaElement;

/** Saves what a text control holds, if it changed. An emptied name, emoji or directory keeps the bot's (only a
 * title or a description can be cleared). Leaving the control does not send again what it already sent (a refused
 * value stays refused until it is edited); Enter does. */
function commitText(input: TextControl, key: TextKey, props: BotSettingsProps, explicit: boolean) {
  const current = botSettingOf(props.bot, key);
  const value = input.value.trim();
  if (!value && key !== "title" && key !== "description") {
    input.value = current;
    return;
  }
  if (value === current || (!explicit && input.dataset["sent"] === value)) return;
  input.dataset["sent"] = value;
  props.onChange(key, value);
}

/** The directory's suggestions are open and list something, so Escape is theirs to close. */
function suggestionsShowing(input: TextControl): boolean {
  return input.getAttribute("aria-expanded") === "true" && Boolean(input.closest(".new-session-page__directory-picker")?.querySelector('[role="option"]'));
}

/** Enter saves (a description is one paragraph, as rosters show it); Escape takes back what was typed, before it
 * closes anything (the directory's suggestions first). Keys from a suggestion choose it. */
function onTextKeydown(event: KeyboardEvent, key: TextKey, props: BotSettingsProps) {
  const input = event.target;
  if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) || event.isComposing) return;
  if (event.key === "Enter") {
    event.preventDefault();
    commitText(input, key, props, true);
  } else if (event.key === "Escape" && !event.defaultPrevented && input.value !== botSettingOf(props.bot, key) && !suggestionsShowing(input)) {
    event.preventDefault();
    event.stopPropagation();
    input.value = botSettingOf(props.bot, key);
    if (key === "cwd") input.setAttribute("aria-expanded", "false");
    delete input.dataset["sent"];
    props.onDismiss(key);
  }
}

function onTextBlur(event: FocusEvent, key: TextKey, props: BotSettingsProps) {
  const input = event.target;
  if ((input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) && !input.disabled) commitText(input, key, props, false);
}

/** The directory field saves when the focus leaves it and its suggestions alike. */
function onDirectoryFocusOut(event: FocusEvent, props: BotSettingsProps) {
  const field = event.currentTarget as HTMLElement;
  if (event.relatedTarget instanceof Node && field.contains(event.relatedTarget)) return;
  const input = field.querySelector("input");
  if (input && !input.disabled) commitText(input, "cwd", props, false);
}

/** The machine a bot runs on, read-only: its worker, or this machine. */
export function renderBotMachine(worker: BotView["worker"]) {
  return html`<span class="bot-machine" data-bot-machine>${worker ? icons.globe : icons.terminal}<span>${worker?.name ?? "Local"}</span></span>`;
}

/**
 * Runs on: the machine the bot stays on, read-only (its chat and memory live in that machine's store), beside the
 * Workspace heading as Model's says when its changes apply, so it costs the tab no height and the tab still fits a
 * 1440×900 screen. Shown for a bot on a worker, and for one here while a worker exists; where a bot runs is chosen when
 * it is created, with the roster's + (`renderNewBotButton`).
 */
export function renderBotMachineField(props: BotSettingsProps): TemplateResult | undefined {
  const { worker } = props.bot;
  if (!worker && !props.workersExist) return undefined;
  return html`Runs on ${renderBotMachine(worker)}`;
}

/** A bot on a worker, under its Workspace: why it stays there, and what it can't use from there. */
function renderMachineHint(bot: BotView) {
  return bot.worker
    ? html`<p class="bot-panel__hint bot-settings__machine-hint">A bot stays on the machine it was created on: its chat and memory live there. Terminals, the browser and watchers stay on this machine, so it can't use them.</p>`
    : nothing;
}

/** What the directory row says: a folder on the machine the bot runs on, which can move only while it is idle. */
function directoryHint(bot: BotView): string {
  if (botIsBusy(bot)) return "It is working. The directory can change once it is idle.";
  return bot.worker ? `A folder on ${bot.worker.name}. Can change only while it is idle.` : "Where it works. Can change only while it is idle.";
}

function renderWorkspace(props: BotSettingsProps) {
  const busy = botIsBusy(props.bot);
  const inputId = `${props.id}-settings-cwd`;
  return html`<section class="bot-settings__section" aria-labelledby=${`${props.id}-settings-workspace`}>
    ${sectionHead(props, "workspace", "Workspace", renderBotMachineField(props))}
    <div class="settings-group bot-settings__group">
      ${renderRow(props, { setting: "workspace", keys: ["cwd"], stacked: true, title: "Directory", labelFor: inputId,
        desc: directoryHint(props.bot),
        control: html`<div class="bot-settings__directory" @keydown=${{ handleEvent: (event: KeyboardEvent) => onTextKeydown(event, "cwd", props), capture: true }}
          @focusout=${(event: FocusEvent) => onDirectoryFocusOut(event, props)}>
          ${renderDirectoryPicker({ id: inputId, label: "Directory", value: props.bot.cwd, suggestions: props.directory.suggestions, onInput: props.directory.onInput,
            inputClass: "settings-input", externalLabel: true, disabled: busy })}
        </div>` })}
    </div>
    ${renderMachineHint(props.bot)}
  </section>`;
}

export function renderBotSettings(props: BotSettingsProps) {
  return html`<div class="bot-settings">
    ${renderProfile(props)}
    ${renderTagging(props)}
    ${renderModels(props)}
    ${renderCalls(props)}
    ${renderWorkspace(props)}
    <p class="bot-settings__note">The same settings from a terminal on this machine:
      <code>hui bot show ${props.bot.handle}</code>, <code>hui bot edit ${props.bot.handle}</code> and <code>hui bot list</code>.</p>
  </div>`;
}
