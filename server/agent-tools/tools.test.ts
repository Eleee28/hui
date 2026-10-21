import assert from "node:assert/strict";
import { mkdtemp, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectTypeOf, test } from "vitest";
import { ToolsCatalog, type ToolCatalogEntry, type RuntimeTool, type RuntimeInspection, type SessionTools } from "../api/tools.ts";
import { expectSchema } from "../test-support/api-schema.ts";


type OriginalToolCatalogEntry = {
  name: string;
  description: string;
  source: string;
  defaultEnabled: boolean;
};

type OriginalRuntimeTool = {
  name: string;
  description: string;
  source: string;
  active: boolean;
  parameters: unknown;
};

type OriginalRuntimeInspection = {
  status: "live";
  backend: string;
  version: string;
  revision: string;
  tools: OriginalRuntimeTool[];
  prompt: string;
  promptPhase: "initialized" | "current-turn" | "last-turn";
  promptSource: string;
  diagnostics: string[];
};

type OriginalSessionTools = OriginalRuntimeInspection | { status: "cold" | "unsupported" };

type OriginalToolsCatalog = {
  backend: "sdk" | "cli";
  sdkVersion: string;
  tools: OriginalToolCatalogEntry[];
  sources: string[];
  diagnostics: string[];
  prompt: { revision: string; text: string };
};

expectTypeOf<ToolCatalogEntry>().toEqualTypeOf<OriginalToolCatalogEntry>();
expectTypeOf<RuntimeTool>().toEqualTypeOf<OriginalRuntimeTool>();
expectTypeOf<RuntimeInspection>().toEqualTypeOf<OriginalRuntimeInspection>();
expectTypeOf<SessionTools>().toEqualTypeOf<OriginalSessionTools>();
expectTypeOf<ToolsCatalog>().toEqualTypeOf<OriginalToolsCatalog>();
import { readToolsCatalog } from "./tools.ts";
import { huiToolDefinitions } from "../runtimes/hui-tools.ts";

test("global tools expose real HUI definitions without loading configured packages or creating sessions", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hui-tools-"));
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "danger.mjs"), 'throw new Error("must not load");');
  await writeFile(join(dir, "settings.json"), JSON.stringify({
    packages: ["npm:nonexistent-test-package", "https://user:hunter2@example.org/repo.git?token=hunter2"],
    extensions: [join(dir, "danger.mjs")],
  }));
  const before = await readdir(dir);
  const result = await readToolsCatalog(dir);
  expectSchema(ToolsCatalog, result);
  assert.equal(result.tools.length, 25);
  assert.equal(result.tools.find((tool) => tool.name === "browser")?.source, "HUI");
  assert.equal(result.tools.find((tool) => tool.name === "show_widget")?.source, "HUI");
  assert.deepEqual(result.tools.filter((tool) => tool.source === "HUI").map((tool) => tool.name), huiToolDefinitions().map((tool) => tool.name));
  assert.deepEqual(result.sources, ["danger.mjs", "nonexistent-test-package", "example.org/repo"]);
  assert.deepEqual(await readdir(dir), before);
  assert(!JSON.stringify(result).includes("hunter2"));
  assert.equal(result.prompt.revision, "hui-v4");
});

test("missing and malformed settings keep the shipped catalog usable with explicit diagnostics", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hui-tools-invalid-"));
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  assert.deepEqual((await readToolsCatalog(dir)).diagnostics, []);
  await writeFile(join(dir, "settings.json"), "not json");
  const result = await readToolsCatalog(dir);
  assert.equal(result.tools.length, 25);
  assert.equal(result.diagnostics.length, 1);
});
