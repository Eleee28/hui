import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "vitest";

test("native palettes and accent contrast retain the pinned original source", () => {
  const files = [
    ["../../public/themes/rose.css", "1c14a27abd28b0f590d6f88e7529e49345777a8abbd8ec5b80ce84433edd6e26"],
    ["../../public/themes/miami.css", "46c7e1855d75867affcc1dd45ed427952f6d469302815d7cdb247f47378df4be"],
    ["./theme/accent-contrast.ts", "9b52f053caa94d578dead4f90f517d33d39823cb79698b9daeb18a8fc10a8dc7"],
  ] as const;
  for (const [file, hash] of files) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8")
      .replace(/^\/\*\* OpenClaw 2026\.9\.5[^\n]*\*\/\n/, "");
    assert.equal(createHash("sha256").update(source).digest("hex"), hash, file);
  }
});

test("the session title marquee retains the original lifecycle and geometry", () => {
  const source = readFileSync(new URL("./hover-marquee.ts", import.meta.url), "utf8")
    .replace(/^\/\/ OpenClaw[^\n]*\n/, "").trim();
  assert.equal(createHash("sha256").update(source).digest("hex"), "915c19efc01ca840e3a115a1d96c36066f6f8807945a9654c1b3ce7c252f0bf4");
});
