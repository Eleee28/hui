import assert from "node:assert/strict";
import { test } from "vitest";
import type { BotView } from "../api/schema/bots.ts";
import { botMentionSuggestions, completeLocalPath, localPathQuery } from "./local-paths.ts";

test("local path queries follow the caret and also expose leading absolute prefixes", () => {
  assert.deepEqual(localPathQuery("Check @src/ma please", 13), {
    input: "src/ma",
    start: 6,
    end: 13,
    mention: true,
  });
  assert.deepEqual(localPathQuery("Open ./src/", 11), {
    input: "./src/",
    start: 5,
    end: 11,
    mention: false,
  });
  assert.deepEqual(localPathQuery("Look in /tmp/hu", 15), {
    input: "/tmp/hu",
    start: 8,
    end: 15,
    mention: false,
  });
  assert.deepEqual(localPathQuery("/review", 7), { input: "/review", start: 0, end: 7, mention: false });
  assert.equal(localPathQuery("$review", 7), null);
  assert.equal(localPathQuery("plain", 5), null);
  assert.equal(localPathQuery("@src", 1, 4), null);
});

test("completion replaces only the token under the caret", () => {
  assert.deepEqual(
    completeLocalPath("Read @src/ma next", { input: "src/ma", start: 5, end: 12, mention: true }, {
      path: "src/main.ts",
      kind: "file",
    }),
    { text: "Read @src/main.ts next", caret: 17 },
  );
  assert.deepEqual(
    completeLocalPath("Ask @ad", { input: "ad", start: 4, end: 7, mention: true }, { path: "ada", kind: "bot", bot: { id: "b1", name: "Ada" } }),
    { text: "Ask @ada ", caret: 9 },
    "a bot ends the mention, so the message goes on",
  );
});

test("a mention suggests the bots the chat may tag, by handle or name, never itself, an archived bot or one nobody may tag", () => {
  const bot = (id: string, handle: string, name: string, extra: Partial<BotView> = {}) => ({ id, handle, name, ...extra }) as BotView;
  const bots = [
    bot("b3", "cy", "Ada's twin"), bot("b1", "ada", "Ada", { title: "Release manager" }), bot("b2", "adam", "Adam", { archived: true }),
    bot("b4", "dee", "Dee", { tagging: "mention" }), bot("b5", "eve", "Eve", { tagging: "nobody" }),
  ];
  assert.deepEqual(botMentionSuggestions(bots, "AD").map((suggestion) => suggestion.path), ["ada", "cy"], "the handle or the name, any case");
  assert.deepEqual(botMentionSuggestions(bots, "").map((suggestion) => suggestion.path), ["ada", "cy", "dee"], "a bare @ lists every bot it may tag, by handle");
  assert.deepEqual(botMentionSuggestions(bots, "", "b1").map((suggestion) => suggestion.path), ["cy", "dee"], "never the bot whose chat it is");
  assert.deepEqual(botMentionSuggestions(bots, "src/"), []);
  assert.deepEqual(botMentionSuggestions(bots, "ada")[0], { path: "ada", kind: "bot", bot: { id: "b1", name: "Ada", title: "Release manager", avatar: undefined } });
});
