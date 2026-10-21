/**
 * `hui bot`: bots (HUI-18) from a terminal. Everything goes through the running
 * gateway, as in Settings and the Bots tab: the `/__hui/bots` routes, the
 * session API for `chat`, and the Automation routes for routines, which
 * `hui schedule` shares (`schedules.ts`). The CLI never opens the Durable store
 * or OptChat's files; the gateway is their only writer.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  BOT_FACE_EARS_LABELS, BOT_FACE_SHAPE_LABELS, botColorName, botFaceEars, botDisplayCwd, botFaceColor, botFaceShape, botKickoffName, botLook, NEW_BOT_NAME,
  type BotCatalog, type BotCatalogTool, type BotMessageResult, type BotQuestion, type BotSkillSelector, type BotSoul, type BotsUpdate, type BotTagging, type BotView,
} from "../server/bots-format.ts";
import { voiceLanguage, voiceLanguageName } from "../server/bots/voice-languages.ts";
import { gptLiveVoiceLabel } from "../server/calls-format.ts";
import { bots, findBot, GatewayError, request, type BotFlags, type BotIO } from "./gateway-client.ts";

/** The real terminal: stdout, stderr, stdin and SIGINT. */
export function terminalBotIO(): BotIO {
  return {
    out: (text) => { process.stdout.write(text); },
    err: (text) => { process.stderr.write(text); },
    readStdin: async () => {
      let text = "";
      process.stdin.setEncoding("utf8");
      for await (const chunk of process.stdin) text += chunk as string;
      return text;
    },
    lines: () => createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY, terminal: false }),
    onInterrupt: (listener) => {
      process.on("SIGINT", listener);
      return () => { process.off("SIGINT", listener); };
    },
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    ask: (question) => new Promise((resolveAnswer) => {
      const reader = createInterface({ input: process.stdin, output: process.stdout });
      reader.question(question, (answer) => { reader.close(); resolveAnswer(answer); });
    }),
    cwd: process.cwd(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

const SESSION_STATUSES_BUSY = new Set(["running", "waiting"]);
/** `send --wait` without `--timeout`: the gateway's default. */
const DEFAULT_WAIT_SECONDS = 300;

/** `id+n`, a line of a bot's memory view. */
export function parseZoom(value: string): { id: number; n: number } {
  const match = /^(\d{1,15})\+(\d{1,15})$/u.exec(value.trim());
  if (!match) throw new Error("--zoom takes a view line's id+n, such as 2184+8.");
  return { id: Number(match[1]), n: Number(match[2]) };
}

/** A file's text, or all of stdin for `-`. */
async function readText(path: string, io: BotIO): Promise<string> {
  return path === "-" ? io.readStdin() : readFile(resolve(io.cwd, path), "utf8");
}

/** A bot body from add/edit flags: only what was given. */
async function botBody(flags: BotFlags, io: BotIO): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {};
  if (flags.name !== undefined) body["name"] = flags.name;
  if (flags.title !== undefined) body["title"] = flags.title;
  if (flags.description !== undefined) body["description"] = flags.description;
  if (flags.tagging !== undefined) body["tagging"] = flags.tagging.trim().toLowerCase();
  if (flags["soul-file"] !== undefined) body["soul"] = await readText(flags["soul-file"], io);
  // `~` is the gateway user's home there; anything else is relative to where the command runs. On a worker, `~` is the
  // remote user's home, and the worker checks the folder.
  if (flags.worker !== undefined) body["worker"] = flags.worker.trim();
  if (flags.cwd !== undefined) body["cwd"] = flags.cwd.startsWith("~") || flags.worker !== undefined ? flags.cwd : resolve(io.cwd, flags.cwd);
  if (flags.model !== undefined) body["model"] = flags.model;
  if (flags.thinking !== undefined) body["thinking"] = flags.thinking;
  if (flags["memory-model"] !== undefined) body["memoryModel"] = flags["memory-model"];
  if (flags["utility-model"] !== undefined) body["memoryModel"] = flags["utility-model"];
  // The look: an emoji, or (with --emoji "") the face, its shape, ears and color; "" clears each.
  if (flags.emoji !== undefined || flags.shape !== undefined || flags.ears !== undefined || flags.color !== undefined) {
    body["avatar"] = {
      ...(flags.emoji !== undefined ? { emoji: flags.emoji } : {}),
      ...(flags.shape !== undefined ? { shape: flags.shape.trim() ? botFaceShape(flags.shape) ?? flags.shape.trim().toLowerCase() : "" } : {}),
      ...(flags.ears !== undefined ? { ears: flags.ears.trim() ? botFaceEars(flags.ears) ?? flags.ears.trim().toLowerCase() : "" } : {}),
      ...(flags.color !== undefined ? { color: lookColor(flags.color) } : {}),
    };
  }
  // Off from its first turn; the gateway checks the names.
  if (flags["deny-tools"] !== undefined) body["disabledTools"] = names(flags["deny-tools"]);
  if (flags["deny-skills"] !== undefined) body["disabledSkills"] = names(flags["deny-skills"]);
  // The language it speaks on calls and its GPT-Live call voice; "" clears each on edit.
  if (flags.language !== undefined || flags["call-voice"] !== undefined) {
    body["voice"] = {
      ...(flags.language !== undefined ? { language: flags.language.trim().toLowerCase() } : {}),
      ...(flags["call-voice"] !== undefined ? { live: flags["call-voice"].trim().toLowerCase() } : {}),
    };
  }
  return body;
}

