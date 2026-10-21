import assert from "node:assert/strict";
import { test } from "vitest";
import { binding, HELP, parseCli } from "./main.ts";

test("CLI parses doctor with only --fix and --json", () => {
  assert.equal(parseCli(["doctor"]).command, "doctor");
  assert.deepEqual({ ...parseCli(["doctor", "--fix", "--json"]).values }, { fix: true, json: true });
  for (const args of [["doctor", "--force"], ["doctor", "extra"], ["gateway", "status", "--fix"], ["update", "--fix"]]) assert.throws(() => parseCli(args), Error, args.join(" "));
});

test("CLI parses lifecycle, UI and local update commands without accepting stray flags", () => {
  for (const verb of ["start", "stop", "restart", "status", "logs", "run"]) assert.equal(parseCli(["gateway", verb]).command, `gateway ${verb}`);
  assert.equal(parseCli(["desktop"]).command, "desktop");
  assert.throws(() => parseCli(["desktop", "--system"]));
  assert.equal(parseCli(["install-app"]).command, "install-app");
  assert.throws(() => parseCli(["desktop", "--host", "127.0.0.1"]));
  assert.equal(parseCli(["gateway"]).command, "gateway run");
  assert.equal(parseCli(["ui", "--no-open"]).values["no-open"], true);
  assert.equal(parseCli(["update", "--from", "/tmp/release.tgz"]).values.from, "/tmp/release.tgz");
  assert.equal(parseCli(["update", "--rollback"]).values.rollback, true);
  assert.equal(parseCli(["update", "--check", "--json"]).values.check, true);
  assert.equal(parseCli(["update", "--nightly"]).values.nightly, true);
  assert.deepEqual({ ...parseCli(["update", "--nightly", "--check", "--json"]).values }, { nightly: true, check: true, json: true });
  assert.equal(parseCli(["gateway", "start", "--port", "0"]).values.port, "0");
  for (const args of [["gateway", "stop", "--host", "127.0.0.1"], ["gateway", "start", "--port", "-1"], ["gateway", "start", "--port", "65536"],
    ["gateway", "logs", "--lines", "0"], ["update", "--rollback", "--from", "file.tgz"], ["update", "--sha256", "bad"], ["update", "--check", "--rollback"], ["update", "--check", "--from", "file.tgz"],
    ["update", "--nightly", "--from", "file.tgz"], ["update", "--nightly", "--rollback"], ["gateway", "restart", "--nightly"], ["ui", "extra"], ["gateway", "status", "extra"], ["typo"]]) {
    assert.throws(() => parseCli(args), Error, args.join(" "));
  }
});

test("CLI parses workers commands, their target and only their own flags", () => {
  assert.equal(parseCli(["workers"]).command, "workers list");
  assert.equal(parseCli(["workers", "list", "--json"]).values.json, true);
  const add = parseCli(["workers", "add", "--name", "box", "--command", "ssh -o BatchMode=yes box", "--extra-path", "~/a", "--extra-path", "~/b"]);
  assert.deepEqual([add.command, add.values.name, add.values.command, add.values["extra-path"]], ["workers add", "box", "ssh -o BatchMode=yes box", ["~/a", "~/b"]]);
  const edit = parseCli(["workers", "edit", "box", "--command", "ssh box"]);
  assert.deepEqual([edit.command, edit.target, edit.values.command], ["workers edit", "box", "ssh box"]);
  assert.equal(parseCli(["workers", "remove", "box"]).target, "box");
  for (const args of [["workers", "add", "--name", "box"], ["workers", "add", "--command", "ssh box"], ["workers", "edit", "box"], ["workers", "edit", "--name", "x"],
    ["workers", "remove"], ["workers", "remove", "box", "extra"], ["workers", "list", "box"], ["workers", "remove", "box", "--name", "x"], ["workers", "sync"], ["doctor", "--name", "x"]]) {
    assert.throws(() => parseCli(args), Error, args.join(" "));
  }
});

