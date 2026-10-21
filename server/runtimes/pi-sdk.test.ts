import type { TranscriptEntry } from "./types.ts";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdtemp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, test, type TestContext } from "vitest";
import type { PiSession } from "./pi.ts";
import type { RuntimeEvent } from "./types.ts";
import { shippedTools } from "./tool-catalog.ts";
import { configuredResourceId } from "./resource-policy.ts";
import { bundledSkills } from "../pi/bundled-skills.ts";
import { registerAgentToolHandler } from "../agent-tools/bridge.ts";
import { SecretFiles, SecretRequests } from "../agent-tools/secret-requests.ts";
import { completeLines } from "../test-support/json-lines.ts";
import { waitFor } from "../test-support/wait-for.ts";

// HUI's configuration directory is resolved at import time, and PI finds skills in ~/.agents/skills: never the operator's own.
const root = await mkdtemp(join(tmpdir(), "hui-sdk-home-"));
const configDir = join(root, "config");
process.env["HOME"] = root;
process.env["XDG_CONFIG_HOME"] = configDir;
afterAll(() => rm(root, { recursive: true, force: true }));
const { piRuntime } = await import("./pi.ts");

function nextEvent(session: PiSession, predicate: (event: RuntimeEvent) => boolean): Promise<RuntimeEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error("Expected runtime event timed out.")); }, 15_000);
    const unsubscribe = session.subscribe((event) => {
      if (predicate(event)) { clearTimeout(timer); unsubscribe(); resolve(event); }
    });
  });
}

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "hui-sdk-test-"));
  const agentDir = join(dir, "agent");
  const cwd = join(dir, "workspace");
  await mkdir(agentDir); await mkdir(cwd);
  await writeFile(join(cwd, "fixture.txt"), "SDK fixture content\n");
  const log = join(dir, "requests.jsonl");
  const sessions: PiSession[] = [];
  const provider = spawn(process.execPath, [fileURLToPath(new URL("../../e2e/fixtures/pi-provider-fixture.mjs", import.meta.url))], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HUI_E2E_PROVIDER_PORT: "0", HUI_E2E_WORKSPACE: cwd, HUI_E2E_PROVIDER_LOG: log },
  });
  t.onTestFinished(async () => {
    for (const session of sessions) session.dispose();
    // dispose() only signals PI, which still writes under agent/ (auth.json, models-store.json) as it shuts down.
    const alive = (pid: number | undefined) => { try { return pid !== undefined && process.kill(pid, 0); } catch { return false; } };
    await waitFor("the PI processes to exit", () => !sessions.some((session) => alive(session.processId)));
    const exit = once(provider, "exit"); provider.kill(); await exit;
    await rm(dir, { recursive: true, force: true });
  });
  const [ready] = await once(provider.stdout, "data");
  const baseUrl = String(ready).match(/http:\/\/127\.0\.0\.1:\d+/u)?.[0];
  assert(baseUrl, String(ready));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "hui-e2e": {
    baseUrl, api: "anthropic-messages", apiKey: "e2e-not-a-secret", models: ["fixture", "group/second"].map((id) => ({
      id, name: id, reasoning: true, input: ["text", "image"], contextWindow: 32000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
  } } }));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "hui-e2e", defaultModel: "fixture", defaultThinkingLevel: "high" }));
  const start = async (extra: Partial<Parameters<typeof piRuntime.start>[0]> = {}) => {
    const session = await piRuntime.start({ cwd, agentDir, backend: "sdk", ...extra });
    sessions.push(session); return session;
  };
  return { dir, cwd, agentDir, log, start, baseUrl };
}

function assertRestoredTranscript(restored: TranscriptEntry[], live: TranscriptEntry[]) {
  assert(live.some(entry => entry.metrics?.completedAt !== undefined), "live calls must have observed completion");
  const durable = live.map(({ metrics, ...entry }) => {
    if (!metrics) return entry;
    const { durationMs, completedAt, ...persisted } = metrics;
    if (durationMs !== undefined) assert(durationMs >= 0);
    return { ...entry, ...(Object.keys(persisted).length ? { metrics: persisted } : {}) };
  });
  assert.deepEqual(restored, durable, "all PI-owned transcript data must survive restart; observed timing must not be invented");
}

