import assert from "node:assert/strict";
import { test } from "vitest";
import { QuestionBox, QuestionsClosedError } from "./question-box.ts";
import type { RuntimeQuestion } from "./types.ts";

test("a question box answers once, refuses the wrong shape, dismisses on cancel or abort, and closing is no dismissal", async () => {
  const asked: RuntimeQuestion[] = [];
  const box = new QuestionBox((question) => asked.push(question));
  const answer = box.ask({ method: "select", title: "Pick", options: ["Allow", "Deny"] });
  const id = asked[0]!.id;
  assert.deepEqual(box.pending().map((question) => question.id), [id]);
  assert.throws(() => box.respond(id, { confirmed: true }), /text response is required/u);
  box.respond(id, { value: "Allow" });
  assert.deepEqual(await answer, { value: "Allow" });
  assert.equal(box.has(id), false);
  assert.throws(() => box.respond(id, { value: "Allow" }), /Unknown question/u);
  const cancelled = box.ask({ method: "confirm", title: "Sure?", message: "Really." });
  box.cancel(asked[1]!.id);
  assert.equal(await cancelled, undefined);
  const controller = new AbortController();
  const aborted = box.ask({ method: "input", title: "Name" }, controller.signal);
  controller.abort();
  assert.equal(await aborted, undefined);
  const closing = box.ask({ method: "input", title: "Later" });
  box.close();
  await assert.rejects(closing, QuestionsClosedError, "nobody answered it: the asker may ask again elsewhere");
  assert.deepEqual(box.pending(), []);
});

test("a question announced while it is asked can be answered at once", async () => {
  let box!: InstanceType<typeof QuestionBox>;
  box = new QuestionBox((question) => box.respond(question.id, { value: "now" }));
  assert.deepEqual(await box.ask({ method: "input", title: "Quick" }), { value: "now" });
  assert.equal(await box.ask({ method: "input", title: "Late" }, AbortSignal.abort()), undefined, "an aborted signal asks nothing");
});