test("CLI parses bot commands, accepting bot and bots, with their operands and only their own flags", () => {
  assert.equal(parseCli(["bot"]).command, "bot list");
  assert.equal(parseCli(["bots"]).command, "bot list");
  assert.deepEqual({ ...parseCli(["bots", "list", "--archived", "--json"]).values }, { archived: true, json: true });
  const add = parseCli(["bot", "add", "--name", "Ada", "--title", "Researcher", "--soul-file", "soul.md", "--cwd", ".",
    "--model", "openai/gpt-5", "--thinking", "high", "--memory-model", "openai/gpt-mini", "--emoji", "🦊", "--json"]);
  assert.equal(add.command, "bot add");
  assert.deepEqual(add.operands, []);
  assert.equal(add.values["memory-model"], "openai/gpt-mini");
  assert.equal(add.values["soul-file"], "soul.md");
  // VoiceStudio is gone: its flags are refused with what took their place, not as unknown options.
  for (const args of [["bot", "add", "--name", "Ada", "--voice", "vp-aria"], ["bot", "edit", "ada", "--voice", ""], ["gateway", "start", "--voice", "x"]]) {
    assert.throws(() => parseCli(args), /--voice is gone: HUI no longer uses VoiceStudio\. A bot speaks on calls with one of GPT-Live's voices: --call-voice <cove\|arbor\|breeze\|ember\|juniper\|maple\|sol\|spruce\|vale>\./u, args.join(" "));
  }
  for (const args of [["bot", "edit", "ada", "--voice-speed", "1.25"], ["bot", "add", "--name", "Ada", "--voice-speed", ""]]) {
    assert.throws(() => parseCli(args), /--voice-speed is gone: HUI no longer uses VoiceStudio, and GPT-Live sets the pace of its own voices\./u, args.join(" "));
  }
  for (const language of ["es", "ES", "haw", "yue", "jw"]) assert.equal(parseCli(["bot", "edit", "ada", "--language", language]).values.language, language, language);
  assert.equal(parseCli(["bot", "add", "--name", "Ada", "--language", "de"]).values.language, "de");
  assert.equal(parseCli(["bot", "edit", "ada", "--language", ""]).values.language, "", "\"\" goes back to Auto");
  for (const language of ["spanish", "es-ES", "xx", "jv", "auto"]) {
    assert.throws(() => parseCli(["bot", "edit", "ada", "--language", language]), /--language must be one of Whisper's language codes, such as en, es, fr, de or ja \(not a name like Spanish\); "" goes back to Auto\./u, language);
  }
  assert.throws(() => parseCli(["bot", "list", "--language", "es"]), /--language is not valid for bot list/u);
  for (const tagging of ["anyone", "Mention", "nobody"]) assert.equal(parseCli(["bot", "edit", "ada", "--tagging", tagging]).values.tagging, tagging, tagging);
  for (const tagging of ["everyone", ""]) assert.throws(() => parseCli(["bot", "edit", "ada", "--tagging", tagging]), /--tagging must be one of: anyone, mention, nobody\./u, tagging);
  assert.equal(parseCli(["bot", "add", "--description", "Finds sources."]).values.description, "Finds sources.");
  assert.equal(parseCli(["bot", "edit", "ada", "--description", ""]).values.description, "", "\"\" clears it");
  for (const voice of ["cove", "Ember", "vale", ""]) assert.equal(parseCli(["bot", "edit", "ada", "--call-voice", voice]).values["call-voice"], voice, voice);
  assert.equal(parseCli(["bot", "add", "--name", "Ada", "--call-voice", "sol"]).values["call-voice"], "sol");
  for (const voice of ["marin", "alloy", "x"]) {
    assert.throws(() => parseCli(["bot", "edit", "ada", "--call-voice", voice]), /--call-voice must be one of GPT-Live's voices: cove, arbor, breeze, ember, juniper, maple, sol, spruce, vale; "" goes back to Settings' default\./u, voice);
  }
  const look = parseCli(["bot", "add", "--name", "Ada", "--shape", "heart", "--color", "mint"]);
  assert.deepEqual([look.values.shape, look.values.color], ["heart", "mint"]);
  for (const shape of ["blob", "round", "Pebble", "TRIANGLE", "heart", "cookie", "star", "Ghost", ""]) assert.equal(parseCli(["bot", "edit", "ada", "--shape", shape]).values.shape, shape, shape);
  for (const color of ["blue", "Yellow", "#D23CE0", "#123456", ""]) assert.equal(parseCli(["bot", "edit", "ada", "--color", color]).values.color, color, color);
  assert.equal(parseCli(["bot", "edit", "ada", "--emoji", ""]).values.emoji, "", "\"\" switches the bot to its face");
  assert.throws(() => parseCli(["bot", "edit", "ada", "--shape", "dragon"]), /--shape must be one of: blob, round, triangle, heart, cookie, star, flower, cloud, drop, ghost, pill, block, hexagon; "" goes back to the one its id picks\./u);
  for (const ears of ["cat", "Bunny", "cat ears", ""]) assert.equal(parseCli(["bot", "edit", "ada", "--ears", ears]).values.ears, ears, ears);
  assert.throws(() => parseCli(["bot", "edit", "ada", "--ears", "wings"]), /--ears must be one of: cat, bear, bunny, antenna, sprout, horns; "" takes them off\./u);
  for (const color of ["red", "#12345", "3a7bfa"]) assert.throws(() => parseCli(["bot", "edit", "ada", "--color", color]), /--color must be one of blue, yellow, magenta, mint, coral, lilac or #rrggbb/u, color);
  assert.throws(() => parseCli(["bot", "show", "ada", "--shape", "heart"]), /--shape is not valid for bot show/u);
  const edit = parseCli(["bot", "edit", "@ada", "--title", "Lead"]);
  assert.deepEqual([edit.command, edit.operands, edit.values.title], ["bot edit", ["@ada"], "Lead"]);
  const soul = parseCli(["bot", "soul", "ada", "--file", "-", "--json"]);
  assert.deepEqual([soul.command, soul.operands, soul.values.file, soul.values.json], ["bot soul", ["ada"], "-", true]);
  assert.deepEqual(parseCli(["bot", "soul", "Ada Lovelace"]).operands, ["Ada Lovelace"]);
  const tools = parseCli(["bot", "tools", "ada", "--deny", "bash,write", "--allow", "read", "--json"]);
  assert.deepEqual([tools.command, tools.operands, tools.values.deny, tools.values.allow, tools.values.json], ["bot tools", ["ada"], "bash,write", "read", true]);
  assert.deepEqual(parseCli(["bot", "skills", "ada", "--allow", "release-notes"]).values.allow, "release-notes");
  assert.equal(parseCli(["bot", "tools", "ada"]).command, "bot tools", "without flags it lists them");
  const denied = parseCli(["bot", "add", "--name", "Ada", "--deny-tools", "bash", "--deny-skills", "alpha,beta"]);
  assert.deepEqual([denied.values["deny-tools"], denied.values["deny-skills"]], ["bash", "alpha,beta"]);
  assert.deepEqual({ ...parseCli(["bot", "add"]).values }, {}, "a bot without a name is New Bot");
  assert.equal(parseCli(["bot", "delete", "ada", "--yes"]).values.yes, true);
  assert.equal(parseCli(["bot", "delete", "ada", "-y"]).values.yes, true);
  // A bot on a worker: chosen once, at creation, with a folder there.
  const remote = parseCli(["bot", "add", "--name", "Rover", "--worker", "devbox", "--cwd", "~/src"]);
  assert.deepEqual([remote.values.worker, remote.values.cwd], ["devbox", "~/src"]);
  assert.equal(parseCli(["bot", "add", "--name", "Rover", "--worker", "devbox", "--cwd", "/srv/rover"]).values.cwd, "/srv/rover");
  assert.equal(parseCli(["bot", "add", "--worker", "devbox"]).values.worker, "devbox", "a new bot on a worker needs no name either");
  assert.throws(() => parseCli(["bot", "edit", "rover", "--worker", "devbox"]), /^Error: A bot stays on the machine it was created on: --worker only applies to bot add.$/u);
  assert.throws(() => parseCli(["bot", "add", "--name", "Rover", "--worker", " "]), /--worker needs a worker's name or id/u);
  assert.throws(() => parseCli(["bot", "add", "--name", "Rover", "--worker", "devbox", "--cwd", "src"]), /With --worker, --cwd is a folder on the worker: absolute or ~\/…\./u);
  assert.throws(() => parseCli(["bot", "show", "rover", "--worker", "devbox"]), /--worker is not valid for bot show/u);
  const cleared = parseCli(["bot", "edit", "ada", "--model", "", "--thinking", "", "--memory-model", ""]);
  assert.deepEqual([cleared.values.model, cleared.values.thinking, cleared.values["memory-model"]], ["", "", ""], "an empty value clears the choice");
  assert.equal(parseCli(["bot", "edit", "ada", "--utility-model", "anthropic/claude-haiku"]).values["utility-model"], "anthropic/claude-haiku");
  assert.throws(() => parseCli(["bot", "edit", "ada", "--utility-model", "a/b", "--memory-model", "a/b"]), /either --utility-model or --memory-model/u);
  assert.throws(() => parseCli(["bot", "edit", "ada", "--utility-model", "nope"]), /--utility-model must be provider\/model/u);
  assert.deepEqual(parseCli(["bot", "send", "ada", "-", "--wait", "--timeout", "90"]).operands, ["ada", "-"]);
  assert.equal(parseCli(["bot", "send", "ada", "hello there"]).operands?.[1], "hello there");
  assert.equal(parseCli(["bot", "chat", "Ada Lovelace"]).operands?.[0], "Ada Lovelace");
  assert.equal(parseCli(["bot", "memory", "ada", "--zoom", "2184+8"]).values.zoom, "2184+8");
  assert.equal(parseCli(["bot", "memory", "ada", "--html", "memory.html"]).values.html, "memory.html");
  for (const verb of ["show", "remove", "restore", "stop"]) assert.deepEqual(parseCli(["bot", verb, "ada", "--json"]).operands, ["ada"]);
  assert.equal(parseCli(["bot", "routine", "list", "ada"]).command, "bot routine list");
  assert.equal(parseCli(["bot", "routines", "list", "ada"]).command, "bot routine list");
  const routine = parseCli(["bot", "routine", "add", "ada", "--name", "Morning", "--prompt", "Check the inbox", "--cron", "0 9 * * 1-5", "--timezone", "Europe/Madrid"]);
  assert.deepEqual([routine.command, routine.operands, routine.values.cron, routine.values.timezone], ["bot routine add", ["ada"], "0 9 * * 1-5", "Europe/Madrid"]);
  assert.equal(parseCli(["bot", "routine", "add", "ada", "--name", "Tick", "--prompt", "Tick", "--every", "30s"]).values.every, "30s", "Automation enforces its own minimum");
  assert.equal(parseCli(["bot", "routine", "add", "ada", "--name", "Once", "--prompt", "Ping", "--at", "2026-10-06T09:00:00+02:00"]).values.at, "2026-10-06T09:00:00+02:00");
  assert.deepEqual(parseCli(["bot", "routine", "run", "ada", "Morning"]).operands, ["ada", "Morning"]);
  assert.deepEqual(parseCli(["bot", "routine", "remove", "ada", "Morning", "--json"]).operands, ["ada", "Morning"]);
  for (const [args, message] of [
    [["bot", "add", "ada", "--name", "Ada"], /takes no operands/u],
    [["bot", "edit", "ada"], /needs at least one of/u],
    [["bot", "edit", "--name", "x"], /needs <bot>/u],
    [["bot", "show"], /needs <bot>/u],
    [["bot", "send", "ada"], /needs <bot> <message>/u],
    [["bot", "send", "ada", "hello", "there"], /quote the message/u],
    [["bot", "send", "ada", "hi", "--timeout", "10"], /--timeout needs --wait/u],
    [["bot", "send", "ada", "hi", "--wait", "--timeout", "0"], /1-3600/u],
    [["bot", "add", "--name", "Ada", "--instructions", "x"], /Unknown option '--instructions'/u],
    [["bot", "add", "--name", "Ada", "--instructions-file", "y"], /Unknown option '--instructions-file'/u],
    [["bot", "edit", "ada", "--soul-file", "x"], /bot edit does not change SOUL\.md: use hui bot soul <bot> --file/u],
    [["bot", "soul"], /needs <bot>/u],
    [["bot", "remove", "ada", "--yes"], /--yes is not valid for bot remove/u],
    [["bot", "soul", "ada", "--title", "x"], /--title is not valid for bot soul/u],
    [["bot", "show", "ada", "--file", "x"], /--file is not valid for bot show/u],
    [["bot", "add", "--name", "Ada", "--thinking", "ultra"], /--thinking must be one of/u],
    [["bot", "add", "--name", "Ada", "--model", "gpt-5"], /--model must be provider\/model/u],
    [["bot", "memory", "ada", "--zoom", "12"], /id\+n/u],
    [["bot", "memory", "ada", "--zoom", "1+1", "--html", "x"], /either --zoom or --html/u],
    [["bot", "routine", "add", "ada", "--name", "x"], /needs --name and --prompt/u],
    [["bot", "routine", "add", "ada", "--name", "x", "--prompt", "y"], /exactly one of --at, --every or --cron/u],
    [["bot", "routine", "add", "ada", "--name", "x", "--prompt", "y", "--every", "5m", "--cron", "* * * * *"], /exactly one/u],
    [["bot", "routine", "add", "ada", "--name", "x", "--prompt", "y", "--every", "5 minutes"], /duration such as 30s/u],
    [["bot", "routine", "add", "ada", "--name", "x", "--prompt", "y", "--every", "5m", "--timezone", "UTC"], /--timezone only applies to --cron/u],
    [["bot", "routine", "add", "ada", "--name", "x", "--prompt", "y", "--at", "tomorrow"], /ISO date/u],
    [["bot", "routine", "run", "ada"], /needs <bot> <routine>/u],
    [["bot", "list", "--name", "x"], /--name is not valid for bot list/u],
    [["bot", "chat", "ada", "--json"], /--json is not valid for bot chat/u],
    [["bot", "tools"], /bot tools needs <bot>/u],
    [["bot", "tools", "ada", "--deny", " , "], /--deny needs comma-separated names/u],
    [["bot", "tools", "ada", "--allow", "bash", "--deny", "bash,write"], /bash can't be both allowed and denied/u],
    [["bot", "skills", "ada", "--title", "x"], /--title is not valid for bot skills/u],
    [["bot", "edit", "ada", "--deny-tools", "bash"], /--deny-tools is not valid for bot edit/u],
    [["bot", "add", "--name", "Ada", "--deny-skills", ""], /--deny-skills needs comma-separated names/u],
    [["bot", "dance"], /Unknown command/u],
    [["bot", "routine", "pause", "ada"], /Unknown command/u],
    [["workers", "list", "--archived"], /--archived is not valid/u],
  ] as const) {
    assert.throws(() => parseCli([...args]), message, args.join(" "));
  }
});

test("HELP lists every hui bot command", () => {
  for (const line of [
    "hui bot list [--archived] [--json]",
    "hui bot show <bot> [--json]",
    "hui bot add [--name <name>] [--title <text>] [--description <text>] [--tagging <anyone|mention|nobody>]",
    "[--worker <name|id>] [--model <provider/model>]",
    "hui bot delete <bot> [--yes] [--json]",
    "Delete removes a bot for good, active or archived",
    "hui bot edit <bot> [same flags as add but --soul-file, --worker and --deny-*] [--json]",
    "hui bot soul <bot> [--file <path|->] [--json]",
    "hui bot tools <bot> [--allow <a,b>] [--deny <a,b>] [--json]",
    "hui bot skills <bot> [--allow <a,b>] [--deny <a,b>] [--json]",
    "[--deny-tools <a,b>] [--deny-skills <a,b>] [--json]",
    "A bot has every tool and skill a session in its directory has, new ones\nincluded, until you turn some off",
    "Tools are the boundary, not a\nsandbox",
    "A new bot starts by asking what you expect from it (talk with\nhui bot chat <handle>), then writes its persona, SOUL.md, itself",
    "hui bot remove <bot> [--json]",
    "hui bot restore <bot> [--json]",
    "hui bot chat <bot>",
    "hui bot send <bot> <message|-> [--wait] [--timeout <seconds>] [--json]",
    "hui bot stop <bot> [--json]",
    "hui bot memory <bot> [--zoom <id+n>] [--html <file>] [--json]",
    "hui bot routine list <bot> [--json]",
    "hui bot routine add <bot> --name <name> --prompt <text> (--at <ISO time> | --every <duration> | --cron <expr>",
    "hui bot routine run <bot> <routine>",
    "hui bot routine remove <bot> <routine> [--json]",
    "On edit, --model \"\" and --thinking \"\" go back to the model and",
    "[--language <code>] [--call-voice <cove|arbor|breeze|ember|juniper|maple|sol|spruce|vale>]",
    "--call-voice is the bot's GPT-Live voice on calls",
    "[--soul-file <path|->] [--cwd <dir>]",
    "--tagging who may: anyone, the default, whenever a task fits; mention, only",
    "--language is the language it",
    "Bots are named agents with one forever chat each",
  ]) assert.ok(HELP.includes(line), line);
  assert.doesNotMatch(HELP, /VoiceStudio|--voice/u, "VoiceStudio's flags are gone");
  assert.doesNotMatch(HELP, /Labs/u, "bots need no Labs switch");
});

test("production binding is explicit and never a wildcard", () => {
  assert.deepEqual(binding(), { host: "127.0.0.1", allowedHosts: [] });
  assert.equal(binding("localhost").host, "127.0.0.1");
  assert.equal(binding("100.64.0.10").host, "100.64.0.10");
  assert.equal(binding("::1").host, "::1");
  for (const value of ["0.0.0.0", "::", "", "untrusted.example", "127.0.0.1:80"]) assert.throws(() => binding(value));
});


test("gateway environment defaults are validated and explicit flags win", () => {  const env = { HUI_GATEWAY_HOST: "127.0.0.2", HUI_GATEWAY_PORT: "5180" };
  for (const command of ["start", "run", "restart"]) {
    const parsed = parseCli(["gateway", command], env);
    assert.equal(parsed.values.host, "127.0.0.2");
    assert.equal(parsed.values.port, "5180");
  }
  const override = parseCli(["gateway", "start", "--host", "::1", "--port", "0"], env);
  assert.equal(override.values.host, "::1");
  assert.equal(override.values.port, "0");
  for (const port of ["", "-1", "65536", "12.5", "bad"]) {
    assert.throws(() => parseCli(["gateway", "start"], { HUI_GATEWAY_PORT: port }), /--port/);
  }
  for (const args of [["--help"], ["--version"], ["desktop"], ["gateway", "stop"], ["gateway", "status"]]) {
    const parsed = parseCli(args, { HUI_GATEWAY_PORT: "bad" });
    assert.equal(parsed.values.port, undefined);
  }
  assert.equal(parseCli(["gateway", "start"], {}).values.port, undefined);
});

test("--allow-host is repeatable, validated and remembered with the binding", () => {
  const parsed = parseCli(["gateway", "restart", "--allow-host", "laptop.example.ts.net", "--allow-host", "Laptop."], {});
  assert.deepEqual(parsed.values["allow-host"], ["laptop.example.ts.net", "laptop"]);
  for (const command of ["start", "run", "restart"]) {
    assert.equal(parseCli(["gateway", command, "--allow-host", "laptop"], {}).values["allow-host"]?.length, 1);
  }
  // A name that could never arrive in a Host header is refused up front, and
  // only lifecycle commands accept the flag at all.
  for (const name of ["*", "http://laptop", "laptop:4173", "laptop,two"]) {
    assert.throws(() => parseCli(["gateway", "start", "--allow-host", name], {}), /is not a host name/u, name);
  }
  for (const command of ["stop", "status", "logs"]) assert.throws(() => parseCli(["gateway", command, "--allow-host", "laptop"], {}));
});
