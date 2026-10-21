import assert from "node:assert/strict";
import { test, vi } from "vitest";

import { Questionnaires } from "./questionnaires.ts";
import { directHuiBridge } from "../runtimes/bridge-client.mjs";
import { huiToolDefinitions } from "../runtimes/hui-tools.ts";

const option = (label: string, extra: Record<string, unknown> = {}) => ({ label, description: `${label} description`, ...extra });
const ask = {
  questions: [
    { header: " Auth ", question: " Which auth method? ", options: [option("OAuth", { preview: "```\nOAuth flow\n```" }), option("API key")] },
    { header: "Features", question: "Which features?", multiSelect: true, options: [option("Search"), option("Export"), option("Sync")] },
  ],
};

function store() {
  const changes: string[] = [];
  return { changes, questionnaires: new Questionnaires({ onChange: (id) => changes.push(id) }) };
}

test("a questionnaire is one pending card in its session, answered all at once", async () => {
  const { questionnaires, changes } = store();
  const result = questionnaires.request("s1", ask);
  const [prompt] = questionnaires.questions("s1");
  assert.equal(prompt?.method, "questionnaire");
  assert.equal(prompt?.title, "Which auth method?", "trimmed, the first question");
  assert.deepEqual(prompt?.questions.map(({ header, multiSelect }) => [header, multiSelect]), [["Auth", false], ["Features", true]]);
  assert.deepEqual(questionnaires.questions("s2"), []);
  assert.equal(questionnaires.answer("s2", prompt!.id, { cancelled: true }), false, "another session cannot answer it");
  assert.equal(questionnaires.answer("s1", "other", { cancelled: true }), false, "nor an unknown id");

  assert.equal(questionnaires.answer("s1", prompt!.id, { answers: [
    { selected: ["OAuth"] },
    { selected: ["Sync", "Search", "Sync"], custom: "  Offline mode " },
  ] }), true);
  assert.deepEqual(await result, { cancelled: false, answers: [
    { header: "Auth", question: "Which auth method?", selected: ["OAuth"], preview: "```\nOAuth flow\n```" },
    { header: "Features", question: "Which features?", selected: ["Search", "Sync", "Offline mode"] },
  ] }, "labels in option order and once, then the typed text; a chosen option's preview goes back to the model");
  assert.deepEqual(questionnaires.questions("s1"), []);
  assert.deepEqual(changes, ["s1", "s1"], "shown, then gone");
});

test("a typed answer replaces a single-select choice, a blank question is left out, and nothing answered is a decline", async () => {
  const { questionnaires } = store();
  const typed = questionnaires.request("s1", ask);
  const id = questionnaires.questions("s1")[0]!.id;
  questionnaires.answer("s1", id, { answers: [{ selected: [], custom: "SSO via Okta" }, { selected: [] }] });
  assert.deepEqual(await typed, { cancelled: false, answers: [{ header: "Auth", question: "Which auth method?", selected: ["SSO via Okta"] }] });

  const blank = questionnaires.request("s1", ask);
  questionnaires.answer("s1", questionnaires.questions("s1")[0]!.id, { answers: [{ selected: [], custom: "   " }, { selected: [] }] });
  assert.deepEqual(await blank, { cancelled: true, answers: [] });
});

test("an answer the card could not have sent is refused and the card stays open", async () => {
  const { questionnaires } = store();
  const pending = questionnaires.request("s1", ask);
  const id = questionnaires.questions("s1")[0]!.id;
  const refused: [Record<string, unknown>, RegExp][] = [
    [{}, /Answer each question/u],
    [{ answers: [{ selected: ["OAuth"] }] }, /Answer each question/u],
    [{ answers: [{ selected: ["Magic link"] }, { selected: [] }] }, /"Auth" has no such option/u],
    [{ answers: [{ selected: ["OAuth", "API key"] }, { selected: [] }] }, /"Auth" takes one answer/u],
    [{ answers: [{ selected: ["OAuth"], custom: "and SSO" }, { selected: [] }] }, /"Auth" takes one answer/u],
    [{ answers: [{ selected: [] }, { selected: [], custom: "x".repeat(4_001) }] }, /at most 4000 characters/u],
  ];
  for (const [body, error] of refused) assert.throws(() => questionnaires.answer("s1", id, body), error);
  assert.equal(questionnaires.questions("s1").length, 1);
  questionnaires.answer("s1", id, { cancelled: true });
  assert.deepEqual(await pending, { cancelled: true, answers: [] });
});

test("Stop, an aborted caller and a gateway stop end a questionnaire as declined", async () => {
  const { questionnaires } = store();
  const stop = new AbortController();
  const stopped = questionnaires.request("s1", ask, stop.signal);
  stop.abort();
  assert.deepEqual(await stopped, { cancelled: true, answers: [] });
  assert.deepEqual(await questionnaires.request("s1", ask, AbortSignal.abort()), { cancelled: true, answers: [] });
  assert.deepEqual(questionnaires.questions("s1"), []);

  const open = [questionnaires.request("s1", ask), questionnaires.request("s2", ask)];
  assert.equal(questionnaires.questions("s1").length + questionnaires.questions("s2").length, 2);
  questionnaires.dispose();
  assert.deepEqual(await Promise.all(open), [{ cancelled: true, answers: [] }, { cancelled: true, answers: [] }]);
});

