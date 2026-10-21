/**
 * Triggers of the kinds HUI no longer has (GitHub, Sessions, Webhook and Slack; every trigger is a listener's now:
 * SPEC.md, "Listeners are the only triggers"), and the files those kinds left: the GitHub and Slack pollers' positions
 * and HUI's own Slack connection, whose token nothing reads any more. The gateway keeps such triggers aside in
 * `bot-triggers.json`, untouched and not run; `--fix` deletes them, their runs and those files, keeping no copy.
 */
import { rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { TRIGGERS_FILE, triggerStore } from "../server/bots/triggers-store.ts";
import { BotRegistry } from "../server/bots/bots.ts";
import { CONFIG_DIR } from "../server/paths.ts";
import type { DoctorCheck, DoctorItem, DoctorResult } from "./doctor-types.ts";

const ID = "triggers";
const TITLE = "Triggers";
const KINDS: Readonly<Record<string, string>> = { github: "GitHub", session: "Sessions", webhook: "Webhook", slack: "Slack" };
const LEFT = [
  { name: "bot-trigger-cursors.json", label: "GitHub triggers' poll positions" },
  { name: "bot-trigger-slack.json", label: "Slack triggers' poll position" },
  { name: "slack.json", label: "HUI's Slack connection, with its token" },
] as const;

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;
const field = (record: unknown, key: string): unknown => (typeof record === "object" && record !== null ? (record as Record<string, unknown>)[key] : undefined);
const removedKind = (record: unknown): string | undefined => {
  const source = field(record, "source");
  return typeof source === "string" && Object.hasOwn(KINDS, source) ? KINDS[source] : undefined;
};
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

type Item = { id: string; label: string };
/** What is left, and why `bot-triggers.json` couldn't be read when it couldn't. */
type Found = { triggers: Item[]; files: Item[]; unreadable?: string };

async function find(): Promise<Found> {
  const files = (await Promise.all(LEFT.map(async ({ name, label }) => {
    const id = join(CONFIG_DIR, name);
    return await stat(id).then(() => true, () => false) ? [{ id, label: `${label} (${name})` }] : [];
  }))).flat();
  let invalid: unknown[];
  try {
    invalid = (await triggerStore().read()).invalid;
  } catch (error) {
    return { triggers: [], files, unreadable: message(error) };
  }
  const old = invalid.filter(removedKind);
  // The bots only name the triggers' owners: one that can't be read costs the names, never the report.
  const handles = old.length ? new Map((await new BotRegistry().list().catch(() => [])).map((bot) => [bot.id, bot.handle])) : new Map<string, string>();
  const triggers = old.map((record, index) => {
    const [id, name, botId] = [field(record, "id"), field(record, "name"), field(record, "botId")];
    const bot = typeof botId === "string" ? handles.get(botId) : undefined;
    return { id: typeof id === "string" ? id : `record ${index + 1}`, label: `${typeof name === "string" ? `"${name}"` : "A trigger"}, ${removedKind(record)}${bot ? `, of @${bot}` : ""}` };
  });
  return { triggers, files };
}

/** `bot-triggers.json` couldn't be read: the operator fixes or moves it first, as the gateway also asks. */
const unreadableItem = (found: Found): DoctorItem[] => (found.unreadable ? [{ id: TRIGGERS_FILE, label: "bot-triggers.json", status: "blocked", detail: found.unreadable }] : []);

function result(found: Found, items: DoctorItem[], notes: string[]): DoctorResult {
  if (!items.length) return { id: ID, title: TITLE, status: "ok", summary: "nothing left of GitHub, Sessions, Webhook or Slack triggers", items, notes };
  const what = [
    ...(found.triggers.length ? [plural(found.triggers.length, "trigger")] : []),
    ...(found.files.length ? [plural(found.files.length, "file")] : []),
  ].join(" and ");
  const failed = items.filter((item) => item.status === "failed").length;
  const summary = [
    ...(!what ? [] : failed ? [`${plural(failed, "item")} could not be deleted`]
      : items.some((item) => item.status === "fixed") ? [`deleted ${what} left by the kinds HUI no longer has`] : [`${what} left by the kinds HUI no longer has`]),
    ...(found.unreadable ? ["bot-triggers.json can't be read"] : []),
  ].join("; ");
  return { id: ID, title: TITLE, status: items.every((item) => item.status === "fixed") ? "fixed" : "issue", summary, items, notes };
}

export const triggersCheck: DoctorCheck = {
  id: ID,
  title: TITLE,
  async inspect() {
    const found = await find();
    const items = [...found.triggers, ...found.files].map((item): DoctorItem => ({ ...item, status: "issue" }));
    const notes = items.length ? [
      "HUI no longer reads GitHub, sessions, webhooks or Slack for triggers: a listener you run reports to a trigger's URL instead (hui bot trigger add). hui doctor --fix deletes these while the gateway is stopped, keeping no copy.",
      ...(found.files.some((file) => basename(file.id) === "slack.json") ? ["Deleting slack.json doesn't revoke its token: remove HUI's app from your Slack workspace if nothing else uses it."] : []),
    ] : [];
    return result(found, [...items, ...unreadableItem(found)], notes);
  },
  async fix() {
    const found = await find();
    const items: DoctorItem[] = [];
    if (found.triggers.length) {
      const failed = await triggerStore().update((state) => {
        const removed = new Set(state.invalid.filter(removedKind).map((record) => field(record, "id")));
        return {
          value: { ...state, invalid: state.invalid.filter((record) => !removedKind(record)), runs: state.runs.filter((run) => !removed.has(run.triggerId)) },
          result: undefined,
        };
      }).then(() => undefined, message);
      items.push(...found.triggers.map((trigger): DoctorItem => ({ ...trigger, ...(failed ? { status: "failed", detail: failed } : { status: "fixed" }) })));
    }
    for (const file of found.files) {
      const failed = await rm(file.id, { force: true }).then(() => undefined, message);
      items.push({ ...file, ...(failed ? { status: "failed", detail: failed } : { status: "fixed" }) });
    }
    return result(found, [...items, ...unreadableItem(found)], []);
  },
};
