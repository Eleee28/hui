import assert from "node:assert/strict";
import { test } from "vitest";
import { pickerRows } from "../picker-options.ts";
import { formatCallTime, languageOptions, microphoneContext, microphoneErrorMessage } from "./voice.ts";

test("call times read like a phone's", () => {
  assert.equal(formatCallTime(0), "0:00");
  assert.equal(formatCallTime(-5), "0:00");
  assert.equal(formatCallTime(65_400), "1:05");
  assert.equal(formatCallTime(3_725_000), "1:02:05");
});

test("the language picker offers Auto, then Whisper's 100 languages by English name with their codes", () => {
  const options = languageOptions();
  assert.equal(options.length, 101);
  assert.deepEqual(options[0], { value: "", label: "Auto (detect)" });
  const labels = options.slice(1).map((option) => option.label);
  assert.deepEqual(labels, [...labels].sort((a, b) => a.localeCompare(b, "en")), "sorted by name");
  const byCode = new Map(options.map((option) => [option.value, option]));
  assert.deepEqual(byCode.get("es"), { value: "es", label: "Spanish", description: "es" });
  assert.deepEqual(byCode.get("haw"), { value: "haw", label: "Hawaiian", description: "haw" });
  assert.deepEqual(byCode.get("yue"), { value: "yue", label: "Cantonese", description: "yue" });
  assert.equal(byCode.get("jw")?.label, "Javanese", "Whisper's jw is Javanese");
  assert.equal(byCode.has("jv"), false, "ISO's jv is not a code HUI stores");
  // Where the browser names a language otherwise, Whisper's name stays searchable.
  assert.deepEqual(byCode.get("bn"), { value: "bn", label: "Bangla", description: "bn · Bengali" });
  const search = (query: string) => pickerRows(options, query).map((option) => option.value);
  assert.deepEqual(search("spanish"), ["es"], "by name");
  assert.ok(search("es").includes("es"), "by code");
  assert.deepEqual(search("bengali"), ["bn"]);
  assert.deepEqual(search("haw"), ["haw"]);
  assert.deepEqual(search("canto"), ["yue"]);
  assert.deepEqual(search("auto"), [""]);
});

test("a language the browser cannot name keeps Whisper's name", () => {
  const names = { of: (code: string) => ({ es: "Spanish", ht: "Haitian Creole", my: "Burmese" } as Record<string, string>)[code] };
  const byCode = new Map(languageOptions(names).map((option) => [option.value, option]));
  assert.deepEqual(byCode.get("es"), { value: "es", label: "Spanish", description: "es" });
  assert.deepEqual(byCode.get("ht"), { value: "ht", label: "Haitian Creole", description: "ht" }, "the same name in another case is no alias");
  assert.deepEqual(byCode.get("my"), { value: "my", label: "Burmese", description: "my · Myanmar" });
  assert.deepEqual(byCode.get("jw"), { value: "jw", label: "Javanese", description: "jw" });
  assert.deepEqual(byCode.get("de"), { value: "de", label: "German", description: "de" });
  const failing = new Map(languageOptions({ of: () => { throw new RangeError("no names"); } }).map((option) => [option.value, option]));
  assert.equal(failing.get("yue")?.label, "Cantonese", "a platform that throws still names it");
  assert.equal(languageOptions(null).length, 101, "no platform names at all");
});

test("microphone failures say what to do", () => {
  const secure = { secure: true, desktop: false };
  assert.match(microphoneErrorMessage(new DOMException("denied", "NotAllowedError"), secure), /denied\. Allow it for this site/u);
  assert.match(microphoneErrorMessage(new DOMException("none", "NotFoundError"), secure), /No microphone was found/u);
  assert.match(microphoneErrorMessage(new DOMException("busy", "NotReadableError"), secure), /busy or unavailable/u);
  assert.equal(microphoneErrorMessage(new Error("weird"), secure), "The microphone could not be opened: weird");
  assert.match(microphoneErrorMessage(new DOMException("denied", "NotAllowedError"), { secure: false, desktop: false }), /secure pages: open HUI on https:\/\//u);
  assert.match(microphoneErrorMessage(undefined, { secure: true, desktop: true }), /desktop app does not allow the microphone yet/u);
  assert.deepEqual(microphoneContext(), { secure: true, desktop: false }, "outside a browser nothing withholds it");
});
