/**
 * Bots on this worker (HUI-18): what a gateway asks the host for a bot whose
 * chat runs here. Its conversation and OptChat memory live in the host's own
 * Durable store, so these reuse the gateway's adapters (`bots/conversations.ts`
 * and `bots/memory.ts`) against the host's DurableHost: a bot's conversation is
 * created here exactly as the gateway creates a local one, its `hui.bot`
 * document and OptChat in one commit. Every bot has a home here, HUI's private
 * folder for it under the data directory (`home(botId)`), as the gateway keeps
 * one under its configuration: its SOUL.md lives there (`bots/souls.ts`, the
 * gateway's own implementation and guard, on this directory), and a bot without
 * a directory of its own works there. The bot itself (its record, routines,
 * roster) stays with the gateway; nothing here knows other bots.
 *
 * What the operator turned off in a bot's chat lives in its `hui.bot` document
 * here, and this host enforces it from that document alone (its tool offer, its
 * HUI tool bridge, its prompt's skills). A gateway reads and writes those lists
 * (`bot.access.*`) and what can be turned off (`bot.offer`: skills by the paths
 * this host's loader finds them at, the mirrored ones included), and hears of a
 * grant made here in a `bot.access` frame.
 */
import { BOT_FACTS_FILE, localBotFacts } from "../bots/facts.ts";
import { realpath, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { BOT_LIMITS, BOT_THINKING_LEVELS, type BotMemoryStatus } from "../bots-format.ts";
import { parseCallRecord } from "../calls-format.ts";
import { durableBotConversations } from "../bots/conversations.ts";
import { BotMemoryUnavailableError, optChatBotMemory, type BotMemorySettings } from "../bots/memory.ts";
import { BOT_TEMPLATE_LIMITS } from "../bots/templates/formats.ts";
import { BOT_SKILL_NAME, localBotSkills, type BotOwnSkill } from "../bots/skills.ts";
import { caseClash, skillFilePath } from "../bots/templates/common.ts";
import { localBotSouls } from "../bots/souls.ts";
import { BotConflictError, BotInputError, BotNotFoundError, accessField, normalizeSoul } from "../bots/bots.ts";
import { createDurableBots, type DurableBotsDeps } from "../bots/durable-access.ts";
import type { DurableHost } from "../runtimes/durable-host.ts";
import { durableConversationId } from "../runtimes/durable.ts";
import { resolveWorkingDirectory } from "../git/working-directories.ts";
import { isRecord, type Frame, type Peer } from "./protocol.ts";

/** What `hello` lists when the host can run bots, so a gateway tells an older host from this one. */
export const BOTS_FEATURE = "bots";
/** Manual knowledge lives beside each bot on its execution host. */
export const BOT_FACTS_FEATURE = "bot-facts";
/** The frame a watched memory's status arrives in. */
export const BOT_MEMORY_STATUS_FRAME = "bot.memory.status";
/** What `hello` lists when the host keeps bots' tool and skill lists (`bot.access.*`, `bot.offer`) and reports grants. */
export const BOT_ACCESS_FEATURE = "bot-access";
/** The frame a bot's lists arrive in after the operator allowed one of its requests here: `{ botId, access }`. */
export const BOT_ACCESS_FRAME = "bot.access";
/** What `hello` lists when the host keeps a bot's own skills in its home (`bot.skills.*`, `bots/skills.ts`): an imported bot's. */
export const BOT_SKILLS_FEATURE = "bot-skills";
/** What `hello` lists when `bot.skills.*` also carry the files beside a SKILL.md (a template's scripts). */
export const BOT_SKILL_FILES_FEATURE = "bot-skill-files";

const ID = /^[A-Za-z0-9_-]{1,100}$/u;
const MODEL = /^[^/\s]+\/\S+$/u;
const LEVELS: ReadonlySet<string> = new Set(BOT_THINKING_LEVELS);
/** References one watch may name; a gateway watches the bots it lists. */
const MAX_WATCHED = 1_000;

export type HostBotsOptions = {
  durable: DurableHost;
  /** The remote user's home, for `~/` directories. */
  home: string;
  /** Where bots' homes go: `<data dir>/bots/<bot id>`. */
  botsDir: string;
  /** The model a bot without one of its own starts on: Settings' primary model, as the gateway mirrors it here. */
  primaryModel?: () => Promise<string | undefined>;
  /** A chat's `bots` section, as a connected gateway gives it. */
  section: DurableBotsDeps["section"];
  /** Settings' profile name, for a bot's first conversation. */
  operator: () => Promise<string | undefined>;
  /** The operator allowed a bot's request here: what its lists are now. */
  recorded: DurableBotsDeps["recorded"];
};

type Handler = (params: Record<string, unknown>) => Promise<unknown>;

/** A memory read's answer: the text, or why this store cannot read the memory (the gateway answers 503 with it). */
type MemoryText = { text: string } | { unavailable: string };

function botId(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) throw new Error("A bot id is required.");
  return value;
}