/** A palette name (`mint`) as its hex; a hex as given, lowercase; "" as "", which clears the color. */
export function lookColor(value: string): string {
  const color = value.trim();
  return color ? botFaceColor(color)?.hex ?? color.toLowerCase() : "";
}

/** `face · Heart · Mint`, `face · Heart · Cat ears · Mint`, `emoji 🦊 · Mint`; "(from its id)" marks what the bot's id picked. */
export function formatLook(bot: Pick<BotView, "id" | "avatar">): string {
  const look = botLook(bot);
  const picked = " (from its id)";
  const color = `${botColorName(look.color)}${look.derived.color ? picked : ""}`;
  return look.kind === "emoji"
    ? `emoji ${look.emoji} · ${color}`
    : `face · ${BOT_FACE_SHAPE_LABELS[look.shape]}${look.derived.shape ? picked : ""}${look.ears ? ` · ${BOT_FACE_EARS_LABELS[look.ears]}` : ""} · ${color}`;
}

/** Runs one `hui bot` action and returns the exit code. */
export async function botCommand(base: string, action: string, operands: readonly string[], flags: BotFlags, io: BotIO): Promise<number> {
  const print = (value: unknown, text: string) => io.out(`${flags.json ? JSON.stringify(value) : text}\n`);
  if (action === "list") {
    const list = await bots(base, flags.archived === true);
    print(list, formatBots(list, flags.archived === true));
    return 0;
  }
  if (action === "add") {
    const { bot } = await request<{ bot: BotView }>(base, "/__hui/bots", { method: "POST", body: await botBody(flags, io), timeoutMs: 60_000 });
    const where = bot.worker ? ` on ${bot.worker.name}` : "";
    print(bot, bot.soul
      ? `Added @${bot.handle} (${bot.name})${where} with the soul you gave it. Talk to it with hui bot chat ${bot.handle}.`
      : bot.name === NEW_BOT_NAME && flags.name === undefined
        ? `Added @${bot.handle} (${bot.name})${where}. It starts by asking what to call it and what you expect from it: talk with hui bot chat ${bot.handle}.`
        : `Added @${bot.handle} (${bot.name})${where}. It starts by asking what you expect from it: talk with hui bot chat ${bot.handle}.`);
    return 0;
  }
  // A template from another platform, or a HUI export: its operand is the source, not a bot.
  if (action === "import") return (await import("./bot-templates.ts")).importCommand(base, operands[0]!, flags, io);
  const bot = await findBot(base, operands[0]!);
  const path = `/__hui/bots/${encodeURIComponent(bot.id)}`;
  switch (action) {
    case "show": {
      const { bot: view } = await request<{ bot: BotView }>(base, path);
      print(view, formatBot(view));
      return 0;
    }
    case "edit": {
      const { bot: view } = await request<{ bot: BotView }>(base, path, { method: "PATCH", body: await botBody(flags, io), timeoutMs: 60_000 });
      print(view, `Updated @${view.handle} (${view.name}).`);
      return 0;
    }
    case "remove": {
      const { bot: view } = await request<{ bot: BotView }>(base, path, { method: "DELETE" });
      print(view, `Archived @${view.handle}. Its chat transcript and memory are kept and its routines are disabled; hui bot restore ${view.handle} brings it back.`);
      return 0;
    }
    case "restore": {
      const { bot: view } = await request<{ bot: BotView }>(base, `${path}/restore`, { method: "POST", body: {} });
      print(view, `Restored @${view.handle}. Its routines stay disabled until you turn them on in Automations.`);
      return 0;
    }
    case "delete": {
      // For good, active or archived: a terminal is asked first, anything else needs --yes.
      const where = bot.worker ? ` on ${bot.worker.name}` : "";
      if (!flags.yes) {
        if (!io.interactive) throw new Error(`hui bot delete cannot ask here (no terminal): add --yes to delete @${bot.handle} for good.`);
        if (!/^\s*(y|yes)\s*$/iu.test(await io.ask(`Delete @${bot.handle} for good? Its chat leaves HUI and its routines, memory and folder${where} go. [y/N] `))) {
          io.out("Nothing was deleted.\n");
          return 1;
        }
      }
      const deleted = await request<{ ok: true; queued?: boolean }>(base, `${path}?permanent=1`, { method: "DELETE", timeoutMs: 60_000 });
      print({ id: bot.id, handle: bot.handle, deleted: true, ...(deleted.queued ? { queued: true } : {}) }, deleted.queued
        ? `Deleted @${bot.handle} for good: its chat left HUI and its routines are gone. HUI is not connected to ${bot.worker?.name ?? "its worker"} now, so its memory and folder there go when it reconnects.`
        : `Deleted @${bot.handle} for good: its chat left HUI, and its routines, memory and folder${where} are gone.`);
      return 0;
    }
    case "stop": {
      const busy = SESSION_STATUSES_BUSY.has(bot.status);
      const { bot: view } = await request<{ bot: BotView }>(base, `${path}/stop`, { method: "POST", body: {}, timeoutMs: 60_000 });
      print(view, busy ? `Stopped @${view.handle}'s turn.` : `@${view.handle} had no turn running.`);
      return 0;
    }
    case "send": return send(base, bot, operands[1]!, flags, io);
    case "export": return (await import("./bot-templates.ts")).exportCommand(base, bot, flags, io);
    case "soul": return soul(base, bot, flags, io);
    case "tools": return tools(base, bot, flags, io);
    case "skills": return skills(base, bot, flags, io);
    case "chat": return botChat(base, bot, io);
    case "memory": return memory(base, bot, flags, io);
    case "routine list":
    case "routine add":
    case "routine run":
    case "routine remove": {
      // Routines are schedules aimed at the bot's chat: `hui schedule`'s code, worded for the bot.
      const { routineCommand } = await import("./schedules.ts");
      return routineCommand(base, bot, action.slice("routine ".length), operands.slice(1), flags, io);
    }
    default:
      throw new Error("Unknown command. Run hui --help.");
  }
}

