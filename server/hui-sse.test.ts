import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { waitFor } from "./test-support/wait-for.ts";
import { SessionStatusStreamFrame } from "./api/sessions.ts";
import { expectSchema } from "./test-support/api-schema.ts";

// Keep all filesystem-backed module state isolated, including on a failed
// assertion. The registry and attachment paths are captured at import time.
process.env["XDG_CONFIG_HOME"] = await mkdtemp(join(tmpdir(), "hui-sse-"));

const {
  streamSession,
  streamSessionStatuses,
} = await import("./hui.ts");
const {
  reattachAfterStoreFailure,
  recoverInterruptedSessions,
  reopenDurableSessions,
} = await import("./backend.ts");
const { sessionMutationErrorStatus } = await import("./routes/sessions.ts");
const { readAttachments, storeAttachmentFile } = await import("./sessions/attachments.ts");
const { createSessionLifecycle } = await import("./sessions/lifecycle.ts");
const { setAgentStage } = await import("./sessions/stages.ts");
const { createSessionViews } = await import("./sessions/views.ts");
const {
  createSession,
  deleteSession,
  forkFromSession,
  forkRequest,
  forkSession,
  renameWithGeneratedTitle,
  startWorktreeSession,
  updateSession,
} = createSessionLifecycle({
  views: createSessionViews({
    bots: () => ({ identity: () => undefined }),
    botRegistry: { list: async () => [] },
    pullRequestStatuses: () => ({ view: (ref) => ref }),
    jiraIssues: () => [],
    watchers: () => ({ list: () => [] }),
  }),
  readAttachments,
  subagents: () => ({ forgetSessions: () => undefined }),
  taskSuggestions: () => ({ forget: () => undefined }),
  watchers: () => ({ forget: async () => undefined }),
  managedBrowser: () => ({ closeOwner: () => undefined }),
});
const { LiveSessions } = await import("./sessions/live-sessions.ts");
const { SessionRegistryError } = await import("./sessions/sessions.ts");
const { runGit } = await import("./git/worktrees.ts");
type SessionStreamMessage = import("./sessions/live-sessions.ts").SessionStreamMessage;
type SessionStatusUpdate = import("./sessions/live-sessions.ts").SessionStatusUpdate;
type SessionSnapshot = import("./sessions/live-sessions.ts").SessionSnapshot;
type SessionRecord = import("./sessions/sessions.ts").SessionRecord;

test("gateway startup eagerly opens only interrupted sessions", () => {
  const now = new Date().toISOString();
  const base: SessionRecord = { id: "idle", title: "Idle", group: "", cwd: tmpdir(), tool: "pi", createdAt: now, updatedAt: now };
  const opened: string[] = [];
  const count = recoverInterruptedSessions([
    base,
    { ...base, id: "interrupted", runStartedAt: now, runPrompt: "finish it" },
  ], { ensure: (record) => { opened.push(record.id); return true; } });

  assert.equal(count, 1);
  assert.deepEqual(opened, ["interrupted"]);
});

test("interrupted Durable work waits for its owning sessions to open", async () => {
  const now = new Date().toISOString();
  const base: SessionRecord = { id: "idle", title: "Idle", group: "", cwd: tmpdir(), tool: "durable", createdAt: now, updatedAt: now };
  const opened: string[] = [];
  let booted!: () => void;
  const booting = new Promise<void>((resolve) => { booted = resolve; });
  let settled = false;
  const reopening = reopenDurableSessions([7], [
    { ...base, id: "owner", piSessionFile: "durable:7" },
    { ...base, id: "other", piSessionFile: "durable:8" },
  ], { ensure: (record) => { opened.push(record.id); return true; }, booted: () => booting }).then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(opened, ["owner"]);
  assert.equal(settled, false, "the runs wait for the owner's boot");
  booted();
  await reopening;
  assert.equal(settled, true);
});

