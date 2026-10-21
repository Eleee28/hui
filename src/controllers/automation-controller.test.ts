import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import type { ReactiveController } from "lit";
import type { AutomationSnapshot, AutomationTask } from "../api/schema/automation.ts";
import { AUTOMATION_POLL_MS, AutomationController, type AutomationApi } from "./automation-controller.ts";

afterEach(() => {
  vi.useRealTimers();
});

const TASK: AutomationTask = {
  id: "task-1", name: "Nightly review", description: "Reads the diff", sessionId: "session-1", prompt: "Review",
  schedule: { kind: "every", everyMs: 60_000 }, enabled: true, timeoutSeconds: 900,
  createdAt: "2026-09-23T08:00:00.000Z", updatedAt: "2026-09-23T08:00:00.000Z", nextRunAt: null,
};

function snapshot(tasks: AutomationTask[] = []): AutomationSnapshot {
  return { scheduler: { enabled: true, activeRuns: 0, nextWakeAt: null }, tasks, runs: [] };
}

function setup(overrides: Partial<AutomationApi> = {}) {
  const calls: string[] = [];
  const controllers: ReactiveController[] = [];
  const scrolled: string[] = [];
  const host = {
    updates: 0,
    addController: (controller: ReactiveController) => { controllers.push(controller); },
    removeController: () => {},
    requestUpdate() { this.updates += 1; },
    updateComplete: Promise.resolve(true),
    renderRoot: { querySelector: (selector: string) => ({ scrollIntoView: () => scrolled.push(selector) }) } as unknown as ParentNode,
  };
  const api: AutomationApi = {
    loadAutomation: async () => { calls.push("load"); return snapshot(); },
    createAutomationTask: async (input) => { calls.push(`create ${input.name}`); return snapshot([TASK]); },
    updateAutomationTask: async (id, input) => { calls.push(`update ${id} ${JSON.stringify(input)}`); return snapshot([TASK]); },
    deleteAutomationTask: async (id) => { calls.push(`delete ${id}`); return snapshot(); },
    runAutomationTask: async (id) => { calls.push(`run ${id}`); return { id: "run-1", taskId: id, taskName: "n", sessionId: "s", source: "manual", status: "queued", createdAt: "t" }; },
    cancelAutomationRun: async (id) => { calls.push(`cancel ${id}`); },
    ...overrides,
  };
  const controller = new AutomationController(host, api);
  return { controller, host, calls, controllers, scrolled };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("the controller joins its host and reads the scheduler's snapshot", async () => {
  const { controller, controllers, calls } = setup();
  assert.deepEqual(controllers, [controller]);
  assert.equal(controller.snapshot, undefined);
  controller.load();
  await settle();
  assert.deepEqual(controller.snapshot, snapshot());
  assert.deepEqual(calls, ["load"]);
});

test("a failed read reports its error and keeps the last snapshot", async () => {
  const { controller } = setup({ loadAutomation: async () => { throw new Error("Scheduler offline."); } });
  controller.snapshot = snapshot([TASK]);
  controller.load();
  await settle();
  assert.equal(controller.error, "Scheduler offline.");
  assert.deepEqual(controller.snapshot, snapshot([TASK]));
});

test("mutations adopt the server's snapshot, and a mutation without one reads it again", async () => {
  const { controller, calls } = setup();
  assert.equal(await controller.create({ name: "Nightly review", sessionId: "session-1", prompt: "Review", schedule: TASK.schedule }), true);
  assert.deepEqual(controller.snapshot, snapshot([TASK]));
  assert.deepEqual(calls, ["create Nightly review"]);
  controller.run(TASK);
  await settle();
  assert.deepEqual(calls, ["create Nightly review", "run task-1", "load"]);
  assert.deepEqual(controller.snapshot, snapshot());
});

test("a refused create or edit is reported in the form, a refused task or run action next to the list", async () => {
  const refuse = async () => { throw new Error("Refused."); };
  const { controller } = setup({ createAutomationTask: refuse, updateAutomationTask: refuse, deleteAutomationTask: refuse, runAutomationTask: refuse, cancelAutomationRun: refuse });
  const input = { name: "n", sessionId: "s", prompt: "p", schedule: TASK.schedule };
  assert.equal(await controller.create(input), false);
  assert.deepEqual([controller.formError, controller.actionError, controller.pending], ["Refused.", "", false]);
  assert.equal(await controller.update(TASK, input), false);
  assert.deepEqual([controller.formError, controller.actionError], ["Refused.", ""]);
  for (const act of [() => controller.delete(TASK), () => controller.run(TASK), () => controller.cancelRun({ id: "run-1" } as never), () => controller.setEnabled(TASK, false)]) {
    controller.clearErrors();
    act();
    await settle();
    assert.deepEqual([controller.formError, controller.actionError], ["", "Refused."]);
  }
});

test("only one mutation runs at a time; another resolves false without a request", async () => {
  let finish: (value: AutomationSnapshot) => void = () => {};
  const { controller, calls } = setup({ createAutomationTask: (input) => { calls.push(`create ${input.name}`); return new Promise((resolve) => { finish = resolve; }); } });
  const first = controller.create({ name: "a", sessionId: "s", prompt: "p", schedule: TASK.schedule });
  assert.equal(controller.pending, true);
  assert.equal(await controller.create({ name: "b", sessionId: "s", prompt: "p", schedule: TASK.schedule }), false);
  finish(snapshot([TASK]));
  assert.equal(await first, true);
  assert.equal(controller.pending, false);
  assert.deepEqual(calls, ["create a"]);
});

test("a read that answers after a newer snapshot was adopted, or after a newer read, is dropped", async () => {
  const reads: ((value: AutomationSnapshot) => void)[] = [];
  const { controller } = setup({ loadAutomation: () => new Promise((resolve) => reads.push(resolve)) });
  controller.load();
  assert.equal(await controller.create({ name: "Nightly review", sessionId: "session-1", prompt: "Review", schedule: TASK.schedule }), true);
  reads[0]!(snapshot());
  await settle();
  assert.deepEqual(controller.snapshot, snapshot([TASK]));

  controller.load();
  controller.load();
  reads[2]!(snapshot([TASK, { ...TASK, id: "task-2" }]));
  reads[1]!(snapshot());
  await settle();
  assert.deepEqual(controller.snapshot, snapshot([TASK, { ...TASK, id: "task-2" }]));
});

test("switching a task on or off keeps every other field of it", async () => {
  const { controller, calls } = setup();
  controller.setEnabled(TASK, false);
  await settle();
  assert.deepEqual(calls, [`update task-1 ${JSON.stringify({ name: TASK.name, description: TASK.description, sessionId: TASK.sessionId, prompt: TASK.prompt, schedule: TASK.schedule, enabled: false, timeoutSeconds: 900 })}`]);
});

test("editing a task names it, scrolls to the form and clears its error; cancelling forgets it", async () => {
  const { controller, scrolled } = setup();
  controller.reportFormError("Name the task.");
  controller.edit(TASK);
  assert.deepEqual([controller.editingId, controller.formError], ["task-1", ""]);
  await settle();
  assert.deepEqual(scrolled, ["#automation-task-form"]);
  controller.cancelEdit();
  assert.equal(controller.editingId, "");
});

test("an open automation page re-reads the scheduler, never while busy, and stops when it closes", async () => {
  vi.useFakeTimers();
  let finish: () => void = () => {};
  const { controller, calls } = setup({ runAutomationTask: (id) => { calls.push(`run ${id}`); return new Promise((resolve) => { finish = () => resolve({} as never); }); } });
  controller.startPolling();
  controller.startPolling();
  await vi.advanceTimersByTimeAsync(AUTOMATION_POLL_MS);
  assert.deepEqual(calls, ["load"]);
  controller.run(TASK);
  await vi.advanceTimersByTimeAsync(AUTOMATION_POLL_MS);
  assert.deepEqual(calls, ["load", "run task-1"]);
  finish();
  await vi.advanceTimersByTimeAsync(AUTOMATION_POLL_MS);
  assert.deepEqual(calls, ["load", "run task-1", "load", "load"]);
  controller.stopPolling();
  await vi.advanceTimersByTimeAsync(AUTOMATION_POLL_MS * 3);
  assert.equal(calls.length, 4);
});

test("a poll waits for a slow read instead of superseding it", async () => {
  vi.useFakeTimers();
  const { controller, calls } = setup({
    loadAutomation: () => {
      calls.push("load");
      return new Promise((resolve) => setTimeout(() => resolve(snapshot([TASK])), AUTOMATION_POLL_MS + 1_000));
    },
  });
  controller.startPolling();
  await vi.advanceTimersByTimeAsync(AUTOMATION_POLL_MS * 2 + 1_000);
  assert.deepEqual(calls, ["load"]);
  assert.deepEqual(controller.snapshot?.tasks, [TASK]);
  controller.stopPolling();
});

test("leaving the page's element behind leaves no timer behind", async () => {
  vi.useFakeTimers();
  const { controller, calls } = setup();
  controller.startPolling();
  controller.hostDisconnected();
  await vi.advanceTimersByTimeAsync(AUTOMATION_POLL_MS * 3);
  assert.deepEqual(calls, []);
});

test("the view's props carry the state and the actions", () => {
  const { controller } = setup();
  controller.editingId = "task-1";
  const props = controller.props();
  assert.equal(props.automationEditingId, "task-1");
  assert.equal(props.onRetryAutomation, controller.load);
  assert.equal(props.onCreateAutomationTask, controller.create);
  assert.equal(props.onCancelAutomationRun, controller.cancelRun);
});
