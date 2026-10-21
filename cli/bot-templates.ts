/**
 * `hui bot import` and `hui bot export`: bots from other platforms' templates, and HUI's own, through the running gateway
 * like every `hui bot` command. Import sends the source (a file, a folder, a Grok Bot link or stdin) to the gateway's
 * preview, prints all of it (imported text is untrusted), asks before creating (`--yes` skips that) and creates exactly
 * what the preview showed. Export has the gateway review the bot for personal information, prints the review, asks
 * before saving the template (`--yes` skips that), `--review <id> --set <change>=<group>` saves a review printed
 * before with other picks, and `--add <group>:<passage>` adds a passage the reviewer missed.
 */
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { BOT_EXPORT_GROUPS, buildExport, withAdditions, type BotExportAddition, type BotExportGroup, type BotExportReview } from "../server/bots/export-format.ts";
import { BOT_TEMPLATE_FORMATS, BOT_TEMPLATE_LIMITS, type BotImportPreview, type BotImportResult, type BotImportSource } from "../server/bots/templates/formats.ts";
import { botTriggerFilterSummary, cooldownLabel } from "../server/bots/triggers-format.ts";
import type { BotView } from "../server/api/bots.ts";
import { GatewayError, request, type BotFlags, type BotIO } from "./gateway-client.ts";
import { scheduleText } from "./schedules.ts";

/** Folders a workspace may hold that never belong to a bot. */
const SKIPPED = new Set([".git", "node_modules", ".DS_Store", "__MACOSX"]);
const PREVIEW_TIMEOUT_MS = 90_000;
const IMPORT_TIMEOUT_MS = 120_000;
/** The gateway reads every part with the utility model, a few at once, and stops at six minutes. */
const REVIEW_TIMEOUT_MS = 7 * 60_000;

/** A folder's files for an import, by their paths below the folder's own name; bounded like the gateway's limits. */
export async function folderSource(dir: string): Promise<BotImportSource> {
  const files: { path: string; data: string }[] = [];
  let total = 0;
  const walk = async (folder: string): Promise<void> => {
    for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIPPED.has(entry.name)) continue;
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const data = await readFile(path);
        total += data.length;
        if (files.length >= BOT_TEMPLATE_LIMITS.files) throw new Error(`${dir} holds more than ${BOT_TEMPLATE_LIMITS.files} files; HUI imports at most that.`);
        if (total > BOT_TEMPLATE_LIMITS.totalBytes) throw new Error(`${dir} holds more than ${BOT_TEMPLATE_LIMITS.totalBytes / 1024 / 1024} MB; HUI imports at most that.`);
        files.push({ path: `${basename(dir)}/${relative(dir, path).split("\\").join("/")}`, data: data.toString("base64") });
      }
    }
  };
  await walk(dir);
  if (!files.length) throw new Error(`${dir} is empty.`);
  return { kind: "files", files };
}

