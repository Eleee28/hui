/**
 * Bots on remote workers (HUI-18), the gateway's half. A bot whose record names
 * a worker keeps its conversation and OptChat memory in that worker's Durable
 * store, where its chat runs as a remote session, and its home folder with
 * SOUL.md in the worker's HUI data directory; these ports reach them through
 * the worker's host (`worker/host-bots.ts`). Only over a live connection: an
 * offline worker fails at once, named, and nothing here ever connects one.
 * Each memory's status arrives by subscription and is kept here, so a bot list
 * never waits on a worker.
 *
 * Deleting a bot whose worker is offline leaves its memory and home there; the
 * clean-up waits in a small file on this machine (`cleanupFile`) and runs at
 * the worker's next connection, or is dropped with the worker.
 *
 * What the operator turned off in such a bot's chat is in its document there,
 * which the worker's host enforces; these ports read and write it, ask the host
 * what can be turned off (skills by the paths it finds them at), and pass on the
 * grants it reports (`onAccessRecorded`).
 */
import { BotFactsStoreError, type BotFacts } from "./facts.ts";
import type { BotFact } from "../api/bots.ts";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BotAccess, BotMemoryStatus, BotToolGroup } from "../bots-format.ts";
import { BotMemoryUnavailableError, type BotMemory } from "./memory.ts";
import type { BotOffer, BotSouls, BotStoredMessage, BotWorkers, RemoteBotConversations } from "./service.ts";
import { BotConflictError, BotInputError, BotNotFoundError, BotWorkerOfflineError, storedAccess } from "./bots.ts";
import type { BotOwnSkill, BotSkillFiles } from "./skills.ts";
import { BOT_FACTS_FEATURE, BOT_ACCESS_FEATURE, BOT_ACCESS_FRAME, BOT_MEMORY_STATUS_FRAME, BOT_SKILL_FILES_FEATURE, BOT_SKILLS_FEATURE, BOTS_FEATURE } from "../worker/host-bots.ts";
import { WorkerOfflineError, type WorkerService } from "../workers.ts";

/** What these ports need of the worker service. */
export type BotWorkerLink = Pick<WorkerService, "list" | "nameOf" | "connected" | "features" | "hostRequest" | "onHostFrame" | "onClosed" | "onConnected" | "onRemoved" | "skillPath">;

export type RemoteBotsOptions = {
  /** Where deleted bots' clean-ups wait for their worker: JSON, owner-only, written atomically. */
  cleanupFile: string;
  /** A clean-up that failed with the worker connected, or a queue that could not be read or written. */
  report?: (action: string, summary: string, error: unknown) => void;
};

/** What a deleted bot left on its worker: its conversation (forgotten there) and home folder. */
export type BotCleanup = { worker: string; botId: string; reference?: string; cwd: string; at: string };

/** Creating a conversation may open the worker's store and read its models first. */
const CREATE_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 30_000;
/** A list's background read of a chat's newest message. */
const LAST_MESSAGE_TIMEOUT_MS = 10_000;
const REFERENCE = /^durable:\d+$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const count = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** A status as the worker reported it, or undefined when it is not one: the roster never shows half a status. */
export function reportedStatus(value: unknown): BotMemoryStatus | undefined {
  if (!isRecord(value) || !isRecord(value["usage"])) return undefined;
  const usage = value["usage"];
  const numbers = ["messages", "built", "pending", "viewBytes", "viewLines"].map((key) => count(value[key]));
  const spent = ["calls", "input", "output", "cacheRead", "cacheWrite", "cost"].map((key) => count(usage[key]));
  if ([...numbers, ...spent].some((entry) => entry === undefined)) return undefined;
  const [messages, built, pending, viewBytes, viewLines] = numbers as number[];
  const [calls, input, output, cacheRead, cacheWrite, cost] = spent as number[];
  const failing = isRecord(value["failing"]) && typeof value["failing"]["error"] === "string" ? value["failing"] : undefined;
  return {
    messages: messages!, built: built!, pending: pending!, viewBytes: viewBytes!, viewLines: viewLines!,
    ...(value["waiting"] === true ? { waiting: true } : {}),
    ...(failing ? { failing: { node: String(failing["node"] ?? ""), error: String(failing["error"]), since: String(failing["since"] ?? "") } } : {}),
    usage: { calls: calls!, input: input!, output: output!, cacheRead: cacheRead!, cacheWrite: cacheWrite!, cost: cost! },
  };
}

