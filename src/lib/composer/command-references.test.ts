import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "vitest";
import { commandReference, resolveCommandReference, type CallableCommand } from "./command-references.ts";

const catalog: CallableCommand[] = [
  { name: "skill:review", source: "skill" },
  { name: "status", source: "extension" },
  { name: "plan", source: "prompt" },
];

test("both menus use catalog-bound aliases without installation paths", () => {
  assert.deepEqual(catalog.map((command) => commandReference(command, catalog)), ["$review", "$status", "/plan"]);
  assert.equal(resolveCommandReference("$review inspect ./src", catalog), "/skill:review inspect ./src");
  assert.equal(resolveCommandReference("$status\nnext line", catalog), "/status\nnext line");
  for (const text of ["$10", "$HOME", "$unknown", "$plan", "Explain $review", "`$review`", "/tmp/review", "$review/path"]) {
    assert.equal(resolveCommandReference(text, catalog), text);
  }
});

test("name collisions keep skill-qualified references unambiguous", () => {
  const collision: CallableCommand[] = [...catalog, { name: "review", source: "extension" }];
  assert.equal(commandReference(collision[0]!, collision), "$skill:review");
  assert.equal(resolveCommandReference("$review args", collision), "/review args");
  assert.equal(resolveCommandReference("$skill:review args", collision), "/skill:review args");
  assert.equal(resolveCommandReference("$review", []), "$review");
});


test("HUI commands and templates do not claim the dollar namespace", () => {
  const commands: CallableCommand[] = [
    { name: "update", source: "hui" },
    { name: "review", source: "prompt" },
    { name: "skill:review", source: "skill" },
  ];
  assert.equal(commandReference(commands[0]!, commands), "/update");
  assert.equal(commandReference(commands[2]!, commands), "$review");
  assert.equal(resolveCommandReference("$update", commands), "$update");
  assert.equal(resolveCommandReference("$skill:review args", commands), "/skill:review args");
});

const fixtures: { input: { text: string; catalog: Parameters<typeof resolveCommandReference>[1] }; expected: string }[] = JSON.parse(readFileSync(new URL("./command-references.fixture.json", import.meta.url), "utf8"));

test("command-references preserves the shared runtime fixtures", () => {
  for (const fixture of fixtures) {
    assert.equal(resolveCommandReference(fixture.input.text, fixture.input.catalog), fixture.expected);
  }
});
