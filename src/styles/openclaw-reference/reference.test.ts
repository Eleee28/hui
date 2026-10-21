import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "vitest";

const root = new URL("./", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8")) as {
  release: string;
  commit: string;
  files: { file: string; source: string; kind: "verbatim" | "excerpt"; sha256: string; sourceSha256: string }[];
};

test("the versioned presentation snapshot retains every reviewed stylesheet", () => {
  assert.equal(manifest.release, "2026.9.5");
  assert.equal(manifest.commit, "ec9c1a13db8938e5a3eaa51fca2e981cde2395a9");
  const actual = readdirSync(root, { recursive: true }).map(String).filter((file) => file.endsWith(".css")).sort();
  assert.deepEqual(actual, manifest.files.map(({ file }) => file).sort());
  assert.equal(manifest.files.filter(({ kind }) => kind === "verbatim").length, 32);
  assert.equal(manifest.files.filter(({ kind }) => kind === "excerpt").length, 5);
  for (const entry of manifest.files) {
    const css = readFileSync(new URL(entry.file, root), "utf8")
      .replace(/^\/\* OpenClaw v2026\.9\.5[\s\S]*?\*\/\s*/, "").trim();
    assert.equal(createHash("sha256").update(css).digest("hex"), entry.sha256, entry.file);
    if (entry.kind === "verbatim") assert.equal(entry.sha256, entry.sourceSha256, entry.file);
    assert.ok(entry.source.startsWith("ui/src/styles/"));
  }
});
