import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import type { SessionStatus, SessionStreamHandlers, SessionView } from "../api/sessions.ts";
import { ConversationController } from "./conversation-controller.ts";

const fake = vi.hoisted(() => ({
  modelRequests: [] as string[],
  modelsFail: false,
  thinking: [] as { id: string; level: string; resolve: (level: string) => void }[],
  opens: [] as { id: string; resolve: (status: SessionStatus) => void }[],
  streams: [] as { id: string; handlers: SessionStreamHandlers; stopped: boolean }[],
}));
vi.mock("../api/sessions.ts", () => ({
  loadModels: async (id: string) => {
    fake.modelRequests.push(id);
    if (fake.modelsFail) throw new Error("not booted");
    return [{ provider: "gw", id: "opus", name: "Opus" }];
  },
  setSessionThinking: (id: string, level: string) => new Promise((resolve) => fake.thinking.push({ id, level, resolve })),
  openSession: (id: string) => new Promise((resolve) => fake.opens.push({
    id,
    resolve: (status) => resolve({ session: { id, status }, transcript: [] }),
  })),
  subscribeSession: (id: string, handlers: SessionStreamHandlers) => {
    const stream = { id, handlers, stopped: false };
    fake.streams.push(stream);
    return () => { stream.stopped = true; };
  },
}));

beforeEach(() => {
  fake.modelRequests = [];
  fake.modelsFail = false;
  fake.thinking = [];
  fake.opens = [];
  fake.streams = [];
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function conversation(state: { selected?: SessionView; streaming?: boolean } = {}) {
  const errors: string[] = [];
  let updates = 0;
  const host = { addController: () => {}, removeController: () => {}, requestUpdate: () => { updates += 1; }, updateComplete: Promise.resolve(true), renderRoot: { querySelector: () => null } as unknown as HTMLElement };
  const controller = new ConversationController(host, {
    showError: (message) => errors.push(message),
    refreshSessions: async () => {},
    paneCreating: () => false,
    paneCreationFailed: () => false,
    resetSession: () => {},
    connectionLost: () => {},
    adoptSnapshot: () => {},
    adoptEvent: () => {},
    statusChanged: () => {},
    flushLaunchPrompt: () => {},
  });
  controller.selected = state.selected;
  controller.streaming = state.streaming ?? false;
  return { controller, errors, updates: () => updates };
}

test("models are requested once per selection once the runtime is ready, and again after a failure", async () => {
  const selected = { id: "s1" } as SessionView;
  const { controller, updates } = conversation({ selected });
  controller.requestModelsWhenReady("s1", "starting");
  assert.deepEqual(fake.modelRequests, []);
  controller.requestModelsWhenReady("s1", "idle");
  controller.requestModelsWhenReady("s1", "idle");
  await settle();
  assert.deepEqual(fake.modelRequests, ["s1"]);
  assert.equal(controller.props().models.length, 1);
  assert.ok(updates() > 0);

  controller.resetModels();
  fake.modelsFail = true;
  controller.requestModelsWhenReady("s1", "idle");
  await settle();
  controller.requestModelsWhenReady("s1", "idle");
  await settle();
  assert.deepEqual(fake.modelRequests, ["s1", "s1", "s1"]);
  assert.deepEqual(controller.props().models, []);
});

test("thinking waits while the session runs and only follows the session still selected", async () => {
  const { controller } = conversation({ selected: { id: "s1" } as SessionView, streaming: true });
  controller.props().onSelectThinking("high");
  assert.equal(fake.thinking.length, 0);

  controller.streaming = false;
  controller.props().onSelectThinking("high");
  fake.thinking[0]?.resolve("high");
  await settle();
  assert.equal(controller.props().thinking, "high");

  controller.props().onSelectThinking("low");
  controller.select({ id: "s2" } as SessionView);
  fake.thinking[1]?.resolve("low");
  await settle();
  assert.equal(controller.props().thinking, "high");
});

test("only the session still selected opens and streams; its status frames reach the shell", async () => {
  const statuses: string[] = [];
  const host = { addController: () => {}, removeController: () => {}, requestUpdate: () => {}, updateComplete: Promise.resolve(true), renderRoot: { querySelector: () => null } as unknown as HTMLElement };
  const controller = new ConversationController(host, {
    showError: () => {},
    refreshSessions: async () => {},
    paneCreating: () => false,
    paneCreationFailed: () => false,
    resetSession: () => {},
    connectionLost: () => {},
    adoptSnapshot: () => {},
    adoptEvent: () => {},
    statusChanged: (id, status) => statuses.push(`${id}:${status}`),
    flushLaunchPrompt: () => {},
  });
  controller.select({ id: "s1" } as SessionView);
  void controller.open("s1");
  controller.select({ id: "s2" } as SessionView);
  void controller.open("s2");
  assert.equal(controller.opening, true);
  fake.opens[0]?.resolve("idle");
  await settle();
  assert.deepEqual(fake.streams.map(({ id }) => id), [], "a late answer for s1 starts nothing");

  fake.opens[1]?.resolve("running");
  await settle();
  assert.equal(controller.opening, false);
  assert.equal(controller.streaming, true);
  assert.deepEqual(fake.streams.map(({ id }) => id), ["s2"]);
  fake.streams[0]?.handlers.onStatus("idle");
  assert.equal(controller.streaming, false);
  assert.equal(controller.selected?.status, "idle");
  assert.deepEqual(statuses, ["s2:running", "s2:idle"]);

  controller.suspend();
  assert.equal(fake.streams[0]?.stopped, true);
  assert.equal(controller.streamOpen, false);
});

test("a conversation whose element is removed starts no stream for an open still pending, and leaves no copy timer or stale state", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("navigator", { clipboard: { writeText: async () => {} } });
  try {
    const { controller, updates } = conversation({ selected: { id: "s1" } as SessionView });
    void controller.open("s1");
    assert.equal(await controller.copy("text", "m1"), true);
    let finishWrite!: () => void;
    vi.stubGlobal("navigator", { clipboard: { writeText: () => new Promise<void>((resolve) => { finishWrite = resolve; }) } });
    const late = controller.copy("text", "m2");
    controller.hostDisconnected();
    assert.equal(controller.opening, false, "a reattached pane does not stay opening");
    assert.equal(controller.copiedId, "", "nor keeps a Copied mark");
    fake.opens[0]?.resolve("idle");
    finishWrite();
    assert.equal(await late, true);
    await vi.advanceTimersByTimeAsync(0);
    assert.deepEqual(fake.streams, []);
    const before = updates();
    await vi.advanceTimersByTimeAsync(1_500);
    assert.equal(updates(), before, "a copy that finished after removal arms no timer");
    assert.equal(controller.copiedId, "");
  } finally {
    vi.useRealTimers();
  }
});
