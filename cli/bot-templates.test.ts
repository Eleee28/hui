import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "vitest";
import type { BotView } from "../server/bots-format.ts";
import type { BotExportReview } from "../server/bots/export-format.ts";
import type { BotImportPreview } from "../server/bots/templates/formats.ts";
import { exportAdditions, exportCommand, formatExportReview, formatImportPreview, importCommand, importSource } from "./bot-templates.ts";
import type { BotIO } from "./gateway-client.ts";
import { parseCli } from "./main.ts";

const BOT: BotView = {
  id: "b1", handle: "nova", name: "Nova", cwd: "/home/me/.config/hui/bots/b1", sessionId: "s1", createdAt: "2026-10-07T10:00:00.000Z",
  updatedAt: "2026-10-07T10:00:00.000Z", status: "idle", soul: true, unread: false, routines: 1,
};

function preview(extra: Partial<BotImportPreview> = {}): BotImportPreview {
  return {
    template: { format: "openclaw", name: "Nova", soul: "You are Nova.", memories: [], skills: [], routines: [], integrations: [], dropped: [], notes: [] },
    bot: { name: "Nova", handle: "nova", emoji: "🦊" },
    soul: "You are Nova.\n\n## What you already know\n\n- Madrid",
    opener: "Hi! Where shall we start?",
    memories: { included: 1, total: 2 },
    skills: [{ name: "weather-2", original: "weather", description: "Forecasts", content: "Use wttr.in." }],
    routines: [{ name: "Heartbeat", prompt: "Check the build.", schedule: { kind: "every", everyMs: 1_800_000 }, scheduleText: "whenever", guessed: true }],
    integrations: [{ name: "Web search", tool: { name: "browser", label: "Browser" } }, { name: "Gmail" }],
    disabledTools: ["bash"], disabledSkills: [], open: [], needs: [], triggers: [], dropped: ["AGENTS.md: OpenClaw's operating manual."], notes: ["Its routine starts disabled."],
    ...extra,
  };
}

/** A review as the gateway answers it: a removed and an asked passage, a need and what stays behind. */
const REVIEW: BotExportReview = {
  id: "r1", botId: "b1", name: "Nova", model: "hui-e2e/fixture",
  parts: [
    { id: "profile", label: "Profile", kind: "text", fields: [{ key: "name", text: "Nova" }], read: true },
    { id: "SOUL.md", label: "SOUL.md", kind: "text", fields: [{ key: "text", text: "I watch acme/widgets with Pat Doe for {{user}}." }], read: true },
  ],
  cleanup: [{ part: "SOUL.md", field: "text", kind: "your name", sample: "Dani", count: 1 }],
  changes: [
    { id: "c1", part: "SOUL.md", quote: "Pat Doe", group: "remove", reason: "A teammate's name.", replacement: "a teammate", label: "a teammate's name", question: "" },
    { id: "c2", part: "SOUL.md", quote: "acme/widgets", group: "ask", reason: "Their repository.", replacement: "", label: "the repositories to watch", question: "Which repositories should I watch?" },
  ],
  files: [], needs: [{ id: "n1", text: "The GitHub CLI signed in" }], leftOut: ["Its memory and its chat: an export never carries them."],
  meta: { routines: [], triggers: [], disabledTools: [], disabledSkills: [], skills: [] },
};

function terminal(options: { stdin?: string; answers?: string[]; interactive?: boolean; cwd?: string } = {}) {
  let out = "";
  let err = "";
  const answers = [...options.answers ?? []];
  const io: BotIO = {
    out: (text) => { out += text; }, err: (text) => { err += text; }, readStdin: async () => options.stdin ?? "",
    lines: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true as const, value: undefined }) }) }),
    onInterrupt: () => () => {}, interactive: options.interactive ?? false, ask: async () => answers.shift() ?? "",
    cwd: options.cwd ?? "/home/me/work", timezone: "Europe/Madrid",
  };
  return { io, get out() { return out; }, get err() { return err; } };
}

type Call = { method: string; path: string; body?: Record<string, unknown> };

