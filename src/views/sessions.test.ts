import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { formatBootDuration, formatRuntimeMemory, groupSessionRows, matchingSessions } from "./sessions.ts";
import type { SessionGroup } from "../api/sessions.ts";

const groups: SessionGroup[] = [
  {
    label: "client work",
    sessions: [
      { id: "a", title: "Fix login", group: "client work", cwd: "/repo/app", tool: "pi", status: "idle", displayCwd: "", stage: "investigation", stageOrigin: "default", createdAt: "", updatedAt: "" },
    ],
  },
  {
    label: "infra",
    sessions: [
      { id: "b", title: "Deploy", group: "infra", cwd: "/repo/ops", tool: "pi", status: "running", archived: true, displayCwd: "", stage: "investigation", stageOrigin: "default", createdAt: "", updatedAt: "" },
    ],
  },
];

test("session registry search covers title, group, path and runtime", () => {
  assert.deepEqual(matchingSessions(groups, "login").map(({ session }) => session.id), ["a"]);
  assert.deepEqual(matchingSessions(groups, "infra", "archived").map(({ session }) => session.id), ["b"]);
  assert.deepEqual(matchingSessions(groups, "/repo/app").map(({ session }) => session.id), ["a"]);
  assert.deepEqual(matchingSessions(groups, "PI", "all").map(({ session }) => session.id), ["a", "b"]);
});

test("the default state shows every session, active and archived", () => {
  assert.deepEqual(matchingSessions(groups, "").map(({ session }) => session.id), ["a", "b"]);
});

test("runtime telemetry uses compact truthful units", () => {
  assert.equal(formatRuntimeMemory(8.25 * 1024 * 1024), "8.3 MB");
  assert.equal(formatRuntimeMemory(128.4 * 1024 * 1024), "128 MB");
  assert.equal(formatRuntimeMemory(undefined), "Unavailable");
  assert.equal(formatBootDuration(842), "842 ms");
  assert.equal(formatBootDuration(4_840), "4.8 s");
  assert.equal(formatBootDuration(undefined), "Unavailable");
});

test("the status filter narrows rows and Running includes starting sessions", () => {
  const withStarting: SessionGroup[] = [...groups, {
    label: "", sessions: [{ id: "c", title: "Boot", group: "", cwd: "/repo/app", tool: "pi", status: "starting", displayCwd: "", stage: "investigation", stageOrigin: "default", createdAt: "", updatedAt: "" }],
  }];
  assert.deepEqual(matchingSessions(withStarting, "", "all", "running").map(({ session }) => session.id), ["b", "c"]);
  assert.deepEqual(matchingSessions(withStarting, "", "all", "idle").map(({ session }) => session.id), ["a"]);
  assert.deepEqual(matchingSessions(withStarting, "", "active", "running").map(({ session }) => session.id), ["c"]);
});

test("rows group by custom group or project directory in first-seen order", () => {
  const rows = [
    ...matchingSessions(groups, ""),
    { group: "client work", session: { id: "c", title: "Docs", group: "client work", cwd: "/repo/ops", tool: "pi", status: "idle" as const, displayCwd: "", stage: "investigation" as const, stageOrigin: "default" as const, createdAt: "", updatedAt: "" } },
  ];
  assert.equal(groupSessionRows(rows, "none"), undefined);
  assert.deepEqual(groupSessionRows(rows, "group")?.map(({ label, rows }) => [label, rows.map(({ session }) => session.id)]),
    [["CLIENT WORK", ["a", "c"]], ["INFRA", ["b"]]]);
  assert.deepEqual(groupSessionRows(rows, "project")?.map(({ label, title, rows }) => [label, title, rows.map(({ session }) => session.id)]),
    [["app", "/repo/app", ["a"]], ["ops", "/repo/ops", ["b", "c"]]]);
});

test("the filter button opens a working popover instead of a disabled placeholder", () => {
  const source = readFileSync(new URL("./sessions.ts", import.meta.url), "utf8");
  assert.match(source, /<wa-popover class="sessions-filter-popover" for="sessions-filter-popover-trigger"/);
  assert.doesNotMatch(source, /sessions-filter-button[^>]*disabled/);
  assert.match(source, /STATE_OPTIONS = \[\["all", "All"\], \["active", "Active"\], \["archived", "Archived"\]\]/);
});

test("blank search retains registry order", () => {
  assert.deepEqual(matchingSessions(groups, "  ", "active").map(({ session }) => session.id), ["a"]);
  assert.deepEqual(matchingSessions(groups, "  ", "archived").map(({ session }) => session.id), ["b"]);
});

test("sessions use the OpenClaw workspace and data-table hierarchy", () => {
  const source = readFileSync(new URL("./sessions.ts", import.meta.url), "utf8");
  assert.match(source, /settings-workspace hui-workspace-page/);
  assert.match(source, /settings-page settings-page--wide sessions-page/);
  assert.match(source, /settings-section[\s\S]*settings-group[\s\S]*sessions-toolbar/);
  assert.match(source, /table class="data-table sessions-table"/);
  assert.doesNotMatch(source, /surface-table/);
  assert.match(source, /sessions-runtime-summary/);
  assert.match(source, />Memory<\/th>/);
  assert.match(source, />Startup<\/th>/);
});

test("workspace stylesheet keeps OpenClaw provenance and canonical breakpoints", () => {
  const css = readFileSync(new URL("../styles/openclaw-workspaces.css", import.meta.url), "utf8");
  const reference = readFileSync(new URL("../styles/openclaw-reference/settings.css", import.meta.url), "utf8");
  assert.match(css, /@import "\.\/openclaw-reference\/sessions\.css"/);
  assert.match(css, /@import "\.\/openclaw-reference\/settings\.css"/);
  assert.match(css, /Copyright \(c\) 2026 OpenClaw Foundation/);
  assert.match(css, /grid-template-columns: 288px minmax\(0, 1fr\)/);
  assert.match(reference, /max-width: 760px/);
  assert.match(reference, /max-width: 1120px/);
  assert.match(css, /max-width: 932px[\s\S]*max-height: 500px/);
});

test("session paths truncate from the start with a full-path tooltip and copy button, like worktrees", () => {
  const source = readFileSync(new URL("./sessions.ts", import.meta.url), "utf8");
  assert.match(source, /worktree-path__text" data-hui-tooltip=\$\{session\.cwd\}><bdi dir="ltr">\$\{session\.displayCwd \|\| session\.cwd\}<\/bdi>/u);
  assert.match(source, /props\.onCopyPath\(session\.cwd/u);
  assert.doesNotMatch(source, /title=\$\{session\.cwd\}/u);
  const css = readFileSync(new URL("../styles/openclaw-workspaces.css", import.meta.url), "utf8");
  assert.match(css, /:is\(\.worktrees-table, \.sessions-table\) \.worktree-path__text \{\s*direction: rtl;/u);
});

test("bulk delete removes only worktrees no surviving session uses", async () => {
  const { worktreesOnlyUsedBy } = await import("../lib/worktrees.ts");
  const row = (path: string, ids: string[]) => ({ path, sessions: ids.map((id) => ({ id, title: id, archived: true })) }) as never;
  assert.deepEqual(
    worktreesOnlyUsedBy([row("/wt/a", ["a", "a-child"]), row("/wt/shared", ["a", "other"]), row("/wt/none", [])], new Set(["a", "a-child"])),
    ["/wt/a"],
  );
});
