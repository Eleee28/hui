import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { SessionGroup, SessionStatusUpdate, SessionView } from "../api/sessions.ts";
import type { WorktreeInventory } from "../lib/worktrees.ts";
import { SessionsController } from "./sessions-controller.ts";

type Handlers = {
  onSnapshot: (updates: readonly SessionStatusUpdate[]) => void;
  onStatus: (update: SessionStatusUpdate) => void;
  onSessions: (update: { revision: number; groups?: { label: string; ids: string[] }[]; upserts: SessionView[] }) => void;
};
const fake = vi.hoisted(() => ({
  streams: [] as { handlers: Handlers; stopped: boolean }[],
  list: { revision: 0, groups: [] as SessionGroup[] },
  deleted: [] as string[],
  inventoryReads: 0,
  inventory: { worktrees: [] } as unknown as WorktreeInventory,
  removed: [] as string[][],
}));
vi.mock("../api/sessions.ts", () => ({
  loadSessions: async () => fake.list,
  deleteSession: async (id: string) => { fake.deleted.push(id); },
  subscribeSessionStatuses: (handlers: Handlers) => {
    const stream = { handlers, stopped: false };
    fake.streams.push(stream);
    return () => { stream.stopped = true; };
  },
}));
vi.mock("../api/worktrees.ts", () => ({
  loadWorktrees: async () => { fake.inventoryReads += 1; return fake.inventory; },
  removeWorktrees: async (paths: string[]) => {
    fake.removed.push(paths);
    return { results: paths.map((path) => ({ path, label: path, removed: true, branchDeleted: true })), inventory: fake.inventory };
  },
}));

beforeEach(() => {
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) });
  fake.streams = [];
  fake.list = { revision: 0, groups: [] };
  fake.deleted = [];
  fake.inventoryReads = 0;
  fake.inventory = { worktrees: [] } as unknown as WorktreeInventory;
  fake.removed = [];
});

afterEach(() => { vi.useRealTimers(); });

const host = { addController: () => {}, removeController: () => {}, requestUpdate: () => {}, updateComplete: Promise.resolve(true), querySelector: () => null };
const session = (id: string, extra: Partial<SessionView> = {}) => ({ id, title: id, status: "idle", ...extra }) as SessionView;
const group = (...sessions: SessionView[]) => ({ label: "ungrouped", sessions }) as unknown as SessionGroup;

function controller(presented = "", worktreesShown = true) {
  const calls = { received: [] as string[][], settled: 0, statuses: [] as string[], deleted: [] as string[][] };
  const sessions = new SessionsController(host, {
    presented: (id) => id === presented,
    listReceived: (ids) => calls.received.push([...ids]),
    listSettled: () => { calls.settled += 1; },
    statusesApplied: () => calls.statuses.push("snapshot"),
    statusApplied: ({ id }) => calls.statuses.push(id),
    reportError: () => {},
    refreshSessions: async () => {},
    sessionsDeleted: (ids) => calls.deleted.push([...ids]),
    worktreesShown: () => worktreesShown,
  });
  return { sessions, calls };
}

test("one status stream keeps the registry current until it stops", async () => {
  const { sessions, calls } = controller("b");
  sessions.start();
  sessions.start();
  assert.equal(fake.streams.length, 1, "the shell holds one status stream however often it starts");
  fake.list = { revision: 1, groups: [group(session("a"), session("b"))] };
  await sessions.refresh();
  assert.equal(sessions.loading, false);
  assert.deepEqual(calls.received, [["a", "b"]]);

  const { handlers } = fake.streams[0]!;
  handlers.onSnapshot([{ id: "a", status: "running", unread: true }]);
  assert.equal(sessions.listed("a")?.status, "running");
  assert.equal(sessions.listed("a")?.unread, true);
  handlers.onStatus({ id: "b", status: "running", unread: true });
  assert.equal(sessions.listed("b")?.status, "running");
  assert.equal(sessions.listed("b")?.unread, undefined, "a presented session is never unread");
  assert.deepEqual(calls.statuses, ["snapshot", "b"]);

  handlers.onSessions({ revision: 1, groups: [{ label: "ungrouped", ids: ["b"] }], upserts: [] });
  assert.ok(sessions.listed("a"), "an older or equal revision loses");
  handlers.onSessions({ revision: 2, groups: [{ label: "ungrouped", ids: ["b"] }], upserts: [] });
  assert.equal(sessions.listed("a"), undefined);
  assert.equal(sessions.revision, 2);

  sessions.stop();
  assert.equal(fake.streams[0]!.stopped, true);
  sessions.start();
  assert.equal(fake.streams.length, 2, "a stopped stream starts again");
});

