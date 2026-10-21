import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "vitest";
import { Type } from "typebox";
import { apiAreas, buildApiSchema } from "../server/api/index.ts";
import { emittedSchema, generateBrowserTypes, schemaType } from "./api-schema.ts";

const root = new URL("../", import.meta.url);
const regenerate = "run `npm run api:schema`";

test("the published schema and browser payload types are current", async () => {
  const committed = await readFile(new URL("docs/api.schema.json", root), "utf8");
  assert.equal(await emittedSchema(), committed, regenerate);
  const generated = generateBrowserTypes(JSON.parse(committed));
  const directory = new URL("src/api/schema/", root);
  assert.deepEqual((await readdir(directory)).sort(), Object.keys(generated).map((area) => `${area}.ts`).sort(), regenerate);
  for (const [area, expected] of Object.entries(generated)) assert.equal(await readFile(new URL(`${area}.ts`, directory), "utf8"), expected, regenerate);
  const modules = (await readdir(new URL("server/api/", root))).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "index.ts");
  assert.deepEqual(modules.sort(), Object.keys(apiAreas).map((area) => `${area}.ts`).sort(), "register each API area in server/api/index.ts");
});

test.for([false, true])("the schema CLI publishes both outputs or leaves them untouched when stale types exist (stale: %s)", async (stale, t) => {
  const temporary = await mkdtemp(join(tmpdir(), "hui-api-schema-"));
  t.onTestFinished(() => rm(temporary, { recursive: true, force: true }));
  for (const directory of ["scripts", "server/api", "docs", "src/api/schema"]) await mkdir(join(temporary, directory), { recursive: true });
  await cp(new URL("api-schema.ts", import.meta.url), join(temporary, "scripts/api-schema.ts"));
  const schema = { $defs: { Fixture: { type: "string" } }, "x-hui-areas": { fixture: ["Fixture"] } };
  await writeFile(join(temporary, "package.json"), JSON.stringify({ type: "module", version: "test" }));
  await writeFile(join(temporary, "server/api/schema.json"), JSON.stringify(schema));
  await writeFile(join(temporary, "server/api/index.ts"), 'import schema from "./schema.json" with { type: "json" };\nexport const buildApiSchema = () => schema;\n');
  const document = join(temporary, "docs/api.schema.json");
  const types = join(temporary, "src/api/schema/fixture.ts");
  await writeFile(document, "previous schema\n");
  await writeFile(types, "previous types\n");
  if (stale) await writeFile(join(temporary, "src/api/schema/obsolete.ts"), "obsolete types\n");
  const run = () => promisify(execFile)(process.execPath, [join(temporary, "scripts/api-schema.ts")], { cwd: temporary });
  if (stale) {
    await assert.rejects(run, /Remove obsolete generated API types: obsolete.ts/u);
    assert.equal(await readFile(document, "utf8"), "previous schema\n");
    assert.equal(await readFile(types, "utf8"), "previous types\n");
    assert.equal(await readFile(join(temporary, "src/api/schema/obsolete.ts"), "utf8"), "obsolete types\n");
  } else {
    await run();
    assert.equal(await readFile(document, "utf8"), `${JSON.stringify(schema, null, 2)}\n`);
    assert.equal(await readFile(types, "utf8"), "/** Generated from docs/api.schema.json by scripts/api-schema.ts. Do not edit. */\n\nexport type Fixture = string;\n");
  }
});

test("the converter handles every supported schema keyword and cross-area references", () => {
  const fixture = {
    $id: "Fixture",
    description: "Not emitted into TypeScript",
    type: "object",
    properties: {
      label: { type: "string" },
      size: { type: "number" },
      count: { type: "integer" },
      enabled: { type: "boolean" },
      tag: { const: "fixed", type: "string" },
      mode: { enum: ["a", "b", null] },
      values: { type: "array", items: { anyOf: [{ type: "null" }, { $ref: "#/$defs/Other" }] } },
      labels: Type.Record(Type.String(), Type.Boolean()),
      numbers: Type.Record(Type.Number(), Type.String()),
      integers: Type.Record(Type.Integer(), Type.String()),
      open: { type: "object", additionalProperties: true },
      extra: { type: "object", additionalProperties: { type: "boolean" } },
    },
    required: ["label", "values"],
    additionalProperties: false,
  };
  const generated = generateBrowserTypes({
    $defs: { Fixture: fixture, Other: { type: "boolean" } },
    "x-hui-areas": { fixture: ["Fixture"], other: ["Other"] },
  });
  assert.equal(generated["fixture"], '/** Generated from docs/api.schema.json by scripts/api-schema.ts. Do not edit. */\nimport type { Other } from "./other.ts";\n\nexport type Fixture = { "label": string; "size"?: number; "count"?: number; "enabled"?: boolean; "tag"?: "fixed"; "mode"?: "a" | "b" | null; "values": Array<(null) | (Other)>; "labels"?: Record<string, boolean>; "numbers"?: Record<number, string>; "integers"?: Record<number, string>; "open"?: Record<string, unknown>; "extra"?: Record<string, boolean>; };\n');
  assert.equal(generated["other"], "/** Generated from docs/api.schema.json by scripts/api-schema.ts. Do not edit. */\n\nexport type Other = boolean;\n");
  assert.throws(() => schemaType({ type: "object", properties: { name: { type: "string", minLength: 1 } } }), /Unsupported keyword #\/properties\/name\/minLength/u);
  assert.throws(() => schemaType({ type: "object", patternProperties: { "^prefix": { type: "string" } } }), /Unsupported pattern at #\/patternProperties/u);
  assert.throws(() => generateBrowserTypes({ $defs: { Missing: { $ref: "#/$defs/Absent" } }, "x-hui-areas": { test: ["Missing"] } }), /Unknown API schema reference: Absent/u);
});

test("every JSON route module and documented route has a published schema", async () => {
  const gaps = [];
  for (const name of await readdir(new URL("server/routes/", root))) {
    if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
    const source = await readFile(new URL(`server/routes/${name}`, root), "utf8");
    if (!/export\s+(?:const\s+routeSchemas|\{[^}]*\brouteSchemas\b)/u.test(source)) gaps.push(`module: ${name.slice(0, -3)}`);
  }
  const documentation = await readFile(new URL("docs/api.md", root), "utf8");
  const documented = new Set([...documentation.matchAll(/^### `(\w+ \/__hui\/[^`]+)`/gmu)].map((match) => match[1]!.split("?")[0]!));
  const published = new Set(buildApiSchema("test")["x-hui-routes"].map((route) => `${route.method} ${route.path}`));
  for (const route of documented) if (!published.has(route)) gaps.push(`missing: ${route}`);
  for (const route of published) if (!documented.has(route)) gaps.push(`undocumented: ${route}`);
  assert.deepEqual(gaps.sort(), [], "add routeSchemas and a docs/api.md heading for every JSON route");
});