const TOOL_GROUPS: ReadonlySet<string> = new Set<BotToolGroup>(["files", "shell", "hui", "extension", "bots"]);
const shortText = (value: unknown, maximum: number): string => typeof value === "string" ? value.slice(0, maximum) : "";

/** What can be turned off in a bot's chat, as its worker reported it: entries that are not one are dropped, and a reply
 * that is no offer at all is undefined. */
export function reportedOffer(value: unknown): BotOffer | undefined {
  if (!isRecord(value) || !Array.isArray(value["tools"]) || !Array.isArray(value["skills"]) || !Array.isArray(value["alwaysOn"])) return undefined;
  const tools = value["tools"].flatMap((tool): BotOffer["tools"] => {
    if (!isRecord(tool) || typeof tool["name"] !== "string" || !tool["name"] || typeof tool["group"] !== "string" || !TOOL_GROUPS.has(tool["group"])) return [];
    return [{
      name: tool["name"].slice(0, 200), label: shortText(tool["label"], 200) || tool["name"].slice(0, 200), description: shortText(tool["description"], 2_000),
      group: tool["group"] as BotToolGroup, source: shortText(tool["source"], 500), powerful: tool["powerful"] === true,
    }];
  });
  const skills = value["skills"].flatMap((skill): BotOffer["skills"] => {
    if (!isRecord(skill) || typeof skill["name"] !== "string" || !skill["name"] || typeof skill["path"] !== "string" || !skill["path"]) return [];
    return [{ name: skill["name"], path: skill["path"], description: shortText(skill["description"], 2_000), source: shortText(skill["source"], 4_096) }];
  });
  const alwaysOn = value["alwaysOn"].flatMap((tool): BotOffer["alwaysOn"] =>
    isRecord(tool) && typeof tool["name"] === "string" && tool["name"] ? [{ name: tool["name"].slice(0, 200), description: shortText(tool["description"], 2_000) }] : []);
  return { tools, skills, alwaysOn, live: value["live"] === true };
}

function storedMessage(value: unknown): BotStoredMessage | undefined {
  if (!isRecord(value) || (value["role"] !== "user" && value["role"] !== "assistant") || typeof value["text"] !== "string") return undefined;
  return { role: value["role"], text: value["text"], ...(typeof value["at"] === "string" ? { at: value["at"] } : {}) };
}

/** What each connected worker last reported about its bots' memories, and which it was asked to report. */
type Reports = { statuses: Map<string, BotMemoryStatus>; watched: Set<string>; queued: Set<string> };

function parseCleanups(value: unknown): BotCleanup[] {
  const list = isRecord(value) && Array.isArray(value["cleanups"]) ? value["cleanups"] : [];
  return list.flatMap((entry): BotCleanup[] => {
    if (!isRecord(entry)) return [];
    const { worker, botId, reference, cwd, at } = entry;
    if (typeof worker !== "string" || !worker || typeof botId !== "string" || !CLEANUP_ID.test(botId) || typeof cwd !== "string") return [];
    return [{ worker, botId, ...(typeof reference === "string" && REFERENCE.test(reference) ? { reference } : {}), cwd, at: typeof at === "string" ? at : "" }];
  });
}

/** The ids a worker's host accepts for a bot (`host-bots.ts`). */
const CLEANUP_ID = /^[A-Za-z0-9_-]{1,100}$/u;

