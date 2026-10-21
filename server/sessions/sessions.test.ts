import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

// The registry path is read once, at import time, so the throwaway home has to
// exist before the module loads.
const configHome = await mkdtemp(join(tmpdir(), "hui-sessions-"));
process.env["XDG_CONFIG_HOME"] = configHome;

const {
  createSessionGroup,
  deleteSessionGroup,
  groupSessions,
  readRegistry,
  readSessionGroups,
  reorderSessionGroups,
  SessionRegistryError,
  updateRegistry,
  updateSessionGroup,
  upsert,
  writeRegistry,
} =
  await import("./sessions.ts");
type SessionRecord = import("./sessions.ts").SessionRecord;

function record(id: string, patch: Partial<SessionRecord> = {}): SessionRecord {
  const now = new Date(2026, 0, 1).toISOString();
  return { id, title: id, group: "", cwd: "/tmp", tool: "pi", createdAt: now, updatedAt: now, ...patch };
}

test("pinned sessions sort above more recent ones in their group", () => {
  const groups = groupSessions([
    record("old-pinned", { pinned: true, updatedAt: "2026-01-01T00:00:00.000Z" }),
    record("new", { updatedAt: "2026-06-01T00:00:00.000Z" }),
    record("middle", { updatedAt: "2026-03-01T00:00:00.000Z" }),
  ]);
  assert.deepEqual(
    groups[0]?.sessions.map((session) => session.id),
    ["old-pinned", "new", "middle"],
  );
});

test("a record round-trips runtime and OpenClaw-style organizer metadata", async () => {
  await writeRegistry([
    record("kept", {
      model: "opencode/gpt-5",
      thinking: "high",
      runStartedAt: "2026-09-24T12:00:00.000Z",
      runPrompt: "Finish the recovery feature",
      pinned: true,
      archived: true,
      unread: true,
      icon: "🚀",
    }),
    record("plain"),
  ]);
  const stored = await readRegistry();
  const kept = stored.find((session) => session.id === "kept");
  assert.equal(kept?.model, "opencode/gpt-5");
  assert.equal(kept?.thinking, "high");
  assert.equal(kept?.runStartedAt, "2026-09-24T12:00:00.000Z");
  assert.equal(kept?.runPrompt, "Finish the recovery feature");
  assert.equal(kept?.pinned, true);
  assert.equal(kept?.archived, true);
  assert.equal(kept?.unread, true);
  assert.equal(kept?.icon, "🚀");
  // An absent flag must stay absent rather than becoming false on every write.
  const plain = stored.find((session) => session.id === "plain");
  assert.equal(plain?.pinned, undefined);
  assert.equal(plain?.archived, undefined);
  assert.equal(plain?.unread, undefined);
  assert.equal(plain?.icon, undefined);
});

test("a subagent record round-trips lineage and lifecycle without a registry migration", async () => {
  await writeRegistry([
    record("parent"),
    record("child", {
      parentId: "parent",
      subagent: {
        taskId: "task-1",
        task: "Inspect the tests",
        label: "Inspector",
        status: "completed",
        startedAt: "2026-09-24T10:00:00.000Z",
        updatedAt: "2026-09-24T10:00:00.000Z",
        endedAt: "2026-09-24T10:00:00.000Z",
        summary: "All clear",
      },
    }),
  ]);
  const child = (await readRegistry()).find((session) => session.id === "child");
  assert.equal(child?.parentId, "parent");
  assert.equal(child?.subagent?.status, "completed");
  assert.equal(child?.subagent?.summary, "All clear");
});

test("a bot's chat record keeps its bot without a registry migration; a blank one is an ordinary session", async () => {
  await writeRegistry([
    record("chat", { tool: "durable", bot: "bot-1", piSessionFile: "durable:4" }),
    record("plain", { bot: "  " } as Partial<SessionRecord>),
  ]);
  const [chat, plain] = await readRegistry();
  assert.equal(chat?.bot, "bot-1");
  assert.equal(chat?.piSessionFile, "durable:4");
  assert.equal(plain && "bot" in plain, false);
  assert.equal(JSON.parse(await readFile(join(configHome, "hui", "sessions.json"), "utf8")).version, 2, "same registry version");
});

test("version one registries migrate their session groups without losing rows", async () => {
  const registryFile = join(configHome, "hui", "sessions.json");
  await writeFile(registryFile, JSON.stringify({
    version: 1,
    sessions: [record("legacy", { group: "Legacy group" })],
  }), "utf8");

  assert.equal((await readRegistry())[0]?.id, "legacy");
  assert.deepEqual(await readSessionGroups(), [{ label: "Legacy group" }]);
});

test("upsert keeps unrelated fields when patching one", () => {
  const existing = [record("s", { model: "opencode/gpt-5", pinned: true })];
  const merged = upsert(existing, [{ ...record("s"), title: "renamed" }]);
  assert.equal(merged[0]?.title, "renamed");
  assert.equal(merged[0]?.model, "opencode/gpt-5");
  assert.equal(merged[0]?.pinned, true);
});

