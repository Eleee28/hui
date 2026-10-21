import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";
import { CONTINUE_PROMPT } from "../agent-tools/subagent-completion.ts";
import type { SessionRecord } from "./sessions.ts";

// HUI's configuration directory is resolved at import time; never read the operator's own.
const configDir = await mkdtemp(join(tmpdir(), "hui-activity-config-"));
process.env["XDG_CONFIG_HOME"] = configDir;
afterAll(() => rm(configDir, { recursive: true, force: true }));
const { activityRange, durableScan, readSessionActivity, repositoryName } = await import("./activity.ts");
const { DurableHost, durableContext } = await import("../runtimes/durable-host.ts");
const { AssistantEntry, CompactionEntry, ToolResultEntry, UserEntry } = await import("@earendil-works/pi-durable");

const MINUTE = 60_000;
const T = Date.UTC(2026, 8, 28, 9); // Monday 09:00 UTC
const userMessage = (minute: number, text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: T + minute * MINUTE });
const user = (minute: number, text: string) => ({ kind: UserEntry.kind, model: [userMessage(minute, text)] });
const answer = (minute: number, model = "claude") => ({ kind: AssistantEntry.kind, model: [{ role: "assistant", provider: "anthropic", model, content: [], timestamp: T + minute * MINUTE }] });
const tool = (minute: number) => ({ kind: ToolResultEntry.kind, model: [{ role: "toolResult", content: [], timestamp: T + minute * MINUTE }] });

function session(id: string, conversation: number | undefined, extra: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id, title: `Session ${id}`, group: "hui", cwd: "/repo", tool: "durable",
    ...(conversation === undefined ? {} : { piSessionFile: `durable:${conversation}` }),
    createdAt: new Date(T - 86_400_000).toISOString(), updatedAt: new Date(T).toISOString(), ...extra,
  };
}

/** A scan over fixed conversations that records how many entries were read. */
function fakeScan(conversations: Record<number, { kind: string; model: unknown[] }[]>) {
  const read: Record<number, number> = {};
  const scan = async function* (id: number) {
    read[id] = 0;
    for (const entry of [...(conversations[id] ?? [])].reverse()) {
      read[id]++;
      yield entry as never;
    }
  };
  return { options: { scan, project: async (cwd: string) => `project of ${cwd}` }, read };
}

test("messages split into blocks at silences over 30 minutes", async () => {
  const { options } = fakeScan({ 1: [
    user(0, CONTINUE_PROMPT), answer(1), tool(20),
    // A compaction summary is a user message, but neither work nor the operator's words.
    { kind: CompactionEntry.kind, model: [userMessage(40, "Summary of earlier work")] },
    user(45, "Add the calendar tab"), answer(46, "opus"),
    { kind: CompactionEntry.kind, model: [userMessage(100, "Summary placed later")] },
    user(120, "Then fix the popover"), answer(121),
  ] });
  const { sessions } = await readSessionActivity([session("a", 1)], T, T + 86_400_000, options);
  assert.deepEqual(sessions, [{ id: "a", title: "Session a", group: "hui", project: "project of /repo", blocks: [
    // A HUI control prompt counts as time but is not what the operator asked.
    { start: T, end: T + 46 * MINUTE, model: "anthropic/opus", firstMessage: "Add the calendar tab" },
    { start: T + 120 * MINUTE, end: T + 121 * MINUTE, model: "anthropic/claude", firstMessage: "Then fix the popover" },
  ] }]);
});

test("only top-level Durable sessions with blocks in the range are listed", async () => {
  const { options } = fakeScan({ 1: [user(0, "one")], 2: [user(0, "two")], 3: [user(0, "three")], 4: [user(-120, "before")] });
  const { sessions } = await readSessionActivity([
    session("top", 1, { archived: true }),
    session("child", 2, { parentId: "top" }),
    session("legacy", undefined, { tool: "pi", piSessionFile: "/pi/session.jsonl" }),
    session("later", 3, { createdAt: new Date(T + 86_400_000).toISOString() }),
    session("earlier", 4),
  ], T - 10 * MINUTE, T + 86_400_000, options);
  assert.deepEqual(sessions.map(({ id, archived }) => ({ id, archived })), [{ id: "top", archived: true }]);
});

test("the scan stops at the first silence before the range, keeping the start of a block that crosses it", async () => {
  const history = [user(-600, "old work"), answer(-599), user(-20, "late night"), answer(-5), tool(10)];
  const { options, read } = fakeScan({ 1: history });
  const { sessions } = await readSessionActivity([session("a", 1)], T, T + 86_400_000, options);
  assert.deepEqual(sessions[0]?.blocks, [{ start: T - 20 * MINUTE, end: T + 10 * MINUTE, model: "anthropic/claude", firstMessage: "late night" }]);
  assert.equal(read[1], 4, "the entry after the silence ends the scan; older history is not read");
});