test("collapsed groups are remembered in the browser", () => {
  const { sessions } = controller();
  sessions.toggleGroup("repo");
  assert.deepEqual(JSON.parse(localStorage.getItem("hui.collapsed-groups") ?? ""), ["repo"]);
  assert.deepEqual([...controller().sessions.collapsed], ["repo"]);
  sessions.expandGroup("repo");
  assert.deepEqual(JSON.parse(localStorage.getItem("hui.collapsed-groups") ?? ""), []);
});

test("a success toast clears after 6 s, while failures and progress stay", () => {
  vi.useFakeTimers();
  const { sessions } = controller();
  sessions.notify("Moved repo.");
  vi.advanceTimersByTime(6_000);
  assert.equal(sessions.actionToast, undefined);
  sessions.notify("Could not move it.", true);
  vi.advanceTimersByTime(6_000);
  assert.deepEqual(sessions.actionToast, { message: "Could not move it.", failed: true });
  sessions.notify("Moving repo…");
  vi.advanceTimersByTime(6_000);
  assert.deepEqual(sessions.actionToast, { message: "Moving repo…", failed: false });
});

test("an archive toast dismisses itself after 15 s", () => {
  vi.useFakeTimers();
  const { sessions } = controller();
  sessions.showArchived(session("a"));
  vi.advanceTimersByTime(14_999);
  assert.equal(sessions.archiveToast?.session.id, "a");
  vi.advanceTimersByTime(1);
  assert.equal(sessions.archiveToast, undefined);
});

test("the worktree inventory polls every 1.5 s while its facts are pending and the page shows, until stopped", async () => {
  vi.useFakeTimers();
  fake.inventory = { pending: true, worktrees: [] } as unknown as WorktreeInventory;
  const { sessions } = controller();
  sessions.openWorktrees();
  await vi.advanceTimersByTimeAsync(1_500);
  assert.equal(fake.inventoryReads, 2);
  sessions.stop();
  await vi.advanceTimersByTimeAsync(3_000);
  assert.equal(fake.inventoryReads, 2, "stopping the controller ends the poll");

  const hidden = controller("", false).sessions;
  hidden.loadWorktreeInventory();
  await vi.advanceTimersByTimeAsync(3_000);
  assert.equal(fake.inventoryReads, 3, "a closed Worktrees page does not poll");
});

test("deleting selected sessions removes their trees and the worktrees only they used", async () => {
  const child = session("child", { parentId: "parent" } as Partial<SessionView>);
  fake.inventory = { worktrees: [
    { path: "/wt/only", branch: "only", sessions: [{ id: "parent" }, { id: "child" }] },
    { path: "/wt/shared", branch: "shared", sessions: [{ id: "parent" }, { id: "other" }] },
  ] } as unknown as WorktreeInventory;
  const { sessions, calls } = controller();
  sessions.receive(1, [group(session("parent"), child, session("other"))]);
  sessions.selectSessions(["parent", "other"], true);
  sessions.selectSessions(["other"], false);
  assert.deepEqual([...sessions.pageSelected], ["parent"]);

  await sessions.deleteSelected(["parent"], true);
  assert.deepEqual(fake.deleted, ["parent"]);
  assert.deepEqual(calls.deleted, [["parent", "child"]]);
  assert.deepEqual(fake.removed, [["/wt/only"]]);
  assert.equal(sessions.pageSelected.size, 0);
  assert.equal(sessions.deleting, false);
  assert.deepEqual(sessions.actionToast, { message: "Deleted 1 session. Removed 1 worktree.", failed: false });
});