/** A Durable resume reference of this store (`durable:N`). */
function reference(value: unknown): string {
  if (typeof value !== "string" || durableConversationId(value) === undefined) throw new Error("A bot's conversation reference is required.");
  return value;
}

function optionalText(value: unknown, maximum: number, what: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maximum) throw new Error(`${what} must be text of at most ${maximum} characters.`);
  return value || undefined;
}

function optionalModel(value: unknown, what: string): string | undefined {
  const model = optionalText(value, 200, what);
  if (model !== undefined && !MODEL.test(model)) throw new Error(`${what} must use provider/id format.`);
  return model;
}

function optionalLevel(value: unknown, what: string): string | undefined {
  const level = optionalText(value, 16, what);
  if (level !== undefined && !LEVELS.has(level)) throw new Error(`${what} must be one of: ${BOT_THINKING_LEVELS.join(", ")}.`);
  return level;
}

function memorySettings(value: unknown): BotMemorySettings {
  if (!isRecord(value)) throw new Error("The bot's memory settings are required.");
  const name = optionalText(value["name"], BOT_LIMITS.name, "The bot's name");
  if (!name) throw new Error("The bot's name is required.");
  const model = optionalModel(value["model"], "The utility model");
  const thinking = optionalLevel(value["thinking"], "The memory thinking level");
  return { name, ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) };
}

/** A bot's own skills as `bot.skills.write` takes them: at most 200, each a skill's name, a SKILL.md of at most 256 KB and
 * the files beside it, within a template's limits. */
function skillFiles(value: unknown): BotOwnSkill[] {
  if (!Array.isArray(value) || value.length > 200) throw new Error("A bot's skills must be a list of at most 200.");
  return value.map((skill) => {
    if (!isRecord(skill) || typeof skill["name"] !== "string" || !BOT_SKILL_NAME.test(skill["name"]) || typeof skill["text"] !== "string" || skill["text"].length > 256 * 1024) {
      throw new Error("Each of a bot's skills needs a skill's name and its SKILL.md.");
    }
    const files = skill["files"] ?? [];
    if (!Array.isArray(files) || files.length > BOT_TEMPLATE_LIMITS.skillFiles) throw new Error(`A skill has at most ${BOT_TEMPLATE_LIMITS.skillFiles} files beside its SKILL.md.`);
    let total = 0;
    const checked = files.map((file) => {
      if (!isRecord(file) || typeof file["path"] !== "string" || skillFilePath(file["path"]) !== file["path"] || typeof file["text"] !== "string") {
        throw new Error("Each file of a skill needs its path inside the skill's folder and its text.");
      }
      total += Buffer.byteLength(file["text"]);
      if (Buffer.byteLength(file["text"]) > BOT_TEMPLATE_LIMITS.skillFileBytes || total > BOT_TEMPLATE_LIMITS.skillFilesBytes) throw new Error(`The files of skill ${skill["name"]} are too large.`);
      return { path: file["path"], text: file["text"] };
    });
    if (caseClash(checked.map((file) => file.path))) throw new Error(`Two files of skill ${skill["name"]} differ only by case.`);
    return { name: skill["name"], text: skill["text"], ...(checked.length ? { files: checked } : {}) };
  });
}