/** `send`: exit 0 once answered (or accepted, without --wait), 1 on failure or timeout, 2 while a question waits. */
async function send(base: string, bot: BotView, message: string, flags: BotFlags, io: BotIO): Promise<number> {
  const text = message === "-" ? await io.readStdin() : message;
  const timeoutSeconds = flags.timeout === undefined ? undefined : Number(flags.timeout);
  const wait = flags.wait === true;
  const result = await request<BotMessageResult>(base, `/__hui/bots/${encodeURIComponent(bot.id)}/messages`, {
    method: "POST",
    body: { text, ...(wait ? { wait: true, ...(timeoutSeconds ? { timeoutSeconds } : {}) } : {}) },
    // The gateway answers a wait itself once its timeout passes; allow it that long.
    timeoutMs: wait ? ((timeoutSeconds ?? DEFAULT_WAIT_SECONDS) + 30) * 1_000 : 60_000,
  });
  const code = result.status === "failed" || result.status === "timeout" ? 1 : result.status === "needs-input" ? 2 : 0;
  if (flags.json) {
    io.out(`${JSON.stringify(result)}\n`);
    return code;
  }
  if (result.status === "sent") io.out(`Sent to @${bot.handle}.\n`);
  else if (result.status === "queued") io.out(`Queued for @${bot.handle}; it answers once its current turn ends.\n`);
  else if (result.status === "answered") io.out(`${result.reply ?? "(no reply)"}\n`);
  else if (result.status === "failed") io.err(`@${bot.handle} failed: ${result.error ?? "the turn ended with an error."}\n`);
  else if (result.status === "timeout") io.err(`No answer within ${timeoutSeconds ?? DEFAULT_WAIT_SECONDS}s; @${bot.handle} keeps working. Follow it with hui bot chat ${bot.handle}.\n`);
  else {
    const asked = "questions" in result ? result.questions ?? [] : [];
    for (const question of asked) io.out(formatQuestion(question));
    io.out(asked.length && asked.every((question) => question.method === "secret")
      ? `@${bot.handle} needs a secret: give it in HUI's Secret card, in its chat.\n`
      : asked.length && asked.every((question) => question.method === "questionnaire")
        ? `@${bot.handle} has questions: answer them in HUI, in its chat.\n`
        : `@${bot.handle} needs an answer: reply with hui bot chat ${bot.handle}.\n`);
  }
  return code;
}

