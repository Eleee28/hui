import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { createSessionListHub } from "./list.ts";

type Session = { id: string; title: string };
type Group = { label: string; sessions: Session[] };
type Frame = { revision: number; groups?: unknown[]; upserts: Session[] };
const golden: { lists: Group[][]; frames: Frame[] } = JSON.parse(readFileSync(new URL("./list.fixture.json", import.meta.url), "utf8"));

test("screens share one list: a full list on join, then only what changed, as the golden frames", async () => {
  let next: Group[] = [];
  const hub = createSessionListHub<Session>(async () => next, 60_000);
  const phone: Frame[] = [];
  const stopPhone = hub.subscribe((update) => phone.push(update));
  for (const list of golden.lists) {
    next = list;
    await hub.refresh();
    await hub.refresh(); // Unchanged: nothing is sent.
  }
  const first = phone[0]?.revision ?? 0;
  assert.ok(first > Date.now() - 60_000, "revisions keep rising across gateway restarts");
  assert.deepEqual(phone.map((frame) => ({ ...frame, revision: frame.revision - first })), golden.frames);

  // A late joiner gets the current list immediately, not a replay.
  const mac: Frame[] = [];
  const stopMac = hub.subscribe((update) => mac.push(update));
  const last = golden.frames.at(-1)!;
  assert.deepEqual(mac, [{ revision: first + last.revision, groups: last.groups, upserts: golden.lists.at(-1)!.flatMap((group) => group.sessions) }]);
  stopPhone();
  stopMac();
});