test("concurrent registry mutations are ordered and preserve each other's fields", async () => {
  await writeRegistry([record("ordered")]);

  await Promise.all([
    updateRegistry((sessions) =>
      sessions.map((session) =>
        session.id === "ordered" ? { ...session, title: "renamed" } : session,
      ),
    ),
    updateRegistry((sessions) =>
      sessions.map((session) =>
        session.id === "ordered" ? { ...session, pinned: true } : session,
      ),
    ),
  ]);

  const stored = (await readRegistry()).find((session) => session.id === "ordered");
  assert.equal(stored?.title, "renamed");
  assert.equal(stored?.pinned, true);
});

test("group lifecycle preserves empty groups, defaults and member sessions atomically", async () => {
  await writeRegistry([
    record("one", { group: "Research" }),
    record("two", { group: "Research" }),
  ]);

  await createSessionGroup("Empty");
  await updateSessionGroup("Research", { label: "Projects", cwd: "/tmp" });

  assert.deepEqual(await readSessionGroups(), [
    { label: "Projects", cwd: "/tmp" },
    { label: "Empty" },
  ]);
  assert.deepEqual((await readRegistry()).map((session) => session.group), ["Projects", "Projects"]);

  await deleteSessionGroup("Projects");
  assert.deepEqual((await readRegistry()).map((session) => session.group), ["", ""]);
  assert.deepEqual(await readSessionGroups(), [{ label: "Empty" }]);
});

test("group order persists, keeps ungrouped last and rejects stale lists", async () => {
  await writeRegistry([record("loose"), record("b", { group: "Beta" })]);
  await createSessionGroup("Alpha");
  await createSessionGroup("Gamma");
  assert.deepEqual((await readSessionGroups()).map((group) => group.label), ["Beta", "Alpha", "Gamma"]);

  await reorderSessionGroups(["Gamma", "Beta", "Alpha"]);
  assert.deepEqual((await readSessionGroups()).map((group) => group.label), ["Gamma", "Beta", "Alpha"]);
  const grouped = groupSessions(await readRegistry(), await readSessionGroups());
  assert.deepEqual(grouped.map((group) => group.label), ["Gamma", "Beta", "Alpha", "ungrouped"]);

  // Rename keeps the position rather than re-sorting by label.
  await updateSessionGroup("Beta", { label: "Aardvark" });
  assert.deepEqual((await readSessionGroups()).map((group) => group.label), ["Gamma", "Aardvark", "Alpha"]);

  for (const stale of [["Gamma", "Alpha"], ["Gamma", "Aardvark", "Alpha", "Ghost"], ["Gamma", "Gamma", "Alpha"]]) {
    await assert.rejects(() => reorderSessionGroups(stale), /group list changed/);
  }
  assert.deepEqual((await readSessionGroups()).map((group) => group.label), ["Gamma", "Aardvark", "Alpha"]);
});

test("group names are unique and unknown groups cannot be mutated", async () => {
  await writeRegistry([]);
  await createSessionGroup("One");
  await assert.rejects(() => createSessionGroup("One"), /already exists/);
  await assert.rejects(() => updateSessionGroup("Missing", { label: "Other" }), /Unknown group/);
  await assert.rejects(() => deleteSessionGroup("Missing"), /Unknown group/);
});

test("a corrupt registry is reported and never replaced with an empty snapshot", async () => {
  const registryFile = join(configHome, "hui", "sessions.json");
  const corrupt = "{ this is not json\n";
  await writeFile(registryFile, corrupt, "utf8");

  await assert.rejects(() => readRegistry(), SessionRegistryError);
  await assert.rejects(
    () => updateRegistry((sessions) => upsert(sessions, [record("must-not-appear")])),
    SessionRegistryError,
  );
  assert.equal(await readFile(registryFile, "utf8"), corrupt);

  // Leave the shared test registry healthy for any later test in this process.
  await writeRegistry([]);
});

for (const completionDelivery of ["pending", "delivered"] as const) {
  test(`subagent completion ${completionDelivery} survives registry round trip`, async () => {
    await writeRegistry([record("durable", { parentId: "parent", subagent: {
      taskId: "stable-id", task: "Review", status: "completed", startedAt: "2026-09-25T10:00:00Z",
      updatedAt: "2026-09-25T10:00:00Z", summary: "Done", completionDelivery,
    } })]);
    assert.equal((await readRegistry())[0]?.subagent?.completionDelivery, completionDelivery);
  });
}


test("group checkout defaults survive read, rename and reorder and can be cleared", async () => {
  await writeRegistry([]);
  await createSessionGroup("Legacy");
  await createSessionGroup("Project");
  assert.deepEqual((await readSessionGroups())[0], { label: "Legacy" });
  await updateSessionGroup("Project", { cwd: "/tmp", workspaceMode: "worktree", baseRef: "release/1.0" });
  await updateSessionGroup("Project", { label: "Renamed" });
  await reorderSessionGroups(["Renamed", "Legacy"]);
  assert.deepEqual((await readSessionGroups())[0], { label: "Renamed", cwd: "/tmp", workspaceMode: "worktree", baseRef: "release/1.0" });
  assert.equal(groupSessions([], await readSessionGroups())[0]?.baseRef, "release/1.0");
  await updateSessionGroup("Renamed", { workspaceMode: "branch" });
  assert.equal((await readSessionGroups())[0]?.baseRef, "release/1.0");
  await updateSessionGroup("Renamed", { workspaceMode: "", baseRef: "" });
  assert.deepEqual((await readSessionGroups())[0], { label: "Renamed", cwd: "/tmp" });
});
