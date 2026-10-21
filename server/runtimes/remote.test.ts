/**
 * The gateway's view of a worker session against a scripted connection: the
 * order frames reach it in, not the host behind it (workers.test.ts runs that).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test, vi } from "vitest";

const root = await mkdtemp(join(tmpdir(), "hui-remote-runtime-"));
process.env["HOME"] = root;
process.env["XDG_CONFIG_HOME"] = join(root, "config");
const { workers } = await import("../workers.ts");
const { remoteRuntime } = await import("./remote.ts");
type Sink = Parameters<typeof workers.startSession>[4];
type Link = Awaited<ReturnType<typeof workers.startSession>>;
type State = Link["started"]["state"];

afterAll(() => rm(root, { recursive: true, force: true }));

const state = (patch: Partial<State> = {}): State => ({ sessionId: "s", isStreaming: false, resumesInterruptedRuns: true, ...patch });

/** Starts a session over a connection that `script` drives through its sink. */
async function start(script: (sink: Sink) => Partial<Link> | void = () => undefined) {
  vi.spyOn(workers, "startSession").mockImplementation(async (...args: Parameters<typeof workers.startSession>): Promise<Link> => ({
    started: { state: state(), seq: 1, transcript: [], methods: [] },
    call: async () => ({ state: state(), seq: 1 }),
    transcript: async () => [],
    dispose: () => undefined,
    ...script(args[4]),
  }));
  try {
    return await remoteRuntime("durable").start({ cwd: "/remote", worker: "w", huiSessionId: "k" });
  } finally {
    vi.restoreAllMocks();
  }
}

test("a reply does not overwrite state from events that followed it on the stream", async () => {
  const session = await start((sink) => ({
    // The reply and the event after it arrive in one chunk: the event is
    // handled before the awaited reply resumes.
    call: () => new Promise((resolve) => {
      resolve({ state: state({ isStreaming: true }), seq: 2 });
      sink.receive({ event: { type: "settled" }, state: state({ isStreaming: false }), seq: 3 });
    }),
  }));
  await session.prompt("hello");
  assert.equal(session.isStreaming, false);
});

test("tracked prompt identities and receipt operations cross the worker proxy only when the host supports them", async () => {
  const calls: Array<[string, unknown[]]> = [];
  const session = await start(() => ({
    started: { state: state(), seq: 1, transcript: [], methods: ["followUp", "waitForTrackedPrompt", "cancelTrackedPrompt"] },
    call: async (method, args) => {
      calls.push([method, args]);
      return { state: state(), seq: 2 + calls.length, ...(method === "waitForTrackedPrompt" ? { result: { summary: "Original answer." } } : {}) };
    },
  }));
  await session.prompt("routine", undefined, { requestId: "run-1" });
  await session.followUp!("queued", undefined, { requestId: "run-2" });
  assert.deepEqual(await session.waitForTrackedPrompt!("run-1"), { summary: "Original answer." });
  await session.cancelTrackedPrompt!("run-2");
  assert.deepEqual(calls, [
    ["prompt", ["routine", [], { requestId: "run-1" }]],
    ["followUp", ["queued", [], { requestId: "run-2" }]],
    ["waitForTrackedPrompt", ["run-1"]],
    ["cancelTrackedPrompt", ["run-2"]],
  ]);
  const legacy = await start();
  assert.equal(legacy.waitForTrackedPrompt, undefined);
  assert.equal(legacy.cancelTrackedPrompt, undefined);
});

test("events and a lost connection before anyone subscribed still reach the session's owner", async () => {
  const question = { id: "q1", kind: "select", title: "Pick", options: [] } as const;
  const session = await start((sink) => {
    sink.receive({ event: { type: "compaction_start", reason: "threshold" } });
    sink.receive({ event: { type: "question", question } as never });
    sink.lost();
  });
  const events: string[] = [];
  session.subscribe((event) => events.push(event.type));
  const exited = new Promise<void>((resolve) => session.onExit!(() => resolve()));
  await exited;
  assert.deepEqual(events, ["compaction_start", "question"]);
});

test("a transcript too large for one frame is read in pages, as of that frame, before the frames after it", async () => {
  let sink!: Sink;
  const read: number[] = [];
  const session = await start((given) => {
    sink = given;
    return {
      transcript: async (seq) => {
        read.push(seq);
        // A later frame waits behind the paged read instead of overtaking it.
        sink.receive({ event: { type: "notice", message: "after", level: "info" }, state: state({ isStreaming: false }), seq: 3 });
        return [{ kind: "message", id: "m1", role: "assistant", text: "paged" }] as never;
      },
    };
  });
  const seen: string[] = [];
  const done = new Promise<void>((resolve) => session.subscribe((event) => {
    seen.push(`${event.type}:${session.transcript().length}:${session.isStreaming}`);
    if (event.type === "notice") resolve();
  }));
  sink.receive({ event: { type: "turn_end" }, state: state({ isStreaming: true }), seq: 2, transcriptPaged: true });
  await done;
  // Each frame's state applies with its own sequence; the later one wins.
  assert.deepEqual(seen, ["turn_end:1:true", "notice:1:false"]);
  assert.deepEqual(read, [2]);
});
