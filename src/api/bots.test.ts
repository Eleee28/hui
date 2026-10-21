import assert from "node:assert/strict";
import { test } from "vitest";
import { createBot, loadBots, subscribeBots } from "./bots.ts";

const RECORD = {
  id: "b1",
  handle: "scout",
  name: "Scout",
  title: "Research assistant",
  instructions: "A gateway from before SOUL.md: ignored.",
  cwd: "/home/me/.config/hui/bots/b1",
  model: "anthropic/claude",
  thinking: "medium",
  avatar: { emoji: "🔭", color: "#5B9CF6" },
  sessionId: "s1",
  createdAt: "2026-10-05T08:00:00.000Z",
  updatedAt: "2026-10-05T09:00:00.000Z",
  status: "running",
  soul: true,
  lastMessage: { role: "assistant", text: "Done:\n  three   links", at: "2026-10-05T09:00:00.000Z" },
  unread: true,
  memory: {
    messages: 40, built: 38, pending: 2, viewBytes: 92_000, viewLines: 31, waiting: true,
    failing: { node: "1+4", error: "429 rate limited", since: "2026-10-05T08:59:00.000Z" },
    usage: { calls: 12, input: 48_000, output: 1_200, cacheRead: 30_000, cacheWrite: 2_000, cost: 0.0421 },
    junk: "x",
  },
  routines: 2,
};

test("the bot stream reads SSE frames, reports a gateway without it, and stops when asked", async () => {
  const encoder = new TextEncoder();
  const frames = [
    `event: bots\ndata: ${JSON.stringify({ revision: 1, ids: ["b1"], upserts: [RECORD] })}\n\n`,
    ": heartbeat\n\n",
    `event: bots\ndata: ${JSON.stringify({ revision: 2, upserts: [{ ...RECORD, status: "idle" }] })}\n\n`,
  ];
  const updates: [number, boolean][] = [];
  const states: string[] = [];
  let stop = () => {};
  const done = new Promise<void>((resolve) => {
    stop = subscribeBots({
      onUpdate: (update, first) => {
        updates.push([update.revision, first]);
        if (update.revision === 2) resolve();
      },
      onConnection: (state) => states.push(state),
    }, async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        (init?.signal as AbortSignal | undefined)?.addEventListener("abort", () => controller.error(new Error("aborted")));
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } }));
  });
  await done;
  stop();
  assert.deepEqual(updates, [[1, true], [2, false]]);
  assert.deepEqual(states, ["live"]);

  const unsupported = await new Promise<string>((resolve) => {
    subscribeBots({ onUpdate: () => {}, onConnection: resolve }, async () => new Response("{}", { status: 404 }));
  });
  assert.equal(unsupported, "unsupported");
});

test("reading the list asks for active and archived bots, as the stream lists both", async () => {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    const bots = url.endsWith("?archived=1") ? [{ id: "b9", name: "Old", sessionId: "s9", archived: true }, RECORD] : [RECORD, { id: "b2", name: "Ledger", sessionId: "s2" }];
    return new Response(JSON.stringify({ bots }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const bots = await loadBots();
    assert.deepEqual(bots.map((bot) => [bot.id, bot.archived === true]), [["b1", false], ["b2", false], ["b9", true]], "a bot listed twice keeps its first copy");
    assert.deepEqual(urls.toSorted(), ["/__hui/bots", "/__hui/bots?archived=1"]);
  } finally {
    globalThis.fetch = original;
  }
});

test("+ creates a bot without a name: the gateway calls it New Bot, and it asks what to call it", async () => {
  const original = globalThis.fetch;
  const calls: { url: string; method: string; body: string }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), method: init.method ?? "GET", body: String(init.body) });
    return new Response(JSON.stringify({ bot: { ...RECORD, id: "b7", name: "New Bot", handle: "new-bot", soul: false } }), { status: 201, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const bot = await createBot({});
    assert.equal(bot.name, "New Bot");
    assert.deepEqual(calls.map(({ url, method, body }) => [url, method, JSON.parse(body)]), [["/__hui/bots", "POST", {}]], "no name in the body, nothing else either");
  } finally {
    globalThis.fetch = original;
  }
});