test("range parameters are bounded epoch milliseconds", () => {
  const range = (query: string) => activityRange(new URLSearchParams(query));
  assert.deepEqual(range(`from=${T}&to=${T + 7 * 86_400_000}`), { from: T, to: T + 7 * 86_400_000 });
  for (const query of ["", `from=${T}`, `from=${T}&to=${T}`, `from=${T}&to=${T + 32 * 86_400_000}`, "from=-1&to=5", "from=1.5&to=9", "from=x&to=9", "from=&to=9", "from=1e3&to=2e3", "from=0x10&to=99"]) {
    assert.equal(range(query), undefined, query);
  }
});

test("a Durable conversation's stored messages become its blocks", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hui-activity-durable-"));
  const agentDir = join(dir, "agent");
  await mkdir(agentDir);
  const host = new DurableHost({ dir: join(dir, "store"), agentDir, resume: false, lookupCaller: async () => undefined });
  host.configureDurableBots(null);
  t.onTestFinished(async () => { await host.close(); await rm(dir, { recursive: true, force: true }); });
  const harness = await host.open();
  // The day before is history the scan must stop at: newest entries come first.
  const entries = [user(-1440, "Yesterday's work"), user(0, "Build the week view"), answer(2), tool(3), user(90, "Polish it")];
  const conversation = await harness.createConversation({
    ownership: { kind: "ownerless" },
    agent: { cwd: dir },
    init: async (tx, id) => {
      for (const { kind, model } of entries) {
        await tx.appendEntry(id, { kind, model: model as never, ...(kind === ToolResultEntry.kind ? { data: { diagnostics: [] } } : {}) });
      }
    },
  }, durableContext);
  const { sessions } = await readSessionActivity([session("a", conversation.id)], T, T + 86_400_000, { scan: durableScan(host), project: async () => "hui" });
  assert.deepEqual(sessions[0]?.blocks, [
    { start: T, end: T + 3 * MINUTE, model: "anthropic/claude", firstMessage: "Build the week view" },
    { start: T + 90 * MINUTE, end: T + 90 * MINUTE, firstMessage: "Polish it" },
  ]);
});

test("a session's project is its repository, shared by its worktrees and subdirectories", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hui-activity-repos-"));
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const repo = join(dir, "checkout-api");
  await mkdir(join(repo, "services", "charge"), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  git("init", "-q");
  git("-c", "user.email=e2e@hui.test", "-c", "user.name=HUI", "commit", "-q", "--allow-empty", "-m", "init");
  git("worktree", "add", "-q", join(dir, "elsewhere", "retry-fix"));
  await mkdir(join(dir, "notes"));
  await mkdir(join(dir, "hui-worktrees", "billing-abcdefabcdef", "left"), { recursive: true });
  await mkdir(join(dir, "hui-worktrees", "billing-abcdefabcdef", "right"), { recursive: true });
  // HUI's worktrees: `<checkout>-<hash>/<branch>`, made from a repository or from another worktree.
  const worktrees = join(dir, "hui-worktrees");
  git("worktree", "add", "-q", join(worktrees, "checkout-api-0123456789ab", "dani--retries"));
  const name = (cwd: string) => repositoryName(cwd, worktrees, join(dir, "home"));
  assert.deepEqual(await Promise.all([
    name(join(repo, "services", "charge")),
    name(join(dir, "elsewhere", "retry-fix")),
    // Removed worktrees: of a repository, and of a worktree that still exists.
    name(join(worktrees, "dd-source-0123456789ab", "dani--fix-retries")),
    name(join(worktrees, "dani--retries-abcdef012345", "dani--follow-up")),
    // Removed, made from a removed worktree: a sibling made from the same one still exists.
    name(join(worktrees, "checkout-api-0123456789ab", "dani--removed")),
    // Leftover folders Git no longer knows name each other's checkout instead of waiting on each other.
    name(join(worktrees, "billing-abcdefabcdef", "left")),
    name(join(worktrees, "billing-abcdefabcdef", "right")),
    name(join(dir, "notes")),
    name(join(dir, "gone")),
    name(join(dir, "home")),
  ]), ["checkout-api", "checkout-api", "dd-source", "checkout-api", "checkout-api", "billing", "billing", "notes", "gone", "~"]);
});