test("SDK owns schemas and prompt, executes tools, preserves history, models, thinking and attachments", { timeout: 45_000 }, async (t) => {
  const f = await fixture(t);
  const session = await f.start();
  const initial = await session.inspect!();
  assert.deepEqual(initial.tools.map((tool) => tool.name).sort(), shippedTools().map((tool) => tool.name).sort());
  assert.equal(initial.tools.filter((tool) => tool.active).length, 21);
  assert.equal(initial.tools.find((tool) => tool.name === "terminal")?.source, "HUI");
  assert.equal(initial.tools.find((tool) => tool.name === "browser")?.source, "HUI");
  assert.equal(initial.tools.find((tool) => tool.name === "progress_card")?.source, "HUI");
  assert.equal(initial.tools.find((tool) => tool.name === "show_widget")?.source, "HUI");
  assert.equal(initial.diagnostics.length, 0);
  assert.match(initial.prompt, /coding assistant in HUI/u);
  const events: RuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));
  let settled = nextEvent(session, (event) => event.type === "settled");
  await session.prompt("E2E_RICH"); await settled;
  assert(events.some((event) => event.type === "thinking"));
  assert(events.some((event) => event.type === "tool_end" && event.name === "read" && event.output?.includes("SDK fixture content")));
  const requests = completeLines(await readFile(f.log, "utf8")).map((line) => JSON.parse(line));
  assert.match(JSON.stringify(requests[0].system), /coding assistant in HUI/u);
  assert.match(JSON.stringify(requests[0].system), /progress_card/u);
  assert.match(JSON.stringify(requests[0].system), /present_media/u);
  assert.match(JSON.stringify(requests[0].system), /show_widget: Show an interactive HTML\/SVG widget inline in the HUI chat/u);
  assert.match(JSON.stringify(requests[0].system), /widget_code is an HTML or SVG fragment/u);
  assert.match(JSON.stringify(requests[0].system), /Active callable tools for this turn/u);
  assert.match(JSON.stringify(requests[0].system), /PI provides their full schemas separately/u);
  assert.match(JSON.stringify(requests[0].system), /browser codec support/u);
  assert.match(JSON.stringify(requests[0].system), /fenced `mermaid` block/u);
  assert.match(JSON.stringify(requests[0].system), /consent-gated post embed/u);
  assert.match(JSON.stringify(requests[0].system), /fenced `chart` block/u);
  assert.match(JSON.stringify(requests[0].system), /Vega-Lite JSON specification/u);
  assert.match(JSON.stringify(requests[0].system), /renders both with KaTeX/u);
  assert.match(JSON.stringify(requests[0].system), /GitHub-style blockquote callouts/u);
  assert.match(JSON.stringify(requests[0].system), /Slack message or channel permalink/u);
  assert.match(JSON.stringify(requests[0].system), /does not authenticate to Slack/u);
  const effective = await session.inspect!();
  assert.equal(effective.promptPhase, "last-turn");
  assert.match(effective.prompt, /<hui_tool_guidelines>/u);
  assert.equal(effective.prompt, requests.at(-1).system[0].text);
  assert.deepEqual(requests[0].tools.map((tool: { name: string }) => tool.name).sort(), initial.tools.filter((tool) => tool.active).map((tool) => tool.name).sort());
  assert.deepEqual(requests[0].tools.find((tool: { name: string }) => tool.name === "read").input_schema, initial.tools.find((tool) => tool.name === "read")?.parameters);
  await session.setModel("hui-e2e", "group/second");
  assert.equal(session.currentModel()?.id, "group/second");
  await session.setThinking("low"); assert.equal(session.currentThinking(), "low");
  settled = nextEvent(session, (event) => event.type === "settled");
  const image = await readFile(new URL("../../public/pi-logo-3d.png", import.meta.url));
  await session.prompt("attachment", [{ kind: "image", name: "fixture.png", mimeType: "image/png", dataBase64: image.toString("base64") }]);
  await settled;
  assert((await readFile(f.log, "utf8")).includes("image/png"), JSON.stringify(session.transcript().slice(-3)));
  const history = session.transcript();
  const sessionFile = session.sessionFile;
  assert(sessionFile?.startsWith(f.agentDir));
  session.dispose();
  const resumed = await f.start({ sessionFile });
  assertRestoredTranscript(resumed.transcript(), history);
  assert.equal(resumed.currentModel()?.id, "group/second");
});

test("SDK rewinds the append-only PI tree and continues without a synthetic user prompt", { timeout: 45_000 }, async (t) => {
  const f = await fixture(t);
  const session = await f.start({ noSession: true });
  let settled = nextEvent(session, (event) => event.type === "settled");
  await session.prompt("CONTINUE_FIXTURE");
  await settled;

  const user = entryId(session, "CONTINUE_FIXTURE");
  await assert.rejects(() => session.continueRun!(), /completed assistant response/u);

  await session.rewind!(user);
  assert.deepEqual(session.transcript().map((entry) => entry.kind === "message" ? `${entry.role}:${entry.text}` : entry.kind), [
    "user:CONTINUE_FIXTURE",
  ]);

  settled = nextEvent(session, (event) => event.type === "settled");
  await session.continueRun!();
  await settled;
  assert(session.transcript().some((entry) => entry.kind === "message" && entry.role === "assistant" && entry.text.includes("Fixture response")));

  await session.rewind!(user, { excludeUserMessage: true });
  assert.deepEqual(session.transcript(), []);
});