test("before a failed store opens again, the open sessions on this machine reattach once their boots settle", async () => {
  const now = new Date().toISOString();
  const base: SessionRecord = { id: "open", title: "Open", group: "", cwd: tmpdir(), tool: "durable", createdAt: now, updatedAt: now };
  const steps: string[] = [];
  let booted!: () => void;
  const booting = new Promise<void>((resolve) => { booted = resolve; });
  const reattaching = reattachAfterStoreFailure([base, { ...base, id: "closed" }, { ...base, id: "remote", worker: "w1" }], {
    isLive: (id) => id !== "closed",
    booted: async (id) => { steps.push(`booted:${id}`); await booting; },
    ensure: (record, reattach) => { steps.push(`ensure:${record.id}:${reattach}`); return true; },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(steps, ["booted:open"], "a boot underway settles first; a session nobody has open and a worker's are left alone");
  booted();
  await reattaching;
  assert.deepEqual(steps, ["booted:open", "ensure:open:true"]);
});

class FakeResponse extends EventEmitter {
  writableEnded = false;
  statusCode = 0;
  chunks: string[] = [];
  headers = new Map<string, unknown>();

  writeHead(status: number, headers: Record<string, unknown>): this {
    this.statusCode = status;
    for (const [name, value] of Object.entries(headers)) this.headers.set(name, value);
    return this;
  }

  setHeader(name: string, value: unknown): this {
    this.headers.set(name, value);
    return this;
  }

  flushHeaders(): void {}

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  end(chunk?: string): this {
    if (chunk) this.chunks.push(chunk);
    this.writableEnded = true;
    return this;
  }
}

function record(): SessionRecord {
  return {
    id: "sse-model",
    title: "SSE model",
    group: "",
    cwd: tmpdir(),
    tool: "pi",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

async function gitRepository() {
  const root = await mkdtemp(join(tmpdir(), "hui-session-checkout-"));
  assert.equal((await runGit(root, ["init", "-b", "main"])).code, 0);
  assert.equal((await runGit(root, ["config", "user.email", "hui@example.invalid"])).code, 0);
  assert.equal((await runGit(root, ["config", "user.name", "HUI tests"])).code, 0);
  await writeFile(join(root, "README.md"), "main\n", "utf8");
  assert.equal((await runGit(root, ["add", "."])).code, 0);
  assert.equal((await runGit(root, ["commit", "-m", "main"])).code, 0);
  assert.equal((await runGit(root, ["checkout", "-b", "topic"])).code, 0);
  await writeFile(join(root, "topic.txt"), "topic\n", "utf8");
  assert.equal((await runGit(root, ["add", "."])).code, 0);
  assert.equal((await runGit(root, ["commit", "-m", "topic"])).code, 0);
  assert.equal((await runGit(root, ["checkout", "main"])).code, 0);
  return root;
}

test("the session event route forwards model stream messages as SSE", () => {
  const response = new FakeResponse();
  let subscriber: ((message: SessionStreamMessage) => void) | undefined;
  streamSession(response as unknown as ServerResponse, record(), {
    ensure: () => true,
    watch: (_id, listener) => {
      subscriber = listener;
      return {
        snapshot: {
          transcript: [],
          status: "idle",
        queue: { steering: [], followUp: [] },
        questions: [],
        subagents: [],
        },
        unsubscribe: () => {},
      };
    },
  });

  subscriber?.({
    kind: "model",
    model: { provider: "openai", id: "gpt-5.6", name: "GPT-5.6" },
  });
  response.emit("close");

  assert.equal(response.statusCode, 200);
  assert.match(
    response.chunks.join(""),
    /event: snapshot\ndata: \{"transcript":\[\],"status":"idle","queue":\{"steering":\[\],"followUp":\[\]\},"questions":\[\],"subagents":\[\]\}\n\n/,
  );
  assert.match(
    response.chunks.join(""),
    /event: model\ndata: \{"provider":"openai","id":"gpt-5\.6","name":"GPT-5\.6"\}\n\n/,
  );
});

test("the gateway status stream multiplexes tagged session lifecycle updates", () => {
  const response = new FakeResponse();
  let subscriber: ((update: SessionStatusUpdate) => void) | undefined;
  let unsubscribed = false;
  let unlisted = false;

  streamSessionStatuses(response as unknown as ServerResponse, {
    watchStatuses: (listener) => {
      subscriber = listener;
      return {
        statuses: [
          { id: "session-a", status: "running" },
          { id: "session-b", status: "idle" },
        ],
        unsubscribe: () => { unsubscribed = true; },
      };
    },
  }, {
    subscribe: (listener) => {
      listener({ revision: 1, groups: [{ label: "work", ids: [] }], upserts: [] });
      return () => { unlisted = true; };
    },
  });

  subscriber?.({ id: "session-a", status: "idle" });
  response.emit("close");

  assert.equal(response.statusCode, 200);
  assert.match(
    response.chunks.join(""),
    /event: snapshot\ndata: \{"statuses":\[\{"id":"session-a","status":"running"\},\{"id":"session-b","status":"idle"\}\]\}\n\n/,
  );
  assert.match(
    response.chunks.join(""),
    /event: status\ndata: \{"id":"session-a","status":"idle"\}\n\n/,
  );
  assert.match(response.chunks.join(""), /event: sessions\ndata: \{"revision":1,"groups":\[\{"label":"work","ids":\[\]\}\],"upserts":\[\]\}\n\n/);
  for (const block of response.chunks.join("").trim().split("\n\n")) {
    const event = block.match(/^event: (.+)$/mu)?.[1];
    const data = block.match(/^data: (.+)$/mu)?.[1];
    assert.ok(event && data);
    expectSchema(SessionStatusStreamFrame, { event, data: JSON.parse(data) });
  }
  assert.equal(unsubscribed, true);
  assert.equal(unlisted, true);
});

test("new sessions reject unsupported tools instead of silently running PI", async () => {
  await assert.rejects(
    () => createSession({ cwd: tmpdir(), tool: "gemini" }),
    /Unsupported session tool: gemini/,
  );
});

test("the events route returns 404 for a stale record after DELETE", () => {
  let starts = 0;
  const sessions = new LiveSessions({
    id: "pi",
    start: async () => {
      starts += 1;
      throw new Error("must not start");
    },
  });
  const stale = record();
  sessions.tombstone(stale.id);
  const response = new FakeResponse();

  streamSession(response as unknown as ServerResponse, stale, sessions);

  assert.equal(response.statusCode, 404);
  assert.equal(starts, 0);
  assert.match(response.chunks.join(""), /unknown session: sse-model/);
});

test("a failed DELETE rolls back its tombstone", async () => {
  const calls: string[] = [];
  const token = Symbol("delete");
  const lifecycle = {
    tombstone(id: string) {
      calls.push(`tombstone:${id}`);
      return token;
    },
    finishDelete(id: string, received: symbol) {
      assert.equal(received, token);
      calls.push(`finish:${id}`);
    },
    rollbackDelete(id: string, received: symbol) {
      assert.equal(received, token);
      calls.push(`rollback:${id}`);
    },
  };

  await assert.rejects(
    () =>
      deleteSession("failed-delete", lifecycle, async () => {
        throw new SessionRegistryError("disk full");
      }),
    SessionRegistryError,
  );
  assert.deepEqual(calls, ["tombstone:failed-delete", "rollback:failed-delete"]);
});

test("an overlapping failed DELETE cannot clear a successful DELETE's protection", async () => {
  const sessions = new LiveSessions({ id: "pi", start: async () => Promise.reject(new Error("unused")) });
  const stored = record();
  let releaseFirst!: () => void;
  const firstMayCommit = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const first = deleteSession(stored.id, sessions, async (mutate) => {
    await firstMayCommit;
    return [...mutate([stored])];
  });
  await assert.rejects(
    () =>
      deleteSession(stored.id, sessions, async () => {
        throw new SessionRegistryError("second write failed");
      }),
    SessionRegistryError,
  );

  assert.equal(sessions.ensure(stored), false, "the first pending operation still blocks open");
  releaseFirst();
  await first;
  assert.equal(sessions.ensure(stored), false, "the committed delete survives the stale rollback");
});

test("DELETE removes only HUI metadata and leaves PI's transcript untouched", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hui-delete-transcript-"));
  const transcript = join(dir, "sentinel.jsonl");
  const sentinel = '{"type":"message","text":"keep me"}\n';
  await writeFile(transcript, sentinel, "utf8");
  const stored = { ...record(), piSessionFile: transcript };
  const token = Symbol("delete");

  await deleteSession(
    stored.id,
    {
      tombstone: () => token,
      finishDelete: (_id, received) => assert.equal(received, token),
      rollbackDelete: () => assert.fail("successful delete must not roll back"),
    },
    async (mutate) => [...mutate([stored])],
  );

  assert.equal(await readFile(transcript, "utf8"), sentinel);
});

test("PATCH checks existence inside the serialized mutation", async () => {
  const existing = record();
  await assert.rejects(
    () =>
      updateSession(existing.id, { title: "renamed" }, async (mutate) => {
        // Models DELETE committing after an earlier route-level read but before
        // PATCH reaches the mutation queue.
        return [...mutate([])];
      }),
    /unknown session: sse-model/,
  );
});

test("PATCH places a stage as the operator and null hands it back", async () => {
  const store = async (mutate: (records: readonly SessionRecord[]) => readonly SessionRecord[]) => [...mutate([{ ...record(), stage: "implementation", stageSource: "agent" }])];
  const placed = await updateSession(record().id, { stage: "testing" }, store);
  assert.equal(placed.stage, "testing");
  assert.equal(placed.stageSource, "operator");
  const cleared = await updateSession(record().id, { stage: null }, store);
  assert.equal(cleared.stage, undefined);
  assert.equal(cleared.stageSource, undefined);
  await assert.rejects(() => updateSession(record().id, { stage: "shipping" }, store), /Session stage must be/);
  await assert.rejects(() => updateSession(record().id, { stage: "backlog" }, store), /cannot be moved to Backlog/);
});

test("set_stage updates an agent stage but reports an operator placement instead of overriding it", async () => {
  let stored: SessionRecord = record();
  const store = async (mutate: (records: readonly SessionRecord[]) => readonly SessionRecord[]) => {
    const next = [...mutate([stored])];
    stored = next[0]!;
    return next;
  };
  assert.deepEqual(await setAgentStage(stored.id, { stage: "investigation" }, store, () => ["https://github.com/o/r/pull/1"]), {
    stage: "investigation", applied: true, message: "Stage set to Investigation.",
  });
  assert.equal(stored.stageSource, "agent");
  assert.deepEqual(stored.stagePullRequests, ["https://github.com/o/r/pull/1"]);
  stored = { ...stored, stage: "testing", stageSource: "operator" };
  const refused = await setAgentStage(stored.id, { stage: "done" }, store);
  assert.equal(refused.applied, false);
  assert.equal(refused.stage, "testing");
  assert.equal(stored.stage, "testing");
  await assert.rejects(() => setAgentStage(stored.id, { stage: "later" }, store), /stage must be one of/);
  await assert.rejects(() => setAgentStage(stored.id, { stage: "backlog" }, store), /Backlog holds backlog items/);
  await assert.rejects(() => setAgentStage("missing", { stage: "done" }, store), /no longer exists/);
});

test("create and PATCH enforce the same bounded metadata contract", async () => {
  await assert.rejects(() => createSession({ cwd: tmpdir(), title: "   " }), /1-200/);
  await assert.rejects(
    () => createSession({ cwd: tmpdir(), group: "x".repeat(201) }),
    /at most 200/,
  );
  await assert.rejects(
    () => updateSession(record().id, { group: "x".repeat(201) }, async () => [record()]),
    /at most 200/,
  );
  await assert.rejects(
    () => updateSession(record().id, { color: "ultraviolet" }, async () => [record()]),
    /Nothing to change/,
  );
  await assert.rejects(
    () => updateSession(record().id, { icon: "x".repeat(33) }, async () => [record()]),
    /at most 32/,
  );
  await assert.rejects(
    () => createSession({ cwd: tmpdir(), model: "missing-provider" }),
    /provider\/id/,
  );
  await assert.rejects(
    () => createSession({ cwd: tmpdir(), thinking: "unlimited" }),
    /Unsupported thinking level/,
  );
  await assert.rejects(
    () => createSession({ cwd: tmpdir(), branchName: "topic" }),
    /requires Create workspace/,
  );
});

test("PATCH persists archive, unread and appearance metadata together", async () => {
  const existing = record();
  const updated = await updateSession(existing.id, {
    archived: true,
    unread: true,
    icon: "🧪",
  }, async (mutate) => [...mutate([existing])]);
  assert.deepEqual(
    { archived: updated.archived, unread: updated.unread, icon: updated.icon },
    { archived: true, unread: true, icon: "🧪" },
  );
});

test("a plain session returns under its provisional title while the utility model names it", async () => {
  let stored: SessionRecord[] = [];
  const registry = async (mutate: (records: readonly SessionRecord[]) => readonly SessionRecord[]) => {
    stored = [...mutate(stored)];
    return stored;
  };
  let answer!: (names: { title: string }) => void;
  let asked = 0;
  const created = await createSession(
    { cwd: tmpdir(), initialPrompt: "why do new sessions time out\nwith more detail" },
    { accept: () => undefined, ensure: () => true },
    registry,
    undefined,
    {
      nameSession: () => {
        asked += 1;
        return new Promise((resolve) => { answer = resolve; });
      },
    },
  );

  // The request did not wait for the model, which has not answered yet.
  assert.equal(asked, 1);
  assert.equal(created.title, "why do new sessions time out");
  assert.equal(stored[0]?.title, "why do new sessions time out");

  answer({ title: "New session timeouts" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stored[0]?.id, created.id);
  assert.equal(stored[0]?.title, "New session timeouts");
});

test("a session started without a model uses the primary route, not PI's default", async () => {
  const settingsFile = join(process.env["XDG_CONFIG_HOME"]!, "hui", "settings.json");
  await mkdir(join(process.env["XDG_CONFIG_HOME"]!, "hui"), { recursive: true });
  await writeFile(settingsFile, JSON.stringify({ models: { primary: "openai/main", fallback: "anthropic/backup" } }), "utf8");
  try {
    let stored: SessionRecord[] = [];
    const registry = async (mutate: (records: readonly SessionRecord[]) => readonly SessionRecord[]) => {
      stored = [...mutate(stored)];
      return stored;
    };
    const sessions = { accept: () => undefined, ensure: () => true };
    assert.equal((await createSession({ cwd: tmpdir(), title: "Follow-up" }, sessions, registry)).model, "openai/main");
    assert.equal((await createSession({ cwd: tmpdir(), title: "Picked", model: "x/chosen" }, sessions, registry)).model, "x/chosen");
  } finally {
    await rm(settingsFile, { force: true });
  }
});

test("a fork registers its conversation copy as a session of its own, without the source's organizer marks", async () => {
  let stored: SessionRecord[] = [];
  const registry = async (mutate: (records: readonly SessionRecord[]) => readonly SessionRecord[]) => {
    stored = [...mutate(stored)];
    return stored;
  };
  const started: SessionRecord[] = [];
  const sessions = { accept: () => undefined, ensure: (started_: SessionRecord) => { started.push(started_); return true; } };
  const source: SessionRecord = {
    ...record(), id: "fork-source", title: "Plan the API", group: "backend", tool: "durable", piSessionFile: "durable:1",
    model: "x/chosen", thinking: "high", pinned: true, unread: true, icon: "🚀", stage: "testing", stageSource: "operator",
    jiraIssues: [{ key: "HUI-1", url: "https://example.atlassian.net/browse/HUI-1" }],
  };

  const forked = await forkSession(source, "durable:2", sessions, registry);
  assert.notEqual(forked.id, source.id);
  assert.deepEqual(
    { title: forked.title, group: forked.group, cwd: forked.cwd, tool: forked.tool, model: forked.model, thinking: forked.thinking, piSessionFile: forked.piSessionFile },
    { title: "Plan the API (fork)", group: "backend", cwd: source.cwd, tool: "durable", model: "x/chosen", thinking: "high", piSessionFile: "durable:2" },
  );
  for (const mark of ["pinned", "unread", "icon", "stage", "stageSource", "jiraIssues", "bot", "parentId"] as const) {
    assert.equal(forked[mark], undefined, mark);
  }
  assert.deepEqual(stored.map((session) => session.id), [forked.id], "registered before its runtime starts");
  assert.deepEqual(started.map((session) => session.piSessionFile), ["durable:2"], "the runtime resumes the copy");

  const long = await forkSession({ ...source, title: "x".repeat(200) }, "durable:3", sessions, registry);
  assert.equal(long.title.length, 200);
  assert.match(long.title, / \(fork\)$/u);
});

test("a fork into a new worktree branches from the source checkout and moves the copy there", async () => {
  const repository = await gitRepository();
  const worktreesRoot = await mkdtemp(join(tmpdir(), "hui-fork-worktrees-"));
  let stored: SessionRecord[] = [];
  const registry = async (mutate: (records: readonly SessionRecord[]) => readonly SessionRecord[]) => {
    stored = [...mutate(stored)];
    return stored;
  };
  const sessions = { accept: () => undefined, ensure: () => true };
  const source: SessionRecord = { ...record(), id: "fork-worktree-source", title: "Plan the API", cwd: repository, tool: "durable", piSessionFile: "durable:1" };
  try {
    const asked: (string | undefined)[][] = [];
    const forked = await forkFromSession(source, { entryId: "e4", worktree: true, branchName: "try-graphql" },
      async (entryId, options) => { asked.push([entryId, options?.cwd]); return "durable:2"; }, sessions, registry, worktreesRoot);
    assert.notEqual(forked.cwd, repository);
    assert.ok(forked.cwd.startsWith(worktreesRoot), forked.cwd);
    assert.deepEqual(asked, [["e4", forked.cwd]], "the copy is moved into the worktree it works in");
    assert.equal(forked.piSessionFile, "durable:2");
    assert.match((await runGit(forked.cwd, ["branch", "--show-current"])).stdout.trim(), /try-graphql$/u);
    assert.equal((await runGit(repository, ["branch", "--show-current"])).stdout.trim(), "main", "the source checkout stays on its branch");

    // Without a name the branch is the title's, marked as a fork.
    const named = await forkFromSession(source, { worktree: true }, async () => "durable:3", sessions, registry, worktreesRoot);
    assert.match((await runGit(named.cwd, ["branch", "--show-current"])).stdout.trim(), /plan-api-fork$/u);

    // A fork that fails after the worktree exists takes it away again.
    const before = (await runGit(repository, ["worktree", "list"])).stdout;
    await assert.rejects(forkFromSession(source, { worktree: true, branchName: "doomed" },
      async () => { throw new Error("copy failed"); }, sessions, registry, worktreesRoot), /copy failed/u);
    assert.equal((await runGit(repository, ["worktree", "list"])).stdout, before);
    assert.doesNotMatch((await runGit(repository, ["branch", "--list"])).stdout, /doomed/u);

    // Without a worktree the copy stays in the source's directory and is not moved.
    const plain = await forkFromSession(source, {}, async (_entryId, options) => { assert.equal(options, undefined); return "durable:4"; }, sessions, registry);
    assert.equal(plain.cwd, repository);

    await assert.rejects(forkFromSession({ ...source, worker: "devbox" }, { worktree: true }, async () => "durable:5", sessions, registry), /remote workers/u);
  } finally {
    await rm(repository, { recursive: true, force: true });
    await rm(worktreesRoot, { recursive: true, force: true });
  }
});

test("fork requests are validated before anything is copied", () => {
  assert.deepEqual(forkRequest({}), {});
  assert.deepEqual(forkRequest({ entryId: " e4 ", worktree: true, branchName: "try-it" }), { entryId: "e4", worktree: true, branchName: "try-it" });
  assert.throws(() => forkRequest({ entryId: "" }), /history entry/u);
  assert.throws(() => forkRequest({ worktree: "yes" }), /true or false/u);
  assert.throws(() => forkRequest({ branchName: "try-it" }), /requires a new worktree/u);
});

test("a generated title is published but never replaces an operator rename", async () => {
  const provisional = { ...record(), title: "fix the thing" };
  let stored: SessionRecord[] = [provisional];
  const registry = async (mutate: (records: readonly SessionRecord[]) => readonly SessionRecord[]) => {
    stored = [...mutate(stored)];
    return stored;
  };
  const published: unknown[] = [];
  const renamed = await renameWithGeneratedTitle(
    provisional,
    async () => ({ title: "Fix the thing" }),
    registry,
    (update) => published.push(update),
    () => "running",
  );
  assert.equal(renamed?.title, "Fix the thing");
  assert.deepEqual(published, [{ id: provisional.id, status: "running", title: "Fix the thing" }]);

  const ignored: unknown[] = [];
  const generate = async () => ({ title: "Model name" });
  stored = [{ ...provisional, title: "Operator name" }];
  assert.equal(await renameWithGeneratedTitle(provisional, generate, registry, (update) => ignored.push(update)), undefined);
  assert.equal(stored[0]?.title, "Operator name");

  stored = [];
  assert.equal(await renameWithGeneratedTitle(provisional, generate, registry, (update) => ignored.push(update)), undefined);
  assert.equal(stored.length, 0);
  assert.equal(ignored.length, 0);
});

test("create can switch the current checkout before registering a non-worktree session", async () => {
  const repo = await gitRepository();
  let stored: SessionRecord[] = [];
  const created = await createSession(
    { cwd: repo, title: "Use topic", baseRef: "topic" },
    {
      accept: (id) => { assert.equal(id, stored[0]?.id); },
      ensure: (session) => {
        assert.deepEqual(session, stored[0]);
        return true;
      },
    },
    async (mutate) => {
      stored = [...mutate([])];
      return stored;
    },
  );

  assert.equal(created.cwd, repo);
  assert.equal((await runGit(repo, ["branch", "--show-current"])).stdout.trim(), "topic");
  assert.equal(await readFile(join(repo, "topic.txt"), "utf8"), "topic\n");
});

test("a new worktree without a branch name gets a short generated branch", async () => {
  const repo = await gitRepository();
  let stored: SessionRecord[] = [];
  const created = await createSession(
    { cwd: repo, title: "Add rate limiting to the Jira proxy and its tests", worktree: true },
    { accept: () => undefined, ensure: () => true },
    async (mutate) => {
      stored = [...mutate([])];
      return stored;
    },
  );

  assert.equal(created.title, "Add rate limiting to the Jira proxy and its tests", "an operator title is kept");
  assert.equal((await runGit(created.cwd, ["branch", "--show-current"])).stdout.trim(), "feature/add-rate-limiting-jira");
});

test("a prompt-named worktree reports its naming step before any Git progress", async () => {
  const repo = await gitRepository();
  const phases: string[] = [];
  const created = await createSession(
    { cwd: repo, initialPrompt: "Throttle the Jira proxy\nwith tests", worktree: true },
    { accept: () => undefined, ensure: () => true },
    async (mutate) => [...mutate([])],
    (progress) => { phases.push(progress.phase); },
  );
  assert.equal(phases[0], "naming");
  assert.ok(phases.indexOf("preparing") > 0, "Git work starts after naming");
  assert.equal(phases.filter((phase) => phase === "naming").length, 1);
  assert.equal((await runGit(created.cwd, ["branch", "--show-current"])).stdout.trim(), "feature/throttle-jira-proxy");

  const named: string[] = [];
  await createSession(
    { cwd: repo, initialPrompt: "Throttle the Jira proxy", worktree: true, branchName: "own-branch" },
    { accept: () => undefined, ensure: () => true },
    async (mutate) => [...mutate([])],
    (progress) => { named.push(progress.phase); },
  );
  assert.equal(named.includes("naming"), false, "an operator branch name skips naming");
});

test("a worktree session returns before Git finishes and the gateway sends its prompt", { timeout: 20_000 }, async () => {
  const response = new FakeResponse();
  streamSessionStatuses(response as unknown as ServerResponse, {
    watchStatuses: () => ({ statuses: [], unsubscribe: () => undefined }),
  });
  const statuses = () => response.chunks.join("").split("\n")
    .filter((line) => line.startsWith("data: {\"id\""))
    .map((line) => JSON.parse(line.slice(6)) as SessionStatusUpdate & { creating?: { phase: string } });

  await assert.rejects(() => startWorktreeSession({ cwd: tmpdir(), worktree: true, model: "bad" }), /provider\/id/);
  assert.deepEqual(statuses(), [], "invalid input is refused without a pending session");

  const settled = (id: string, status: string) => waitFor(`${id} to be ${status}`,
    () => statuses().some((update) => update.id === id && update.status === status && !update.creating),
    { state: () => statuses().filter((update) => update.id === id) });

  const repo = await gitRepository();
  let stored: SessionRecord[] = [];
  const calls: string[] = [];
  const pending = await startWorktreeSession(
    {
      cwd: repo,
      title: "Background checkout",
      initialPrompt: " first turn ",
      initialAttachments: [{ kind: "image", name: "shot.png", mimeType: "image/png", dataBase64: "iVBORw0K" }],
      worktree: true,
    },
    {
      accept: () => undefined,
      ensure: (record) => { calls.push(`ensure ${stored.some(({ id }) => id === record.id)}`); return true; },
      status: () => "starting",
      watch: () => ({ snapshot: { status: "idle" } as SessionSnapshot, unsubscribe: () => undefined }),
      prompt: async (id, text, attachments) => {
        calls.push(`prompt ${id === pending.id} ${text} ${attachments?.map(({ name }) => name).join()}`);
      },
    },
    async (mutate) => { stored = [...mutate([])]; return stored; },
  );
  assert.equal(pending.title, "Background checkout");
  assert.equal(pending.status, "starting");
  assert.ok(pending.creating, "the browser can show progress before Git finishes");
  assert.equal(stored.length, 0, "nothing is persisted before the worktree exists");
  await settled(pending.id, "starting");
  assert.equal(stored[0]?.id, pending.id, "the finished record keeps the pending id");
  assert.notEqual(stored[0]?.cwd, repo);
  await waitFor("the first prompt", () => calls.length >= 2, { state: () => calls });
  assert.deepEqual(calls, ["ensure true", "prompt true first turn shot.png"], "the gateway sends the first prompt once, after persisting");

  response.emit("close");
});

test("create preserves namespaced model ids through persistence and runtime startup", async () => {
  for (const model of [
    "anthropic/claude-opus-5.5",
    "vercel-ai-gateway/anthropic/claude-opus-5.5",
    "openrouter/vendor/family/model:free",
  ]) {
    let stored: SessionRecord[] = [];
    const operations: string[] = [];
    const created = await createSession(
      { cwd: tmpdir(), title: "Namespaced model", model, thinking: "low" },
      {
        accept: (id) => {
          assert.equal(id, stored[0]?.id);
          operations.push("accept");
        },
        ensure: (session) => {
          assert.equal(session.model, model);
          assert.equal(session.thinking, "low");
          assert.deepEqual(session, stored[0]);
          operations.push("start");
          return true;
        },
      },
      async (mutate) => {
        stored = [...mutate([])];
        operations.push("persist");
        return stored;
      },
    );
    assert.equal(created.model, model);
    assert.deepEqual(operations, ["persist", "accept", "start"]);
  }
});

test("invalid model references never persist a session or start a runtime", async () => {
  for (const model of ["missing-provider", "/model", "provider/", "provider/model with spaces", "bad provider/model"]) {
    await assert.rejects(
      () => createSession(
        { cwd: tmpdir(), model },
        { accept: () => assert.fail("accepted invalid model"), ensure: () => assert.fail("started invalid model") },
        async () => assert.fail("persisted invalid model"),
      ),
      /provider\/id/,
      model,
    );
  }
});

test("session mutation routes classify storage failures as 500 and input/source failures as 400", () => {
  assert.equal(sessionMutationErrorStatus(new SessionRegistryError("corrupt")), 500);
  assert.equal(sessionMutationErrorStatus(new Error("unsupported tool")), 400);
});

test("attachments reject malformed, oversized-count and unsupported image input before writing", async () => {
  const valid = { kind: "file", name: "note.txt", mimeType: "text/plain", dataBase64: "aGk=" };
  await assert.rejects(() => readAttachments("strict", [valid, ...Array(8).fill(valid)]), /At most 8/);
  await assert.rejects(
    () => readAttachments("strict", [{ ...valid, name: "../note.txt" }]),
    /path separators or controls/,
  );
  await assert.rejects(
    () => readAttachments("strict", [{ ...valid, name: "bad\u0007name.txt" }]),
    /path separators or controls/,
  );
  await assert.rejects(
    () => readAttachments("strict", [{ ...valid, dataBase64: "not base64" }]),
    /canonical base64/,
  );
  await assert.rejects(
    () =>
      readAttachments("strict", [
        { kind: "image", name: "vector.svg", mimeType: "image/svg+xml", dataBase64: "PHN2Zy8+" },
      ]),
    /PNG, JPEG, GIF, or WebP/,
  );
});

test("attachment byte limits match the browser contract", async () => {
  const image = (name: string, bytes: number) => ({
    kind: "image",
    name,
    mimeType: "image/png",
    dataBase64: Buffer.alloc(bytes).toString("base64"),
  });
  await assert.rejects(
    () => readAttachments("strict", [image("large.png", 12 * 1024 * 1024 + 1)]),
    /12 MB or smaller/,
  );
  await assert.rejects(
    () => readAttachments("strict", [
      image("first.png", 8 * 1024 * 1024),
      image("second.png", 8 * 1024 * 1024),
      image("extra.png", 1),
    ]),
    /total at most 16 MB/,
  );
});

test("file uploads get immutable paths and rejected prompt cleanup removes only those paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "hui-attachments-"));
  const store = (sessionId: string, name: string, data: string) =>
    storeAttachmentFile(sessionId, name, data, root);
  const first = await readAttachments(
    "same-session",
    [{ kind: "file", name: "note.txt", mimeType: "text/plain", dataBase64: "Zmlyc3Q=" }],
    store,
  );
  const second = await readAttachments(
    "same-session",
    [{ kind: "file", name: "note.txt", mimeType: "text/plain", dataBase64: "c2Vjb25k" }],
    store,
  );
  const firstPath = first.attachments[0]?.kind === "file" ? first.attachments[0].path : "";
  const secondPath = second.attachments[0]?.kind === "file" ? second.attachments[0].path : "";
  assert.notEqual(firstPath, secondPath);
  assert.equal(await readFile(firstPath, "utf8"), "first");
  assert.equal(await readFile(secondPath, "utf8"), "second");

  await second.cleanupRejected();
  assert.equal(await readFile(firstPath, "utf8"), "first", "an earlier accepted upload is untouched");
  await assert.rejects(() => readFile(secondPath, "utf8"), /ENOENT/);
});

test("file uploads preserve common display names while storing a path-safe UUID name", async () => {
  const root = await mkdtemp(join(tmpdir(), "hui-attachment-names-"));
  const displayName = "captura final 🏂.txt";
  const result = await readAttachments(
    "unicode-name",
    [{ kind: "file", name: displayName, mimeType: "text/plain", dataBase64: "aGk=" }],
    (sessionId, name, data) => storeAttachmentFile(sessionId, name, data, root),
  );
  const stored = result.attachments[0];
  assert.equal(stored?.name, displayName);
  assert.equal(stored?.kind, "file");
  if (stored?.kind === "file") {
    assert.equal(await readFile(stored.path, "utf8"), "hi");
    assert.doesNotMatch(stored.path, /captura final|🏂/u);
  }
});

function sessionTreeFixture(): SessionRecord[] {
  const root = { ...record(), id: "root" };
  return [root,
    { ...root, id: "child", parentId: "root", group: "Different group", title: "Keep child title" },
    { ...root, id: "grandchild", parentId: "child", archived: true },
    { ...root, id: "sibling", parentId: "root" },
    { ...root, id: "outside" },
  ];
}

test("archive and restore cascade only the archive flag through the subtree", async () => {
  let records = sessionTreeFixture();
  const update = async (mutate: (rows: readonly SessionRecord[]) => readonly SessionRecord[]) => {
    records = [...mutate(records)];
    return records;
  };
  await updateSession("root", { archived: true, title: "New root title", unread: true }, update);
  assert.deepEqual(records.filter((r) => r.archived).map((r) => r.id), ["root", "child", "grandchild", "sibling"]);
  assert.equal(records[1]?.title, "Keep child title");
  assert.equal(records[1]?.unread, undefined);
  assert.equal(records[1]?.group, "Different group");
  await updateSession("root", { archived: false }, update);
  assert.equal(records.some((r) => r.archived), false);
  await updateSession("child", { archived: true }, update);
  assert.deepEqual(records.filter((r) => r.archived).map((r) => r.id), ["child", "grandchild"]);
});

for (const fail of [false, true]) {
  test(`tree deletion ${fail ? "rolls every tombstone back on write failure" : "removes every descendant atomically"}`, async () => {
    let records = sessionTreeFixture();
    const tokens = new Map<string, symbol>();
    const finished: string[] = [];
    const rolledBack: string[] = [];
    const operation = deleteSession("child", {
      tombstone: (id) => { const token = Symbol(id); tokens.set(id, token); return token; },
      finishDelete: (id, token) => { assert.equal(tokens.get(id), token); finished.push(id); },
      rollbackDelete: (id, token) => { assert.equal(tokens.get(id), token); rolledBack.push(id); },
    }, async (mutate) => {
      const next = [...mutate(records)];
      assert.deepEqual([...tokens.keys()], ["child", "grandchild"]);
      assert.deepEqual(finished, [], "runtimes remain alive until durable commit");
      if (fail) throw new SessionRegistryError("disk full");
      records = next;
      return records;
    });
    if (fail) {
      await assert.rejects(operation, /disk full/);
      assert.equal(records.length, 5);
      assert.deepEqual(rolledBack, ["child", "grandchild"]);
      assert.deepEqual(finished, []);
    } else {
      await operation;
      assert.deepEqual(records.map((r) => r.id), ["root", "sibling", "outside"]);
      assert.deepEqual(finished, ["child", "grandchild"]);
      assert.deepEqual(rolledBack, []);
    }
  });
}
