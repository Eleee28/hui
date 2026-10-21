import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { test } from "vitest";
import { BOT_TRIGGER_LIMITS } from "./triggers-format.ts";
import {
  hashHookToken, HOOK_ROUTE, HookBodyError, isHookPath, isTailnetOrLoopback, listenerMatches, newHookToken, parseListenerReport, readHookBody, sameHash,
  type ListenerEvent,
} from "./triggers-listener.ts";
import { TriggerInputError } from "./triggers-input.ts";

const NOW = Date.parse("2026-10-08T12:00:00.000Z");
const ping = (extra: Record<string, unknown> = {}) => ({
  id: "G01REVIEWS:1791481674.389319", summary: "@rodrigo in #team-reviews: acme/widgets#42", details: "From Rodrigo\n  > could you review it?",
  at: "2026-10-08T13:50:27+02:00", links: ["https://github.com/acme/widgets/pull/42"], fields: { channel: "G01REVIEWS", kind: "mention" }, ...extra,
});

test("a report reads as the events it lists, each id once; an empty one is only a check-in", () => {
  const report = parseListenerReport(({
    events: [
      ping({ summary: `  a summary\nthat runs  ${"on ".repeat(80)}`, details: `${"x".repeat(BOT_TRIGGER_LIMITS.details + 50)}`, links: ["https://www.github.com/acme/widgets/pull/42/files", "https://example.com/doc", "https://github.com/acme/widgets/pull/42", "https://github.com/a/b/pull/1", "https://github.com/a/b/pull/2", "https://github.com/a/b/pull/3"] }),
      ping({ summary: "the same id again, later in the report" }),
      { id: "jira:ACME-7", summary: "ACME-7 assigned to you", bot: true, external: false },
    ],
    error: "  the Slack MCP sign-in\nexpires soon ",
    catchUp: true,
  }), NOW);
  assert.deepEqual(report.events.map((event) => event.id), ["G01REVIEWS:1791481674.389319", "jira:ACME-7"]);
  const [first, second] = report.events as [ListenerEvent, ListenerEvent];
  assert.match(first.summary, /^a summary that runs on on/u);
  assert.equal(first.summary.length, 160, "one line, cut");
  assert.equal(first.details.length, BOT_TRIGGER_LIMITS.details);
  assert.match(first.details, /\n…$/u);
  assert.equal(first.at, "2026-10-08T11:50:27.000Z", "any ISO time, kept in UTC");
  assert.deepEqual(first.links, ["https://github.com/acme/widgets/pull/42", "https://github.com/a/b/pull/1", "https://github.com/a/b/pull/2"], "its pull requests, canonical, once each, three at most");
  assert.deepEqual(first.fields, { channel: "G01REVIEWS", kind: "mention" });
  assert.deepEqual([second.at, second.details, second.links, second.fields, second.bot, second.external], [new Date(NOW).toISOString(), "", [], {}, true, false], "when HUI got it, with nothing more");
  assert.deepEqual([report.error, report.catchUp], ["the Slack MCP sign-in expires soon", true]);
  assert.deepEqual(parseListenerReport(({ events: [] }), NOW), { events: [], catchUp: false });
  // What a listener relays never brings a terminal's escapes or bidirectional overrides along.
  const [plain] = parseListenerReport(({ events: [ping({ summary: "\u001b[31mred\u001b[0m alert \u202egnp.exe", details: "line one\n\tindented\u0007\u001b[2J\u2066done" })], error: "bad\u001b]0;title\u0007 news" }), NOW).events as [ListenerEvent];
  assert.equal(plain.summary, "[31mred [0m alert gnp.exe");
  assert.equal(plain.details, "line one\n\tindented[2Jdone");
  assert.equal(parseListenerReport(({ events: [], error: "bad\u001b]0;title\u0007 news" }), NOW).error, "bad ]0;title news");
});