/** `soul`: prints SOUL.md, or with `--file` replaces it; an empty file removes it, so the bot asks what you expect again. */
async function soul(base: string, bot: BotView, flags: BotFlags, io: BotIO): Promise<number> {
  const path = `/__hui/bots/${encodeURIComponent(bot.id)}/soul`;
  if (flags.file !== undefined) {
    const result = await request<BotSoul>(base, path, { method: "PUT", body: { soul: await readText(flags.file, io) } });
    io.out(`${flags.json ? JSON.stringify(result) : result.soul === null
      ? `Removed @${bot.handle}'s SOUL.md. It asks what you expect from it again in its next turn (hui bot chat ${bot.handle}).`
      : `Replaced @${bot.handle}'s SOUL.md (${result.soul.length} characters); its next turn follows it.`}\n`);
    return 0;
  }
  const result = await request<BotSoul>(base, path);
  io.out(`${flags.json ? JSON.stringify(result) : result.soul ?? `@${bot.handle} has no SOUL.md yet: it writes one in its first conversation with you (hui bot chat ${bot.handle}).`}\n`);
  return 0;
}

/** `a, b,c` as distinct names. */
export function names(value: string): string[] {
  return [...new Set(value.split(",").map((name) => name.trim()).filter(Boolean))];
}

const catalogOf = (base: string, bot: BotView) => request<BotCatalog>(base, `/__hui/bots/${encodeURIComponent(bot.id)}/catalog`, { timeoutMs: 60_000 });

/** `--allow` and `--deny`: whole lists sent to the gateway, which checks every name against the bot's chat. */
async function changeAccess(base: string, bot: BotView, change: Record<string, unknown>): Promise<void> {
  await request<{ bot: BotView }>(base, `/__hui/bots/${encodeURIComponent(bot.id)}`, { method: "PATCH", body: change, timeoutMs: 60_000 });
}

/** `hui bot tools`: what the bot's chat has, and with `--allow`/`--deny` what to turn on or off. Prints the catalog after. */
async function tools(base: string, bot: BotView, flags: BotFlags, io: BotIO): Promise<number> {
  if (flags.allow !== undefined || flags.deny !== undefined) {
    const current = await catalogOf(base, bot);
    const allow = names(flags.allow ?? "");
    const deny = names(flags.deny ?? "");
    const known = new Set([...current.tools.map((tool) => tool.name), ...current.disabledTools]);
    // A bot's own tools are refused by the gateway, with its reason; other unknown names get the list here.
    const unknown = [...allow, ...deny].filter((name) => !known.has(name) && !current.alwaysOn.some((tool) => tool.name === name));
    if (unknown.length) throw new Error(`Unknown tool${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}. @${bot.handle}'s tools: ${current.tools.map((tool) => tool.name).join(", ")}.`);
    await changeAccess(base, bot, { disabledTools: [...current.disabledTools.filter((name) => !allow.includes(name)), ...deny.filter((name) => !current.disabledTools.includes(name))] });
  }
  const catalog = await catalogOf(base, bot);
  io.out(`${flags.json ? JSON.stringify(catalog) : formatTools(bot, catalog)}\n`);
  return 0;
}

/** `hui bot skills`: the skills of the bot's directory, on or off; `--allow`/`--deny` name them. */
async function skills(base: string, bot: BotView, flags: BotFlags, io: BotIO): Promise<number> {
  if (flags.allow !== undefined || flags.deny !== undefined) {
    const current = await catalogOf(base, bot);
    const allow = names(flags.allow ?? "");
    const deny = names(flags.deny ?? "");
    const known = new Set([...current.skills.map((skill) => skill.name), ...current.disabledSkills.map((skill) => skill.name)]);
    const unknown = [...allow, ...deny].filter((name) => !known.has(name));
    if (unknown.length) throw new Error(`Unknown skill${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}. @${bot.handle}'s skills: ${current.skills.length ? current.skills.map((skill) => skill.name).join(", ") : "none"}.`);
    // Kept as the refs they are; new ones by name, which the gateway resolves (and refuses when two skills share it).
    const next: BotSkillSelector[] = [
      ...current.disabledSkills.filter((skill) => !allow.includes(skill.name)),
      ...deny.filter((name) => !current.disabledSkills.some((skill) => skill.name === name)),
    ];
    await changeAccess(base, bot, { disabledSkills: next });
  }
  const catalog = await catalogOf(base, bot);
  io.out(`${flags.json ? JSON.stringify(catalog) : formatSkills(bot, catalog)}\n`);
  return 0;
}

