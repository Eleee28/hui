import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { ReactiveController } from "lit";
import type { UpdateSnapshot } from "../api/schema/updates.ts";
import { UpdateController } from "./update-controller.ts";

const fake = vi.hoisted(() => ({ loads: 0, answers: [] as Array<"running" | "succeeded" | "offline"> }));

function snapshot(status: "running" | "succeeded"): UpdateSnapshot {
  return { currentVersion: "1.0.0", check: null, job: { id: "job-1", pid: 1, status, version: "1.1.0", message: "" } };
}

vi.mock("../api/update.ts", () => ({
  loadUpdate: async () => {
    fake.loads += 1;
    const answer = fake.answers.shift() ?? "running";
    if (answer === "offline") throw new Error("offline");
    return snapshot(answer);
  },
  checkUpdate: async () => snapshot("succeeded"),
}));

beforeEach(() => {
  fake.loads = 0;
  fake.answers = [];
  const listeners = { addEventListener: () => {}, removeEventListener: () => {} };
  vi.stubGlobal("document", listeners);
  vi.stubGlobal("window", {
    ...listeners,
    setTimeout: (run: () => void, ms: number) => setTimeout(run, ms),
    clearTimeout: (id: number) => clearTimeout(id),
  });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  const controllers: ReactiveController[] = [];
  const focused: string[] = [];
  const host = {
    addController: (controller: ReactiveController) => { controllers.push(controller); },
    removeController: () => {},
    requestUpdate: () => {},
    updateComplete: Promise.resolve(true),
    renderRoot: { querySelector: () => null } as unknown as ParentNode,
  };
  const controller = new UpdateController(host, () => focused.push("composer"));
  return { controller, controllers, focused };
}

async function openOnRunningUpdate(controller: UpdateController) {
  fake.answers.push("running");
  controller.review(null, false, async () => true);
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(controller.open, true);
  assert.equal(fake.loads, 1);
}

test("a running update is polled every second until it reports completion", async () => {
  const { controller, controllers } = setup();
  assert.deepEqual(controllers, [controller]);
  await openOnRunningUpdate(controller);
  fake.answers.push("offline", "succeeded");
  await vi.advanceTimersByTimeAsync(1000);
  assert.equal(controller.reconnecting, true, "a gateway restarting mid-update is waited for");
  await vi.advanceTimersByTimeAsync(1000);
  assert.equal(controller.reconnecting, false);
  assert.equal(controller.snapshot?.job?.status, "succeeded");
  await vi.advanceTimersByTimeAsync(5000);
  assert.equal(fake.loads, 3, "no poll after completion");
});

test("closing the dialog stops the poll and returns the focus", async () => {
  const { controller, focused } = setup();
  await openOnRunningUpdate(controller);
  controller.close();
  assert.equal(controller.open, false);
  assert.deepEqual(focused, ["composer"]);
  await vi.advanceTimersByTimeAsync(5000);
  assert.equal(fake.loads, 1);
});

test("a poll that never sees completion gives up after ten minutes", async () => {
  const { controller } = setup();
  await openOnRunningUpdate(controller);
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  assert.match(controller.error, /^The update has not reported completion\./u);
  const loads = fake.loads;
  await vi.advanceTimersByTimeAsync(5000);
  assert.equal(fake.loads, loads);
});

test("disconnecting the host stops the poll", async () => {
  const { controller } = setup();
  await openOnRunningUpdate(controller);
  controller.hostDisconnected();
  await vi.advanceTimersByTimeAsync(5000);
  assert.equal(fake.loads, 1);
});
