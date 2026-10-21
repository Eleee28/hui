/** The `hui` command line: argument parsing, validation and dispatch. Gateway lifecycle and updates run here under
 * the lifecycle lock; worker and bot commands only talk to the running gateway, and the doctor, desktop, update and
 * release logic live in their own modules. */
import { execFileSync, spawn } from "node:child_process";
import { isIP } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { allowedHostsFromEnv, hostName, tailnetFromStatus } from "../server/host.ts";
import { gatewayLogs, gatewayStatus, startGateway, stopGateway } from "./gateway.ts";
import { packageVersion, type Installation } from "./installation.ts";
import { LOG_FILE, withLifecycleLock } from "./state.ts";
import { updateRelease } from "./update.ts";
import { checkNightly, checkRelease } from "./releases.ts";
import { BOT_FACE_COLORS, BOT_FACE_EARS, BOT_FACE_SHAPES, BOT_TAGGING, BOT_THINKING_LEVELS, botFaceColor, botFaceEars, botFaceShape, isBotTagging } from "../server/bots-format.ts";
import { VOICE_LANGUAGE_EXAMPLES, voiceLanguage } from "../server/bots/voice-languages.ts";
import { GPT_LIVE_VOICES, gptLiveVoice } from "../server/calls-format.ts";
import { checkTriggerAdd } from "./bot-triggers.ts";