test("SDK continues an aborted reply that followed a persisted prompt or tool change", { timeout: 45_000 }, async (t) => {
  // PI persists prompt and tool loadout changes as system entries in front of
  // the request that used them, so an aborted reply can follow toolResult → system.
  const f = await fixture(t);
  const first = await f.start();
  let settled = nextEvent(first, (event) => event.type === "settled");
  await first.prompt("Create the transcript"); await settled;
  const sessionFile = first.sessionFile;
  assert(sessionFile);
  first.dispose();
  const persisted = (await readFile(sessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { id: string; type: string; message?: { role?: string } });
  assert(persisted.some((entry) => entry.type === "message" && entry.message?.role === "system"), "PI records the initial loadout as a system entry");
  let parentId = persisted.at(-1)!.id;
  const append = (id: string, message: Record<string, unknown>) => {
    const entry = { type: "message", id, parentId, timestamp: new Date().toISOString(), message: { ...message, timestamp: Date.now() } };
    parentId = id;
    return JSON.stringify(entry);
  };
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const reply = { api: "anthropic-messages", provider: "hui-e2e", model: "fixture", usage };
  const lines = [
    append("c0a1b2c3", { role: "user", content: [{ type: "text", text: "Read the fixture" }] }),
    append("c0a1b2c4", { role: "assistant", content: [{ type: "toolCall", id: "tool-continue-read", name: "read", arguments: { path: "fixture.txt" } }], ...reply, stopReason: "toolUse" }),
    append("c0a1b2c5", { role: "toolResult", toolCallId: "tool-continue-read", toolName: "read", content: [{ type: "text", text: "SDK fixture content\n" }], isError: false }),
    append("c0a1b2c6", { role: "system", content: "", sections: { continue_marker: "CONTINUE_SECTION_FIXTURE" } }),
    append("c0a1b2c7", { role: "assistant", content: [], ...reply, stopReason: "aborted", errorMessage: "Request was aborted" }),
  ];
  await writeFile(sessionFile, `${(await readFile(sessionFile, "utf8")).trimEnd()}\n${lines.join("\n")}\n`);

  const resumed = await f.start({ sessionFile });
  const before = completeLines(await readFile(f.log, "utf8")).length;
  settled = nextEvent(resumed, (event) => event.type === "settled");
  await resumed.continueRun!();
  await settled;
  assert(resumed.transcript().some((entry) => entry.kind === "message" && entry.role === "assistant" && entry.text.includes("Tool complete")), JSON.stringify(resumed.transcript()));
  const requests = completeLines(await readFile(f.log, "utf8")).slice(before).map((line) => JSON.parse(line));
  assert.equal(requests.length, 1, "continuing sends exactly one request and no synthetic user prompt");
  assert(JSON.stringify(requests[0]).includes("CONTINUE_SECTION_FIXTURE"), "the persisted loadout change still applies to the continued request");
  assert(!JSON.stringify(requests[0]).includes("Request was aborted"));
});

test("SDK inspects late tools, overrides and load failures; SYSTEM and APPEND compose; questions use RPC", { timeout: 45_000 }, async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.agentDir, "extensions"));
  await writeFile(join(f.agentDir, "extensions", "broken.ts"), 'throw new Error("fixture load failure");');
  await writeFile(join(f.agentDir, "extensions", "tools.ts"), `export default function(pi) {
    const tool = (name) => ({name,label:name,description:"Fixture override",parameters:{type:"object",properties:{path:{type:"string"}}},promptSnippet:"Fixture guidance",execute:async()=>({content:[{type:"text",text:"override"}],details:{}})});
    pi.registerTool(tool("read"));
    pi.on("session_start",()=>pi.registerTool(tool("late_tool")));
    pi.registerCommand("choose",{handler:async(_,ctx)=>{const answer=await ctx.ui.input("SDK question"); ctx.ui.notify("Answered: "+answer,"info");}});
    pi.registerCommand("tools",{handler:async()=>{pi.setActiveTools(["read","late_tool"]);}});
  }`);
  await writeFile(join(f.agentDir, "SYSTEM.md"), "User-owned base prompt");
  await writeFile(join(f.agentDir, "APPEND_SYSTEM.md"), "User addendum");
  await writeFile(join(f.cwd, "AGENTS.md"), "Fixture project instructions");
  const session = await f.start({ noSession: true });
  const info = await session.inspect!();
  assert.equal(info.tools.find((tool) => tool.name === "read")?.description, "Fixture override");
  assert(info.tools.some((tool) => tool.name === "late_tool"));
  assert(info.diagnostics.some((message) => message.includes("fixture load failure")));
  assert.match(info.prompt, /User-owned base prompt/u); assert.doesNotMatch(info.prompt, /coding assistant in HUI/u);
  assert.match(info.prompt, /User addendum/u); assert.match(info.prompt, /Fixture project instructions/u);
  const question = nextEvent(session, (event) => event.type === "question");
  await session.prompt("/choose");
  const q = await question; assert.equal(q.type, "question");
  if (q.type !== "question") throw new Error("Missing question");
  let settled = nextEvent(session, (event) => event.type === "settled");
  const notice = nextEvent(session, (event) => event.type === "notice");
  await session.respondQuestion(q.question.id, { value: "fixture answer" });
  assert.match(JSON.stringify(await notice), /fixture answer/u); await settled;
  await session.prompt("/tools");
  const updated = await session.inspect!();
  assert.notEqual(info.revision, updated.revision);
  assert.deepEqual(updated.tools.filter((tool) => tool.active).map((tool) => tool.name).sort(), ["late_tool", "read"]);
  settled = nextEvent(session, (event) => event.type === "settled");
  await session.prompt("E2E_RICH"); await settled;
  const request = JSON.parse(completeLines(await readFile(f.log, "utf8"))[0]!);
  assert.deepEqual(request.tools.map((tool: { name: string }) => tool.name).sort(), ["late_tool", "read"]);
  assert.match(JSON.stringify(request.system), /Fixture guidance/u);
  assert.doesNotMatch(JSON.stringify(request.system), /Maintain the current task progress/u);
  assert.equal(session.sessionFile, undefined);
});

test("SDK safe probes skip broken packages and never create transcripts; unknown models fail explicitly", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.agentDir, "settings.json"), JSON.stringify({ packages: ["npm:nonexistent-hui-fixture-do-not-install"] }));
  const session = await f.start({ safeProbe: true, noSession: true });
  assert.equal(session.sessionFile, undefined);
  assert.equal((await session.inspect!()).tools.length, 8);
  assert(!(await readdir(f.agentDir)).includes("sessions"));
  await assert.rejects(f.start({ safeProbe: true, noSession: true, model: "hui-e2e/missing" }), /Unknown PI model/u);
});

test("SDK resumes long worktree transcripts without putting the launch in the worker's argv", { timeout: 45_000 }, async (t) => {
  // Endpoint security agents can SIGKILL an exec whose cwd plus one argument
  // reaches MAXPATHLEN (1024); a long worktree and transcript path crossed it.
  const f = await fixture(t);
  const cwd = join(f.cwd, "long-worktree-".padEnd(150, "x"));
  await mkdir(cwd);
  const first = await f.start({ cwd });
  const settled = nextEvent(first, (event) => event.type === "settled");
  await first.prompt("Create the transcript"); await settled;
  const sessionFile = first.sessionFile;
  assert(sessionFile);
  first.dispose();
  const resumed = await f.start({ cwd, sessionFile, title: "Long worktree fixture" });
  assert.equal(resumed.sessionFile, sessionFile);
  const args = execFileSync("ps", ["-ww", "-o", "args=", "-p", String(resumed.processId)], { encoding: "utf8" });
  assert.match(args.trim(), /pi-sdk-worker\.ts$/u, "nothing may follow the worker's script path");
});

