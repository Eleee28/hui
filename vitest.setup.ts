import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Runs in each Vitest worker before its tests. CI preloads Datadog's tracer through NODE_OPTIONS (see test.yml);
// the worker has loaded it by now, so drop it here: the gateways, workers and CLIs the tests spawn are code under
// test, not test runners, and must start as they do for users.
delete process.env["NODE_OPTIONS"];

// server/paths.ts fixes HUI's folder when it is first imported, often before a test points HOME elsewhere: start every
// test file on an empty folder of its own so no test can write the operator's ~/.config/hui.
const configHome = mkdtempSync(join(tmpdir(), "hui-test-config-"));
process.env["XDG_CONFIG_HOME"] = configHome;
delete process.env["HUI_CONFIG_DIR"];
afterAll(() => rmSync(configHome, { recursive: true, force: true }));