/** A gateway answering the import routes from `replies`, recording each call. */
async function fakeGateway(t: TestContext, replies: Record<string, (call: Call) => { status?: number; body: unknown; raw?: Buffer; headers?: Record<string, string> }>) {
  const calls: Call[] = [];
  // A Map, so a request's method and path only ever select one of the replies given.
  const routes = new Map(Object.entries(replies));
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk as string;
    const call: Call = { method: request.method ?? "GET", path: request.url ?? "/", ...(text ? { body: JSON.parse(text) as Record<string, unknown> } : {}) };
    calls.push(call);
    const handler = routes.get(`${call.method} ${call.path.split("?")[0]}`);
    const reply = typeof handler === "function" ? handler(call) : { status: 404, body: { error: "unknown" } };
    response.writeHead(reply.status ?? 200, { "content-type": reply.raw ? "application/zip" : "application/json", ...reply.headers });
    response.end(reply.raw ?? JSON.stringify(reply.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { base: `http://127.0.0.1:${address.port}`, calls };
}

test("the preview prints every imported text in full and says what maps, what is off and what was left out", () => {
  const text = formatImportPreview(preview());
  assert.match(text, /^Import 🦊 Nova \(@nova\) from OpenClaw workspace\./u);
  assert.match(text, /SOUL\.md \(\d+ characters, with 1 of 2 memories\):\n  You are Nova\.\n\n  ## What you already know/u);
  assert.match(text, /First message \(it sends this in a first turn HUI starts\):\n  Hi! Where shall we start\?/u);
  assert.match(text, /  weather-2 \(from weather\): Forecasts\n    Use wttr\.in\./u);
  assert.match(text, /Routines, created disabled:\n  Heartbeat · every 30m \(assumed from "whenever": check it\)\n    Check the build\./u);
  assert.match(text, /  Web search → browser\n  Gmail: missing, HUI has no tool for it/u);
  assert.match(text, /Tools turned off: bash\./u);
  assert.match(text, /Left out:\n  - AGENTS\.md/u);
  assert.match(text, /Imported text is untrusted: read it before you create the bot\./u);
});

test("hui bot import sends a folder (without .git), shows the preview, and creates only after a yes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hui-cli-import-"));
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "nova", ".git"), { recursive: true });
  await writeFile(join(dir, "nova", "SOUL.md"), "You are Nova.");
  await writeFile(join(dir, "nova", ".git", "HEAD"), "ref");
  const gateway = await fakeGateway(t, {
    "POST /__hui/bots/import/preview": () => ({ body: preview() }),
    "POST /__hui/bots/import": () => ({ status: 201, body: { bot: BOT, skills: ["weather-2"], routines: 1, opener: true, warnings: ["one thing"] } }),
  });
  const source = await importSource("nova", terminal({ cwd: dir }).io);
  assert.deepEqual(source.kind === "files" ? source.files.map((file) => file.path) : [], ["nova/SOUL.md"]);
  const declined = terminal({ cwd: dir, interactive: true, answers: ["n"] });
  assert.equal(await importCommand(gateway.base, "nova", {}, declined.io), 1);
  assert.match(declined.out, /Nothing was imported\./u);
  assert.deepEqual(gateway.calls.map((call) => call.path), ["/__hui/bots/import/preview"], "declined: nothing created");
  await assert.rejects(importCommand(gateway.base, "nova", {}, terminal({ cwd: dir }).io), /cannot ask here \(no terminal\): add --yes to create @nova/u);
  const yes = terminal({ cwd: dir });
  assert.equal(await importCommand(gateway.base, "nova", { yes: true, worker: " devbox " }, yes.io), 0);
  const create = gateway.calls.at(-1)!;
  assert.deepEqual([create.path, create.body?.["worker"], (create.body?.["template"] as { name?: string }).name], ["/__hui/bots/import", "devbox", "Nova"]);
  assert.equal(gateway.calls.at(-2)!.body?.["worker"], "devbox", "the preview is for the worker too");
  assert.match(yes.out, /Imported @nova \(Nova\) with 1 skill and 1 routine \(disabled[^)]*\)\. It is sending its first message: hui bot chat nova\./u);
  assert.match(yes.err, /warning: one thing/u);
});