async function memory(base: string, bot: BotView, flags: BotFlags, io: BotIO): Promise<number> {
  const path = `/__hui/bots/${encodeURIComponent(bot.id)}/memory`;
  if (flags.zoom !== undefined) {
    const { id, n } = parseZoom(flags.zoom);
    const result = await request<{ text: string }>(base, `${path}/zoom?id=${id}&n=${n}`);
    io.out(`${flags.json ? JSON.stringify(result) : result.text}\n`);
    return 0;
  }
  if (flags.html !== undefined) {
    const file = resolve(io.cwd, flags.html);
    await writeFile(file, await request<string>(base, `${path}/html`, { html: true }), { mode: 0o600 });
    io.out(`${flags.json ? JSON.stringify({ file }) : `Wrote @${bot.handle}'s memory to ${file}.`}\n`);
    return 0;
  }
  const result = await request<{ status: NonNullable<BotView["memory"]>; view: string }>(base, path);
  io.out(`${flags.json ? JSON.stringify(result) : `${formatMemory(result.status)}\n${result.view}`}\n`);
  return 0;
}

type ChatEntry = { kind: string; role?: string; text?: string; id?: string; name?: string };
type ChatSnapshot = { status: string; questions?: BotQuestion[]; transcript?: readonly ChatEntry[] };
type ChatEvent = { type: string; id?: string; delta?: string; name?: string; message?: string; level?: string; question?: BotQuestion };

/** Frames of one server-sent `/__hui/` stream until it ends or `signal` aborts. */
async function* frames(base: string, path: string, signal: AbortSignal): AsyncGenerator<{ event: string; data: unknown }> {
  const response = await fetch(new URL(path, base), { headers: { "x-hui": "1", accept: "text/event-stream" }, signal, redirect: "error" });
  if (!response.ok || !response.body) {
    const text = await response.text();
    let error: string | undefined;
    try { error = (JSON.parse(text) as { error?: string }).error; } catch { error = text.trim() || undefined; }
    throw new GatewayError(error ?? `HUI returned HTTP ${response.status}.`, response.status);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        let event = "message";
        const data: string[] = [];
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        }
        if (data.length) yield { event, data: JSON.parse(data.join("\n")) as unknown };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** What typing an answer sends for a question. */
export function questionAnswer(question: BotQuestion, typed: string): Record<string, unknown> {
  const value = typed.trim();
  if (value === "/cancel") return { id: question.id, cancelled: true };
  // HUI's masked card takes a secret: typed here it would stay on screen and in the terminal's scrollback.
  if (question.method === "secret") throw new Error("Give the secret in HUI's Secret card, in this bot's chat, so it stays out of this terminal (or /cancel).");
  if (question.method === "questionnaire") throw new Error("Answer these questions in HUI, in this bot's chat (or /cancel).");
  if (question.method === "confirm") {
    if (/^(y|yes)$/iu.test(value)) return { id: question.id, confirmed: true };
    if (/^(n|no)$/iu.test(value)) return { id: question.id, confirmed: false };
    throw new Error("Answer y or n (or /cancel).");
  }
  if (question.method === "select") {
    const options = question.options ?? [];
    const index = /^\d+$/u.test(value) ? Number(value) - 1 : options.findIndex((option) => option.toLowerCase() === value.toLowerCase());
    const option = options[index];
    if (option === undefined) throw new Error(`Answer with a number from 1 to ${options.length} (or /cancel).`);
    return { id: question.id, value: option };
  }
  return { id: question.id, value: typed };
}

const isUserMessage = (entry: ChatEntry) => entry.kind === "message" && entry.role === "user" && Boolean(entry.text?.trim());

/**
 * `chat`: the bot's replies as they stream, typed lines as prompts while it is
 * idle and steering while it works, questions answered inline, and every
 * message the bot gets from elsewhere (a routine, another bot, the Bots tab)
 * as a `> ` line before its reply. Plain text, so it works over SSH. The first
 * Ctrl+C stops a running turn, the next one exits.
 */
export async function botChat(base: string, bot: BotView, io: BotIO): Promise<number> {
  const session = `/__hui/sessions/${encodeURIComponent(bot.sessionId)}`;
  const closing = new AbortController();
  let status = bot.status as string;
  let questions: BotQuestion[] = [];
  let atLineStart = true;
  let speaking = false;
  let interrupts = 0;
  let summarizing = false;
  // Durable may commit a quick reply whole, with no text deltas: the transcript a settle brings is then the only
  // record of it. `seen` entries are accounted for; `streamed` is the text printed live since the last settle.
  let seen = 0;
  let streamed = "";
  let settling = false;
  let firstSnapshot = true;
  const toolsShown = new Set<string>();
  // Lines typed here (prompts and steering) no transcript has shown yet, and how many user messages after `seen` are
  // accounted for: printed when they arrived, or found to be typed here.
  const typed: string[] = [];
  let users = 0;
  let finish!: (code: number) => void;
  const finished = new Promise<number>((resolveCode) => { finish = resolveCode; });
  // Nothing typed is sent before the live stream is attached: a fast reply would otherwise finish unseen.
  let attached!: () => void;
  const streaming = new Promise<void>((resolveStream) => { attached = resolveStream; });
  const write = (text: string) => {
    if (!text) return;
    io.out(text);
    atLineStart = text.endsWith("\n");
  };
  const line = (text: string) => {
    if (!atLineStart) write("\n");
    write(`${text}\n`);
    speaking = false;
  };
  const ask = (question: BotQuestion) => {
    if (!atLineStart) write("\n");
    write(formatQuestion(question));
    speaking = false;
  };
  const failed = (error: unknown) => line(`error: ${error instanceof Error ? error.message : String(error)}`);
  /** A message the bot received: one typed here is on screen already; HUI's kickoff is a note; any other is printed as a user line. */
  const received = (text: string) => {
    const own = typed.indexOf(text.trim());
    const created = botKickoffName(text.trim());
    if (own >= 0) typed.splice(own, 1);
    else if (created !== undefined) line(`· ${created || bot.name} was created`);
    else line(`> ${text.trim().replace(/\n/gu, "\n> ")}`);
  };
  /** The user messages a snapshot holds after `seen` that are not accounted for yet, in order. */
  const announce = (transcript: readonly ChatEntry[]) => {
    const messages = transcript.slice(seen).filter(isUserMessage);
    for (const entry of messages.slice(users)) received(entry.text!);
    // A refused prompt is withdrawn by a later snapshot: count what is there now.
    users = messages.length;
  };
  const adopt = (snapshot: ChatSnapshot) => {
    status = snapshot.status;
    const known = new Set(questions.map((question) => question.id));
    questions = [...snapshot.questions ?? []];
    for (const question of questions) if (!known.has(question.id)) ask(question);
  };
  /** After a settle: prints what the run said that never streamed (or the tail of what streamed partly). */
  const reconcile = (transcript: readonly ChatEntry[]) => {
    let pending = streamed;
    let user = 0;
    for (const entry of transcript.slice(seen)) {
      // Printed when it arrived, or now in its place.
      if (isUserMessage(entry)) {
        if (user++ >= users) received(entry.text!);
        continue;
      }
      if (entry.kind === "tool" && entry.id && entry.name && !toolsShown.has(entry.id)) line(`· ${entry.name}`);
      if (entry.kind !== "message" || entry.role !== "assistant" || !entry.text?.trim()) continue;
      const text = entry.text;
      if (pending && pending.startsWith(text)) pending = pending.slice(text.length);
      else if (pending && text.startsWith(pending)) {
        write(text.slice(pending.length));
        pending = "";
      } else line(`@${bot.handle}: ${text.trim()}`);
    }
    if (!atLineStart) write("\n");
    seen = transcript.length;
    users = 0;
    streamed = "";
    speaking = false;
    toolsShown.clear();
  };

  const opened = await request<{ snapshot: ChatSnapshot }>(base, `${session}/open`, { method: "POST", body: {}, timeoutMs: 60_000 });
  line(`Chatting with @${bot.handle} (${bot.name}). Type a message and press Enter. Ctrl+C stops a turn; twice exits.`);
  const last = [...opened.snapshot.transcript ?? []].reverse().find((entry) => entry.kind === "message" && entry.role === "assistant" && entry.text?.trim());
  if (last?.text) line(`@${bot.handle}: ${last.text.trim()}`);
  adopt(opened.snapshot);

  const onEvent = (event: ChatEvent) => {
    if (event.type === "text" && event.delta) {
      if (!speaking) {
        if (!atLineStart) write("\n");
        write(`@${bot.handle}: `);
        speaking = true;
      }
      write(event.delta);
      streamed += event.delta;
    } else if (event.type === "tool_start" && event.name) {
      if (event.id) toolsShown.add(event.id);
      line(`· ${event.name}`);
    }
    else if (event.type === "question" && event.question) {
      if (!questions.some((question) => question.id === event.question!.id)) {
        questions.push(event.question);
        ask(event.question);
      }
    } else if (event.type === "notice" && event.message && event.level !== "info") line(`${event.level}: ${event.message}`);
    else if (event.type === "error" && event.message) line(`error: ${event.message}`);
    else if (event.type === "settled") {
      // The snapshot that follows carries the settled transcript.
      settling = true;
      summarizing = false;
      // The next turn's first Ctrl+C stops it again.
      interrupts = 0;
    }
  };

  void (async () => {
    try {
      for await (const { event, data } of frames(base, `${session}/events`, closing.signal)) {
        if (event === "snapshot") {
          const snapshot = data as ChatSnapshot;
          adopt(snapshot);
          if (settling) reconcile(snapshot.transcript ?? []);
          // The first snapshot is history already on screen (its last reply was printed on opening).
          else if (firstSnapshot) seen = snapshot.transcript?.length ?? 0;
          // A bot's chat sends one when it accepts a message, and when a turn takes in steering: before the reply.
          else announce(snapshot.transcript ?? []);
          settling = false;
          firstSnapshot = false;
          attached();
        } else if (event === "status") status = (data as { status: string }).status;
        else if (event === "event") onEvent(data as ChatEvent);
        else if (event === "closed") {
          line(`@${bot.handle}'s chat runtime exited.`);
          finish(1);
          return;
        }
      }
      if (!closing.signal.aborted) {
        line("The gateway closed the stream.");
        finish(1);
      }
    } catch (error) {
      if (closing.signal.aborted) return;
      failed(error);
      finish(1);
    } finally {
      attached();
    }
  })();

  // "Summarizing memory…" while a turn waits on OptChat's compactor; nothing while the gateway cannot read the memory.
  void (async () => {
    try {
      for await (const { event, data } of frames(base, "/__hui/bots/events", closing.signal)) {
        if (event !== "bots") continue;
        const view = (data as BotsUpdate).upserts.find((candidate) => candidate.id === bot.id);
        if (!view) continue;
        if (view.memory?.waiting && !summarizing) line("Summarizing memory…");
        summarizing = view.memory?.waiting === true;
      }
    } catch { /* optional: the chat works without it */ }
  })();

  const submit = async (entered: string) => {
    if (questions.length) {
      const question = questions[0]!;
      let answer: Record<string, unknown>;
      try {
        answer = questionAnswer(question, entered);
      } catch (error) {
        failed(error);
        return;
      }
      questions.shift();
      await request(base, `${session}/question`, { method: "POST", body: answer }).catch((error: unknown) => {
        questions.unshift(question);
        failed(error);
      });
      return;
    }
    const text = entered.trim();
    if (!text) return;
    const steer = () => request(base, `${session}/steer`, { method: "POST", body: { text }, timeoutMs: 60_000 });
    // Before the request: the snapshot that shows it may come before the reply to it.
    typed.push(text);
    try {
      if (SESSION_STATUSES_BUSY.has(status)) await steer();
      else {
        try {
          await request(base, `${session}/prompt`, { method: "POST", body: { text }, timeoutMs: 60_000 });
        } catch (error) {
          // A turn started meanwhile (a routine, another bot): steer it instead.
          if (!(error instanceof GatewayError) || error.status !== 409 || /starting/u.test(error.message)) throw error;
          await steer();
        }
      }
    } catch (error) {
      typed.splice(typed.lastIndexOf(text), 1);
      failed(error);
    }
  };

  // Held as an iterator, so leaving the chat also closes the terminal's line reader.
  const input = io.lines()[Symbol.asyncIterator]();
  void (async () => {
    try {
      await streaming;
      for (;;) {
        const next = await input.next();
        if (next.done || closing.signal.aborted) break;
        await submit(next.value);
      }
      finish(0);
    } catch (error) {
      failed(error);
      finish(1);
    }
  })();

  const stopListening = io.onInterrupt(() => {
    interrupts += 1;
    if (interrupts === 1 && SESSION_STATUSES_BUSY.has(status)) {
      line("Stopping… (Ctrl+C again to exit)");
      void request(base, `${session}/abort`, { method: "POST", body: {}, timeoutMs: 60_000 }).catch(failed);
      return;
    }
    finish(130);
  });

  const code = await finished;
  closing.abort();
  stopListening();
  void input.return?.();
  if (!atLineStart) write("\n");
  return code;
}

function formatQuestion(question: BotQuestion): string {
  const lines = [`? ${question.method === "secret" ? `Secret: ${question.title}` : question.method === "questionnaire" ? "Questions" : question.title}`];
  if (question.message) lines.push(`  ${question.message}`);
  (question.options ?? []).forEach((option, index) => lines.push(`  ${index + 1}. ${option}`));
  lines.push(question.method === "confirm" ? "  Answer y or n, or /cancel."
    : question.method === "select" ? "  Answer with a number, or /cancel."
      : question.method === "secret" ? "  Give it in HUI's Secret card, in this bot's chat, so it stays out of this terminal; or /cancel."
        : question.method === "questionnaire" ? "  Answer them in HUI, in this bot's chat; or /cancel."
          : `  Type your answer${question.prefill ? ` (was: ${question.prefill})` : ""}, or /cancel.`);
  return `${lines.join("\n")}\n`;
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

const TOOL_GROUPS: readonly [BotCatalogTool["group"], string][] = [["files", "Files"], ["shell", "Shell"], ["hui", "HUI"], ["extension", "Extensions"], ["bots", "Bots"]];

/** A pending access request, and where to answer it. */
function formatRequest(bot: BotView, catalog: BotCatalog): string[] {
  return catalog.request ? ["", `Waiting for you: ${catalog.request.title} Answer it in hui bot chat ${bot.handle} or on its Tools & skills page.`] : [];
}

/** The tools, grouped, each on or off; powerful ones marked. */
export function formatTools(bot: BotView, catalog: BotCatalog): string {
  const off = catalog.tools.filter((tool) => !tool.enabled).length;
  const width = Math.max(0, ...catalog.tools.map((tool) => tool.name.length));
  const lines = [`@${bot.handle}'s tools: ${off ? `${off} of ${catalog.tools.length} off` : `all ${catalog.tools.length} on`}. Changes apply from its next request.`];
  if (!catalog.live) lines.push("Its chat isn't running, so an extension's tools aren't listed.");
  for (const [group, title] of TOOL_GROUPS) {
    const members = catalog.tools.filter((tool) => tool.group === group);
    if (!members.length) continue;
    lines.push("", title);
    for (const tool of members) {
      const source = group === "extension" ? `  [${tool.source}]` : "";
      lines.push(`  ${tool.enabled ? "on " : "off"}  ${tool.name.padEnd(width)}  ${tool.description}${tool.powerful ? " (powerful)" : ""}${source}`);
    }
  }
  lines.push("", `Always on: ${catalog.alwaysOn.map((tool) => tool.name).join(", ")}.`, ...formatRequest(bot, catalog));
  return lines.join("\n");
}

/** The skills, each on or off, with where they come from. */
export function formatSkills(bot: BotView, catalog: BotCatalog): string {
  const off = catalog.skills.filter((skill) => !skill.enabled).length;
  if (!catalog.skills.length) return [`@${bot.handle} has no skills: none are installed for its directory.`, ...formatRequest(bot, catalog)].join("\n");
  const width = Math.max(0, ...catalog.skills.map((skill) => skill.name.length));
  return [
    `@${bot.handle}'s skills: ${off ? `${off} of ${catalog.skills.length} off` : `all ${catalog.skills.length} on`}. Changes apply from its next request.`,
    "",
    ...catalog.skills.map((skill) => `  ${skill.enabled ? "on " : "off"}  ${skill.name.padEnd(width)}  ${skill.description}  [${skill.source}]`),
    ...formatRequest(bot, catalog),
  ].join("\n");
}

/** One line: the log, the tree, the view, and what the compactor spent since the gateway opened the memory. */
function formatMemory(status: NonNullable<BotView["memory"]>): string {
  const size = status.viewBytes < 1024 ? `${status.viewBytes} B` : `${Math.round(status.viewBytes / 1024)} KB`;
  const { usage } = status;
  return [
    plural(status.messages, "message"),
    `${plural(status.built, "summary", "summaries")} built`,
    `${status.pending} pending`,
    `view ${size} in ${plural(status.viewLines, "line")}`,
    ...(status.waiting ? ["summarizing"] : []),
    ...(status.failing ? [`retrying ${status.failing.node} since ${status.failing.since}: ${status.failing.error}`] : []),
    `compactor ${plural(usage.calls, "call")}, ${plural(usage.input + usage.cacheRead + usage.cacheWrite, "token")} in, ${usage.output} out${usage.cost > 0 ? `, $${usage.cost.toFixed(4)}` : ""}`,
  ].join(" · ");
}

/** One line per bot, for people; --json prints the views. */
export function formatBots(list: readonly BotView[], archived = false): string {
  if (!list.length) return archived ? "No archived bots." : "No bots. Add one with hui bot add --name <name>.";
  return list.map((bot) => [
    `${bot.avatar?.emoji ? `${bot.avatar.emoji} ` : ""}@${bot.handle}`,
    bot.name,
    `${bot.status}${bot.unread ? " · unread" : ""}${bot.worker ? ` · on ${bot.worker.name}` : ""}`,
    ...(bot.title ? [bot.title] : []),
    `${bot.routines} routine${bot.routines === 1 ? "" : "s"}`,
    bot.id,
  ].join("  ")).join("\n");
}

/** Who may tag a bot, as `hui bot show` says it. */
const TAGGING_TEXT: Readonly<Record<BotTagging, string>> = {
  anyone: "anyone, when a task fits its description",
  mention: "only when your message tags it",
  nobody: "nobody",
};

/** `es (Spanish)`; `auto` when the bot answers in the language it hears. */
function formatLanguage(value: string | undefined): string {
  const code = voiceLanguage(value);
  return code ? `${code} (${voiceLanguageName(code)})` : "auto";
}

export function formatBot(bot: BotView): string {
  return [
    `${bot.avatar?.emoji ? `${bot.avatar.emoji} ` : ""}@${bot.handle} · ${bot.name}${bot.title ? ` (${bot.title})` : ""}${bot.archived ? " · archived" : ""}`,
    `status: ${bot.status}${bot.unread ? " · unread" : ""}`,
    ...(bot.worker ? [`worker: ${bot.worker.name} (${bot.worker.id})`] : []),
    `look: ${formatLook(bot)}`,
    `model: ${bot.model ?? "default"}${bot.thinking ? ` · thinking ${bot.thinking}` : ""}`,
    `memory: ${bot.memory ? formatMemory(bot.memory) : "unavailable"}`,
    `utility model: ${bot.memoryModel ?? "default (Settings' utility model, else its model)"}`,
    `language: ${formatLanguage(bot.voice?.language)}`,
    ...(bot.voice?.live ? [`call voice: ${gptLiveVoiceLabel(bot.voice.live)}`] : []),
    `routines: ${bot.routines}`,
    `cwd: ${botDisplayCwd(bot)}`,
    `chat session: ${bot.sessionId}`,
    `id: ${bot.id}`,
    ...(bot.lastMessage ? [`last message (${bot.lastMessage.role}, ${bot.lastMessage.at}): ${bot.lastMessage.text}`] : []),
    ...(bot.description ? [`description: ${bot.description}`] : []),
    `tagging: ${TAGGING_TEXT[bot.tagging ?? "anyone"]}`,
    `soul: ${bot.soul ? `SOUL.md (hui bot soul ${bot.handle})` : "none yet: it writes SOUL.md in its first conversation"}`,
  ].join("\n");
}