export const HELP = `Usage:
  hui gateway start [--host <IP|tailnet>] [--port <number>] [--allow-host <name>] [--json]
  hui gateway stop [--force] [--json]
  hui gateway restart [--force] [--host <IP|tailnet>] [--port <number>] [--allow-host <name>] [--json]
  hui gateway status [--json]
  hui gateway logs [--lines <number>]
  hui gateway run [--host <IP|tailnet>] [--port <number>] [--allow-host <name>]
  hui ui [--no-open]
  hui desktop
  hui install-app
  hui update [--check] [--json]
  hui update --nightly [--check] [--json]
  hui update --from <local.tgz> [--sha256 <digest>]
  hui update --rollback
  hui doctor [--fix] [--json]
  hui workers list [--json]
  hui workers add --name <name> --command <connect command> [--extra-path <path>] [--json]
  hui workers edit <name|id> [--name <name>] [--command <connect command>] [--extra-path <path>] [--json]
  hui workers remove <name|id> [--json]
  hui bot list [--archived] [--json]
  hui bot show <bot> [--json]
  hui bot add [--name <name>] [--title <text>] [--description <text>] [--tagging <anyone|mention|nobody>]
              [--soul-file <path|->] [--cwd <dir>]
              [--worker <name|id>] [--model <provider/model>] [--thinking <level>] [--utility-model <provider/model>] [--emoji <e>]
              [--shape <shape>] [--ears <cat|bear|bunny|antenna|sprout|horns>] [--color <name|#rrggbb>]
              [--language <code>] [--call-voice <cove|arbor|breeze|ember|juniper|maple|sol|spruce|vale>]
              [--deny-tools <a,b>] [--deny-skills <a,b>] [--json]
  hui bot edit <bot> [same flags as add but --soul-file, --worker and --deny-*] [--json]
  hui bot import <file|folder|url|-> [--worker <name|id>] [--agent <name>] [--yes] [--json]
  hui bot export <bot> [--out <file>] [--review <id> --set <change>=<group>...] [--add <group>:<passage>[ => <becomes>]...] [--yes] [--json]
  hui bot soul <bot> [--file <path|->] [--json]
  hui bot tools <bot> [--allow <a,b>] [--deny <a,b>] [--json]
  hui bot skills <bot> [--allow <a,b>] [--deny <a,b>] [--json]
  hui bot remove <bot> [--json]
  hui bot restore <bot> [--json]
  hui bot delete <bot> [--yes] [--json]
  hui bot chat <bot>
  hui bot send <bot> <message|-> [--wait] [--timeout <seconds>] [--json]
  hui bot stop <bot> [--json]
  hui bot memory <bot> [--zoom <id+n>] [--html <file>] [--json]
  hui bot routine list <bot> [--json]
  hui bot routine add <bot> --name <name> --prompt <text> (--at <ISO time> | --every <duration> | --cron <expr>
              [--timezone <tz>]) [--json]
  hui bot routine run <bot> <routine>
  hui bot routine remove <bot> <routine> [--json]
  hui bot trigger list <bot> [--json]
  hui bot trigger add <bot> --name <name> [--match <field=value|field~value>] [--pr-links] [--allow-bots]
              [--allow-external] [--prompt <text>] [--cooldown <0|30s|5m|1h>] [--json]
  hui bot trigger remove <bot> <trigger> [--json]
  hui bot trigger test <bot> <trigger> [--json]
  hui schedule list [--bot <bot> | --session <session>] [--json]
  hui schedule show <schedule> [--json]
  hui schedule add --name <name> --prompt <text> (--at <ISO time> | --every <duration> | --cron <expr> [--timezone <tz>])
              (--bot <bot> | --session <session>) [--description <text>] [--timeout <seconds>]
              [--until <ISO time>] [--runs <n>] [--disabled] [--json]
  hui schedule edit <schedule> [same flags as add] [--json]
  hui schedule pause|resume|run|remove <schedule> [--json]
  hui --version

HUI_GATEWAY_HOST and HUI_GATEWAY_PORT configure defaults; CLI flags override them.
A reverse proxy needs its Host name allowed: --allow-host <name>, repeatable,
which is remembered with the binding. HUI_GATEWAY_ALLOWED_HOSTS takes a
comma-separated list instead, for a gateway started by something you do not edit.
The gateway binds 127.0.0.1:4173 by default. No login is provided; prefer Tailscale.
Stop/restart refuse work a restart would interrupt unless --force explicitly does so;
Pi Durable sessions keep running and resume when the gateway is back.
Updates use public GitHub Releases, and never edit a source checkout or PI data.
--nightly installs the build of the latest validated main commit instead of the
latest stable release; a plain hui update returns to stable once one is newer.
Doctor reports state an upgraded HUI needs changed, such as sessions still on PI;
--fix changes it while the gateway is stopped. It exits 1 while anything remains.
Gateway without a subcommand is an alias for foreground run.
Workers are the remote machines of Settings → Workers, managed through the
running gateway. A new worker connects at once; --extra-path is repeatable and
on edit replaces the list. Edit changes only the fields given; a new command
applies the next time the worker connects.
Bots are named agents with one forever chat each, managed through the running
gateway like the Bots tab; "bots" works as "bot". <bot> is an id, a handle or
an exact name. A new bot starts by asking what you expect from it (talk with
hui bot chat <handle>), then writes its persona, SOUL.md, itself; --soul-file
gives it one instead (- reads stdin) and skips that first conversation. Without
--name it is "New Bot" and first asks what to call it. Agents and bots tag a
bot (@handle) to hand it work, as they load a skill: --description says what it
does and when to tag it (its title stands in without one; "" clears it on edit),
and --tagging who may: anyone, the default, whenever a task fits; mention, only
when your message names @handle; nobody, never. Soul prints SOUL.md;
--file replaces it, and an empty file removes it so the bot asks again.
--worker runs a new bot on a remote worker of Settings → Workers, by name or id,
which HUI must be connected to: its chat, memory, folder and SOUL.md live there,
--cwd is then a folder there (absolute or ~/), and it never moves. Bots on a
worker can't use terminals, the browser or watchers, which stay on this machine.
A bot has every tool and skill a session in its directory has, new ones
included, until you turn some off: tools lists them grouped, each on or off,
and --deny turns tools off, --allow back on (comma-separated names); skills
does the same for its skills. They apply from its next turn. On add,
--deny-tools and --deny-skills turn some off from its first turn (the tools
every chat has; an extension's tools once the bot exists). A bot can ask you to
turn something back on; answer in hui bot chat. Tools are the boundary, not a
sandbox: with bash or read a bot reaches whatever your account can.
On edit, --model "" and --thinking "" go back to the model and
thinking level a new chat gets. --model is the bot's main model (the smartest you
have; speed does not matter); --utility-model the fastest, ideally cheap, for its
memory summaries, quick answers on calls and call summaries (--memory-model is
the same flag); "" goes back to Settings' utility model, then the bot's own.
A bot shows an animated face, or its --emoji while it has one: --emoji "" switches
it to its face. --shape is blob, round (or pebble), triangle, heart, cookie, star,
flower, cloud, drop, ghost, pill, block or hexagon; --ears puts cat, bear or bunny
ears, an antenna, a sprout or horns on top ("" takes them off); --color is one of
blue, yellow, magenta, mint, coral, lilac or any #rrggbb. Without a shape or
color a bot's face is picked by its id, the same everywhere; on edit "" goes back
to that one.
--call-voice is the bot's GPT-Live voice on calls (Settings → Models → Calls);
"" goes back to the default voice Settings chose. --language is the language it
speaks on calls, a Whisper code (en, es, fr, de, ja, zh, haw, yue…); nothing is
translated, and "" goes back to Auto (it answers in the language you speak).
Import makes a bot from another platform's template: a Grok Bot marketplace link,
an OpenClaw workspace (folder or zip), a Claude Code subagent (.md), a Letta
agent file (.af), a character card (JSON or PNG), a CrewAI agents.yaml, a HUI
export, or a persona as text (- reads stdin). It prints everything the bot would
get first (imported text is untrusted) and asks before creating it; --yes skips
that. --agent picks one agent of a file that holds several. An import turns
nothing on beyond a new bot's defaults: its routines start disabled and a
subagent's tools list only turns tools off. Export makes the bot a template
someone else can import: HUI cleans out your name, paths, addresses and keys,
Settings' utility model sorts the rest into removed, asked (the new owner gives
theirs), confirmed (they agree to it first) and kept, and it prints that review
and asks before saving <name>.hui-bot.zip (--yes saves it as reviewed). Its
memory never leaves. --review <id> --set c1=keep saves a printed review with
other picks; a script is kept, confirmed or removed whole. --add adds a passage
the reviewer missed, copied from its text: remove:<passage> => <what it becomes>,
ask:<passage> => <what the new owner gives>, or confirm:<passage> (a passage
can't hold " => "). It never replaces a file without --yes.
Remove archives: the chat transcript and memory are kept and its routines are
disabled. Delete removes a bot for good, active or archived: its turn stops, its
chat leaves HUI, and its routines, memory and folder (SOUL.md and every file in
it) go; a workspace you chose stays. It asks first; --yes skips that, and is
needed where it cannot ask (no terminal). Chat streams the replies as plain
text and sends what you
type (steering a turn that runs); messages from elsewhere (routines, other
bots, the Bots tab) show as > lines. Ctrl+C stops a turn, twice exits. Send -
reads the message from stdin; with --wait it prints the reply and exits 0, 1 on
failure or timeout, 2 while the bot waits for an answer (give it in chat).
Routines are Automation tasks aimed at the bot's chat. --every takes 30s, 5m,
2h or 1d (Automation allows one minute at least); --cron uses this machine's
time zone unless --timezone names another.
Triggers wake a bot when a program you run (a listener) reports something, as
[trigger: <name> · <summary>] <prompt> in its chat. add makes the trigger's
URL, shown once: the listener watches what HUI doesn't read itself (a Slack, a
Jira board) and, after every check, POSTs { "events": [{ "id", "summary", ...
}] } to it from this machine or the tailnet. Each event wakes the bot once, an
empty list only says the listener is alive, and the trigger says when it last
reported. --match keeps only events whose field (fields.channel, summary)
equals, or with ~ contains, a value, --pr-links those linking a GitHub pull
request (read into the delivery through the gateway's gh, so a bot can review
without a shell), and events it marks as from bots or from outside your
organization wake it only with --allow-bots and --allow-external. Events
within --cooldown (default 5m) of the last delivery arrive together. <trigger>
is a name or id; test sends a sample event now.
Schedules are every Automation task: a prompt HUI sends a session, or a bot's
chat (its routines), on a schedule, as on the Automations page; "schedules"
works as "schedule". <schedule> is an id or an exact name, <session> a
session's id or exact title. Edit changes only the flags given: --bot or
--session moves it there, --disabled pauses it. A temporary schedule ends by
itself: --until at that time, --runs after that many runs (1-1000; a skipped
run doesn't count), and HUI deletes it after either; on edit --until "" and
--runs "" clear them. --timeout is how long one run may take (10-86400
seconds, default 900). A bot can schedule its own routines too, with its
routines tool, which shows as made by @bot.
`;

