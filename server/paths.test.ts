import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { test } from "vitest";
import { CONFIG_DIR } from "./paths.ts";

test("tests resolve HUI's folder to a throwaway one, never the operator's", () => {
  assert.ok(CONFIG_DIR.startsWith(tmpdir()), CONFIG_DIR);
});