test("a report HUI can't read is refused with what to fix", () => {
  const event = ping();
  for (const [body, message] of [
    [[event], /A report is \{ "events": \[\.\.\.\] \}/u],
    ["hello", /A report is/u],
    [({ events: [], extra: 1 }), /Unknown report field: extra\./u],
    [({}), /events must be a list of at most 50 events, empty when nothing happened/u],
    [({ events: Array.from({ length: 51 }, (_, index) => ({ ...event, id: `e${index}` })) }), /send more in several reports/u],
    [({ events: ["ping"] }), /events\[0\] must be an object/u],
    [({ events: [{ ...event, colour: "red" }] }), /Unknown events\[0\] field: colour\./u],
    [({ events: [{ ...event, id: "" }] }), /events\[0\]\.id must be 1-200 characters on one line/u],
    [({ events: [{ ...event, id: "x".repeat(201) }] }), /events\[0\]\.id must be/u],
    [({ events: [{ ...event, id: "two\nlines" }] }), /events\[0\]\.id must be/u],
    [({ events: [{ ...event, summary: "  " }] }), /events\[0\]\.summary must be text/u],
    [({ events: [{ ...event, details: 7 }] }), /events\[0\]\.details must be text/u],
    [({ events: [{ ...event, at: "yesterday-ish" }] }), /events\[0\]\.at must be an ISO 8601 time/u],
    [({ events: [{ ...event, links: "https://github.com/a/b/pull/1" }] }), /events\[0\]\.links must be a list of at most 20 URLs/u],
    [({ events: [{ ...event, fields: { "a.b": 1 } }] }), /events\[0\]\.fields\.a\.b must be text/u],
    [({ events: [{ ...event, fields: { nested: { deep: true } } }] }), /events\[0\]\.fields\.nested must be text/u],
    [({ events: [{ ...event, fields: { long: "x".repeat(501) } }] }), /fields\.long must be text \(500 characters at most\)/u],
    [({ events: [{ ...event, bot: "yes" }] }), /events\[0\]\.bot must be true or false/u],
    [({ events: [], error: { code: 1 } }), /error must be text/u],
    [({ events: [], catchUp: "yes" }), /catchUp must be true or false/u],
  ] as const) {
    assert.throws(() => parseListenerReport(body, NOW), (error: unknown) => error instanceof TriggerInputError && message.test(error.message), message.source);
  }
});

test("a listener filter: nothing older than the trigger, bots and outsiders only when allowed, PR links, and a match on the event", () => {
  const [event] = parseListenerReport(({ events: [ping()] }), NOW).events as [ListenerEvent];
  const since = "2026-10-08T11:00:00.000Z";
  assert.equal(listenerMatches({}, event, since), true);
  assert.equal(listenerMatches({}, event, "2026-10-08T12:00:00.000Z"), false, "an event from before the trigger");
  assert.equal(listenerMatches({}, { ...event, bot: true }, since), false);
  assert.equal(listenerMatches({ bots: true }, { ...event, bot: true }, since), true);
  assert.equal(listenerMatches({}, { ...event, external: true }, since), false);
  assert.equal(listenerMatches({ external: true }, { ...event, external: true }, since), true);
  assert.equal(listenerMatches({ prLinks: true }, { ...event, links: [] }, since), false);
  assert.equal(listenerMatches({ prLinks: true }, event, since), true);
  assert.equal(listenerMatches({ match: { field: "fields.channel", op: "equals", value: "G01REVIEWS" } }, event, since), true);
  assert.equal(listenerMatches({ match: { field: "fields.channel", op: "equals", value: "C0RANDOM" } }, event, since), false);
  assert.equal(listenerMatches({ match: { field: "summary", op: "contains", value: "widgets#42" } }, event, since), true);
  assert.equal(listenerMatches({ match: { field: "", op: "contains", value: "could you review" } }, event, since), true, "the whole event");
  assert.equal(listenerMatches({ match: { field: "fields.missing", op: "equals", value: "x" } }, event, since), false);
  const [listed] = parseListenerReport({ events: [ping({ fields: { labels: ["ci", "bug"], number: 12, draft: false } })] }, NOW).events as [ListenerEvent];
  assert.equal(listenerMatches({ match: { field: "fields.labels", op: "contains", value: "bug" } }, listed, since), true, "a list contains an element");
  assert.equal(listenerMatches({ match: { field: "fields.labels", op: "contains", value: "bu" } }, listed, since), false, "an element, not part of one");
  assert.equal(listenerMatches({ match: { field: "fields.number", op: "equals", value: "12" } }, listed, since), true, "numbers compare as text");
  assert.equal(listenerMatches({ match: { field: "fields.draft", op: "equals", value: "false" } }, listed, since), true);
  assert.equal(listenerMatches({ match: { field: "links.0", op: "equals", value: "https://github.com/acme/widgets/pull/42" } }, listed, since), true, "list indexes");
  assert.equal(listenerMatches({ match: { field: "fields", op: "equals", value: "x" } }, listed, since), false, "an object equals nothing");
  assert.equal(listenerMatches({ match: { field: "fields.constructor", op: "contains", value: "Object" } }, listed, since), false, "only the event's own keys");
});