test("with a question timeout an unanswered card ends as timed out; Off keeps waiting", async (t) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  t.onTestFinished(() => { vi.useRealTimers(); });
  const { questionnaires, changes } = store();
  const timed = questionnaires.request("s1", ask, undefined, 10);
  const off = questionnaires.request("s2", ask);
  vi.advanceTimersByTime(10 * 60_000 - 1);
  assert.equal(questionnaires.questions("s1").length, 1, "still open a moment before");
  vi.advanceTimersByTime(1);
  assert.deepEqual(await timed, { cancelled: true, answers: [], timedOut: true, timeoutMinutes: 10 });
  assert.deepEqual(questionnaires.questions("s1"), [], "the card is gone and can no longer be answered");
  assert.deepEqual(changes, ["s1", "s2", "s1"]);

  vi.advanceTimersByTime(24 * 60 * 60_000);
  assert.equal(questionnaires.questions("s2").length, 1, "Off waits as long as the call lives");
  questionnaires.answer("s2", questionnaires.questions("s2")[0]!.id, { answers: [{ selected: ["API key"] }, { selected: [] }] });
  assert.deepEqual(await off, { cancelled: false, answers: [{ header: "Auth", question: "Which auth method?", selected: ["API key"] }] });

  const answered = questionnaires.request("s1", ask, undefined, 5);
  questionnaires.answer("s1", questionnaires.questions("s1")[0]!.id, { cancelled: true });
  assert.deepEqual(await answered, { cancelled: true, answers: [] }, "an answer in time is what the call returns");
  assert.equal(vi.getTimerCount(), 0, "and its timer is gone");
});

test("a malformed call is rejected with a reason the model can fix", async () => {
  const { questionnaires } = store();
  const question = (extra: Record<string, unknown> = {}) => ({ header: "Pick", question: "Which?", options: [option("A"), option("B")], ...extra });
  const rejected: [unknown, RegExp][] = [
    [undefined, /at least one question/u],
    [[], /at least one question/u],
    [Array.from({ length: 5 }, (_, index) => question({ question: `Q${index}?` })), /at most 4 questions/u],
    [[question(), question()], /asked once/u],
    [[question({ options: [option("A")] })], /2-4 options/u],
    [[question({ options: [option("A"), option("B"), option("C"), option("D"), option("E")] })], /2-4 options/u],
    [[question({ options: [option("A"), option("Other")] })], /"Other" is reserved/u],
    [[question({ options: [option("A"), option("Type something.")] })], /reserved/u],
    [[question({ options: [option("A"), option("A")] })], /unique labels/u],
    [[question({ options: [option("A"), option(" ")] })], /label must be non-empty/u],
    [[question({ header: "A header that is too long" })], /header must be at most 16/u],
    [[question({ header: "" })], /header must be non-empty/u],
    [[question({ options: [option("A", { preview: "x".repeat(2_501) }), option("B")] })], /preview must be at most 2500/u],
    [[question({ multiSelect: true, options: [option("A", { preview: "x" }), option("B")] })], /single-select questions only/u],
    [["not a question"], /must be an object/u],
  ];
  for (const [questions, error] of rejected) await assert.rejects(questionnaires.request("s1", { questions }), error);
  assert.deepEqual(questionnaires.questions("s1"), [], "nothing was shown");
});

test("the tool tells the model what the operator chose, or that they declined", async () => {
  const tool = huiToolDefinitions().find(({ name }) => name === "ask_user_question");
  assert(tool);
  const run = (result: unknown) => directHuiBridge.run(
    async (action: string) => { assert.equal(action, "ask_user_question"); return result; },
    () => tool.execute("call", ask as never, undefined, undefined, undefined as never),
  );
  const answered = await run({ cancelled: false, answers: [
    { header: "Auth", question: "Which auth method?", selected: ["OAuth"], preview: "OAuth flow" },
    { header: "Features", question: "Which features?", selected: ["Search", "Offline mode"] },
  ] });
  assert.equal(answered.content[0]?.type === "text" && answered.content[0].text,
    "User has answered your questions: \"Which auth method?\"=\"OAuth\". selected preview: OAuth flow. \"Which features?\"=\"Search, Offline mode\". You can now continue with the user's answers in mind.");
  const declined = await run({ cancelled: true, answers: [] });
  assert.equal(declined.content[0]?.type === "text" && declined.content[0].text, "User declined to answer questions");
  const timedOut = await run({ cancelled: true, answers: [], timedOut: true, timeoutMinutes: 10 });
  assert.equal(timedOut.content[0]?.type === "text" && timedOut.content[0].text,
    "No answer within 10 minutes; the operator may be away. Continue with your recommended option, keep going with the rest of the work, and in your final reply list the decisions that still need the operator.");
});