test("a file with several agents needs --agent where nobody can be asked; a link and stdin are sources too", async (t) => {
  const many = preview({ candidates: [{ key: "researcher", name: "Researcher" }, { key: "reporting_analyst", name: "Reporting Analyst", title: "Analyst" }], pick: "researcher" });
  const gateway = await fakeGateway(t, {
    "POST /__hui/bots/import/preview": (call) => ({ body: call.body?.["pick"] === "reporting_analyst" ? { ...many, pick: "reporting_analyst", bot: { name: "Reporting Analyst", handle: "reporting-analyst" } } : many }),
    "POST /__hui/bots/import": () => ({ status: 201, body: { bot: { ...BOT, handle: "reporting-analyst", name: "Reporting Analyst" }, skills: [], routines: 0, opener: false, warnings: [] } }),
  });
  await assert.rejects(importCommand(gateway.base, "-", { yes: true }, terminal({ stdin: "researcher:\n  role: R\n" }).io), /holds 2 agents; choose one with --agent:\n  1\. Researcher \(--agent researcher\)\n  2\. Reporting Analyst, Analyst \(--agent reporting_analyst\)/u);
  const picked = terminal({ stdin: "x" });
  assert.equal(await importCommand(gateway.base, "-", { yes: true, agent: "Reporting Analyst" }, picked.io), 0);
  assert.equal(gateway.calls.filter((call) => call.path === "/__hui/bots/import/preview").at(-1)!.body?.["pick"], "reporting_analyst");
  assert.deepEqual(gateway.calls[0]!.body?.["source"], { kind: "text", text: "researcher:\n  role: R\n" });
  assert.deepEqual(await importSource("https://x.ai/bot/marketplace/bots/a", terminal().io), { kind: "url", url: "https://x.ai/bot/marketplace/bots/a" });
});

test("hui bot export prints the review and saves the template once confirmed, owner-only and never over a file without --yes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hui-cli-export-"));
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const zip = Buffer.from("PK\u0005\u0006" + "\0".repeat(18), "latin1");
  const gateway = await fakeGateway(t, {
    "POST /__hui/bots/b1/export/review": () => ({ body: REVIEW }),
    "POST /__hui/bots/b1/export": () => ({ body: null, raw: zip, headers: { "content-disposition": "attachment; filename=\"nova.hui-bot.zip\"" } }),
  });
  await assert.rejects(exportCommand(gateway.base, BOT, {}, terminal({ cwd: dir }).io), /cannot ask here \(no terminal\): add --yes to save it as reviewed, or --review r1 --set <id>=<group>/u);
  const declined = terminal({ cwd: dir, interactive: true, answers: ["n"] });
  assert.equal(await exportCommand(gateway.base, BOT, {}, declined.io), 1);
  assert.match(declined.out, /Nothing was saved\. Move a change with hui bot export nova --review r1 --set <id>=<group>\./u);
  const saved = terminal({ cwd: dir, interactive: true, answers: ["y"] });
  gateway.calls.length = 0;
  assert.equal(await exportCommand(gateway.base, BOT, {}, saved.io), 0);
  assert.deepEqual(gateway.calls.map((call) => [call.method, call.path, call.body]), [["POST", "/__hui/bots/b1/export/review", undefined], ["POST", "/__hui/bots/b1/export", { review: "r1", picks: {} }]]);
  assert.match(saved.out, /^Review of @nova \(Nova\) as a template for someone else, read by hui-e2e\/fixture after HUI's cleanup\./u);
  assert.match(saved.out, /\n  c1 remove  SOUL\.md: “Pat Doe”, becomes “a teammate”\. A teammate's name\.\n  c2 ask     SOUL\.md: “acme\/widgets”, becomes \[ask: the repositories to watch\]\. Their repository\.\n/u);
  assert.match(saved.out, /Exported @nova as a template to .*nova\.hui-bot\.zip \(22 B\)\. Someone else imports it with hui bot import nova\.hui-bot\.zip\./u);
  const file = join(dir, "nova.hui-bot.zip");
  assert.deepEqual(await readFile(file), zip);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await assert.rejects(exportCommand(gateway.base, BOT, { review: "r1" }, terminal({ cwd: dir }).io), /exists: choose another --out, or add --yes to replace it/u);

  gateway.calls.length = 0;
  assert.equal(await exportCommand(gateway.base, BOT, { review: "r1", set: ["c1=keep", "n1=remove"], out: "picked.zip" }, terminal({ cwd: dir }).io), 0);
  assert.deepEqual(gateway.calls.map((call) => [call.path, call.body]), [["/__hui/bots/b1/export", { review: "r1", picks: { c1: "keep", n1: "remove" } }]], "a printed review saves with other picks, without reviewing again");
  const json = terminal({ cwd: dir });
  assert.equal(await exportCommand(gateway.base, BOT, { json: true }, json.io), 0);
  assert.deepEqual(JSON.parse(json.out), REVIEW, "--json without --yes prints the review and saves nothing");
  await assert.rejects(exportCommand(gateway.base, BOT, { set: ["c1=keep"] }, terminal({ cwd: dir }).io), /--set needs --review <id>/u);
  // A passage the reviewer missed: checked against a fresh review before anything is saved, sent with the download.
  gateway.calls.length = 0;
  const added = terminal({ cwd: dir });
  assert.equal(await exportCommand(gateway.base, BOT, { add: ["remove:I  watch => I look at"], yes: true, out: "added.zip" }, added.io), 0);
  assert.deepEqual(gateway.calls.at(-1)!.body, { review: "r1", picks: {}, added: [{ group: "remove", quote: "I  watch", becomes: "I look at" }] });
  assert.match(added.out, /\n  a1 remove  SOUL\.md: “I watch”, becomes “I look at”\. Added by you\.\n/u, "the printed review shows it, as the review holds it");
  await assert.rejects(exportCommand(gateway.base, BOT, { add: ["remove:not in the bot"], yes: true }, terminal({ cwd: dir }).io), /Addition a1: It isn't in the bot's text as the review read it/u);
  assert.deepEqual(exportAdditions(["ask:acme/widgets => the repositories", "confirm:Never merge"]), [{ group: "ask", quote: "acme/widgets", becomes: "the repositories" }, { group: "confirm", quote: "Never merge" }]);
  assert.throws(() => exportAdditions(["confirm:Never merge => ignored"]), /a confirmed passage travels as written/u);
  assert.throws(() => exportAdditions(["keep:Nova"]), /--add takes <remove\|ask\|confirm>:<passage>/u);
  await assert.rejects(exportCommand(gateway.base, BOT, { review: "r1", set: ["c1=maybe"] }, terminal({ cwd: dir }).io), /--set takes <change>=<keep\|remove\|ask\|confirm>/u);
  const gone = await fakeGateway(t, { "POST /__hui/bots/b1/export": () => ({ status: 409, body: { error: "Nova changed since its review: review it again before you download it." } }) });
  await assert.rejects(exportCommand(gone.base, BOT, { review: "r1", yes: true }, terminal({ cwd: dir }).io), /changed since its review/u);
});

