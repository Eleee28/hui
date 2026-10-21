/**
 * The bot CLI's gateway client: one `/__hui/` request with its refusal error,
 * the bot lookup by id, handle or name, the flags and terminal every `hui bot`
 * and `hui schedule` command takes, and a routine's schedule from those flags.
 */
import type { BotView } from "../server/api/bots.ts";
import type { AutomationSchedule } from "../server/automation.ts";

export type BotFlags = {
  archived?: boolean;
  json?: boolean;
  /** `delete` without asking. */
  yes?: boolean;
  name?: string;
  title?: string;
  /** What it does and when to tag it. */
  description?: string;
  /** Who may tag it: anyone, mention or nobody. */
  tagging?: string;
  "soul-file"?: string;
  file?: string;
  cwd?: string;
  /** `add` only: a remote worker's name or id. */
  worker?: string;
  model?: string;
  thinking?: string;
  "memory-model"?: string;
  "utility-model"?: string;
  emoji?: string;
  shape?: string;
  ears?: string;
  color?: string;
  language?: string;
  "call-voice"?: string;
  wait?: boolean;
  timeout?: string;
  zoom?: string;
  html?: string;
  prompt?: string;
  at?: string;
  every?: string;
  cron?: string;
  timezone?: string;
  /** `tools` and `skills`: comma-separated names to turn on or off. */
  allow?: string;
  deny?: string;
  /** `add`: tools and skills off from its first turn. */
  "deny-tools"?: string;
  "deny-skills"?: string;
  /** `import`: which agent of a file that holds several. */
  agent?: string;
  /** `export`: where to save the zip, a review printed before, the picks for its changes (`c1=keep`) and passages the
   * reviewer missed (`remove:<passage> => <what it becomes>`). */
  out?: string;
  review?: string;
  set?: string[];
  add?: string[];
};

/** The terminal, injectable so `chat` and `send` run against scripted input in tests. */
export type BotIO = {
  out(text: string): void;
  err(text: string): void;
  /** All of stdin, for `send -`, `--soul-file -` and `soul --file -`. */
  readStdin(): Promise<string>;
  /** Lines typed in `chat`; ends with stdin. */
  lines(): AsyncIterable<string>;
  /** Ctrl+C during `chat`; returns an unsubscribe. */
  onInterrupt(listener: () => void): () => void;
  /** A terminal on both ends, which can be asked to confirm. */
  interactive: boolean;
  /** One line typed in answer to `question`. */
  ask(question: string): Promise<string>;
  /** Where relative `--cwd`, `--soul-file`, `--file` and `--html` paths resolve. */
  cwd: string;
  /** `--cron` without `--timezone`. */
  timezone: string;
};

/** A refused request, with the gateway's message. */
export class GatewayError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
  }
}

/** One `/__hui/` request; a refusal throws its message (a few, such as a disallowed Host, are plain text). */
export async function request<T>(base: string, path: string, options: { method?: string; body?: unknown; timeoutMs?: number; html?: boolean } = {}): Promise<T> {
  const response = await fetch(new URL(path, base), {
    method: options.method ?? "GET",
    headers: { "x-hui": "1", ...(options.body === undefined ? {} : { "content-type": "application/json" }) },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    redirect: "error",
  });
  const text = await response.text();
  if (options.html && response.ok) return text as T;
  let reply: T & { error?: string };
  try {
    reply = JSON.parse(text) as T & { error?: string };
  } catch {
    throw new GatewayError(text.trim() || `HUI returned HTTP ${response.status}.`, response.status);
  }
  if (!response.ok) throw new GatewayError(reply.error ?? `HUI returned HTTP ${response.status}.`, response.status);
  return reply;
}

export const bots = async (base: string, archived = false) =>
  (await request<{ bots: BotView[] }>(base, `/__hui/bots${archived ? "?archived=1" : ""}`)).bots;

/** The bot an id, handle (`@` optional) or exact name names, archived ones included; a shared name must be an id or handle. */
export async function findBot(base: string, target: string): Promise<BotView> {
  const all = [...await bots(base), ...await bots(base, true)];
  const byId = all.find((bot) => bot.id === target);
  if (byId) return byId;
  const handle = target.replace(/^@/u, "").toLowerCase();
  const byHandle = all.find((bot) => bot.handle === handle);
  if (byHandle) return byHandle;
  const named = all.filter((bot) => bot.name === target);
  if (named.length === 1) return named[0]!;
  throw new Error(named.length
    ? `${named.length} bots are named ${target}. Use a handle or an id: hui bot list --json.`
    : `No bot named ${target}. See hui bot list.`);
}

/** `30s`, `5m`, `2h` or `1d` in milliseconds. */
export function parseDuration(value: string): number {
  const match = /^(\d{1,9})(s|m|h|d)$/u.exec(value.trim());
  if (!match) throw new Error("--every takes a duration such as 30s, 5m, 2h or 1d.");
  return Number(match[1]) * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "s" | "m" | "h" | "d"];
}

export function routineSchedule(flags: BotFlags, timezone: string): AutomationSchedule {
  if (flags.at !== undefined) {
    const at = Date.parse(flags.at);
    if (!Number.isFinite(at)) throw new Error("--at takes an ISO date and time, such as 2026-10-06T09:00:00+02:00.");
    return { kind: "at", at: new Date(at).toISOString() };
  }
  if (flags.every !== undefined) return { kind: "every", everyMs: parseDuration(flags.every) };
  return { kind: "cron", expression: flags.cron ?? "", timezone: flags.timezone ?? timezone };
}
