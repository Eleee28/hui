import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { progressCardHeadsUp } from "./session-progress-card.ts";
import { huiHovercardRow } from "./hui-hovercard-adapter.ts";
import { toSanitizedMarkdownHtml } from "./progress-markdown.ts";

test("upstream heads-up distinguishes running, paused, terminal and completed plans", () => {
  const card = { markdown: "", steps: [
    { step: "Read", status: "completed" as const },
    { step: "Check", status: "in_progress" as const },
  ], updatedAt: 200 };
  assert.deepEqual(progressCardHeadsUp(card, "running", 100, true), { step: "Check", status: "in_progress", completed: 1, total: 2 });
  assert.equal(progressCardHeadsUp(card, undefined, undefined, false)?.status, "paused");
  assert.equal(progressCardHeadsUp(card, "running", 300, true)?.status, "paused");
  assert.equal(progressCardHeadsUp(card, "done", 100, false), null);
  assert.equal(progressCardHeadsUp({ markdown: "Notes", steps: [] }), null);
  assert.equal(progressCardHeadsUp({ markdown: "", steps: [{ step: "Done", status: "completed" }] }), null);
});

test("HUI supplies real session facts without manufacturing identity or task completion", () => {
  const row = huiHovercardRow({ id: "one", title: "Build", cwd: "/work/project", group: "", tool: "pi", status: "idle", displayCwd: "", stage: "investigation", stageOrigin: "default", createdAt: "2026-09-25T00:00:00Z", updatedAt: "2026-09-25T00:00:00Z" });
  assert.equal(row.label, "Build");
  assert.equal(row.status, undefined);
  assert.equal(row.hasActiveRun, false);
  assert.equal(row.createdActor, undefined);
  assert.deepEqual(row.workContext, { kind: "workspace", name: "project", path: "/work/project" });
});

test("notepad supports safe explicit progress bars but never executable HTML", () => {
  const rendered = toSanitizedMarkdownHtml('<progress value="2" max="4" aria-label="Build" onclick="alert(1)"></progress>\n\n**Notes**', { progressBars: true });
  assert.match(rendered, /<progress value="2" max="4" aria-label="Build"><\/progress>/);
  assert.doesNotMatch(rendered, /onclick=/);
  assert.match(rendered, /<strong>Notes<\/strong>/);
  const unsafe = toSanitizedMarkdownHtml('<script>alert(1)</script> <img src=x onerror=alert(1)>', { progressBars: true });
  assert.doesNotMatch(unsafe, /<script>|<img src=x/);
});

test("pinned upstream source and stylesheet retain their reviewed content", () => {
  const manifest = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8")) as { files: { file: string; sha256: string }[] };
  for (const entry of manifest.files) {
    const source = readFileSync(new URL(entry.file, import.meta.url), "utf8");
    assert.equal(createHash("sha256").update(source).digest("hex"), entry.sha256, entry.file);
  }
});