export function parseCli(args: string[], env: NodeJS.ProcessEnv = process.env) {
  const options = {
    help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" }, json: { type: "boolean" },
    force: { type: "boolean" }, host: { type: "string" }, port: { type: "string" }, lines: { type: "string" },
    "allow-host": { type: "string", multiple: true },
    "no-open": { type: "boolean" }, from: { type: "string" }, sha256: { type: "string" }, rollback: { type: "boolean" },
    check: { type: "boolean" }, fix: { type: "boolean" }, nightly: { type: "boolean" },
    name: { type: "string" }, command: { type: "string" }, "extra-path": { type: "string", multiple: true },
    archived: { type: "boolean" }, title: { type: "string" }, "soul-file": { type: "string" }, file: { type: "string" }, yes: { type: "boolean", short: "y" },
    cwd: { type: "string" }, worker: { type: "string" }, model: { type: "string" }, thinking: { type: "string" }, "memory-model": { type: "string" }, "utility-model": { type: "string" },
    emoji: { type: "string" }, shape: { type: "string" }, ears: { type: "string" }, color: { type: "string" }, voice: { type: "string" }, "voice-speed": { type: "string" }, language: { type: "string" }, "call-voice": { type: "string" }, wait: { type: "boolean" }, timeout: { type: "string" }, zoom: { type: "string" }, html: { type: "string" },
    tagging: { type: "string" },
    prompt: { type: "string" }, at: { type: "string" }, every: { type: "string" }, cron: { type: "string" }, timezone: { type: "string" },
    allow: { type: "string" }, deny: { type: "string" }, "deny-tools": { type: "string" }, "deny-skills": { type: "string" },
    bot: { type: "string" }, session: { type: "string" }, description: { type: "string" }, until: { type: "string" }, runs: { type: "string" }, disabled: { type: "boolean" },
    match: { type: "string" }, cooldown: { type: "string" },
    "pr-links": { type: "boolean" }, "allow-bots": { type: "boolean" }, "allow-external": { type: "boolean" },
    agent: { type: "string" }, out: { type: "string" }, review: { type: "string" }, set: { type: "string", multiple: true }, add: { type: "string", multiple: true }, memory: { type: "boolean" },
  } as const;
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options });
  if (values.help || !args.length) return { command: "help", values };
  if (values.version) return { command: "version", values };
  // VoiceStudio is gone (2026-10-06): its flags say what took their place instead of failing as unknown options.
  if (values.voice !== undefined) throw new Error(`--voice is gone: HUI no longer uses VoiceStudio. A bot speaks on calls with one of GPT-Live's voices: --call-voice <${GPT_LIVE_VOICES.join("|")}>.`);
  if (values["voice-speed"] !== undefined) throw new Error("--voice-speed is gone: HUI no longer uses VoiceStudio, and GPT-Live sets the pace of its own voices.");
  // Exports became templates reviewed for personal information (2026-10-16): a bot's memory never leaves.
  if (values.memory !== undefined) throw new Error("--memory is gone: hui bot export makes a template someone else can import, reviewed for personal information, and a bot's memory never leaves.");
  const [first, second, ...extra] = positionals;
  const bots = first === "bot" || first === "bots";
  const schedules = first === "schedule" || first === "schedules";
  const routine = bots && (second === "routine" || second === "routines");
  const trigger = bots && (second === "trigger" || second === "triggers");
  const command = bots ? (routine ? `bot routine ${extra.shift() ?? "list"}` : trigger ? `bot trigger ${extra.shift() ?? "list"}` : `bot ${second ?? "list"}`)
    : schedules ? `schedule ${second ?? "list"}`
    : first === "gateway" ? `gateway ${second ?? "run"}` : first === "workers" ? `workers ${second ?? "list"}` : first;
  // `workers edit` and `workers remove` name the worker they act on.
  const target = command === "workers edit" || command === "workers remove" ? extra.shift() : undefined;
  // A bot command's operands: the bot, then a message or a routine; a schedule command's, the schedule.
  const operands = bots || schedules ? extra.splice(0) : [];
  const allowed: Record<string, string[]> = {
    "gateway start": ["host", "port", "json", "allow-host"], "gateway run": ["host", "port", "allow-host"],
    "gateway stop": ["force", "json"], "gateway restart": ["host", "port", "force", "json", "allow-host"],
    "gateway status": ["json"], "gateway logs": ["lines"], ui: ["no-open"], browser: ["no-open"],
    update: ["from", "sha256", "rollback", "check", "json", "nightly"], desktop: [], "install-app": [],
    doctor: ["fix", "json"], "workers list": ["json"], "workers add": ["name", "command", "extra-path", "json"],
    "workers edit": ["name", "command", "extra-path", "json"], "workers remove": ["json"],
    "bot list": ["archived", "json"], "bot show": ["json"], "bot add": [...BOT_FIELDS, "soul-file", "worker", "deny-tools", "deny-skills", "json"], "bot edit": [...BOT_FIELDS, "json"],
    "bot soul": ["file", "json"], "bot tools": ["allow", "deny", "json"], "bot skills": ["allow", "deny", "json"],
    "bot import": ["worker", "agent", "yes", "json"], "bot export": ["out", "review", "set", "add", "yes", "json"],
    "bot remove": ["json"], "bot restore": ["json"], "bot delete": ["yes", "json"], "bot chat": [], "bot send": ["wait", "timeout", "json"], "bot stop": ["json"],
    "bot memory": ["zoom", "html", "json"], "bot routine list": ["json"],
    "bot routine add": ["name", "prompt", "at", "every", "cron", "timezone", "json"], "bot routine run": [], "bot routine remove": ["json"],
    "bot trigger list": ["json"], "bot trigger remove": ["json"], "bot trigger test": ["json"],
    "bot trigger add": ["name", "prompt", "match", "cooldown", "pr-links", "allow-bots", "allow-external", "json"],
    "schedule list": ["bot", "session", "json"], "schedule show": ["json"], "schedule add": [...SCHEDULE_FIELDS, "json"], "schedule edit": [...SCHEDULE_FIELDS, "json"],
    "schedule pause": ["json"], "schedule resume": ["json"], "schedule run": ["json"], "schedule remove": ["json"],
  };
  if (!command || !allowed[command] || extra.length || first !== "gateway" && first !== "workers" && !bots && !schedules && second) throw new Error("Unknown command. Run hui --help.");
  // Where a bot runs is chosen once; an edit cannot move it.
  if (command === "bot edit" && values.worker !== undefined) throw new Error("A bot stays on the machine it was created on: --worker only applies to bot add.");
  if (command === "bot edit" && values["soul-file"] !== undefined) throw new Error("bot edit does not change SOUL.md: use hui bot soul <bot> --file <path|->.");
  for (const flag of Object.keys(values)) if (!allowed[command]!.includes(flag)) throw new Error(`--${flag} is not valid for ${command}.`);
  if (bots) checkBotCommand(command, operands, values);
  if (schedules) checkScheduleCommand(command, operands, values);
  if (["gateway start", "gateway run", "gateway restart"].includes(command)) {
    values.host ??= env["HUI_GATEWAY_HOST"];
    values.port ??= env["HUI_GATEWAY_PORT"];
  }
  if (values.port !== undefined && (!/^\d+$/u.test(values.port) || Number(values.port) > 65535)) throw new Error("--port must be between 0 and 65535.");
  if (values["allow-host"]) values["allow-host"] = values["allow-host"].map((name) => hostName(name, "--allow-host"));
  if (values.lines !== undefined && (!/^\d+$/u.test(values.lines) || Number(values.lines) < 1 || Number(values.lines) > 1000)) throw new Error("--lines must be between 1 and 1000.");
  if (values.rollback && (values.from || values.sha256) || values.sha256 && !values.from) throw new Error("Use either --from [--sha256] or --rollback.");
  if (values.sha256 && !/^[a-fA-F0-9]{64}$/u.test(values.sha256)) throw new Error("--sha256 must be a 64-character hexadecimal digest.");
  if (values.check && (values.from || values.sha256 || values.rollback)) throw new Error("--check cannot be combined with --from, --sha256 or --rollback.");
  if (values.nightly && (values.from || values.sha256 || values.rollback)) throw new Error("--nightly cannot be combined with --from, --sha256 or --rollback.");
  if (command === "workers add" && (!values.name || !values.command)) throw new Error("workers add needs --name and --command.");
  if ((command === "workers edit" || command === "workers remove") && !target) throw new Error(`${command} needs the worker's name or id.`);
  if (command === "workers edit" && values.name === undefined && values.command === undefined && !values["extra-path"]) throw new Error("workers edit needs --name, --command or --extra-path.");
  return { command, values, ...(target ? { target } : {}), ...(bots || schedules ? { operands } : {}) };
}