for (const backend of ["sdk", "cli"] as const) {
  test(`${backend} discovers the default generator, persists opt-out and respects project overrides`, { timeout: 60_000 }, async (t) => {
    const f = await fixture(t);
    const bundled = bundledSkills[0];
    const settingsPath = join(configDir, "hui", "settings.json");
    await mkdir(join(configDir, "hui"), { recursive: true });
    await writeFile(settingsPath, "{}");
    t.onTestFinished(() => writeFile(settingsPath, "{}"));
    // PI's CLI deliberately excludes untrusted project resources. Establish
    // trust only inside this throwaway fixture, not by changing HUI policy.
    const piSettingsPath = join(f.agentDir, "settings.json");
    await writeFile(piSettingsPath, JSON.stringify({ ...JSON.parse(await readFile(piSettingsPath, "utf8")), defaultProjectTrust: "always" }));
    const piSettings = await readFile(join(f.agentDir, "settings.json"), "utf8");
    const enabled = await f.start({ backend, noSession: true });
    assert((await enabled.listCommands()).some((command) => command.name === `skill:${bundled.name}`));
    let settled = nextEvent(enabled, (event) => event.type === "settled");
    await enabled.prompt("Default discovery fixture"); await settled;
    let requests = completeLines(await readFile(f.log, "utf8")).map((line) => JSON.parse(line));
    assert(JSON.stringify(requests.at(-1).system).includes(bundled.path));

    await writeFile(settingsPath, JSON.stringify({ disabledSkills: [{ name: bundled.name, path: bundled.preferencePath }] }));
    const disabled = await f.start({ backend, noSession: true });
    assert(!(await disabled.listCommands()).some((command) => command.name === `skill:${bundled.name}`));
    // An already-running runtime is not implicitly restarted by a preference edit.
    assert((await enabled.listCommands()).some((command) => command.name === `skill:${bundled.name}`));
    settled = nextEvent(disabled, (event) => event.type === "settled");
    await disabled.prompt("Disabled discovery fixture"); await settled;
    requests = completeLines(await readFile(f.log, "utf8")).map((line) => JSON.parse(line));
    assert(!JSON.stringify(requests.at(-1).system).includes(bundled.path));

    const overrideDir = join(f.cwd, ".agents", "skills", bundled.name);
    await mkdir(overrideDir, { recursive: true });
    const overridePath = join(overrideDir, "SKILL.md");
    const override = `---\nname: ${bundled.name}\ndescription: Project-owned generator override\n---\nProject generator.\n`;
    await writeFile(overridePath, override);
    // The default's opt-out must not suppress independently owned same-name skills.
    const overridden = await f.start({ backend, noSession: true });
    assert((await overridden.listCommands()).some((command) => command.name === `skill:${bundled.name}`));
    await writeFile(settingsPath, "{}");
    const restored = await f.start({ backend, noSession: true });
    assert.equal((await restored.listCommands()).filter((command) => command.name === `skill:${bundled.name}`).length, 1);
    settled = nextEvent(restored, (event) => event.type === "settled");
    await restored.prompt("Override discovery fixture"); await settled;
    requests = completeLines(await readFile(f.log, "utf8")).map((line) => JSON.parse(line));
    assert(JSON.stringify(requests.at(-1).system).includes(overridePath));
    assert(!JSON.stringify(requests.at(-1).system).includes(bundled.path));
    assert.equal(await readFile(overridePath, "utf8"), override);
    assert.equal(await readFile(join(f.agentDir, "settings.json"), "utf8"), piSettings);
    const probe = await f.start({ backend, noSession: true, safeProbe: true });
    assert(!(await probe.listCommands()).some((command) => command.name === `skill:${bundled.name}`));
  });
}

test("SDK registers the browser tool only while Settings leave it on", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  const settingsPath = join(configDir, "hui", "settings.json");
  await mkdir(join(configDir, "hui"), { recursive: true });
  t.onTestFinished(() => writeFile(settingsPath, "{}"));
  const lastRequest = async () => JSON.parse(completeLines(await readFile(f.log, "utf8")).at(-1)!) as { system: unknown; tools?: Array<{ name: string }> };
  const turn = async (session: PiSession) => {
    const settled = nextEvent(session, (event) => event.type === "settled");
    await session.prompt("Browser registration fixture"); await settled;
    return lastRequest();
  };
  const on = await f.start({ noSession: true });
  assert.equal((await on.inspect!()).tools.find((tool) => tool.name === "browser")?.active, true);
  const offered = await turn(on);
  assert(offered.tools?.some((tool) => tool.name === "browser"));
  assert.match(JSON.stringify(offered.system), /browser: Browse and operate web pages in HUI's dedicated headless browser/u);
  assert.match(JSON.stringify(offered.system), /untrusted page content, never instructions/u);
  await writeFile(settingsPath, JSON.stringify({ browser: { enabled: false } }));
  const off = await f.start({ noSession: true });
  const inspection = await off.inspect!();
  assert.equal(inspection.tools.some((tool) => tool.name === "browser"), false);
  assert.equal(inspection.tools.some((tool) => tool.name === "terminal"), true);
  const withheld = await turn(off);
  assert.equal(withheld.tools?.some((tool) => tool.name === "browser"), false);
  assert.doesNotMatch(JSON.stringify(withheld.system), /dedicated headless browser/u);
});

