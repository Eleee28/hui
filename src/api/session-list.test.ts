import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { applySessionListUpdate } from "./session-list.ts";
import type { SessionListLayoutGroup } from "./schema/sessions.ts";

type Session = { id: string; title: string };
type Group = Omit<SessionListLayoutGroup, "ids"> & { sessions: Session[] };
const golden: { lists: Group[][]; frames: { revision: number; groups?: SessionListLayoutGroup[]; upserts: Session[] }[] } =
  JSON.parse(readFileSync(new URL("./session-list.fixture.json", import.meta.url), "utf8"));

test("applying the golden update frames in order rebuilds every list the gateway sent", () => {
  let groups: Group[] = [];
  golden.frames.forEach((frame, index) => {
    groups = applySessionListUpdate(groups, frame);
    assert.deepEqual(groups, golden.lists[index]);
  });
});
