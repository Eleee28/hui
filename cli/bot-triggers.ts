/**
 * `hui bot trigger`: a bot's triggers (HUI-18) from a terminal, through the running gateway's trigger routes, as the
 * Triggers section of the Bots tab uses them: list, add, remove and test. Every trigger is a listener's: `add` prints
 * the URL its listener reports to, this once.
 */
import { BOT_TRIGGER_SOURCE_LABELS, botTriggerFilterSummary, cooldownLabel, type BotTrigger, type BotTriggerCreated, type BotTriggerRun, type BotTriggersList } from "../server/bots/triggers-format.ts";
import type { BotView } from "../server/api/bots.ts";
import type { BotIO } from "./gateway-client.ts";

export type TriggerFlags = {
  json?: boolean;
  name?: string;
  prompt?: string;
  /** `add`: only events whose field equals (`=`) or contains (`~`) a value, that link a pull request, and who else may
   * wake it. */
  match?: string;
  "pr-links"?: boolean;
  "allow-bots"?: boolean;
  "allow-external"?: boolean;
  cooldown?: string;
};

/** `0`, `45s`, `5m`, `2h` or `1d` as seconds. */
export function parseCooldown(value: string): number {
  const match = /^(\d{1,6})(s|m|h|d)?$/u.exec(value.trim());
  if (!match) throw new Error("--cooldown takes 0 or a duration such as 30s, 5m or 1h.");
  return Number(match[1]) * { s: 1, m: 60, h: 3_600, d: 86_400 }[(match[2] ?? "s") as "s" | "m" | "h" | "d"];
}

/** `field=value` (equals) or `field~value` (contains); no field matches the whole body (a listener's: the whole event). */
export function parseMatch(value: string): { field: string; op: "equals" | "contains"; value: string } {
  const match = /^([^=~]*)([=~])(.+)$/u.exec(value);
  if (!match) throw new Error("--match takes field=value (equals) or field~value (contains), such as action=opened.");
  return { field: match[1]!.trim(), op: match[2] === "~" ? "contains" : "equals", value: match[3]! };
}

/** The body of `POST /__hui/bots/:id/triggers` from `add`'s flags; the gateway checks it all again. */
export function triggerBody(flags: TriggerFlags): Record<string, unknown> {
  return {
    name: flags.name,
    ...(flags.prompt !== undefined ? { prompt: flags.prompt } : {}),
    ...(flags.cooldown !== undefined ? { cooldownSeconds: parseCooldown(flags.cooldown) } : {}),
    source: "listener",
    filter: {
      ...(flags.match !== undefined ? { match: parseMatch(flags.match) } : {}),
      ...(flags["pr-links"] ? { prLinks: true } : {}),
      ...(flags["allow-external"] ? { external: true } : {}),
      ...(flags["allow-bots"] ? { bots: true } : {}),
    },
  };
}

/** One trigger per line, with its id's start to name it by. */
export function formatTriggers(bot: Pick<BotView, "handle">, result: BotTriggersList): string {
  if (!result.triggers.length) return `@${bot.handle} has no triggers. Add one with hui bot trigger add ${bot.handle} --name <name>, then give its URL to the listener that reports to it.`;
  return [
    ...result.triggers.map((trigger) => formatTrigger(trigger)),
    `Deliveries in the last hour: ${result.deliveries.lastHour} of ${result.deliveries.perHour}.`,
  ].join("\n");
}

export function formatTrigger(trigger: BotTrigger): string {
  return [
    `${trigger.name} (${trigger.id.slice(0, 8)})`,
    BOT_TRIGGER_SOURCE_LABELS[trigger.source],
    botTriggerFilterSummary(trigger),
    `cooldown ${cooldownLabel(trigger.cooldownSeconds)}`,
    trigger.enabled ? "on" : "off",
    trigger.lastFiredAt ? `last fired ${trigger.lastFiredAt}` : "never fired",
    ...(trigger.pending ? [`${trigger.pending.events} waiting until ${trigger.pending.until}`] : []),
    ...(trigger.watch?.error ? [`${BOT_TRIGGER_SOURCE_LABELS[trigger.source]}: ${trigger.watch.error}`] : []),
  ].join(" · ");
}

/** Runs one `hui bot trigger` action and returns the exit code. */
export async function triggerCommand(base: string, action: string, operands: readonly string[], flags: TriggerFlags, io: BotIO): Promise<number> {
  const print = (value: unknown, text: string) => io.out(`${flags.json ? JSON.stringify(value) : text}\n`);
  // Loaded here, so `hui --help` and the argument checks above don't load the rest of the bot CLI.
  const { findBot, request } = await import("./gateway-client.ts");
  const bot = await findBot(base, operands[0]!);
  const path = `/__hui/bots/${encodeURIComponent(bot.id)}/triggers`;
  const one = (ref: string) => `${path}/${encodeURIComponent(ref)}`;
  switch (action) {
    case "list": {
      const result = await request<BotTriggersList>(base, path);
      print(result, formatTriggers(bot, result));
      return 0;
    }
    case "add": {
      const created = await request<BotTriggerCreated>(base, path, { method: "POST", body: triggerBody(flags), timeoutMs: 30_000 });
      print(created, `Added the trigger ${created.trigger.name} to @${bot.handle} (${botTriggerFilterSummary(created.trigger)}). Its URL, shown this once: your listener POSTs { "events": [...] } to it after every check, from this machine or your tailnet (use the gateway's tailnet name from elsewhere):\n${new URL(created.hook.path, base).href}`);
      return 0;
    }
    case "remove": {
      await request(base, one(operands[1]!), { method: "DELETE" });
      print({ removed: operands[1], bot: bot.handle }, `Removed the trigger ${operands[1]} of @${bot.handle}.`);
      return 0;
    }
    case "test": {
      const { run } = await request<{ run: BotTriggerRun }>(base, `${one(operands[1]!)}/test`, { method: "POST", body: {}, timeoutMs: 90_000 });
      print(run, run.status === "fired" ? `Sent a test event to @${bot.handle}: ${run.summary}.` : `The test did not reach @${bot.handle}: ${run.reason ?? run.status}.`);
      return run.status === "fired" ? 0 : 1;
    }
    default:
      throw new Error("Unknown command. Run hui --help.");
  }
}

/** What `add` would refuse anyway, refused before a request. */
export function checkTriggerAdd(values: Record<string, unknown>): void {
  if (!values["name"]) throw new Error("bot trigger add needs --name.");
  if (values["match"] !== undefined) parseMatch(String(values["match"]));
  if (values["cooldown"] !== undefined) parseCooldown(String(values["cooldown"]));
}