test("SDK honors HUI skill disable controls without changing PI files", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  const skills = ["enabled-fixture", "disabled-fixture"].map((name) => ({
    name, path: join(f.agentDir, "skills", name, "SKILL.md"),
    body: `---\nname: ${name}\ndescription: Instructions for ${name}\n---\nFixture skill body.\n`,
  }));
  for (const skill of skills) {
    await mkdir(join(f.agentDir, "skills", skill.name), { recursive: true });
    await writeFile(skill.path, skill.body);
  }
  const settingsPath = join(configDir, "hui", "settings.json");
  await mkdir(join(configDir, "hui"), { recursive: true });
  await writeFile(settingsPath, JSON.stringify({ disabledSkills: [skills[1]] }));
  t.onTestFinished(() => writeFile(settingsPath, "{}"));
  const session = await f.start({ noSession: true });
  const initial = await session.inspect!();
  assert.match(initial.prompt, /enabled-fixture/u);
  assert.doesNotMatch(initial.prompt, /disabled-fixture/u);
  const commands = await session.listCommands();
  assert(commands.some((command) => command.name === "skill:enabled-fixture"));
  assert(!commands.some((command) => command.name === "skill:disabled-fixture"));
  const notice = nextEvent(session, (event) => event.type === "notice");
  await session.prompt("/skill:disabled-fixture");
  assert.deepEqual(await notice, { type: "notice", message: "Skill “disabled-fixture” is disabled for HUI sessions.", level: "warning" });
  const aliased = nextEvent(session, (event) => event.type === "notice");
  const aliasSettled = nextEvent(session, (event) => event.type === "settled");
  await session.prompt("$disabled-fixture now");
  assert.deepEqual(await aliased, { type: "notice", message: "Skill “disabled-fixture” is disabled for HUI sessions.", level: "warning" });
  await aliasSettled;
  assert.equal(session.isStreaming, false, "the composer's $name form settles like the /skill command");
  await assert.rejects(readFile(f.log, "utf8"), { code: "ENOENT" });
  const settled = nextEvent(session, (event) => event.type === "settled");
  await session.prompt("Skill filtering fixture"); await settled;
  const request = JSON.parse(completeLines(await readFile(f.log, "utf8"))[0]!);
  assert.match(JSON.stringify(request.system), /enabled-fixture/u);
  assert.doesNotMatch(JSON.stringify(request.system), /disabled-fixture/u);
  for (const skill of skills) assert.equal(await readFile(skill.path, "utf8"), skill.body);
});

test("SDK reload picks up skills added after the session started", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  const session = await f.start({ noSession: true });
  assert(!(await session.listCommands()).some((command) => command.name === "skill:late-fixture"));
  await mkdir(join(f.agentDir, "skills", "late-fixture"), { recursive: true });
  await writeFile(join(f.agentDir, "skills", "late-fixture", "SKILL.md"), "---\nname: late-fixture\ndescription: Added later\n---\nBody.\n");
  await session.reload!();
  assert((await session.listCommands()).some((command) => command.name === "skill:late-fixture"));
  assert.match((await session.inspect!()).prompt, /late-fixture/u);
});

test("SDK excludes disabled packages and direct extensions before their code loads", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  const pluginDir = join(f.agentDir, "fixture-plugin");
  const marker = join(f.dir, "plugin-loaded.txt");
  const directMarker = join(f.dir, "direct-extension-loaded.txt");
  await mkdir(join(pluginDir, "extensions"), { recursive: true });
  await writeFile(join(pluginDir, "package.json"), JSON.stringify({
    name: "fixture-plugin",
    pi: { extensions: ["./extensions/plugin.mjs"] },
  }));
  await writeFile(join(pluginDir, "extensions", "plugin.mjs"), `
    import { writeFileSync } from "node:fs";
    writeFileSync(${JSON.stringify(marker)}, "loaded");
    export default function(pi) {
      pi.registerTool({name:"disabled_plugin_tool",label:"disabled",description:"must not load",parameters:{type:"object",properties:{}},execute:async()=>({content:[],details:{}})});
    }
  `);
  await writeFile(join(f.agentDir, "direct-extension.mjs"), `
    import { writeFileSync } from "node:fs";
    writeFileSync(${JSON.stringify(directMarker)}, "loaded");
    export default function(pi) {
      pi.registerTool({name:"disabled_direct_tool",label:"disabled",description:"must not load",parameters:{type:"object",properties:{}},execute:async()=>({content:[],details:{}})});
    }
  `);
  const piSettings = JSON.stringify({
    defaultProvider: "hui-e2e",
    defaultModel: "fixture",
    packages: ["./fixture-plugin"],
    extensions: ["./direct-extension.mjs"],
  });
  await writeFile(join(f.agentDir, "settings.json"), piSettings);
  const settingsPath = join(configDir, "hui", "settings.json");
  await mkdir(join(configDir, "hui"), { recursive: true });
  await writeFile(settingsPath, JSON.stringify({ disabledPlugins: [
    { id: configuredResourceId("package", "./fixture-plugin"), name: "fixture-plugin", kind: "package" },
    { id: configuredResourceId("extension", "./direct-extension.mjs"), name: "direct-extension.mjs", kind: "extension" },
  ] }));
  t.onTestFinished(() => writeFile(settingsPath, "{}"));

  const session = await f.start({ noSession: true });
  const toolNames = (await session.inspect!()).tools.map((tool) => tool.name);
  assert(!toolNames.includes("disabled_plugin_tool"));
  assert(!toolNames.includes("disabled_direct_tool"));
  await assert.rejects(readFile(marker, "utf8"), { code: "ENOENT" });
  await assert.rejects(readFile(directMarker, "utf8"), { code: "ENOENT" });
  assert.equal(await readFile(join(f.agentDir, "settings.json"), "utf8"), piSettings);
  await assert.rejects(f.start({ backend: "cli", noSession: true }), /requires the PI SDK backend/u);
});