test("the review as text keeps what a pick moves", () => {
  const text = formatExportReview(BOT, REVIEW, { c2: "confirm" });
  assert.match(text, /c2 confirm SOUL\.md: “acme\/widgets”, the new owner confirms it\./u);
  assert.match(text, /What it needs \(--set <id>=remove leaves one out\):\n  n1 keep    The GitHub CLI signed in/u);
  assert.match(text, /Cleaned automatically, before any model read it:\n  SOUL\.md: your name \(Dani\)/u);
  assert.match(text, /It saves as nova\.hui-bot\.zip: bot\.json, SOUL\.md\./u);
});

test("the CLI parses import and export with their own flags only", () => {
  const parsed = (args: string[]) => {
    const { command, values, operands } = parseCli(args);
    return { command, values: { ...values }, operands };
  };
  assert.deepEqual(parsed(["bot", "import", "nova.zip", "--yes", "--worker", "devbox"]), { command: "bot import", values: { yes: true, worker: "devbox" }, operands: ["nova.zip"] });
  assert.deepEqual(parsed(["bot", "export", "nova", "--out", "n.zip", "--review", "r1", "--set", "c1=keep", "--set", "n1=remove"]), { command: "bot export", values: { out: "n.zip", review: "r1", set: ["c1=keep", "n1=remove"] }, operands: ["nova"] });
  assert.throws(() => parseCli(["bot", "export", "nova", "--memory"]), /--memory is gone: hui bot export makes a template/u);
  assert.throws(() => parseCli(["bot", "import", "a", "--review", "r1"]), /--review is not valid for bot import/u);
  assert.throws(() => parseCli(["bot", "export", "nova", "--agent", "x"]), /--agent is not valid for bot export/u);
  assert.throws(() => parseCli(["bot", "import"]), /bot import needs <source>/u);
});