test("only this machine and Tailscale's addresses may report", () => {
  for (const address of ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1", "100.64.0.1", "100.101.102.103", "100.127.255.254", "::ffff:100.100.1.2", "fd7a:115c:a1e0::1", "fd7a:115c:a1e0:ab12:4843:cd96:6258:b240"]) {
    assert.equal(isTailnetOrLoopback(address), true, address);
  }
  for (const address of [undefined, "", "10.0.0.5", "192.168.1.20", "100.63.255.255", "100.128.0.1", "8.8.8.8", "::ffff:8.8.8.8", "fd7a:115c:a1e1::1", "2001:db8::1", "localhost"]) {
    assert.equal(isTailnetOrLoopback(address), false, String(address));
  }
});

test("a token is 32 random bytes in base64url, stored only as its SHA-256 and compared in constant time", () => {
  const first = newHookToken();
  const second = newHookToken();
  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/u);
  assert.notEqual(first.token, second.token);
  assert.equal(first.hash, hashHookToken(first.token));
  assert.match(first.hash, /^[0-9a-f]{64}$/u);
  assert.equal(first.hint, first.token.slice(0, 4));
  assert.equal(sameHash(first.hash, hashHookToken(first.token)), true);
  assert.equal(sameHash(first.hash, second.hash), false);
  assert.equal(sameHash(first.hash, "zz"), false, "not a digest");
  assert.equal(HOOK_ROUTE.exec(`/__hui/hooks/${first.token}`)?.[1], first.token);
  assert.equal(HOOK_ROUTE.test("/__hui/hooks/short"), false);
  assert.equal(HOOK_ROUTE.test(`/__hui/hooks/${first.token}/x`), false);
  assert.equal(isHookPath("/__hui/hooks/anything"), true);
  assert.equal(isHookPath("/__hui/bots"), false);
});

function request(body: string, headers: Record<string, string> = { "content-type": "application/json" }): IncomingMessage {
  const stream = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
  stream.headers = headers;
  return stream;
}

test("a report's body is read up to 64 KiB, and only as JSON", async () => {
  assert.deepEqual(await readHookBody(request("{\"events\":[]}", { "content-type": "application/json; charset=utf-8" })), { events: [] });
  assert.deepEqual(await readHookBody(request("{\"a\":1}", { "content-type": "application/vnd.listener+json" })), { a: 1 });
  const refused = (status: number, message: RegExp) => (error: unknown) => error instanceof HookBodyError && error.status === status && message.test(error.message);
  await assert.rejects(readHookBody(request("{\"events\":[]}", {})), refused(400, /A listener reports JSON \(Content-Type: application\/json\)/u), "no type");
  await assert.rejects(readHookBody(request("hello", { "content-type": "text/plain" })), refused(400, /A listener reports JSON/u));
  await assert.rejects(readHookBody(request("{nope")), refused(400, /says it is JSON but isn't/u));
  await assert.rejects(readHookBody(request(`"${"x".repeat(65 * 1024)}"`)), refused(413, /larger than 64 KiB/u), "a body that turns out too large");
  await assert.rejects(readHookBody(request("{}", { "content-type": "application/json", "content-length": String(1024 * 1024) })), refused(413, /larger than 64 KiB/u), "a declared length over the cap is refused before reading");
  assert.equal(await readHookBody(request(`"${"x".repeat(64 * 1024 - 2)}"`)).then((value) => (value as string).length), 64 * 1024 - 2, "exactly the cap passes");
});