test("SDK secret_request gives the agent a file the operator filled, never the value, and Stop cancels one", { timeout: 45_000 }, async (t) => {
  const f = await fixture(t);
  const changed: Array<() => void> = [];
  const requests = new SecretRequests({ onChange: () => { for (const wake of changed.splice(0)) wake(); } });
  const files = new SecretFiles(f.dir);
  t.onTestFinished(() => { requests.dispose(); files.dispose(); });
  const pending = async (count: number) => {
    while (requests.questions("secret-sdk").length !== count) await new Promise<void>((wake) => changed.push(wake));
    return requests.questions("secret-sdk");
  };
  registerAgentToolHandler(async ({ callerSessionId, action, params, signal }) => {
    if (action !== "secret_request") throw new Error(`Unexpected HUI tool ${action}.`);
    return files.deliver(await requests.request(callerSessionId, params, signal));
  });
  const session = await f.start({ huiSessionId: "secret-sdk" });
  let settled = nextEvent(session, (event) => event.type === "settled");
  await session.prompt("E2E_SECRET_REQUEST");
  const [question] = await pending(1);
  assert.equal(question?.title, "Fixture API key");
  requests.answer("secret-sdk", question!.id, { value: "sk-fixture-0123456789" });
  await settled;
  const history = JSON.stringify(session.transcript());
  assert.match(history, /Secret length: 21/u, "the agent's next command read the file");
  assert.match(history, /used the secret in a command without seeing it/u);
  const stored = await readFile(session.sessionFile!, "utf8");
  assert.match(stored, /Fixture API key/u, "the transcript keeps the request itself");
  for (const text of [history, stored, await readFile(f.log, "utf8")]) {
    assert(!text.includes("sk-fixture"), "neither the transcript nor the model ever holds the value");
  }

  settled = nextEvent(session, (event) => event.type === "settled");
  await session.prompt("E2E_SECRET_REQUEST again");
  await pending(1);
  await session.abort(); await settled;
  await pending(0);
});

test("SDK abort and steer/follow-up settle without losing queue messages", { timeout: 45_000 }, async (t) => {
  const f = await fixture(t);
  const session = await f.start({ noSession: true });
  let prefix = nextEvent(session, (event) => event.type === "text" && event.delta.includes("Abort prefix"));
  await session.prompt("E2E_ABORT"); await prefix;
  let settled = nextEvent(session, (event) => event.type === "settled");
  await session.abort(); await settled;
  assert.equal(session.isStreaming, false);
  // The browser shows a prompt sent this run without an entry id; PI counts it from the end.
  await session.rewind!({ userFromEnd: 0 }, { excludeUserMessage: true });
  assert.deepEqual(session.transcript(), []);
  prefix = nextEvent(session, (event) => event.type === "text" && event.delta.includes("Replay prefix"));
  await session.prompt("E2E_REPLAY"); await prefix;
  await session.steer("Steering fixture"); await session.followUp("Follow-up fixture");
  assert.deepEqual(session.pendingQueue(), { steering: ["Steering fixture"], followUp: ["Follow-up fixture"] });
  settled = nextEvent(session, (event) => event.type === "settled");
  await fetch(`${f.baseUrl}/control/release-replay`, { method: "POST" }); await settled;
  const history = JSON.stringify(session.transcript());
  assert.match(history, /Steering fixture/u); assert.match(history, /Follow-up fixture/u);
  assert.deepEqual(session.pendingQueue(), { steering: [], followUp: [] });
});

test("CLI fallback and SDK can resume each other's PI transcripts", { timeout: 45_000 }, async (t) => {
  const f = await fixture(t);
  const cli = await f.start({ backend: "cli" });
  assert.equal(cli.inspect, undefined);
  let settled = nextEvent(cli, (event) => event.type === "settled");
  await cli.prompt("CLI compatibility turn"); await settled;
  const file = cli.sessionFile;
  assert(file);
  const history = cli.transcript();
  cli.dispose();
  const sdk = await f.start({ sessionFile: file });
  assertRestoredTranscript(sdk.transcript(), history);
  settled = nextEvent(sdk, (event) => event.type === "settled");
  await sdk.prompt("SDK compatibility turn"); await settled;
  const sdkHistory = sdk.transcript();
  sdk.dispose();
  const fallback = await f.start({ backend: "cli", sessionFile: file });
  assertRestoredTranscript(fallback.transcript(), sdkHistory);
  settled = nextEvent(fallback, (event) => event.type === "settled");
  await fallback.prompt("Fallback compatibility turn"); await settled;
  const { metrics, ...last } = fallback.transcript().at(-1)!;
  assert(last.kind === "message" && last.entryId, JSON.stringify(last));
  assert.deepEqual(last, { kind: "message", role: "assistant", text: "Fixture response.", entryId: last.entryId });
  assert.equal(metrics?.outputTokens, 1);
  assert.equal(metrics?.inputTokens, 1);
  assert.equal(typeof metrics?.completedAt, "number");
  assert.equal(typeof metrics?.durationMs, "number");
});

test("SDK compaction persists through resume and a crashing extension only exits its worker", { timeout: 45_000 }, async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.agentDir, "extensions"));
  await writeFile(join(f.agentDir, "extensions", "lifecycle.ts"), `export default function(pi) {
    pi.registerCommand("fixture-compact",{handler:async(_,ctx)=>{ctx.compact({onComplete:()=>ctx.ui.notify("Compaction complete","info"),onError:(error)=>ctx.ui.notify("Compaction failed: "+error.message,"error")});}});
    pi.registerCommand("fixture-crash",{handler:async()=>process.exit(17)});
  }`);
  await writeFile(join(f.agentDir, "settings.json"), JSON.stringify({ defaultProvider: "hui-e2e", defaultModel: "fixture", compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1024 } }));
  const session = await f.start();
  for (const message of ["First compaction fixture turn", "Second compaction fixture turn"]) {
    const settled = nextEvent(session, (event) => event.type === "settled");
    await session.prompt(message); await settled;
  }
  const notice = nextEvent(session, (event) => event.type === "notice" && event.message.startsWith("Compaction "));
  await session.prompt("/fixture-compact");
  assert.deepEqual(await notice, { type: "notice", message: "Compaction complete", level: "info" });
  const file = session.sessionFile!;
  assert(completeLines(await readFile(file, "utf8")).some((line) => JSON.parse(line).type === "compaction"));
  session.dispose();
  const resumed = await f.start({ sessionFile: file });
  const settled = nextEvent(resumed, (event) => event.type === "settled");
  await resumed.prompt("After compaction"); await settled;
  assert.equal(resumed.transcript().at(-1)?.kind, "message");
  const exit = new Promise<void>((resolve) => resumed.onExit(resolve));
  await assert.rejects(resumed.prompt("/fixture-crash"), /exited/u); await exit;
  await assert.rejects(resumed.inspect!(), /unavailable/u);
  assert.equal(resumed.running, false);
  const replacement = await f.start({ sessionFile: file });
  assert.equal(replacement.running, true);
});