/** The bots a gateway runs on this host: request handlers for each connected gateway, and the memories it watches. */
export function hostBots(options: HostBotsOptions) {
  const memory = optChatBotMemory(options.durable);
  const conversations = durableBotConversations(options.durable, memory, options.primaryModel ? { primaryModel: options.primaryModel } : {});
  /** A bot's home on this worker: HUI's private folder for it, where its SOUL.md lives. */
  const home = (id: string) => join(options.botsDir, botId(id));
  /** SOUL.md in those homes, with the gateway's guard: a deleted bot's home goes only when it really is that folder of
   * this bots directory, and a link in its place is removed, never followed. */
  const souls = localBotSouls(options.botsDir);
  const facts = localBotFacts(options.botsDir);
  // The worker wire otherwise transports only Error.message; preserve the facts API's status categories explicitly.
  const factsReply = async (read: () => Promise<unknown>) => {
    try { return { facts: await read() }; }
    catch (error) {
      return { error: error instanceof Error ? error.message : String(error), code: error instanceof BotConflictError ? "conflict" : error instanceof BotNotFoundError ? "not-found" : error instanceof BotInputError ? "input" : "store" };
    }
  };
  /** Each bot's own skills, in its home here: what an import brought. */
  const ownSkills = localBotSkills(options.botsDir);
  /** Each bot's name as its gateway last gave it (the create, then every `bots` section): a bot still called "New Bot"
   * asks for a real one in its first conversation. */
  const names = new Map<string, string>();
  // Its SOUL.md (or its first conversation) from its home here, and write_soul writes it there.
  options.durable.configureDurableBots(createDurableBots(options.durable, {
    section: options.section, recorded: options.recorded,
    souls: { home, operator: options.operator, name: (id) => names.get(id) },
  }));

  /** A directory chosen for the bot that lies inside its home here: deleting the home would take it along. */
  const chosenInsideHome = async (id: string, cwd: unknown): Promise<boolean> => {
    const folder = home(id);
    if (typeof cwd !== "string" || !cwd.startsWith("/") || cwd === folder) return false;
    const resolved = (path: string) => realpath(path).catch(() => path);
    const [inside, root] = await Promise.all([resolved(cwd), resolved(folder)]);
    const within = relative(root, inside);
    return within === "" || (!within.startsWith("..") && !isAbsolute(within));
  };
  /** Each gateway's watched memories, so their status reaches it as it changes. */
  const watches = new Map<Peer, Map<string, () => void>>();

  /** A directory here: `~/` is the remote user's home; it must exist. */
  const directory = async (value: unknown): Promise<string> => {
    if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error("A directory on the worker is required.");
    const given = value.trim();
    if (!given.startsWith("/") && given !== "~" && !given.startsWith("~/")) throw new Error("A directory on a worker must be absolute or start with ~/.");
    const path = resolveWorkingDirectory(given, options.home);
    if (!isAbsolute(path)) throw new Error("A directory on a worker must be absolute or start with ~/.");
    const info = await stat(path).catch(() => undefined);
    if (!info) throw new Error(`No such directory on the remote: ${path}`);
    if (!info.isDirectory()) throw new Error(`Not a directory on the remote: ${path}`);
    return path;
  };

  /** A memory read, with OptChat's own refusal (no memory for that chat here) as an answer instead of a failure. */
  const memoryText = async (read: () => Promise<string>): Promise<MemoryText> => {
    try {
      return { text: await read() };
    } catch (error) {
      if (error instanceof BotMemoryUnavailableError) return { unavailable: error.message };
      throw error;
    }
  };

  const detach = (peer: Peer) => {
    const watched = watches.get(peer);
    watches.delete(peer);
    for (const stop of watched?.values() ?? []) stop();
  };

  /** The handlers for one gateway's connection. */
  function handlers(peer: Peer): Record<string, Handler> {
    return {
      /**
       * The bot's home (always: SOUL.md lives there, never in a directory chosen for the bot), SOUL.md when given, then
       * its conversation in one commit, in the given directory or that home. A failure removes the home and SOUL.md
       * again; a chosen directory lies outside the home and is never touched.
       */
      "bot.create": async (params) => {
        const id = botId(params["botId"]);
        const settings = memorySettings(params["memory"]);
        const model = optionalModel(params["model"], "The bot's model");
        const thinking = optionalLevel(params["thinking"], "The thinking level");
        const soul = params["soul"] === undefined ? "" : normalizeSoul(params["soul"]);
        // What is off from its first turn, as the gateway checked it against this host's offer (`bot.offer`).
        const access = params["access"] === undefined ? undefined : accessField(params["access"]);
        const cwd = params["cwd"] === undefined ? home(id) : await directory(params["cwd"]);
        await souls.prepare(id);
        try {
          if (soul) await souls.write(id, soul);
          const reference = await conversations.create({
            botId: id, cwd,
            ...(model ? { model } : {}),
            ...(thinking ? { thinking } : {}),
            memory: settings,
            ...(access ? { access } : {}),
          });
          names.set(id, settings.name);
          return { reference, cwd };
        } catch (error) {
          await souls.remove(id).catch(() => {});
          throw error;
        }
      },
      "bot.directory": async (params) => ({ cwd: await directory(params["cwd"]) }),
      /** What the operator turned off in the bot's chat: its document's lists, which this host enforces. */
      "bot.access.read": async (params) => ({ access: await conversations.access(reference(params["reference"])) }),
      /** New lists in one commit; a session following the chat here is offered its tools again at once. */
      "bot.access.write": async (params) => {
        await conversations.setAccess(reference(params["reference"]), accessField(params["access"]));
        return {};
      },
      /**
       * What the operator can turn off in the bot's chat, as this host offers it: a live session's own offer (extension
       * tools included), else the tools every chat has, and the skills this host's loader finds in the chat's
       * directory, the gateway's mirrored there by their mirrored paths, with Settings' choices as the gateway mirrors
       * them. Before the conversation exists: the folder asked for (checked here), or the bot's home.
       */
      "bot.offer": async (params) => {
        const conversation = params["reference"] === undefined ? undefined : reference(params["reference"]);
        const cwd = params["cwd"] === undefined ? home(botId(params["botId"])) : await directory(params["cwd"]);
        return { offer: await conversations.offer(conversation, cwd) };
      },
      /** A new working directory, from the conversation's next request: the only change a gateway makes here. */
      "bot.configure": async (params) => {
        await conversations.configure(reference(params["reference"]), { cwd: await directory(params["cwd"]) });
        return {};
      },
      /** A deleted bot's conversation stops being a bot's chat, and its memory is turned off and deleted. */
      "bot.forget": async (params) => {
        await conversations.forget(reference(params["reference"]));
        return {};
      },
      "bot.home.prepare": async (params) => {
        await souls.prepare(botId(params["botId"]));
        return {};
      },
      "bot.facts.retire": async (params) => factsReply(async () => { await facts.retire(botId(params["botId"])); return []; }),
      "bot.facts.list": async (params) => factsReply(() => facts.list(botId(params["botId"]))),
      "bot.facts.create": async (params) => factsReply(() => facts.create(botId(params["botId"]), params["input"])),
      "bot.facts.update": async (params) => factsReply(() => facts.update(botId(params["botId"]), botId(params["factId"]), params["input"])),
      "bot.facts.delete": async (params) => factsReply(() => facts.delete(botId(params["botId"]), botId(params["factId"]), params["revision"] as number)),
      "bot.soul.read": async (params) => ({ soul: (await souls.read(botId(params["botId"]))) ?? null }),
      /** Writes a bot's own skills into its home here (an import's), each `{ name, text, files? }`: its folder's name, SKILL.md
       * and the files beside it. */
      "bot.skills.write": async (params) => {
        await ownSkills.write(botId(params["botId"]), skillFiles(params["skills"]));
        return {};
      },
      "bot.skills.read": async (params) => ({ skills: await ownSkills.read(botId(params["botId"])) }),
      /** Replaces SOUL.md atomically; none (or empty) removes it, which brings the first conversation back. */
      "bot.soul.write": async (params) => {
        const id = botId(params["botId"]);
        const soul = params["soul"] === undefined || params["soul"] === null ? "" : normalizeSoul(params["soul"]);
        if (soul) await souls.prepare(id);
        await souls.write(id, soul || undefined);
        return {};
      },
      "bot.last-message": async (params) => {
        const message = await conversations.lastMessage(reference(params["reference"]));
        return message ? { message } : {};
      },
      "bot.call-record": async (params) => {
        const record = parseCallRecord(params["record"]);
        if (!record) throw new Error("The call's record is not valid.");
        await conversations.writeCallRecord(reference(params["reference"]), record);
        return {};
      },
      /**
       * A deleted bot's home with everything in it (SOUL.md and every file HUI or the bot put there), as the gateway
       * removes its own (`localBotSouls.remove`): only the folder of this bots directory named by the bot's id, never
       * through a link. When `cwd`, the directory the bot worked in, lies inside its home, only SOUL.md goes.
       */
      "bot.remove-home": async (params) => {
        const id = botId(params["botId"]);
        await facts.retire(id);
        if (await chosenInsideHome(id, params["cwd"])) {
          await souls.write(id, undefined);
          await rm(join(home(id), BOT_FACTS_FILE), { force: true });
        }
        else await souls.remove(id);
        names.delete(id);
        return {};
      },
      "bot.memory.configure": async (params) => {
        await memory.configure(reference(params["reference"]), memorySettings(params["settings"]));
        return {};
      },
      "bot.memory.status": async (params) => {
        const status = await memory.status(reference(params["reference"]));
        return status ? { status } : {};
      },
      // With the status after the view caught up, so the gateway's copy counts the messages the view shows.
      "bot.memory.view": async (params) => {
        const read = reference(params["reference"]);
        const answer = await memoryText(() => memory.view(read));
        const status = "text" in answer ? await memory.status(read) : undefined;
        return { ...answer, ...(status ? { status } : {}) };
      },
      "bot.memory.zoom": async (params) => {
        const at = Number(params["id"]);
        const n = Number(params["n"]);
        if (!Number.isSafeInteger(at) || at < 0 || !Number.isSafeInteger(n) || n < 1) throw new Error("Zoom needs a message id (0 or more) and a span n (1 or more).");
        return memoryText(() => memory.zoom(reference(params["reference"]), at, n));
      },
      "bot.memory.html": async (params) => memoryText(() => memory.html(reference(params["reference"]))),
      /** These memories' status goes to this gateway as it changes, the current one first, until it disconnects. */
      "bot.memory.watch": async (params) => {
        const references = (Array.isArray(params["references"]) ? params["references"] : []).slice(0, MAX_WATCHED).map(reference);
        let watched = watches.get(peer);
        if (!watched) {
          watched = new Map();
          watches.set(peer, watched);
          peer.onClose(() => detach(peer));
        }
        for (const watchedReference of references) {
          if (watched.has(watchedReference)) continue;
          watched.set(watchedReference, memory.subscribe(watchedReference, (status: BotMemoryStatus) => {
            peer.send({ t: BOT_MEMORY_STATUS_FRAME, reference: watchedReference, status } satisfies Frame);
          }));
        }
        return {};
      },
    };
  }

  return {
    handlers,
    /** What a gateway's `bots` section reply says the bot is called now. */
    named(id: string, name: string): void {
      if (ID.test(id) && name) names.set(id, name.slice(0, BOT_LIMITS.name));
    },
    /** Ends every watch, as the host stops. */
    close(): void {
      for (const peer of [...watches.keys()]) detach(peer);
    },
  };
}