/** The flags `schedule add` and `schedule edit` share. */
const SCHEDULE_FIELDS = ["name", "prompt", "description", "at", "every", "cron", "timezone", "bot", "session", "timeout", "until", "runs", "disabled"];
const ISO_HINT = "an ISO date and time, such as 2026-10-06T09:00:00+02:00";

/** What the gateway would refuse anyway, refused before a request. */
function checkScheduleCommand(command: string, operands: readonly string[], values: Record<string, string | boolean | string[] | undefined>): void {
  const takes = command === "schedule list" || command === "schedule add" ? 0 : 1;
  if (operands.length !== takes) throw new Error(takes ? `${command} needs <schedule>: its id or exact name (hui schedule list).` : `${command} takes no operands.`);
  const given = (flag: string) => values[flag] !== undefined;
  const text = (flag: string) => String(values[flag] ?? "");
  if (given("bot") && given("session")) throw new Error("Use either --bot or --session.");
  for (const flag of ["bot", "session", "name", "prompt"]) if (given(flag) && !text(flag).trim()) throw new Error(`--${flag} can't be empty.`);
  const schedules = ["at", "every", "cron"].filter(given);
  if (schedules.length > 1) throw new Error("Use one of --at, --every or --cron.");
  if (given("every") && !/^\d{1,9}(s|m|h|d)$/u.test(text("every"))) throw new Error("--every takes a duration such as 30s, 5m, 2h or 1d.");
  if (given("at") && !Number.isFinite(Date.parse(text("at")))) throw new Error(`--at takes ${ISO_HINT}.`);
  const edit = command === "schedule edit";
  // On edit "" clears a limit; anything else must be one.
  if (given("until") && !(edit && !text("until").trim()) && !Number.isFinite(Date.parse(text("until")))) throw new Error(`--until takes ${ISO_HINT}${edit ? `; "" clears it` : ""}.`);
  if (given("runs") && !(edit && !text("runs").trim()) && (!/^\d{1,4}$/u.test(text("runs")) || Number(text("runs")) < 1 || Number(text("runs")) > 1000)) {
    throw new Error(`--runs takes 1-1000 runs${edit ? `; "" clears it` : ""}.`);
  }
  if (given("timeout") && (!/^\d{1,5}$/u.test(text("timeout")) || Number(text("timeout")) < 10 || Number(text("timeout")) > 86_400)) throw new Error("--timeout takes 10-86400 seconds.");
  if (command === "schedule add") {
    if (!given("name") || !given("prompt")) throw new Error("schedule add needs --name and --prompt.");
    if (schedules.length !== 1) throw new Error("schedule add needs one of --at, --every or --cron.");
    if (!given("bot") && !given("session")) throw new Error("schedule add needs --bot <bot> or --session <session>: where it sends its prompt.");
    if (given("timezone") && !given("cron")) throw new Error("--timezone only applies to --cron.");
  }
  if (edit) {
    if (!SCHEDULE_FIELDS.some(given)) throw new Error(`schedule edit needs at least one of ${SCHEDULE_FIELDS.map((flag) => `--${flag}`).join(", ")}.`);
    if (given("timezone") && schedules.length && !given("cron")) throw new Error("--timezone only applies to --cron.");
  }
}

