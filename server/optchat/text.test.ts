import assert from "node:assert/strict";
import { test } from "vitest";
import { bytes, capText, cutUtf8, flatten, localDateTime, localDay } from "./text.ts";

test("cutUtf8 never splits a character at the byte limit", () => {
  assert.equal(cutUtf8("abc", 5), "abc");
  assert.equal(cutUtf8("abcdef", 3), "abc");
  // "é" is two bytes: a limit falling inside it drops it whole.
  assert.equal(cutUtf8("aé", 2), "a");
  assert.equal(cutUtf8("aé", 3), "aé");
  // A four-byte emoji cut anywhere inside goes whole.
  for (const limit of [2, 3, 4]) assert.equal(cutUtf8("a😀b", limit), "a");
  assert.equal(cutUtf8("a😀b", 5), "a😀");
  assert.equal(bytes(cutUtf8("ñ".repeat(300), 511)), 510);
});

test("capText keeps the head and the tail within the cap and says what it cut", () => {
  assert.equal(capText("short", 30), "short");
  const text = `${"H".repeat(500)}${"x".repeat(9_000)}${"T".repeat(500)}`;
  const capped = capText(text, 1_000);
  assert(capped.length <= 1_000, String(capped.length));
  assert(capped.startsWith("H".repeat(450)), "the head is kept");
  assert(capped.endsWith("T".repeat(450)), "the tail is kept");
  const cut = Number(/\n\[(\d+) characters cut\]\n/u.exec(capped)?.[1]);
  assert.equal(capped.length - `\n[${cut} characters cut]\n`.length + cut, text.length, "the note counts exactly what is missing");
  // A surrogate pair at a cut is dropped whole rather than split.
  const emoji = capText("😀".repeat(100), 60);
  assert.doesNotThrow(() => encodeURIComponent(emoji), "no lone surrogate");
});

test("flatten and local dates", () => {
  assert.equal(flatten("a\nb\r\nc\rd"), "a b c d");
  const date = new Date(2026, 9, 5, 7, 8, 9);
  assert.equal(localDay(date), "2026-10-05");
  const offset = -date.getTimezoneOffset();
  const zone = `${offset < 0 ? "-" : "+"}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0")}:${String(Math.abs(offset) % 60).padStart(2, "0")}`;
  assert.equal(localDateTime(date), `2026-10-05 07:08:09 ${zone}`);
});