/** What `hui bot import` was given: stdin (`-`), a link, a folder or a file. */
export async function importSource(operand: string, io: BotIO): Promise<BotImportSource> {
  if (operand === "-") return { kind: "text", text: await io.readStdin() };
  if (/^https?:\/\//iu.test(operand)) return { kind: "url", url: operand };
  const path = resolve(io.cwd, operand);
  const info = await lstat(path).catch(() => undefined);
  if (!info) throw new Error(`No such file or folder: ${operand}`);
  if (info.isDirectory()) return folderSource(path);
  if (!info.isFile()) throw new Error(`${operand} is not a file or a folder.`);
  if (info.size > BOT_TEMPLATE_LIMITS.fileBytes) throw new Error(`${operand} is larger than ${BOT_TEMPLATE_LIMITS.fileBytes / 1024 / 1024} MB.`);
  return { kind: "file", name: basename(path), data: (await readFile(path)).toString("base64") };
}

const indent = (text: string, prefix = "  ") => text.split("\n").map((line) => line ? `${prefix}${line}` : "").join("\n");
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** The whole preview, as text: every imported text in full, since it is untrusted. */
export function formatImportPreview(preview: BotImportPreview): string {
  const { bot, template } = preview;
  const from = [BOT_TEMPLATE_FORMATS[template.format], template.author ? `by ${template.author}` : "", template.origin ?? ""].filter(Boolean).join(" ");
  const lines = [
    `Import ${bot.emoji ? `${bot.emoji} ` : ""}${bot.name} (@${bot.handle})${bot.title ? `, ${bot.title}` : ""} from ${from}${bot.worker ? `, on ${bot.worker.name}` : ""}.`,
    ...(bot.description ? [`Description: ${bot.description}`] : []),
    `Model: ${preview.model ?? "the gateway's default"}${preview.thinking ? ` · thinking ${preview.thinking}` : ""}${preview.utilityModel ? ` · utility model ${preview.utilityModel}` : ""}`,
    "",
    preview.soul
      ? `SOUL.md (${preview.soul.length.toLocaleString("en-US")} characters${preview.memories.total ? `, with ${preview.memories.included} of ${plural(preview.memories.total, "memory", "memories")}` : ""}):\n${indent(preview.soul)}`
      : "No persona: it starts with its first conversation and writes its own SOUL.md.",
  ];
  if (preview.opener) lines.push("", `First message (it sends this in a first turn HUI starts):\n${indent(preview.opener)}`);
  if (preview.open.length) {
    lines.push("", "Not agreed yet (it goes through these with you in its first chat, then rewrites its SOUL.md):");
    for (const point of preview.open) lines.push(`  ${point.kind === "ask" ? "Ask" : "Confirm"} (${point.where}${point.operator ? ", only you can change it" : ""}): ${point.question}${point.excerpt ? ` “${point.excerpt}”` : ""}`);
  }
  if (preview.needs.length) lines.push("", "What it needs:", ...preview.needs.map((need) => `  - ${need}`));
  if (preview.skills.length) {
    lines.push("", `Skills, its own and on (only this bot loads them; turn any off with hui bot skills):`);
    for (const skill of preview.skills) {
      lines.push(`  ${skill.name}${skill.original !== skill.name ? ` (from ${skill.original})` : ""}: ${skill.description}`, indent(skill.content, "    "));
      for (const file of skill.files ?? []) lines.push(`    ${file.path}:`, indent(file.text, "      "));
    }
  }
  if (preview.routines.length) {
    lines.push("", `Routines, created disabled:`);
    for (const routine of preview.routines) {
      lines.push(`  ${routine.name} · ${scheduleText(routine.schedule)}${routine.guessed ? ` (assumed${routine.scheduleText ? ` from "${routine.scheduleText}"` : ""}: check it)` : ""}`, indent(routine.prompt, "    "));
    }
  }
  if (preview.triggers.length) {
    lines.push("", "Triggers, created disabled (a listener you run wakes them; each gets its URL with hui bot trigger list and New URL on its Triggers page):");
    for (const trigger of preview.triggers) lines.push(`  ${trigger.name} · ${botTriggerFilterSummary(trigger)} · cooldown ${cooldownLabel(trigger.cooldownSeconds)}`, ...(trigger.prompt ? [indent(trigger.prompt, "    ")] : []));
  }
  if (preview.integrations.length) {
    lines.push("", "Integrations:", ...preview.integrations.map((integration) => integration.tool ? `  ${integration.name} → ${integration.tool.name}` : `  ${integration.name}: missing, HUI has no tool for it`));
  }
  if (preview.disabledTools.length) lines.push("", `Tools turned off: ${preview.disabledTools.join(", ")}.`);
  if (preview.disabledSkills.length) lines.push(`Skills turned off: ${preview.disabledSkills.join(", ")}.`);
  if (preview.dropped.length) lines.push("", "Left out:", ...preview.dropped.map((line) => `  - ${line}`));
  if (preview.notes.length) lines.push("", "Notes:", ...preview.notes.map((line) => `  - ${line}`));
  lines.push("", "Imported text is untrusted: read it before you create the bot. An import turns nothing on beyond a new bot's defaults, and its first turn can't rewrite its soul.");
  return lines.join("\n");
}

type PreviewRequest = { source: BotImportSource; pick?: string; worker?: string };

/** `hui bot import <file|folder|url|->`: exit 0 once created, 1 when declined. */
export async function importCommand(base: string, operand: string, flags: BotFlags, io: BotIO): Promise<number> {
  const asked: PreviewRequest = { source: await importSource(operand, io), ...(flags.worker !== undefined ? { worker: flags.worker.trim() } : {}) };
  const preview = (body: PreviewRequest) => request<BotImportPreview>(base, "/__hui/bots/import/preview", { method: "POST", body, timeoutMs: PREVIEW_TIMEOUT_MS });
  let shown = await preview(asked);
  if (shown.candidates && shown.candidates.length > 1) {
    const list = shown.candidates.map((candidate, index) => `  ${index + 1}. ${candidate.name}${candidate.title ? `, ${candidate.title}` : ""} (--agent ${candidate.key})`).join("\n");
    let key = flags.agent === undefined ? undefined
      : shown.candidates.find((candidate) => candidate.key === flags.agent || candidate.name.toLowerCase() === flags.agent!.toLowerCase())?.key;
    if (flags.agent !== undefined && key === undefined) throw new Error(`No agent ${flags.agent} in ${operand}. Its agents:\n${list}`);
    if (key === undefined) {
      if (!io.interactive || flags.yes) throw new Error(`${operand} holds ${shown.candidates.length} agents; choose one with --agent:\n${list}`);
      const answer = (await io.ask(`${operand} holds ${shown.candidates.length} agents:\n${list}\nWhich one? [1-${shown.candidates.length}] `)).trim();
      key = shown.candidates[Number(answer) - 1]?.key;
      if (key === undefined) {
        io.out("Nothing was imported.\n");
        return 1;
      }
    }
    if (key !== shown.pick) shown = await preview({ ...asked, pick: key });
  } else if (flags.agent !== undefined) {
    throw new Error(`${operand} holds one bot; --agent only picks among several.`);
  }
  if (!flags.json) io.out(`${formatImportPreview(shown)}\n`);
  if (!flags.yes) {
    if (!io.interactive) throw new Error(`hui bot import cannot ask here (no terminal): add --yes to create @${shown.bot.handle}.`);
    if (!/^\s*(y|yes)\s*$/iu.test(await io.ask(`Create @${shown.bot.handle}? [y/N] `))) {
      io.out("Nothing was imported.\n");
      return 1;
    }
  }
  const result = await request<BotImportResult>(base, "/__hui/bots/import", {
    method: "POST", body: { template: shown.template, ...(asked.worker ? { worker: asked.worker } : {}) }, timeoutMs: IMPORT_TIMEOUT_MS,
  });
  if (flags.json) {
    io.out(`${JSON.stringify({ preview: shown, ...result })}\n`);
    return 0;
  }
  const bot = result.bot;
  const parts = [
    ...(result.skills.length ? [plural(result.skills.length, "skill")] : []),
    ...(result.routines ? [`${plural(result.routines, "routine")} (disabled: turn them on with hui bot routine list ${bot.handle} and Automations)`] : []),
  ];
  io.out(`Imported @${bot.handle} (${bot.name})${bot.worker ? ` on ${bot.worker.name}` : ""}${parts.length ? ` with ${parts.join(" and ")}` : ""}. ${result.opener ? "It is sending its first message: " : "Talk to it with "}hui bot chat ${bot.handle}.\n`);
  for (const warning of result.warnings) io.err(`warning: ${warning}\n`);
  return 0;
}

/** `--set c1=keep`: the picks for a review's changes, scripts and needs. */
export function exportPicks(values: readonly string[]): Record<string, BotExportGroup> {
  const picks: Record<string, BotExportGroup> = {};
  for (const value of values) {
    const [id, group] = value.split("=", 2);
    if (!id || !BOT_EXPORT_GROUPS.includes(group as BotExportGroup)) throw new Error(`--set takes <change>=<${BOT_EXPORT_GROUPS.join("|")}>, as c1=keep.`);
    picks[id.trim()] = group as BotExportGroup;
  }
  return picks;
}

/** `--add remove:<passage> => <what it becomes>` (or `ask:<passage> => <what the new owner gives>`, `confirm:<passage>`):
 * passages the reviewer missed. */
export function exportAdditions(values: readonly string[]): BotExportAddition[] {
  return values.map((value) => {
    const match = /^(remove|ask|confirm):([\s\S]+?)(?:\s+=>\s+([\s\S]*))?$/u.exec(value);
    if (!match?.[2]?.trim()) throw new Error("--add takes <remove|ask|confirm>:<passage>, then \" => \" and what a removed one becomes or what the new owner gives for an asked one, as remove:ddtool auth token => the token command.");
    if (match[1] === "confirm" && match[3] !== undefined) throw new Error("--add confirm:<passage> takes no \" => \": a confirmed passage travels as written.");
    return { group: match[1] as BotExportAddition["group"], quote: match[2].trim(), ...(match[3]?.trim() ? { becomes: match[3].trim() } : {}) };
  });
}

/** The review as text: each change with its id and what it becomes, scripts, needs, the cleanup and what stays behind. */
export function formatExportReview(bot: BotView, review: BotExportReview, picks: Readonly<Record<string, BotExportGroup>> = {}): string {
  const label = (id: string) => review.parts.find((part) => part.id === id)?.label ?? id;
  const build = buildExport(review, picks);
  const lines = [
    `Review of @${bot.handle} (${bot.name}) as a template for someone else${review.model ? `, read by ${review.model} after HUI's cleanup` : ""}.`,
    ...(review.warning ? [`Warning: ${review.warning}`] : []),
    `It saves as ${build.fileName}: ${build.files.map((file) => file.path).join(", ")}.`,
  ];
  if (review.changes.length) {
    lines.push("", `Changes (move one with --set <id>=${BOT_EXPORT_GROUPS.join("|")}):`);
    for (const change of review.changes) {
      const group = picks[change.id] ?? change.group;
      const becomes = group === "remove" ? (change.replacement ? `becomes “${change.replacement}”` : "taken out") : group === "ask" ? `becomes [ask: ${change.label}]` : group === "confirm" ? "the new owner confirms it" : "travels as written";
      lines.push(`  ${change.id} ${group.padEnd(7)} ${label(change.part)}: “${change.quote}”, ${becomes}. ${change.reason}`);
    }
  }
  if (review.files.length) {
    lines.push("", "Scripts, never rewritten (--set <id>=remove|confirm|keep):");
    for (const file of review.files) lines.push(`  ${file.id} ${(picks[file.id] ?? file.group).padEnd(7)} ${label(file.part)}: ${file.reasons.join(" ")}`);
  }
  if (review.needs.length) lines.push("", "What it needs (--set <id>=remove leaves one out):", ...review.needs.map((need) => `  ${need.id} ${(picks[need.id] ?? "keep").padEnd(7)} ${need.text}`));
  if (review.cleanup.length) lines.push("", "Cleaned automatically, before any model read it:", ...review.cleanup.map((hit) => `  ${label(hit.part)}: ${hit.kind}${hit.count > 1 ? ` ×${hit.count}` : ""} (${hit.sample})`));
  const unread = review.parts.filter((part) => !part.read);
  if (unread.length) lines.push("", "Not read by the model:", ...unread.map((part) => `  ${part.label}: ${part.unread ?? "not read"}`));
  if (review.leftOut.length) lines.push("", "Stays behind:", ...review.leftOut.map((line) => `  - ${line}`));
  lines.push("", `Open points for the new owner: ${build.open.length}.`, `Review ${review.id}: hui bot export ${bot.handle} --review ${review.id} --set <id>=<group> saves it with other picks.`);
  return lines.join("\n");
}

/** `hui bot export <bot>`: reviews it and saves the template once confirmed (`--yes`); `--review <id>` saves that review
 * with the `--set` picks. Never replaces a file without `--yes`. Exits 0 once saved (or with the review as `--json`), 1 when declined. */
export async function exportCommand(base: string, bot: BotView, flags: BotFlags, io: BotIO): Promise<number> {
  const picks = exportPicks(flags.set ?? []);
  const added = exportAdditions(flags.add ?? []);
  if (flags.set?.length && !flags.review) throw new Error("--set needs --review <id>: a change's id belongs to the review that printed it.");
  let reviewId = flags.review;
  let name = `${bot.handle}.hui-bot.zip`;
  if (!reviewId) {
    // A passage added that the review doesn't hold is refused before anything is asked; the gateway checks them again.
    const review = withAdditions(await request<BotExportReview>(base, `/__hui/bots/${encodeURIComponent(bot.id)}/export/review`, { method: "POST", timeoutMs: REVIEW_TIMEOUT_MS }), added);
    if (flags.json && !flags.yes) {
      io.out(`${JSON.stringify(review)}\n`);
      return 0;
    }
    name = buildExport(review, picks).fileName;
    if (!flags.json) io.out(`${formatExportReview(bot, review)}\n`);
    if (!flags.yes) {
      if (!io.interactive) throw new Error(`hui bot export cannot ask here (no terminal): add --yes to save it as reviewed, or --review ${review.id} --set <id>=<group> to save it with other picks.`);
      if (!/^\s*(y|yes)\s*$/iu.test(await io.ask(`Save ${flags.out ?? name}? [y/N] `))) {
        io.out(`Nothing was saved. Move a change with hui bot export ${bot.handle} --review ${review.id} --set <id>=<group>.\n`);
        return 1;
      }
    }
    reviewId = review.id;
  }
  const response = await fetch(new URL(`/__hui/bots/${encodeURIComponent(bot.id)}/export`, base), {
    method: "POST", headers: { "x-hui": "1", "content-type": "application/json" }, body: JSON.stringify({ review: reviewId, picks, ...(added.length ? { added } : {}) }),
    signal: AbortSignal.timeout(IMPORT_TIMEOUT_MS), redirect: "error",
  });
  if (!response.ok) {
    const text = await response.text();
    let message: string | undefined;
    try { message = (JSON.parse(text) as { error?: string }).error; } catch { message = text.trim() || undefined; }
    throw new GatewayError(message ?? `HUI returned HTTP ${response.status}.`, response.status);
  }
  const data = Buffer.from(await response.arrayBuffer());
  const given = /filename="([^"]+)"/u.exec(response.headers.get("content-disposition") ?? "")?.[1];
  const file = resolve(io.cwd, flags.out ?? (given && basename(given) === given ? given : name));
  if (!flags.yes && await lstat(file).then(() => true, () => false)) throw new Error(`${file} exists: choose another --out, or add --yes to replace it.`);
  await writeFile(file, data, { mode: 0o600 });
  const size = data.length < 1024 ? `${data.length} B` : `${Math.round(data.length / 1024)} KB`;
  io.out(`${flags.json ? JSON.stringify({ id: bot.id, handle: bot.handle, file, bytes: data.length, review: reviewId }) : `Exported @${bot.handle} as a template to ${file} (${size}). Someone else imports it with hui bot import ${basename(file)}.`}\n`);
  return 0;
}