/** The flags `bot add` and `bot edit` share. */
const BOT_FIELDS = ["name", "title", "description", "tagging", "cwd", "model", "thinking", "memory-model", "utility-model", "emoji", "shape", "ears", "color", "language", "call-voice"];
/** Operands each bot command takes, in order. */
const BOT_OPERANDS: Record<string, readonly string[]> = {
  "bot list": [], "bot add": [], "bot show": ["bot"], "bot edit": ["bot"], "bot soul": ["bot"], "bot tools": ["bot"], "bot skills": ["bot"],
  "bot import": ["source"], "bot export": ["bot"],
  "bot remove": ["bot"], "bot restore": ["bot"], "bot delete": ["bot"],
  "bot chat": ["bot"], "bot send": ["bot", "message"], "bot stop": ["bot"], "bot memory": ["bot"],
  "bot routine list": ["bot"], "bot routine add": ["bot"], "bot routine run": ["bot", "routine"], "bot routine remove": ["bot", "routine"],
  "bot trigger list": ["bot"], "bot trigger add": ["bot"], "bot trigger remove": ["bot", "trigger"], "bot trigger test": ["bot", "trigger"],
};
const MODEL_REF = /^[^/\s]+\/\S+$/u;

/** What the gateway would refuse anyway, refused before a request. */
function checkBotCommand(command: string, operands: readonly string[], values: Record<string, string | boolean | string[] | undefined>): void {
  const expected = BOT_OPERANDS[command] ?? [];
  if (operands.length !== expected.length) {
    if (command === "bot send" && operands.length > 2) throw new Error("bot send takes the bot and one message: quote the message, or pass - to read it from stdin.");
    throw new Error(expected.length ? `${command} needs ${expected.map((name) => `<${name}>`).join(" ")}.` : `${command} takes no operands.`);
  }
  const given = (flag: string) => values[flag] !== undefined;
  if (given("worker") && !String(values["worker"]).trim()) throw new Error("--worker needs a worker's name or id: see hui workers list.");
  // A folder on a worker is never relative to where this command runs.
  if (given("worker") && given("cwd") && !/^(?:\/|~(?:\/|$))/u.test(String(values["cwd"]).trim())) throw new Error("With --worker, --cwd is a folder on the worker: absolute or ~/….");
  if (command === "bot edit" && !BOT_FIELDS.some(given)) throw new Error(`bot edit needs at least one of ${BOT_FIELDS.map((flag) => `--${flag}`).join(", ")}.`);
  // `""` clears a choice: the gateway's default for the chat, Settings' utility model, Auto for the language,
  // Settings' call voice.
  const cleared = (flag: string) => values[flag] === "";
  if (given("thinking") && !cleared("thinking") && !(BOT_THINKING_LEVELS as readonly string[]).includes(String(values["thinking"]))) throw new Error(`--thinking must be one of: ${BOT_THINKING_LEVELS.join(", ")}.`);
  for (const flag of ["model", "memory-model", "utility-model"]) if (given(flag) && !cleared(flag) && !MODEL_REF.test(String(values[flag]))) throw new Error(`--${flag} must be provider/model.`);
  if (given("memory-model") && given("utility-model")) throw new Error("Use either --utility-model or --memory-model: they are the same.");
  if (given("shape") && !cleared("shape") && !botFaceShape(String(values["shape"]))) {
    throw new Error(`--shape must be one of: ${BOT_FACE_SHAPES.join(", ")}; "" goes back to the one its id picks.`);
  }
  if (given("ears") && !cleared("ears") && !botFaceEars(String(values["ears"]))) {
    throw new Error(`--ears must be one of: ${BOT_FACE_EARS.join(", ")}; "" takes them off.`);
  }
  if (given("color") && !cleared("color") && !botFaceColor(String(values["color"])) && !/^#[0-9a-f]{6}$/iu.test(String(values["color"]).trim())) {
    throw new Error(`--color must be one of ${BOT_FACE_COLORS.map((color) => color.id).join(", ")} or #rrggbb; "" goes back to the one its id picks.`);
  }
  if (given("language") && !cleared("language") && !voiceLanguage(values["language"])) {
    throw new Error(`--language must be one of Whisper's language codes, such as ${VOICE_LANGUAGE_EXAMPLES} (not a name like Spanish); "" goes back to Auto.`);
  }
  if (given("call-voice") && !cleared("call-voice") && !gptLiveVoice(values["call-voice"])) {
    throw new Error(`--call-voice must be one of GPT-Live's voices: ${GPT_LIVE_VOICES.join(", ")}; "" goes back to Settings' default.`);
  }
  if (given("tagging") && !isBotTagging(String(values["tagging"]).trim().toLowerCase())) throw new Error(`--tagging must be one of: ${BOT_TAGGING.join(", ")}.`);
  if (given("timeout") && (!values["wait"] || !/^\d+$/u.test(String(values["timeout"])) || Number(values["timeout"]) < 1 || Number(values["timeout"]) > 3600)) {
    throw new Error("--timeout needs --wait and 1-3600 seconds.");
  }
  // Comma-separated names; one name may not be turned on and off at once.
  const listed = (flag: string) => String(values[flag] ?? "").split(",").map((name) => name.trim()).filter(Boolean);
  for (const flag of ["allow", "deny", "deny-tools", "deny-skills"]) if (given(flag) && !listed(flag).length) throw new Error(`--${flag} needs comma-separated names.`);
  const both = listed("allow").filter((name) => listed("deny").includes(name));
  if (both.length) throw new Error(`${both.join(", ")} can't be both allowed and denied.`);
  if (given("zoom") && given("html")) throw new Error("Use either --zoom or --html.");
  if (given("agent") && !String(values["agent"]).trim()) throw new Error("--agent needs an agent's name, as hui bot import lists them.");
  if (given("out") && !String(values["out"]).trim()) throw new Error("--out needs a file name.");
  if (given("zoom") && !/^\d{1,15}\+\d{1,15}$/u.test(String(values["zoom"]))) throw new Error("--zoom takes a view line's id+n, such as 2184+8.");
  if (command === "bot trigger add") checkTriggerAdd(values);
  if (command === "bot routine add") {
    if (!values["name"] || !values["prompt"]) throw new Error("bot routine add needs --name and --prompt.");
    if (["at", "every", "cron"].filter(given).length !== 1) throw new Error("bot routine add needs exactly one of --at, --every or --cron.");
    if (given("timezone") && !given("cron")) throw new Error("--timezone only applies to --cron.");
    if (given("every") && !/^\d{1,9}(s|m|h|d)$/u.test(String(values["every"]))) throw new Error("--every takes a duration such as 30s, 5m, 2h or 1d.");
    if (given("at") && !Number.isFinite(Date.parse(String(values["at"])))) throw new Error("--at takes an ISO date and time, such as 2026-10-06T09:00:00+02:00.");
  }
}

