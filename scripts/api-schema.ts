/** Publishes the server's API schema and generates browser-only payload types from the published JSON. */
import { realpathSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { buildApiSchema } from "../server/api/index.ts";

const root = new URL("../", import.meta.url);
const keywords = new Set(["type", "properties", "required", "additionalProperties", "patternProperties", "items", "anyOf", "const", "enum", "$ref", "$id", "description"]);
const header = "/** Generated from docs/api.schema.json by scripts/api-schema.ts. Do not edit. */\n";

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`Expected an object at ${path}`);
  return value as Record<string, unknown>;
}

function list(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Expected an array at ${path}`);
  return value;
}

function literal(value: unknown, path: string): string {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return JSON.stringify(value);
  throw new Error(`Unsupported literal at ${path}`);
}

export function schemaType(value: unknown, path = "#", reference: (name: string) => string = (name) => name): string {
  const schema = object(value, path);
  for (const key of Object.keys(schema)) if (!keywords.has(key)) throw new Error(`Unsupported keyword ${path}/${key}`);
  if (typeof schema["$ref"] === "string") {
    const match = /^#\/\$defs\/([A-Za-z_$][\w$]*)$/u.exec(schema["$ref"]);
    if (!match?.[1]) throw new Error(`Unsupported reference at ${path}/$ref`);
    return reference(match[1]);
  }
  if ("const" in schema) return literal(schema["const"], `${path}/const`);
  if ("enum" in schema) return list(schema["enum"], `${path}/enum`).map((item) => literal(item, `${path}/enum`)).join(" | ") || "never";
  if ("anyOf" in schema) return list(schema["anyOf"], `${path}/anyOf`).map((item, index) => `(${schemaType(item, `${path}/anyOf/${index}`, reference)})`).join(" | ") || "never";
  switch (schema["type"]) {
    case "string": return "string";
    case "number":
    case "integer": return "number";
    case "boolean": return "boolean";
    case "null": return "null";
    case "array": return `Array<${schemaType(schema["items"], `${path}/items`, reference)}>`;
    case "object": {
      const properties = object(schema["properties"] ?? {}, `${path}/properties`);
      const required = list(schema["required"] ?? [], `${path}/required`);
      const fields = Object.entries(properties).map(([name, child]) => `${JSON.stringify(name)}${required.includes(name) ? "" : "?"}: ${schemaType(child, `${path}/properties/${name}`, reference)};`);
      const parts = fields.length > 0 ? [`{ ${fields.join(" ")} }`] : [];
      for (const [pattern, child] of Object.entries(object(schema["patternProperties"] ?? {}, `${path}/patternProperties`))) {
        const key = pattern === "^.*$" ? "string" : ["^-?(?:0|[1-9][0-9]*)$", "^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$"].includes(pattern) ? "number" : undefined;
        if (!key) throw new Error(`Unsupported pattern at ${path}/patternProperties/${pattern}`);
        parts.push(`Record<${key}, ${schemaType(child, `${path}/patternProperties/${pattern}`, reference)}>`);
      }
      const additional = schema["additionalProperties"];
      if (additional === true) parts.push("Record<string, unknown>");
      else if (additional !== undefined && additional !== false) parts.push(`Record<string, ${schemaType(additional, `${path}/additionalProperties`, reference)}>`);
      return parts.join(" & ") || "Record<string, unknown>";
    }
    case undefined:
      if (Object.keys(schema).every((key) => key === "$id" || key === "description")) return "unknown";
      throw new Error(`Missing schema type at ${path}`);
    default: throw new Error(`Unsupported type at ${path}/type`);
  }
}

export function generateBrowserTypes(document: unknown): Record<string, string> {
  const schema = object(document, "#");
  const definitions = object(schema["$defs"], "#/$defs");
  const areas = object(schema["x-hui-areas"], "#/x-hui-areas");
  const owners = new Map<string, string>();
  for (const [area, names] of Object.entries(areas)) {
    if (!/^[a-z][a-z0-9-]*$/u.test(area)) throw new Error(`Invalid API area: ${area}`);
    for (const name of list(names, `#/x-hui-areas/${area}`)) {
      if (typeof name !== "string" || !/^[A-Za-z_$][\w$]*$/u.test(name) || !Object.hasOwn(definitions, name)) throw new Error(`Invalid API schema name in ${area}: ${String(name)}`);
      if (owners.has(name)) throw new Error(`Duplicate API schema owner: ${name}`);
      owners.set(name, area);
    }
  }
  if (Object.keys(definitions).some((name) => !owners.has(name))) throw new Error("Every API schema must have an area");
  return Object.fromEntries(Object.keys(areas).sort().map((area) => {
    const imports = new Map<string, Set<string>>();
    const reference = (name: string) => {
      const owner = owners.get(name);
      if (!owner) throw new Error(`Unknown API schema reference: ${name}`);
      if (owner !== area) {
        if (!imports.has(owner)) imports.set(owner, new Set());
        imports.get(owner)!.add(name);
      }
      return name;
    };
    const types = [...owners].filter(([, owner]) => owner === area).map(([name]) => `export type ${name} = ${schemaType(definitions[name], `#/$defs/${name}`, reference)};\n`);
    const dependencies = [...imports].sort(([a], [b]) => a.localeCompare(b)).map(([owner, names]) => `import type { ${[...names].sort().join(", ")} } from "./${owner}.ts";\n`).join("");
    return [area, `${header}${dependencies}\n${types.join("\n")}`];
  }));
}

export async function emittedSchema(): Promise<string> {
  const { version } = JSON.parse(await readFile(new URL("package.json", root), "utf8")) as { version: string };
  return `${JSON.stringify(buildApiSchema(version), null, 2)}\n`;
}

const entry = process.argv[1];
if (import.meta.main ?? (entry !== undefined && import.meta.url === pathToFileURL(realpathSync(entry)).href)) {
  const destination = new URL("docs/api.schema.json", root);
  const schema = await emittedSchema();
  const generated = generateBrowserTypes(JSON.parse(schema));
  const directory = new URL("src/api/schema/", root);
  await mkdir(directory, { recursive: true });
  const stale = (await readdir(directory)).filter((file) => file.endsWith(".ts") && !(file.slice(0, -3) in generated));
  if (stale.length > 0) throw new Error(`Remove obsolete generated API types: ${stale.join(", ")}`);
  await writeFile(destination, schema);
  for (const [area, content] of Object.entries(generated)) await writeFile(new URL(`${area}.ts`, directory), content);
}