/** The clean-up queue on disk: read and written one change at a time. */
function cleanupQueue(file: string, report: NonNullable<RemoteBotsOptions["report"]>) {
  let chain: Promise<unknown> = Promise.resolve();
  const read = async (): Promise<BotCleanup[]> => {
    try {
      return parseCleanups(JSON.parse(await readFile(file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") report("bot_cleanup_queue_unreadable", "Deleted bots' clean-ups on their workers could not be read", error);
      return [];
    }
  };
  const write = async (list: readonly BotCleanup[]) => {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ version: 1, cleanups: list }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, file);
  };
  return {
    list: read,
    /** One change, after every earlier one; resolves with the new list. */
    update(change: (list: readonly BotCleanup[]) => readonly BotCleanup[]): Promise<readonly BotCleanup[]> {
      const next = chain.then(async () => {
        const before = await read();
        const after = change(before);
        if (after !== before) await write(after);
        return after;
      });
      chain = next.catch(() => {});
      return next;
    },
  };
}

/** The items of a list that are objects with these string fields, with only those fields. */
function stringItems<K extends string>(value: unknown, keys: readonly K[]): Record<K, string>[] {
  return (Array.isArray(value) ? value : []).filter((item): item is Record<K, string> => isRecord(item) && keys.every((key) => typeof item[key] === "string"))
    .map((item) => Object.fromEntries(keys.map((key) => [key, item[key]])) as Record<K, string>);
}

/** A worker's bots' own skills (`skills.ts`), in their homes there: what imports write and exports read. */
export type RemoteBotSkills = {
  skills(id: string): BotSkillFiles;
  /** Whether the connected worker keeps bots' own skills; false while offline or on an older worker. */
  keepsSkills(id: string): boolean;
};

export function remoteBots(workers: BotWorkerLink, options: RemoteBotsOptions): BotWorkers & RemoteBotSkills {
  const name = (id: string) => workers.nameOf(id) ?? "That worker";
  const warn = options.report ?? (() => {});
  const queue = cleanupQueue(options.cleanupFile, warn);
  /** Workers whose queued clean-ups are running, so a quick reconnect does not run them twice. */
  const draining = new Set<string>();
  /** Per worker, for its current connection only: a new one starts over. */
  const reports = new Map<string, Reports>();
  /** Live views of one memory (`BotMemory.subscribe`), kept across reconnects. */
  const listeners = new Map<string, Map<string, Set<(status: BotMemoryStatus) => void>>>();

  const offline = (id: string, creating: boolean) => new BotWorkerOfflineError(creating
    ? `HUI is not connected to ${name(id)}. Connect it in Settings → Workers, then create the bot again.`
    : `${name(id)}, where this bot runs, is offline: HUI is not connected to it. Connect it in Settings → Workers, then try again.`);

  /** One request to the worker's host: refused at once while HUI is not connected, or when the host predates bots (or
   * the `feature` the operation needs). */
  async function request<T>(id: string, op: string, params: Record<string, unknown>, options: { timeoutMs?: number; creating?: boolean; feature?: string } = {}): Promise<T> {
    const creating = options.creating === true;
    const features = workers.features(id);
    if (!features) throw offline(id, creating);
    if (!features.includes(BOTS_FEATURE)) {
      throw new BotConflictError(`${name(id)} runs an older HUI worker that cannot run bots. Disconnect it in Settings → Workers and connect it again once its sessions are idle, so it runs this HUI's worker.`);
    }
    if (options.feature === BOT_ACCESS_FEATURE && !features.includes(BOT_ACCESS_FEATURE)) {
      throw new BotConflictError(`${name(id)} runs an older HUI worker that cannot turn a bot's tools and skills off. Disconnect it in Settings → Workers and connect it again once its sessions are idle, so it runs this HUI's worker.`);
    }
    if (options.feature === BOT_SKILLS_FEATURE && !features.includes(BOT_SKILLS_FEATURE)) {
      throw new BotConflictError(`${name(id)} runs an older HUI worker that cannot keep a bot's own skills. Disconnect it in Settings → Workers and connect it again once its sessions are idle, so it runs this HUI's worker.`);
    }
    try {
      return await workers.hostRequest<T>(id, op, params, options.timeoutMs ?? REQUEST_TIMEOUT_MS);
    } catch (error) {
      // The connection went while the request was out.
      if (error instanceof WorkerOfflineError || !workers.connected(id)) throw offline(id, creating);
      throw error;
    }
  }

  const reportsOf = (id: string): Reports => {
    let own = reports.get(id);
    if (!own) reports.set(id, own = { statuses: new Map(), watched: new Set(), queued: new Set() });
    return own;
  };

  const report = (id: string, reference: string, status: BotMemoryStatus) => {
    if (!workers.connected(id)) return;
    reportsOf(id).statuses.set(reference, status);
    for (const listener of [...listeners.get(id)?.get(reference) ?? []]) listener(status);
  };

  /** Asks the worker to report a memory's status as it changes; every memory a list asks about at once goes in one request. */
  const watch = (id: string, reference: string) => {
    if (!REFERENCE.test(reference) || !(workers.features(id) ?? []).includes(BOTS_FEATURE)) return;
    const own = reportsOf(id);
    if (own.watched.has(reference)) return;
    own.watched.add(reference);
    own.queued.add(reference);
    if (own.queued.size > 1) return;
    setTimeout(() => {
      const references = [...own.queued];
      own.queued.clear();
      // The connection went meanwhile: the next one starts over.
      if (reports.get(id) !== own) return;
      workers.hostRequest(id, "bot.memory.watch", { references }, REQUEST_TIMEOUT_MS).catch(() => {
        for (const reference of references) own.watched.delete(reference);
      });
    }, 0);
  };

  workers.onHostFrame((id, frame) => {
    if (frame.t !== BOT_MEMORY_STATUS_FRAME || typeof frame["reference"] !== "string") return;
    const status = reportedStatus(frame["status"]);
    if (status) report(id, frame["reference"], status);
  });
  /** Who hears of grants made in bots' chats on workers; the service checks that the bot runs there. */
  const accessListeners = new Set<(id: string, botId: string, access: BotAccess) => void>();
  workers.onHostFrame((id, frame) => {
    if (frame.t !== BOT_ACCESS_FRAME || typeof frame["botId"] !== "string" || !CLEANUP_ID.test(frame["botId"]) || !isRecord(frame["access"])) return;
    const access = storedAccess(frame["access"]);
    for (const listener of [...accessListeners]) listener(id, frame["botId"], access);
  });
  // An offline worker reports nothing: its bots show no memory until it is back.
  workers.onClosed((id) => reports.delete(id));
  workers.onConnected((id) => { for (const reference of listeners.get(id)?.keys() ?? []) watch(id, reference); });

  /** A deleted bot's conversation forgotten on its worker, then its home folder (or only SOUL.md) removed there. */
  async function cleanUp(id: string, job: BotCleanup): Promise<void> {
    if (job.reference) await request(id, "bot.forget", { reference: job.reference });
    await request(id, "bot.remove-home", { botId: job.botId, cwd: job.cwd });
  }

  const sameJob = (job: BotCleanup, other: BotCleanup) => job.worker === other.worker && job.botId === other.botId;

  /** At a (re)connection: what deleted bots left there while it was offline. One that fails stays for the next. */
  async function drain(id: string): Promise<void> {
    if (draining.has(id)) return;
    draining.add(id);
    try {
      for (const job of (await queue.list()).filter((entry) => entry.worker === id)) {
        try {
          await cleanUp(id, job);
        } catch (error) {
          // Gone again: the next connection tries again.
          if (!workers.connected(id)) return;
          warn("bot_cleanup_failed", `A deleted bot's memory or home folder on ${name(id)} could not be removed yet; HUI tries again at its next connection`, error);
          continue;
        }
        await queue.update((list) => list.filter((entry) => !sameJob(entry, job)));
      }
    } catch (error) {
      warn("bot_cleanup_failed", `Deleted bots' clean-ups on ${name(id)} could not run`, error);
    } finally {
      draining.delete(id);
    }
  }

  workers.onConnected((id) => void drain(id));
  // A removed worker takes what was waiting for it along.
  workers.onRemoved((id) => {
    void queue.update((list) => list.some((entry) => entry.worker === id) ? list.filter((entry) => entry.worker !== id) : list)
      .catch((error: unknown) => warn("bot_cleanup_queue_unwritable", "Deleted bots' clean-ups for a removed worker could not be dropped", error));
  });
  // A worker removed while this gateway was not running.
  void Promise.all([queue.list(), workers.list()]).then(async ([list, current]) => {
    const known = new Set(current.map((worker) => worker.id));
    if (list.some((entry) => !known.has(entry.worker))) await queue.update((now) => now.filter((entry) => known.has(entry.worker)));
  }).catch(() => {});

  /** A memory read; the worker's own refusal (no memory for that chat there) is the routes' 503. */
  async function text(id: string, op: string, params: { reference: string } & Record<string, unknown>): Promise<string> {
    const reply = await request<{ text?: unknown; unavailable?: unknown; status?: unknown }>(id, op, params);
    if (typeof reply.unavailable === "string") throw new BotMemoryUnavailableError(reply.unavailable);
    if (typeof reply.text !== "string") throw new Error(`${name(id)} sent no memory.`);
    const status = reportedStatus(reply.status);
    if (status) {
      report(id, params.reference, status);
      watch(id, params.reference);
    }
    return reply.text;
  }

  return {
    async find(target) {
      const value = target.trim();
      const list = await workers.list();
      const byId = list.find((worker) => worker.id === value);
      const named = byId ? [byId] : list.filter((worker) => worker.name === value);
      if (named.length === 1) return { id: named[0]!.id, name: named[0]!.name };
      throw new BotInputError(named.length
        ? `${named.length} workers are named ${value}. Use its id: hui workers list --json.`
        : `No worker named ${value}. See Settings → Workers.`);
    },

    nameOf: (id) => workers.nameOf(id),

    conversations(id): RemoteBotConversations {
      return {
        async create(input) {
          const reply = await request<{ reference?: unknown; cwd?: unknown }>(id, "bot.create", { ...input }, { timeoutMs: CREATE_TIMEOUT_MS, creating: true });
          if (typeof reply.reference !== "string" || !REFERENCE.test(reply.reference) || typeof reply.cwd !== "string" || !reply.cwd.startsWith("/")) {
            throw new Error(`${name(id)} did not create the bot's conversation.`);
          }
          return { reference: reply.reference, cwd: reply.cwd };
        },
        async directory(cwd) {
          const reply = await request<{ cwd?: unknown }>(id, "bot.directory", { cwd });
          if (typeof reply.cwd !== "string" || !reply.cwd.startsWith("/")) throw new Error(`${name(id)} did not check the directory.`);
          return reply.cwd;
        },
        async configure(reference, change) {
          await request(id, "bot.configure", { reference, ...change });
        },
        async lastMessage(reference) {
          return storedMessage((await request<{ message?: unknown }>(id, "bot.last-message", { reference }, { timeoutMs: LAST_MESSAGE_TIMEOUT_MS })).message);
        },
        async writeCallRecord(reference, record) {
          await request(id, "bot.call-record", { reference, record });
        },
        async forget(reference) {
          await request(id, "bot.forget", { reference });
        },
        async access(reference) {
          const reply = await request<{ access?: unknown }>(id, "bot.access.read", { reference }, { feature: BOT_ACCESS_FEATURE });
          if (!isRecord(reply.access)) throw new Error(`${name(id)} sent no tool and skill lists.`);
          return storedAccess(reply.access);
        },
        async setAccess(reference, access) {
          await request(id, "bot.access.write", { reference, access }, { feature: BOT_ACCESS_FEATURE });
        },
        // Without a conversation yet, part of creating the bot: an offline worker says so, and the store may open first.
        async offer(reference, cwd, botId) {
          const creating = reference === undefined;
          const reply = await request<{ offer?: unknown }>(id, "bot.offer", {
            ...(reference !== undefined ? { reference } : {}), ...(cwd !== undefined ? { cwd } : {}), ...(botId !== undefined ? { botId } : {}),
          }, { feature: BOT_ACCESS_FEATURE, creating, ...(creating ? { timeoutMs: CREATE_TIMEOUT_MS } : {}) });
          const offer = reportedOffer(reply.offer);
          if (!offer) throw new Error(`${name(id)} sent nothing a bot's tools and skills could be checked against.`);
          return offer;
        },
      };
    },

    skillPath: (id, path) => workers.skillPath(id, path),

    skills(id): BotSkillFiles {
      // An older worker keeps SKILL.md only: an import lists the files it leaves out, and none are sent there.
      const files = (workers.features(id) ?? []).includes(BOT_SKILL_FILES_FEATURE);
      return {
        files,
        async write(botId, skills) {
          await request(id, "bot.skills.write", { botId, skills: files ? skills : skills.map(({ name, text }) => ({ name, text })) }, { feature: BOT_SKILLS_FEATURE });
        },
        async read(botId) {
          const reply = await request<{ skills?: unknown }>(id, "bot.skills.read", { botId }, { feature: BOT_SKILLS_FEATURE });
          return (Array.isArray(reply.skills) ? reply.skills : []).filter((skill): skill is Record<string, unknown> =>
            isRecord(skill) && typeof skill["name"] === "string" && typeof skill["text"] === "string").map((skill): BotOwnSkill => {
            const own = stringItems(skill["files"], ["path", "text"]);
            const skipped = stringItems(skill["skipped"], ["path", "reason"]);
            return { name: skill["name"] as string, text: skill["text"] as string, ...(own.length ? { files: own } : {}), ...(skipped.length ? { skipped } : {}) };
          });
        },
      };
    },

    keepsSkills: (id) => (workers.features(id) ?? []).includes(BOT_SKILLS_FEATURE),

    onAccessRecorded(listener) {
      accessListeners.add(listener);
      return () => accessListeners.delete(listener);
    },

    facts(id): BotFacts {
      const call = async (action: string, params: Record<string, unknown>): Promise<BotFact[]> => {
        if (!workers.features(id)) throw offline(id, false);
        if (!workers.features(id)?.includes(BOT_FACTS_FEATURE)) throw new BotMemoryUnavailableError("Update this bot's worker to use explicit memories.");
        const reply = await request<{ facts?: BotFact[]; error?: string; code?: string }>(id, `bot.facts.${action}`, params);
        if (reply.error) {
          if (reply.code === "conflict") throw new BotConflictError(reply.error);
          if (reply.code === "not-found") throw new BotNotFoundError(reply.error);
          if (reply.code === "input") throw new BotInputError(reply.error);
          throw new BotFactsStoreError(reply.error);
        }
        if (!Array.isArray(reply.facts)) throw new BotMemoryUnavailableError("The worker did not return its explicit memories.");
        return reply.facts;
      };
      return {
        list: (botId) => call("list", { botId }),
        retire: async (botId) => { await call("retire", { botId }); },
        create: (botId, input) => call("create", { botId, input }),
        update: (botId, factId, input) => call("update", { botId, factId, input }),
        delete: (botId, factId, revision) => call("delete", { botId, factId, revision }),
      };
    },

    souls(id): BotSouls {
      const read = async (botId: string) => {
        const reply = await request<{ soul?: unknown }>(id, "bot.soul.read", { botId });
        return typeof reply.soul === "string" && reply.soul ? reply.soul : undefined;
      };
      return {
        async prepare(botId) {
          await request(id, "bot.home.prepare", { botId });
        },
        read,
        exists: async (botId) => (await read(botId)) !== undefined,
        async write(botId, soul) {
          await request(id, "bot.soul.write", { botId, ...(soul ? { soul } : {}) });
        },
        // The whole home: a bot's working directory is never inside a home made at its creation (`cleanUp` passes it).
        async remove(botId) {
          await request(id, "bot.remove-home", { botId });
        },
      };
    },

    async cleanUp(id, bot) {
      const job: BotCleanup = { worker: id, botId: bot.botId, ...(bot.reference ? { reference: bot.reference } : {}), cwd: bot.cwd, at: new Date().toISOString() };
      try {
        await cleanUp(id, job);
        // Done now: an older attempt waiting for this worker is moot.
        await queue.update((list) => list.some((entry) => sameJob(entry, job)) ? list.filter((entry) => !sameJob(entry, job)) : list);
        return "done";
      } catch (error) {
        // Refused with the worker connected (a folder that is not the bot's, say): the delete fails and can run again.
        if (!(error instanceof BotWorkerOfflineError)) throw error;
      }
      await queue.update((list) => [...list.filter((entry) => !sameJob(entry, job)), job]);
      return "queued";
    },

    memory(id): BotMemory {
      return {
        enable: async () => { throw new Error("A worker turns on a bot's memory itself, in the commit that creates its conversation."); },
        disable: async () => { throw new Error("A worker turns off a deleted bot's memory itself, as it forgets its conversation (bot.forget)."); },
        purge: async () => { throw new Error("A worker deletes a deleted bot's memory itself, as it forgets its conversation (bot.forget)."); },
        async configure(reference, settings) {
          await request(id, "bot.memory.configure", { reference, settings });
        },
        // What the worker last reported; the first ask starts its reports and answers nothing yet.
        async status(reference) {
          watch(id, reference);
          return reports.get(id)?.statuses.get(reference);
        },
        view: (reference) => text(id, "bot.memory.view", { reference }),
        zoom: (reference, at, n) => text(id, "bot.memory.zoom", { reference, id: at, n }),
        html: (reference) => text(id, "bot.memory.html", { reference }),
        subscribe(reference, listener) {
          let byReference = listeners.get(id);
          if (!byReference) listeners.set(id, byReference = new Map());
          let set = byReference.get(reference);
          if (!set) byReference.set(reference, set = new Set());
          const own = set;
          own.add(listener);
          watch(id, reference);
          const known = reports.get(id)?.statuses.get(reference);
          if (known) queueMicrotask(() => { if (own.has(listener)) listener(known); });
          return () => {
            own.delete(listener);
            if (!own.size) byReference!.delete(reference);
          };
        },
      };
    },

    onConnected: (listener) => workers.onConnected(listener),
  };
}