export function binding(host = "127.0.0.1"): { host: string; allowedHosts: string[] } {
  if (host === "tailnet") {
    const result = tailnetFromStatus(execFileSync("tailscale", ["status", "--json"], { encoding: "utf8", timeout: 5_000 }));
    if (!result) throw new Error("Tailscale did not report an address. Is tailscale up?");
    return { host: result.host, allowedHosts: [...result.allowedHosts ?? []] };
  }
  if (host === "localhost") host = "127.0.0.1";
  if (!isIP(host) || host === "0.0.0.0" || host === "::") throw new Error("--host needs a specific IP address or tailnet, not a wildcard.");
  return { host, allowedHosts: [] };
}

export async function main(args: string[], installation: Installation): Promise<void> {
  const { command, values, target, operands } = parseCli(args);
  if (command === "help") { process.stdout.write(HELP); return; }
  if (command === "version") { console.log(await packageVersion(installation.packageRoot)); return; }
  if (command === "desktop" || command === "install-app") {
    const module = await import(pathToFileURL(join(installation.packageRoot, "desktop", command === "desktop" ? "launch.mjs" : "install.mjs")).href);
    if (command === "desktop") await module.launchDesktop(installation.installationRoot);
    else await module.installApp(installation.installationRoot);
    return;
  }
  // Read before any gateway is stopped, so a bad list cannot cost a running one.
  const extraAllowedHosts = [...allowedHostsFromEnv(), ...(values["allow-host"] ?? [])];
  const requestedBinding = values.host !== undefined ? binding(values.host) : undefined;
  const report = (result: unknown) => console.log(values.json ? JSON.stringify(result) : typeof result === "object" ? JSON.stringify(result, null, 2) : result);
  if (command === "update" && values.check) { report(await (values.nightly ? checkNightly : checkRelease)(installation)); return; }
  if (command === "doctor") {
    const { formatDoctorReport, runDoctor } = await import("./doctor.ts");
    const result = await runDoctor({ fix: values.fix === true });
    console.log(values.json ? JSON.stringify(result) : formatDoctorReport(result));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command.startsWith("workers ")) {
    const status = await gatewayStatus();
    if (status.status !== "running" || !status.url) throw new Error("Gateway is not running. Start it with hui gateway start.");
    const { formatWorkers, workersCommand } = await import("./workers.ts");
    const action = command.slice("workers ".length);
    const result = await workersCommand(status.url, action, target, values);
    if (action === "list" && !values.json) console.log(formatWorkers(result as Parameters<typeof formatWorkers>[0])); else report(result);
    return;
  }
  if (command.startsWith("bot trigger ")) {
    const status = await gatewayStatus();
    if (status.status !== "running" || !status.url) throw new Error("Gateway is not running. Start it with hui gateway start.");
    const [{ terminalBotIO }, { triggerCommand }] = await Promise.all([import("./bots.ts"), import("./bot-triggers.ts")]);
    process.exitCode = await triggerCommand(status.url, command.slice("bot trigger ".length), operands ?? [], values, terminalBotIO());
    return;
  }
  if (command.startsWith("bot ")) {
    const status = await gatewayStatus();
    if (status.status !== "running" || !status.url) throw new Error("Gateway is not running. Start it with hui gateway start.");
    const { botCommand, terminalBotIO } = await import("./bots.ts");
    process.exitCode = await botCommand(status.url, command.slice("bot ".length), operands ?? [], values, terminalBotIO());
    return;
  }
  if (command.startsWith("schedule ")) {
    const status = await gatewayStatus();
    if (status.status !== "running" || !status.url) throw new Error("Gateway is not running. Start it with hui gateway start.");
    const [{ scheduleCommand }, { terminalBotIO }] = await Promise.all([import("./schedules.ts"), import("./bots.ts")]);
    process.exitCode = await scheduleCommand(status.url, command.slice("schedule ".length), operands ?? [], values, terminalBotIO());
    return;
  }
  if (command === "gateway status") { const status = await gatewayStatus(); report(status); if (status.status === "unresponsive") process.exitCode = 1; return; }
  if (command === "gateway logs") { process.stdout.write(await gatewayLogs(Number(values.lines ?? 100))); return; }
  if (command === "ui" || command === "browser") {
    const status = await gatewayStatus();
    if (status.status !== "running" || !status.url) throw new Error("Gateway is not running. Start it with hui gateway start.");
    console.log(status.url);
    const headless = process.platform === "linux" && !process.env["DISPLAY"] && !process.env["WAYLAND_DISPLAY"];
    if (values["no-open"] || headless) return;
    const executable = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const child = spawn(executable, process.platform === "win32" ? ["/c", "start", "", status.url] : [status.url], { detached: true, stdio: "ignore" });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); }); child.unref();
    return;
  }
  await withLifecycleLock(async () => {
    if (command === "update") { report(await updateRelease(installation, values)); return; }
    if (command === "gateway stop") { await stopGateway(values.force); report({ status: "stopped" }); return; }
    const previous = command === "gateway restart" ? await stopGateway(values.force) : undefined;
    const host = requestedBinding ?? (previous ? { host: previous.host, allowedHosts: previous.allowedHosts } : binding());
    const options = { ...installation, ...host, allowedHosts: [...new Set([...host.allowedHosts, ...extraAllowedHosts])], port: Number(values.port ?? previous?.port ?? 4173) };
    if (command === "gateway run") {
      const current = await gatewayStatus();
      if (current.status !== "stopped") throw new Error("A gateway is already running or unresponsive.");
      const { runGateway } = await import("../server/gateway.ts");
      const gateway = await runGateway(options);
      console.log(`HUI ${gateway.state.version} · ${gateway.state.url}`);
      // The servers keep the foreground process alive; release the operation
      // lock now so another CLI can query/stop it.
      return;
    }
    try { report(await startGateway(options)); }
    catch (error) {
      if (previous) await startGateway({ ...previous, packageRoot: previous.packageRoot });
      throw error;
    }
    if (!values.json) console.log(`Logs: ${LOG_FILE}`);
  });
}
