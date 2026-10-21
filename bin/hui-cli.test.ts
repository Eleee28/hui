import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { scripts?: Record<string, string> };
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

test("npm run dev serves HUI without opening a browser", () => {
  assert.equal(packageJson.scripts?.dev, "node bin/hui-dev.mjs gateway");
  assert.match(readme, /npm run dev\s+# starts the Vite server and prints its URL; opens no window/);
  assert.match(readme, /`hui browser` is an alias for `hui ui`/);
});