const shown = (session: PiSession) => session.transcript().map((entry) =>
  entry.kind === "message" ? `${entry.role}:${entry.text.slice(0, 13)}` : entry.kind);

function entryId(session: PiSession, text: string): string {
  const entry = session.transcript().find((item) => item.kind === "message" && item.text.startsWith(text));
  assert(entry?.kind === "message" && entry.entryId, text);
  return entry.entryId;
}

/** The provider request that carried `marker`, as searchable text. */
async function requestWith(log: string, marker: string): Promise<string> {
  const request = completeLines(await readFile(log, "utf8")).findLast((line) => line.includes(marker));
  assert(request, marker);
  return request;
}

test("SDK keeps the whole branch visible across compaction and rewinds to any message by entry id", { timeout: 45_000 }, async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.agentDir, "extensions"));
  await copyFile(new URL("../../e2e/fixtures/compaction-extension.ts", import.meta.url), join(f.agentDir, "extensions", "compaction.ts"));
  // The long third turn alone exceeds keepRecentTokens: PI keeps it verbatim and summarizes the first two.
  await writeFile(join(f.agentDir, "settings.json"), JSON.stringify({ defaultProvider: "hui-e2e", defaultModel: "fixture", compaction: { enabled: true, keepRecentTokens: 400, reserveTokens: 1024 } }));
  const session = await f.start();
  for (const message of ["COMPACT_ONE", "COMPACT_TWO", `COMPACT_THREE ${"kept ".repeat(400)}`]) {
    const settled = nextEvent(session, (event) => event.type === "settled");
    await session.prompt(message); await settled;
  }
  const compacted = nextEvent(session, (event) => event.type === "settled");
  await session.prompt("/fixture-compact"); await compacted;
  assert.equal(shown(session).at(-1), "compaction", "the settle after compaction already shows it");
  const file = session.sessionFile!;
  session.dispose();
  // Each rewind below starts from the compacted branch.
  const copy = join(f.dir, "compacted.jsonl");
  await copyFile(file, copy);

  const resumed = await f.start({ sessionFile: file });
  assert.deepEqual(shown(resumed), [
    "user:COMPACT_ONE", "assistant:Fixture respo", "user:COMPACT_TWO", "assistant:Fixture respo",
    "user:COMPACT_THREE", "assistant:Fixture respo", "compaction",
  ]);
  const marker = resumed.transcript().at(-1);
  assert(marker?.kind === "compaction" && marker.summary.includes("FIXTURE_SUMMARY") && marker.tokensBefore > 0, JSON.stringify(marker));

  // Behind the cut the summary describes later work, so PI must send the original messages.
  await resumed.rewind!(entryId(resumed, "COMPACT_TWO"), { excludeUserMessage: true });
  assert.deepEqual(shown(resumed), ["user:COMPACT_ONE", "assistant:Fixture respo"]);
  let settled = nextEvent(resumed, (event) => event.type === "settled");
  await resumed.prompt("AFTER_CUT"); await settled;
  let request = await requestWith(f.log, "AFTER_CUT");
  assert.match(request, /COMPACT_ONE/u);
  assert.doesNotMatch(request, /FIXTURE_SUMMARY/u);
  resumed.dispose();

  // Inside the kept window the summary still covers everything before the target.
  const kept = await f.start({ sessionFile: copy });
  await kept.rewind!(entryId(kept, "COMPACT_THREE"), { excludeUserMessage: true });
  assert.deepEqual(shown(kept), ["user:COMPACT_ONE", "assistant:Fixture respo", "user:COMPACT_TWO", "assistant:Fixture respo", "compaction"]);
  // The summary is the whole context now; Continue resumes from it.
  settled = nextEvent(kept, (event) => event.type === "settled");
  await kept.continueRun!(); await settled;
  request = await requestWith(f.log, "FIXTURE_SUMMARY");
  assert.doesNotMatch(request, /COMPACT_ONE/u);
  settled = nextEvent(kept, (event) => event.type === "settled");
  await kept.prompt("AFTER_KEPT"); await settled;
  request = await requestWith(f.log, "AFTER_KEPT");
  assert.match(request, /FIXTURE_SUMMARY/u);
  assert.doesNotMatch(request, /COMPACT_ONE/u);
});

test("SDK continues past a failure PI retried and then compacted, keeping the summary", { timeout: 45_000 }, async (t) => {
  const f = await fixture(t);
  // PI hides each failed attempt behind a context edit before retrying it and
  // may compact right after the final failure, so neither the leaf nor the
  // entry before it is the message to continue from.
  const at = new Date().toISOString();
  const failed = { role: "assistant", content: [], api: "anthropic-messages", provider: "hui-e2e", model: "fixture", stopReason: "error", errorMessage: "Request timed out.", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  const file = join(f.dir, "retried.jsonl");
  await writeFile(file, [
    { type: "session", version: 3, id: "retried", timestamp: at, cwd: f.cwd },
    { type: "message", id: "old", parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: "SUMMARIZED_PROMPT" }], timestamp: Date.now() } },
    { type: "message", id: "done", parentId: "old", timestamp: at, message: { ...failed, stopReason: "stop", errorMessage: undefined, content: [{ type: "text", text: "Done." }] } },
    { type: "message", id: "user", parentId: "done", timestamp: at, message: { role: "user", content: [{ type: "text", text: "RETRIED_PROMPT" }], timestamp: Date.now() } },
    { type: "message", id: "first", parentId: "user", timestamp: at, message: failed },
    { type: "context_edit", id: "hide-first", parentId: "first", timestamp: at, targetId: "first", replacement: null },
    { type: "message", id: "final", parentId: "hide-first", timestamp: at, message: failed },
    { type: "compaction", id: "compacted", parentId: "final", timestamp: at, summary: "SYNTH_SUMMARY", firstKeptEntryId: "user", tokensBefore: 100 },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const session = await f.start({ sessionFile: file });
  assert.deepEqual(shown(session), ["user:SUMMARIZED_PR", "assistant:Done.", "user:RETRIED_PROMP", "error", "compaction"]);
  const settled = nextEvent(session, (event) => event.type === "settled");
  await session.continueRun!(); await settled;
  const request = await requestWith(f.log, "RETRIED_PROMPT");
  assert.match(request, /SYNTH_SUMMARY/u);
  assert.doesNotMatch(request, /SUMMARIZED_PROMPT/u);
  assert.deepEqual(shown(session), ["user:SUMMARIZED_PR", "assistant:Done.", "user:RETRIED_PROMP", "compaction", "assistant:Fixture respo"]);
});

