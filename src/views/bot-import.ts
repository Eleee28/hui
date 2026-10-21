/**
 * Importing a bot (the roster's + → Import bot…) and exporting one (its ⋯ → Export…). Rendering only: `hui-app.ts`
 * owns the state and every request (`lib/bots/templates.ts`). The import dialog has two steps: the source (a file or a
 * folder, a Grok Bot link, or pasted text), then the gateway's preview of everything creating it would do, which shows
 * all of the imported text, since it is untrusted, before Create. The export dialog shows the gateway's review of the
 * bot (what the cleanup and the utility model would change), a group picker per change, and the files exactly as
 * Download saves them (`buildExport`, a copy of the gateway's).
 */
import { html, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { buildExport, changeGroups, withAdditions, type BotExportBuild } from "../lib/bots/export-preview.ts";
import type { BotExportAddition, BotExportGroup, BotExportReview, BotImportPreview } from "../api/schema/bot-templates.ts";
import type { BotView } from "../lib/bots/bots.ts";
import { BOT_TEMPLATE_FORMATS, BOT_TEMPLATE_LIMITS, type BotImportTab, type PickedSource } from "../lib/bots/templates.ts";
import { botTriggerFilterSummary, cooldownLabel } from "../lib/bots/triggers.ts";
import { icons } from "../lib/icons.ts";
import { renderBotAvatar, type BotPlace } from "./bots.ts";
import { describeRoutineSchedule } from "./settings-automation.ts";
import { loadViewAssets } from "../lib/view-assets.ts";

loadViewAssets(() => import("../styles/bot-import.css"));

export type BotImportDialogProps = {
  step: "source" | "preview";
  tab: BotImportTab;
  picked?: PickedSource | undefined;
  url: string;
  text: string;
  /** Remote workers a bot can be imported onto; none: this machine only. */
  workers: readonly BotPlace[];
  /** The chosen worker's id; "" for this machine. */
  worker: string;
  /** Reading a source, or creating the bot. */
  pending: boolean;
  error: string;
  preview?: BotImportPreview | undefined;
  onTab: (tab: BotImportTab) => void;
  onPickFile: (file: File) => void;
  onPickFolder: (files: File[]) => void;
  onUrl: (value: string) => void;
  onText: (value: string) => void;
  onWorker: (id: string) => void;
  onPreview: () => void;
  /** Another agent of a file that holds several. */
  onPick: (key: string) => void;
  onBack: () => void;
  onCreate: () => void;
  onClose: () => void;
};

const TABS: readonly [BotImportTab, string][] = [["file", "File or folder"], ["link", "Link"], ["paste", "Paste"]];
const ACCEPT = ".zip,.json,.af,.png,.md,.markdown,.yaml,.yml,.txt";
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** What HUI reads, one line, for the source step. */
export const IMPORT_FORMATS_HINT = "HUI reads Grok Bot links, OpenClaw workspaces (a folder or a zip), Claude Code subagents (.claude/agents/*.md), Letta agent files (.af), character cards (JSON or PNG), CrewAI agents.yaml and HUI exports. Other text becomes the bot's persona.";

function renderSourceStep(props: BotImportDialogProps) {
  const tab = props.tab;
  return html`<fieldset class="bot-import__tabs">
      <legend class="sr-only">Import from</legend>
      <div class="settings-segmented bot-import__tablist">
        ${TABS.map(([value, label]) => html`<label class="settings-segmented__btn"><input type="radio" name="bot-import-tab" value=${value} .checked=${tab === value}
          @change=${() => props.onTab(value)} /><span>${label}</span></label>`)}
      </div>
    </fieldset>
    ${tab === "file" ? html`<div class="bot-import__drop ${props.picked ? "bot-import__drop--picked" : ""}"
        @dragover=${(event: DragEvent) => { event.preventDefault(); }}
        @drop=${(event: DragEvent) => {
          event.preventDefault();
          const file = event.dataTransfer?.files[0];
          if (file) props.onPickFile(file);
        }}>
        <span class="bot-import__drop-icon" aria-hidden="true">${props.picked ? icons.check : icons.fileText}</span>
        <p class="bot-import__drop-label" aria-live="polite">${props.picked ? props.picked.label : "Drop a file here, or choose a file or a folder."}</p>
        <div class="bot-import__pick">
          <label class="btn btn--sm">Choose file…<input class="sr-only" type="file" accept=${ACCEPT} ?disabled=${props.pending} @change=${(event: Event) => {
            const input = event.currentTarget as HTMLInputElement;
            const file = input.files?.[0];
            if (file) props.onPickFile(file);
            input.value = "";
          }} /></label>
          <label class="btn btn--sm">Choose folder…<input class="sr-only" type="file" webkitdirectory multiple ?disabled=${props.pending} @change=${(event: Event) => {
            const input = event.currentTarget as HTMLInputElement;
            const files = [...input.files ?? []];
            if (files.length) props.onPickFolder(files);
            input.value = "";
          }} /></label>
        </div>
        <p class="bot-import__hint">One file up to ${BOT_TEMPLATE_LIMITS.fileBytes / 1024 / 1024} MB, or a folder up to ${BOT_TEMPLATE_LIMITS.totalBytes / 1024 / 1024} MB.</p>
      </div>` : nothing}
    ${tab === "link" ? html`<label class="bot-import__field">
        <span class="bot-import__label">Grok Bot marketplace link</span>
        <input class="settings-input" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://x.ai/bot/marketplace/bots/…"
          .value=${props.url} ?disabled=${props.pending} @input=${(event: Event) => props.onUrl((event.currentTarget as HTMLInputElement).value)} />
        <span class="bot-import__hint">HUI fetches this page once, now. If x.ai changed it and HUI can't read it, copy the bot's instructions and paste them instead.</span>
      </label>` : nothing}
    ${tab === "paste" ? html`<label class="bot-import__field">
        <span class="bot-import__label">Template</span>
        <textarea class="settings-input bot-import__paste" rows="9" spellcheck="false" ?disabled=${props.pending}
          placeholder="A Claude Code subagent, a character card's JSON, an agents.yaml, a Letta agent file, or a Grok Bot's instructions…"
          .value=${props.text} @input=${(event: Event) => props.onText((event.currentTarget as HTMLTextAreaElement).value)}></textarea>
      </label>` : nothing}
    ${props.workers.length ? html`<label class="bot-import__field bot-import__field--inline">
        <span class="bot-import__label">Runs on</span>
        <select class="settings-input" ?disabled=${props.pending} @change=${(event: Event) => props.onWorker((event.currentTarget as HTMLSelectElement).value)}>
          <option value="" ?selected=${!props.worker}>Local</option>
          ${props.workers.map((worker) => html`<option value=${worker.id} ?selected=${props.worker === worker.id}>${worker.name}${worker.state === "connected" ? "" : ` (${worker.state === "error" ? "offline" : worker.state})`}</option>`)}
        </select>
      </label>` : nothing}
    <p class="bot-import__hint">${IMPORT_FORMATS_HINT}</p>`;
}

function section(title: string, count: string | undefined, body: TemplateResult | typeof nothing, options: { open?: boolean; name: string }) {
  return html`<details class="bot-import__section" data-import-section=${options.name} ?open=${options.open ?? false}>
    <summary><span>${title}</span>${count ? html`<span class="bot-import__count">${count}</span>` : nothing}</summary>
    <div class="bot-import__section-body">${body}</div>
  </details>`;
}

/** The imported text, exactly as it will be used: plain text, never rendered. */
const textBlock = (text: string) => html`<pre class="bot-import__text">${text}</pre>`;

function renderPreviewStep(props: BotImportDialogProps, preview: BotImportPreview) {
  const { bot, template } = preview;
  const from = [BOT_TEMPLATE_FORMATS[template.format], template.author ? `by ${template.author}` : "", template.origin ? `· ${template.origin}` : ""].filter(Boolean).join(" ");
  const facts: [string, string][] = [
    ["Soul", preview.soul ? `${preview.soul.length.toLocaleString()} characters${preview.memories.total ? `, with ${preview.memories.included} of ${plural(preview.memories.total, "memory", "memories")}` : ""}` : "None: it starts with its first conversation"],
    ["Model", preview.model ?? "Gateway default"],
    ["Skills", preview.skills.length ? `${preview.skills.length} of its own, on` : "None of its own"],
    ["Routines", preview.routines.length ? `${preview.routines.length}, disabled` : "None"],
    ...(preview.triggers.length ? [["Triggers", `${preview.triggers.length}, disabled`] as [string, string]] : []),
    ...(preview.open.length ? [["To agree", `${preview.open.length} with you`] as [string, string]] : []),
    ["Tools off", preview.disabledTools.length ? String(preview.disabledTools.length) : "None"],
  ];
  const missing = preview.integrations.filter((integration) => !integration.tool).length;
  return html`<div class="bot-import__who">
      ${renderBotAvatar({ id: `import:${bot.handle}`, avatar: { ...(bot.emoji ? { emoji: bot.emoji } : {}), ...bot.avatar } }, "md")}
      <div class="bot-import__identity">
        <div class="bot-import__name">${bot.name} <span class="bot-import__handle">@${bot.handle}</span></div>
        <div class="bot-import__meta">${[bot.title, `From ${from}`, bot.worker ? `Runs on ${bot.worker.name}` : ""].filter(Boolean).join(" · ")}</div>
      </div>
    </div>
    ${preview.candidates?.length ? html`<label class="bot-import__field bot-import__field--inline">
        <span class="bot-import__label">Agent</span>
        <select class="settings-input" ?disabled=${props.pending} @change=${(event: Event) => props.onPick((event.currentTarget as HTMLSelectElement).value)}>
          ${preview.candidates.map((candidate) => html`<option value=${candidate.key} ?selected=${candidate.key === preview.pick}>${candidate.name}${candidate.title ? ` — ${candidate.title}` : ""}</option>`)}
        </select>
      </label>` : nothing}
    <p class="bot-import__untrusted" role="note"><span aria-hidden="true">${icons.alertTriangle}</span><span>Imported text is untrusted: read it below before you create the bot. An import turns nothing on beyond a new bot's defaults: its routines and triggers start disabled, a tools list can only turn tools off, and its first turn can't rewrite its soul.</span></p>
    <dl class="bot-import__facts">${facts.map(([term, value]) => html`<div><dt>${term}</dt><dd>${value}</dd></div>`)}</dl>
    ${preview.open.length ? section("Not agreed yet", String(preview.open.length), html`<p class="bot-import__hint">It came from someone else's bot: in its first chat it goes through these with you, a question or two at a time, then rewrites its SOUL.md.</p><ul class="bot-import__list">${preview.open.map((point) => html`<li>
        <div><strong>${point.kind === "ask" ? "Ask" : "Confirm"}</strong> <span class="bot-import__muted">· ${point.where}${point.operator ? " · only you can change it" : ""}</span></div>
        <div>${point.question}</div>
        ${point.excerpt ? html`<div class="bot-import__muted">“${point.excerpt}”</div>` : nothing}
      </li>`)}</ul>`, { name: "open", open: true }) : nothing}
    ${preview.needs.length ? section("What it needs", String(preview.needs.length), html`<ul class="bot-import__lines">${preview.needs.map((need) => html`<li>${need}</li>`)}</ul>`, { name: "needs", open: true }) : nothing}
    ${section("SOUL.md", preview.soul ? `${preview.soul.length.toLocaleString()} characters` : "none", preview.soul ? textBlock(preview.soul) : html`<p class="bot-import__hint">No persona: the bot asks what you expect from it and writes its own SOUL.md.</p>`, { open: true, name: "soul" })}
    ${preview.opener ? section("First message", undefined, html`${textBlock(preview.opener)}<p class="bot-import__hint">It sends this as its first message, in a first turn HUI starts once it exists.</p>`, { name: "opener" }) : nothing}
    ${preview.skills.length ? section("Skills", String(preview.skills.length), html`<ul class="bot-import__list">${preview.skills.map((skill) => html`<li>
        <div><strong>${skill.name}</strong>${skill.original && skill.original !== skill.name ? html` <span class="bot-import__muted">(from ${skill.original})</span>` : nothing} — ${skill.description}</div>
        <details><summary>Instructions</summary>${textBlock(skill.content)}</details>
        ${skill.files?.length ? html`<details><summary>${plural(skill.files.length, "file")} beside it</summary><ul class="bot-import__list">${skill.files.map((file) => html`<li><code>${file.path}</code>${textBlock(file.text)}</li>`)}</ul></details>` : nothing}
      </li>`)}</ul><p class="bot-import__hint">Its own, in its home folder: only this bot loads them. They are on, like every skill of a bot; turn any off on its Tools & skills page.</p>`, { name: "skills" }) : nothing}
    ${preview.routines.length ? section("Routines", `${preview.routines.length} · disabled`, html`<ul class="bot-import__list">${preview.routines.map((routine) => html`<li>
        <div><strong>${routine.name}</strong> · ${describeRoutineSchedule(routine.schedule)}${routine.guessed ? html` <span class="bot-import__warn">· assumed${routine.scheduleText ? ` from “${routine.scheduleText}”` : ""}, check it</span>` : routine.scheduleText ? html` <span class="bot-import__muted">· “${routine.scheduleText}”</span>` : nothing}</div>
        ${textBlock(routine.prompt)}
      </li>`)}</ul>`, { name: "routines" }) : nothing}
    ${preview.triggers.length ? section("Triggers", `${preview.triggers.length} · disabled`, html`<ul class="bot-import__list">${preview.triggers.map((trigger) => html`<li>
        <div><strong>${trigger.name}</strong> · ${botTriggerFilterSummary(trigger)} · cooldown ${cooldownLabel(trigger.cooldownSeconds)}</div>
        ${trigger.prompt ? textBlock(trigger.prompt) : nothing}
      </li>`)}</ul><p class="bot-import__hint">A listener you run wakes them: each gets its URL from New URL on the bot's Triggers page.</p>`, { name: "triggers" }) : nothing}
    ${preview.integrations.length ? section("Integrations", missing ? `${missing} missing` : "all mapped", html`<ul class="bot-import__list bot-import__list--compact">${preview.integrations.map((integration) => html`<li class=${integration.tool ? "is-mapped" : "is-missing"}>
        <span aria-hidden="true">${integration.tool ? icons.check : icons.circleX}</span>
        <span><strong>${integration.name}</strong>${integration.tool ? html` → ${integration.tool.label} <code>${integration.tool.name}</code>` : html` <span class="bot-import__muted">· missing: HUI has no tool for it</span>`}</span>
      </li>`)}</ul>`, { name: "integrations" }) : nothing}
    ${preview.disabledTools.length ? section("Tools turned off", String(preview.disabledTools.length), html`<p class="bot-import__chips">${preview.disabledTools.map((tool) => html`<code>${tool}</code>`)}</p>`, { name: "tools" }) : nothing}
    ${preview.dropped.length ? section("Left out", String(preview.dropped.length), html`<ul class="bot-import__lines">${preview.dropped.map((line) => html`<li>${line}</li>`)}</ul>`, { name: "dropped" }) : nothing}
    ${preview.notes.length ? section("Notes", String(preview.notes.length), html`<ul class="bot-import__lines">${preview.notes.map((line) => html`<li>${line}</li>`)}</ul>`, { name: "notes", open: true }) : nothing}`;
}

export function renderBotImportDialog(props: BotImportDialogProps) {
  const preview = props.step === "preview" ? props.preview : undefined;
  return html`<dialog class="hui-modal-dialog bot-import-dialog" aria-labelledby="bot-import-title"
    @cancel=${(event: Event) => { event.preventDefault(); if (!props.pending) props.onClose(); }}>
    <form class="exec-approval-card bot-import" method="dialog" aria-busy=${props.pending ? "true" : "false"}
      @submit=${(event: SubmitEvent) => { event.preventDefault(); if (props.pending) return; if (preview) props.onCreate(); else props.onPreview(); }}>
      <header class="bot-import__header">
        <h2 class="exec-approval-title bot-import__title" id="bot-import-title">${preview ? `Import ${preview.bot.name}` : "Import bot"}</h2>
        <button type="button" class="btn btn--ghost btn--icon bot-import__close" aria-label="Close" ?disabled=${props.pending} @click=${props.onClose}>${icons.close}</button>
      </header>
      <div class="bot-import__body">
        ${preview ? renderPreviewStep(props, preview) : renderSourceStep(props)}
      </div>
      ${props.error ? html`<p class="group-action-dialog__error bot-import__error" role="alert">${props.error}</p>` : nothing}
      <div class="exec-approval-actions bot-import__actions">
        <button type="submit" class="btn primary" ?disabled=${props.pending}>${preview ? (props.pending ? "Creating…" : "Create bot") : (props.pending ? "Reading…" : "Preview")}</button>
        ${preview
          ? html`<button type="button" class="btn bot-import-back" ?disabled=${props.pending} @click=${props.onBack}>Back</button>`
          : html`<button type="button" class="btn bot-import-cancel" ?disabled=${props.pending} @click=${props.onClose}>Cancel</button>`}
      </div>
    </form>
  </dialog>`;
}

/* ── export ───────────────────────────────────────────────────────────── */

export type BotExportDialogProps = {
  bot: BotView;
  /** The gateway's review; absent while it reviews. */
  review?: BotExportReview | undefined;
  picks: Readonly<Record<string, BotExportGroup>>;
  /** Reviewing, or downloading. */
  pending: boolean;
  error: string;
  /** The download was refused because the review is gone or the bot changed since. */
  stale: boolean;
  onPick: (id: string, group: BotExportGroup) => void;
  /** Passages the operator added (`a1`, `a2`…), and the form for the next one. */
  added: readonly BotExportAddition[];
  draft: BotExportDraft;
  onDraft: (change: Partial<BotExportDraft>) => void;
  onAdd: () => void;
  onUndo: (index: number) => void;
  onReview: () => void;
  onDownload: () => void;
  onClose: () => void;
};

/** "Missed something?": a passage the reviewer didn't flag, what happens to it, and why the last Add was refused. */
export type BotExportDraft = { quote: string; group: BotExportAddition["group"]; becomes: string; error: string };

/** A passage's groups, as its picker names them. */
const CHANGE_GROUPS: readonly [BotExportGroup, string][] = [["remove", "Remove"], ["ask", "Ask the new owner"], ["confirm", "New owner confirms"], ["keep", "Keep as written"]];
/** A script's: it is never rewritten. */
const FILE_GROUPS: readonly [BotExportGroup, string][] = [["remove", "Stays behind"], ["confirm", "Travels, new owner checks it"], ["keep", "Travels as it is"]];
const SECTIONS: readonly [BotExportGroup, string, string][] = [
  ["remove", "Removed", "Never leaves this machine."],
  ["ask", "Asked", "Blanked to a mark; the new owner gives theirs in the bot's first chat."],
  ["confirm", "Confirmed", "Travels as written; the bot agrees it with the new owner before acting on it."],
  ["keep", "Kept", "Travels as written."],
];

/** A change's group picker. The rows move between sections as the operator picks, so a row's select can be reused for
 * another change: its live value is set each render, not only its options' first `selected`. */
function picker(label: string, groups: readonly [BotExportGroup, string][], value: BotExportGroup, props: BotExportDialogProps, id: string) {
  return html`<label class="bot-export__pick"><span class="sr-only">${label}</span>
    <select class="settings-input" .value=${live(value)} ?disabled=${props.pending} @change=${(event: Event) => props.onPick(id, (event.currentTarget as HTMLSelectElement).value as BotExportGroup)}>
      ${groups.map(([group, name]) => html`<option value=${group} ?selected=${group === value}>${name}</option>`)}
    </select></label>`;
}

/** What a passage comes to in its group, exactly as the zip says it (`buildExport`'s outcomes). */
function outcome(result: BotExportBuild["outcomes"][string] | undefined, group: BotExportGroup) {
  if (group === "remove") return result?.replacement ? html`Becomes <q>${result.replacement}</q>` : "Taken out";
  if (group === "ask") return html`Becomes <code>${result?.replacement ?? ""}</code> · asks: ${result?.question ?? ""}`;
  if (group === "confirm") return html`Asks: ${result?.question ?? ""}`;
  return "Travels as written";
}

/** The form for a passage the reviewer missed. Inside the dialog's form, whose submit is Download: Add is a plain button,
 * and Enter in its line adds. */
function renderAddition(props: BotExportDialogProps) {
  // Its section starts closed and is then left as the operator leaves it (`{ name: "export-add" }`, no `open`): bound to
  // the form's state, it closed while they typed.
  const { draft } = props;
  const add = () => { if (!props.pending && draft.quote.trim()) props.onAdd(); };
  return html`<p class="bot-import__hint">Copy a passage no change touches from the files below, and pick what happens to it.</p>
    <div class="bot-export__add">
      <label class="bot-export__field"><span>Passage</span>
        <textarea class="settings-input" rows="2" .value=${live(draft.quote)} ?disabled=${props.pending} @input=${(event: Event) => props.onDraft({ quote: (event.currentTarget as HTMLTextAreaElement).value })}></textarea></label>
      <label class="bot-export__field"><span>What happens</span>
        <select class="settings-input" .value=${live(draft.group)} ?disabled=${props.pending} @change=${(event: Event) => props.onDraft({ group: (event.currentTarget as HTMLSelectElement).value as BotExportDraft["group"] })}>
          ${CHANGE_GROUPS.filter(([group]) => group !== "keep").map(([group, name]) => html`<option value=${group} ?selected=${group === draft.group}>${name}</option>`)}
        </select></label>
      ${draft.group === "confirm" ? nothing : html`<label class="bot-export__field"><span>${draft.group === "remove" ? "Becomes" : "What the new owner gives"}</span>
        <input class="settings-input" maxlength="120" placeholder=${draft.group === "remove" ? "Nothing: it is taken out" : "the repositories to watch"} .value=${live(draft.becomes)} ?disabled=${props.pending}
          @input=${(event: Event) => props.onDraft({ becomes: (event.currentTarget as HTMLInputElement).value })}
          @keydown=${(event: KeyboardEvent) => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); add(); } }} /></label>`}
      ${draft.error ? html`<p class="group-action-dialog__error bot-import__error bot-export__add-error" role="alert">${draft.error}</p>` : nothing}
      <div class="bot-export__add-actions"><button type="button" class="btn btn--sm bot-export__add-button" ?disabled=${props.pending || !draft.quote.trim()} @click=${add}>Add</button></div>
    </div>`;
}

function renderReview(props: BotExportDialogProps, held: BotExportReview) {
  const { bot, picks } = props;
  // The operator's additions are changes like the reviewer's (`a1`, `a2`…), made as the gateway will make them; each was
  // checked when added, against this same review.
  const review = withAdditions(held, props.added);
  const pick = (id: string, fallback: BotExportGroup) => picks[id] ?? fallback;
  const build = buildExport(review, picks);
  const label = (id: string) => review.parts.find((part) => part.id === id)?.label ?? id;
  const cleaned = review.cleanup.reduce((sum, hit) => sum + hit.count, 0);
  const unread = review.parts.filter((part) => !part.read);
  const facts: [string, string][] = [
    ["Changes", String(review.changes.length + review.files.length)],
    ["Cleaned", cleaned ? `${cleaned} automatically` : "Nothing"],
    ["Open points", build.open.length ? `${build.open.length} for the new owner` : "None"],
    ["Files", String(build.files.length)],
  ];
  return html`<div class="bot-import__who">
      ${renderBotAvatar(bot, "md")}
      <div class="bot-import__identity">
        <div class="bot-import__name">${build.name}</div>
        <div class="bot-import__meta">A template someone else can import · ${build.fileName}</div>
      </div>
    </div>
    ${review.warning
      ? html`<p class="bot-import__untrusted" role="note"><span aria-hidden="true">${icons.alertTriangle}</span><span>${review.warning}</span></p>`
      : html`<p class="bot-import__hint">HUI cleaned it, then ${review.model} read every part. Nothing leaves until you download, and only what the files below hold.</p>`}
    <dl class="bot-import__facts">${facts.map(([term, value]) => html`<div><dt>${term}</dt><dd>${value}</dd></div>`)}</dl>
    ${SECTIONS.map(([group, title, about]) => {
      const changes = review.changes.filter((change) => pick(change.id, change.group) === group);
      return changes.length ? section(title, String(changes.length), html`<p class="bot-import__hint">${about}</p><ul class="bot-import__list">${changes.map((change) => html`<li class="bot-export__change" data-change=${change.id}>
          <div class="bot-export__row"><span class="bot-import__muted">${label(change.part)}</span>${picker(`What happens to “${change.quote.slice(0, 60)}”`, CHANGE_GROUPS.filter(([each]) => changeGroups(change.part).includes(each)), group, props, change.id)}</div>
          ${textBlock(change.quote)}
          <div class="bot-export__outcome">${outcome(build.outcomes[change.id], group)}</div>
          <div class="bot-import__hint">${change.reason}${change.id.startsWith("a") ? html` <button type="button" class="btn btn--ghost btn--sm bot-export__undo" ?disabled=${props.pending} @click=${() => props.onUndo(Number(change.id.slice(1)) - 1)}>Undo</button>` : nothing}</div>
        </li>`)}</ul>`, { name: `export-${group}`, open: true }) : nothing;
    })}
    ${section("Missed something?", props.added.length ? String(props.added.length) : undefined, renderAddition(props), { name: "export-add" })}
    ${review.files.length ? section("Scripts", String(review.files.length), html`<p class="bot-import__hint">A script is never rewritten: it travels as it is, travels for the new owner to check, or stays behind.</p><ul class="bot-import__list">${review.files.map((file) => html`<li class="bot-export__change" data-change=${file.id}>
        <div class="bot-export__row"><strong>${label(file.part)}</strong>${picker(`What happens to ${label(file.part)}`, FILE_GROUPS, pick(file.id, file.group), props, file.id)}</div>
        <ul class="bot-import__lines">${file.reasons.map((reason) => html`<li>${reason}</li>`)}</ul>
      </li>`)}</ul>`, { name: "export-scripts", open: true }) : nothing}
    ${review.needs.length ? section("What it needs", String(review.needs.filter((need) => pick(need.id, "keep") !== "remove").length), html`<p class="bot-import__hint">The new owner sees these before they import it.</p><ul class="bot-import__list bot-import__list--compact">${review.needs.map((need) => html`<li><label class="bot-export__need">
        <input type="checkbox" .checked=${pick(need.id, "keep") !== "remove"} ?disabled=${props.pending} @change=${(event: Event) => props.onPick(need.id, (event.currentTarget as HTMLInputElement).checked ? "keep" : "remove")} />
        <span>${need.text}</span></label></li>`)}</ul>`, { name: "export-needs", open: true }) : nothing}
    ${review.cleanup.length ? section("Cleaned automatically", String(cleaned), html`<p class="bot-import__hint">Done before any model read it, and always applied.</p><ul class="bot-import__lines">${review.cleanup.map((hit) => html`<li>${label(hit.part)}: ${hit.kind}${hit.count > 1 ? ` ×${hit.count}` : ""} <span class="bot-import__muted">(${hit.sample})</span></li>`)}</ul>`, { name: "export-cleanup" }) : nothing}
    ${unread.length ? section("Not read by the model", String(unread.length), html`<ul class="bot-import__lines">${unread.map((part) => html`<li>${part.label}: ${part.unread ?? "not read"}</li>`)}</ul>`, { name: "export-unread", open: review.parts.length > unread.length }) : nothing}
    ${review.leftOut.length ? section("Stays behind", String(review.leftOut.length), html`<ul class="bot-import__lines">${review.leftOut.map((line) => html`<li>${line}</li>`)}</ul>`, { name: "export-left-out" }) : nothing}
    ${section("Files as they will be saved", String(build.files.length), html`<ul class="bot-import__list">${build.files.map((file) => html`<li><details><summary><code>${file.path}</code></summary>${textBlock(file.text)}</details></li>`)}</ul>`, { name: "export-files" })}`;
}

export function renderBotExportDialog(props: BotExportDialogProps) {
  const { bot, review } = props;
  const downloading = props.pending && review !== undefined;
  return html`<dialog class="hui-modal-dialog bot-import-dialog bot-export-dialog" aria-labelledby="bot-export-title"
    @cancel=${(event: Event) => { event.preventDefault(); if (!downloading) props.onClose(); }}>
    <form class="exec-approval-card bot-import" method="dialog" aria-busy=${props.pending ? "true" : "false"}
      @submit=${(event: SubmitEvent) => { event.preventDefault(); if (!props.pending && review) props.onDownload(); }}>
      <header class="bot-import__header">
        <h2 class="exec-approval-title bot-import__title" id="bot-export-title">Export ${bot.name} as a template</h2>
        <button type="button" class="btn btn--ghost btn--icon bot-import__close" aria-label="Close" ?disabled=${downloading} @click=${props.onClose}>${icons.close}</button>
      </header>
      <div class="bot-import__body">
        ${review ? renderReview(props, review) : props.pending
          ? html`<div class="bot-export__reviewing" role="status"><span class="session-run-spinner" aria-hidden="true"></span><div>
              <strong>Reviewing ${bot.name} for personal information…</strong>
              <p class="bot-import__hint">HUI cleans it first, then Settings' utility model reads each part. It can take a minute, and nothing leaves until you download.</p>
            </div></div>`
          : nothing}
      </div>
      ${props.error ? html`<p class="group-action-dialog__error bot-import__error" role="alert">${props.error}</p>` : nothing}
      <div class="exec-approval-actions bot-import__actions">
        ${review && !props.stale
          ? html`<button type="submit" class="btn primary" ?disabled=${props.pending}>${downloading ? "Exporting…" : "Download"}</button>`
          : html`<button type="button" class="btn primary bot-export-review" ?disabled=${props.pending} @click=${props.onReview}>${props.pending ? "Reviewing…" : "Review again"}</button>`}
        <button type="button" class="btn bot-export-cancel" ?disabled=${downloading} @click=${props.onClose}>Cancel</button>
      </div>
    </form>
  </dialog>`;
}
