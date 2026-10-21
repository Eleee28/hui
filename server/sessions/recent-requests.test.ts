import assert from "node:assert/strict";
import { test } from "vitest";
import { REQUEST_ID, RecentRequests } from "./recent-requests.ts";

test("a resent request id waits for the first send and is reported, not sent again", async () => {
  const requests = new RecentRequests();
  let sends = 0;
  let finish!: (value: string) => void;
  const send = () => { sends += 1; return new Promise<string>((resolve) => { finish = resolve; }); };
  const first = requests.run("s1", "r1", send);
  const resent = requests.run("s1", "r1", send);
  finish("item-1");
  assert.deepEqual(await first, { value: "item-1", duplicate: false });
  assert.deepEqual(await resent, { value: "item-1", duplicate: true }, "while it was still on its way");
  assert.deepEqual(await requests.run("s1", "r1", send), { value: "item-1", duplicate: true }, "and after it settled");
  assert.equal(sends, 1);
});

test("a failed send is forgotten, so its resend runs; ids are per session and optional", async () => {
  const requests = new RecentRequests();
  let sends = 0;
  await assert.rejects(requests.run("s1", "r1", async () => { sends += 1; throw new Error("busy"); }), /busy/u);
  assert.deepEqual(await requests.run("s1", "r1", async () => { sends += 1; return "ok"; }), { value: "ok", duplicate: false });
  assert.equal((await requests.run("s2", "r1", async () => { sends += 1; return "other"; })).duplicate, false, "another session's id is its own");
  await requests.run("s1", undefined, async () => { sends += 1; });
  await requests.run("s1", undefined, async () => { sends += 1; });
  assert.equal(sends, 5);
});

test("a settled id is remembered for its time, then forgotten", async () => {
  let now = 0;
  const requests = new RecentRequests({ ttlMs: 1_000, now: () => now });
  await requests.run("s", "a", async () => "a");
  now = 900;
  assert.equal((await requests.run("s", "a", async () => "again")).duplicate, true);
  now = 2_000;
  assert.equal((await requests.run("s", "a", async () => "again")).duplicate, false);
});

test("beyond the cap the oldest settled id makes room; a send still on its way is never dropped", async () => {
  const requests = new RecentRequests({ max: 2 });
  let finish!: () => void;
  const pending = requests.run("s", "slow", () => new Promise<void>((resolve) => { finish = resolve; }));
  await requests.run("s", "a", async () => "a");
  await requests.run("s", "b", async () => "b");
  assert.equal((await requests.run("s", "b", async () => "again")).duplicate, true, "the newest stays");
  assert.equal((await requests.run("s", "a", async () => "again")).duplicate, false, "the oldest settled went");
  finish();
  assert.equal((await pending).duplicate, false);
  assert.equal((await requests.run("s", "slow", async () => undefined)).duplicate, true, "the one on its way was kept");
});

test("request ids are short and plain", () => {
  assert.ok(REQUEST_ID.test("7c9e6679-7425-40de-944b-e07fc1f90ae7"));
  assert.ok(!REQUEST_ID.test(""));
  assert.ok(!REQUEST_ID.test("x".repeat(101)));
  assert.ok(!REQUEST_ID.test("a b"));
});