/** Every compaction event and settle the session emits, in order. */
function compactionLog(session: PiSession): string[] {
  const log: string[] = [];
  session.subscribe((event) => {
    if (event.type === "compaction_start") log.push(`start:${event.reason}`);
    else if (event.type === "compaction_end") log.push(`end:${event.reason}:${event.outcome}${event.message ? `:${event.message}` : ""}`);
    else if (event.type === "settled") log.push("settled");
  });
  return log;
}

test("SDK /compact passes focus text, reports failure and cancellation, and settles after each", { timeout: 45_000 }, async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.agentDir, "settings.json"), JSON.stringify({ defaultProvider: "hui-e2e", defaultModel: "fixture", compaction: { enabled: true, keepRecentTokens: 400, reserveTokens: 1024 } }));
  const session = await f.start({ noSession: true });
  for (const message of ["COMPACT_ONE", "COMPACT_TWO", `COMPACT_THREE ${"kept ".repeat(400)}`]) {
    const settled = nextEvent(session, (event) => event.type === "settled");
    await session.prompt(message); await settled;
  }
  const log = compactionLog(session);

  let settled = nextEvent(session, (event) => event.type === "settled");
  await session.compact!("keep the API decisions"); await settled;
  assert.deepEqual(log, ["start:manual", "end:manual:done", "settled"]);
  assert.match(await requestWith(f.log, "context checkpoint summary"), /keep the API decisions/u);
  assert.equal(session.transcript().at(-1)?.kind, "compaction");

  settled = nextEvent(session, (event) => event.type === "settled");
  await session.compact!(); await settled;
  assert.deepEqual(log.slice(3), ["start:manual", "end:manual:failed:Already compacted", "settled"]);

  // A held summary keeps the compaction running until Stop cancels it. The
  // marker must be summarized, so a long turn follows it into the kept window.
  for (const message of ["E2E_SLOW_COMPACT", `LONG ${"kept ".repeat(400)}`]) {
    settled = nextEvent(session, (event) => event.type === "settled");
    await session.prompt(message); await settled;
  }
  const ready = fetch(`${f.baseUrl}/control/wait-replay-ready`);
  settled = nextEvent(session, (event) => event.type === "settled");
  await session.compact!();
  await ready;
  await session.abort(); await settled;
  assert.deepEqual(log.slice(8), ["start:manual", "end:manual:cancelled", "settled"]);
  assert.notEqual(session.transcript().at(-1)?.kind, "compaction");
});

test("SDK reports PI's automatic compaction after a turn and settles again once it is written", { timeout: 45_000 }, async (t) => {
  const f = await fixture(t);
  // Any context exceeds window - reserve, so PI compacts after the first reply.
  await writeFile(join(f.agentDir, "settings.json"), JSON.stringify({ defaultProvider: "hui-e2e", defaultModel: "fixture", compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 31_999 } }));
  const session = await f.start({ noSession: true });
  const log = compactionLog(session);
  // The turn's own settle may land after compaction_end; wait for the one with the summary.
  const compacted = nextEvent(session, (event) => event.type === "settled" && session.transcript().at(-1)?.kind === "compaction");
  await session.prompt("AUTO_COMPACT_ONE");
  await compacted;
  assert.deepEqual(log.filter((item) => item !== "settled"), ["start:threshold", "end:threshold:done"]);
});

test("SDK accepts a prompt PI compacts before and stays busy until that prompt's reply ends", { timeout: 45_000 }, async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.agentDir, "settings.json"), JSON.stringify({ defaultProvider: "hui-e2e", defaultModel: "fixture", compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 31_999 } }));
  const session = await f.start({ noSession: true });
  const log = compactionLog(session);
  const held = () => fetch(`${f.baseUrl}/control/wait-replay-ready`);
  const release = () => fetch(`${f.baseUrl}/control/release-replay`, { method: "POST" });

  // PI compacts after this turn; the held summary is cancelled, so the context stays full.
  let ready = held();
  let settled = nextEvent(session, (event) => event.type === "settled");
  await session.prompt("E2E_SLOW_COMPACT one"); await settled; await ready;
  settled = nextEvent(session, (event) => event.type === "settled");
  await session.abort(); await settled;
  assert.deepEqual(log.filter((item) => item !== "settled"), ["start:threshold", "end:threshold:cancelled"]);

  // So PI compacts before the next prompt, answering it only after the summary.
  ready = held();
  const prompted = session.prompt("E2E_REPLAY second");
  await ready;
  await prompted;
  const beforeReply = log.length;
  const replying = nextEvent(session, (event) => event.type === "text" && event.delta.includes("Replay prefix"));
  await release(); await replying;
  assert.equal(session.isStreaming, true);
  assert.deepEqual(log.slice(beforeReply), ["end:threshold:done"]);
  settled = nextEvent(session, (event) => event.type === "settled");
  await release(); await settled;
  assert(JSON.stringify(session.transcript()).includes("replay suffix"));
});
