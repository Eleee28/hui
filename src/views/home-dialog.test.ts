import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

test("the delete confirmation aligns its actions like an OpenClaw modal footer", () => {
  const css = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8");
  assert.match(
    css,
    /\.delete-session-dialog \.transcript__actions\s*\{[^}]*justify-content:\s*flex-end[^}]*margin-top:\s*var\(--space-4\)/s,
  );
});
