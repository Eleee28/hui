/**
 * Enforces the dependency rules listed in docs/map.md: which areas may import which, where network calls and
 * custom elements live, no cycles, a worker release that ships what it imports, and installed entry paths that
 * never move. There are no exceptions: a violation fails the test.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAst } from "vite";
import { test } from "vitest";
import { workerRelease } from "../server/worker/release.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const AREAS = ["bin", "cli", "desktop", "evals", "e2e", "scripts", "server", "src"];
const CODE = /\.[cm]?[jt]s$/u;
const TEST = /\.test\.[cm]?[jt]s$/u;
const ENTRIES = ["bin/hui.mjs", "cli/launch.ts", "cli/main.ts", "cli/gateway-run.ts", "server/runtimes/pi-sdk-worker.ts", "server/worker/main.ts", "index.html"];

const under = (path, ...dirs) => dirs.some((dir) => path === dir || path.startsWith(`${dir}/`));
const builtin = (specifier) => specifier.startsWith("node:") || builtinModules.includes(specifier.split("/")[0]);

async function sources(directory) {
  const found = [];
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") found.push(...await sources(path));
    } else if (CODE.test(entry.name)) found.push(path);
  }
  return found;
}

function walk(node, visit) {
  if (Array.isArray(node)) for (const child of node) walk(child, visit);
  else if (typeof node?.type === "string") {
    visit(node);
    for (const value of Object.values(node)) if (value && typeof value === "object") walk(value, visit);
  }
}

const text = (node) => (node?.type === "Literal" && typeof node.value === "string" ? node.value : undefined);
const named = (node, name) => node?.type === "Identifier" && node.name === name;
const member = (node, object, property) => node?.type === "MemberExpression" && named(node.object, object) && named(node.property, property);

/** Import-like specifiers and the network and element calls a file makes. */
function scan(file, code) {
  const imports = [];
  const calls = new Set();
  walk(parseAst(code, { lang: /\.d\.[cm]?ts$/u.test(file) ? "dts" : "ts" }), (node) => {
    if (node.type === "ImportDeclaration") imports.push({ specifier: node.source.value, type: node.importKind === "type" });
    else if (node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") {
      if (node.source) imports.push({ specifier: node.source.value, type: node.exportKind === "type" });
    } else if (node.type === "ImportExpression" && text(node.source)) imports.push({ specifier: text(node.source), type: false });
    else if (node.type === "TSImportType" && text(node.source)) imports.push({ specifier: text(node.source), type: true });
    else if (node.type === "NewExpression") {
      const [target, base] = node.arguments;
      if (named(node.callee, "URL") && CODE.test(text(target) ?? "") && base?.type === "MemberExpression" && base.object.type === "MetaProperty") {
        imports.push({ specifier: text(target), type: false });
      }
      if (named(node.callee, "WebSocket") || named(node.callee, "EventSource")) calls.add(`new ${node.callee.name}`);
    } else if (node.type === "CallExpression") {
      if (named(node.callee, "fetch") || member(node.callee, "window", "fetch") || member(node.callee, "globalThis", "fetch")) calls.add("fetch");
      if (member(node.callee, "customElements", "define")) calls.add("customElements.define");
    } else if (node.type === "Decorator" && named(node.expression.callee ?? node.expression, "customElement")) calls.add("@customElement");
  });
  return { imports, calls };
}

test.each([
  ['import type { X } from "../api/fixture.ts";', true],
  ['import { type X, type Y } from "../api/fixture.ts";', false],
  ['import type * as X from "../api/fixture.ts";', true],
  ['import { type X, Y } from "../api/fixture.ts";', false],
  ['import X, { type Y } from "../api/fixture.ts";', false],
  ['import * as X from "../api/fixture.ts";', false],
  ['import "../api/fixture.ts";', false],
  ['import {} from "../api/fixture.ts";', false],
  ['export type { X } from "../api/fixture.ts";', true],
  ['export { type X, type Y } from "../api/fixture.ts";', false],
  ['export type * from "../api/fixture.ts";', true],
  ['export { type X, Y } from "../api/fixture.ts";', false],
  ['export * from "../api/fixture.ts";', false],
  ['export * as X from "../api/fixture.ts";', false],
  ['export {} from "../api/fixture.ts";', false],
])("only a type-only declaration is erased; inline type specifiers still load the module: %s", (code, type) => {
  assert.deepEqual(scan("src/lib/fixture.ts", code).imports, [{ specifier: "../api/fixture.ts", type }]);
});

function rule(from, to, specifier, type) {
  const production = !TEST.test(from);
  if (to === undefined) {
    if (under(from, "src") && production && builtin(specifier)) return "R1";
    if (under(from, "server/api") && !/^typebox(?:\/|$)/u.test(specifier)) return "R15";
    return undefined;
  }
  if (under(to, "shared")) return "R3";
  if (under(from, "src")) {
    if (!under(to, "src")) return "R1";
    if (under(from, "src/lib") && ((under(to, "src/api") && !type && !from.endsWith("-store.ts")) || under(to, "src/controllers", "src/components", "src/views"))) return "R6";
    if (under(from, "src/views") && (under(to, "src/controllers") || to === "src/hui-app.ts")) return "R7";
    return undefined;
  }
  if (under(from, "bin", "cli", "desktop", "server") && under(to, "src")) return "R2";
  if (under(to, "e2e", "evals", "scripts")) return production && under(from, "bin", "cli", "desktop", "server") ? "R11" : undefined;
  if (under(from, "server/optchat") && !under(to, "server/optchat")) return "R9";
  if (under(from, "server/api") && !under(to, "server/api")) return "R15";
  if (production && under(from, "server/runtimes", "server/sessions") && under(to, "server/bots")) return "R8";
  if (under(from, "server", "cli") && !under(to, "server", "cli")) return "R4";
  if (under(from, "desktop") && !under(to, "desktop")) return "R4";
  if (under(from, "bin") && !under(to, "bin", "cli", "server", "desktop", "build")) return "R4";
  return undefined;
}

const files = (await Promise.all(AREAS.map(sources))).flat().sort();
const edges = [];
const unresolved = [];
const violations = new Set();
for (const file of files) {
  const text = await readFile(join(root, file), "utf8");
  const { imports, calls } = scan(file, text);
  const production = !TEST.test(file);
  if (!production && /\bread(?:File(?:Sync)?)?\([^)]*(?:hui-app\.ts|controllers\/)/u.test(text)) violations.add(`${file} (R13)`);
  for (const { specifier, type } of imports) {
    const relativePath = specifier.startsWith(".") ? posix.join(posix.dirname(file), specifier.split("?")[0]) : undefined;
    if (relativePath && !under(relativePath, "build", "dist") && !existsSync(join(root, relativePath))) {
      if (production) unresolved.push(`${file} -> ${specifier}`);
      continue;
    }
    if (relativePath) edges.push({ from: file, to: relativePath, type });
    const broken = rule(file, relativePath, specifier, type);
    if (broken) violations.add(`${file} -> ${relativePath ?? specifier} (${broken})`);
  }
  if (under(file, "src") && production) {
    for (const call of calls) {
      if (call.endsWith("define") || call === "@customElement") {
        if (!under(file, "src/components", "src/hui-app.ts")) violations.add(`${file}: ${call} (R7)`);
      } else if (!under(file, "src/api")) violations.add(`${file}: ${call} (R5)`);
    }
  }
}

for (const file of files.filter((path) => under(path, "e2e", "evals", "scripts"))) {
  const targets = edges.filter((edge) => edge.from === file);
  if (targets.some((edge) => under(edge.to, "src")) && targets.some((edge) => under(edge.to, "server"))) violations.add(`${file} (R12)`);
}

const inside = new Map();
for (const { from, to } of edges) {
  if (["src", "server", "cli"].some((area) => under(from, area) && under(to, area))) inside.set(from, [...inside.get(from) ?? [], to]);
}
function reachable(start) {
  const seen = new Set();
  const stack = [start];
  while (stack.length > 0) {
    for (const next of inside.get(stack.pop()) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return seen;
}
for (const [from, targets] of inside) for (const to of targets) if (reachable(to).has(from)) violations.add(`${from} -> ${to} (R10)`);

const shipped = new Set((await workerRelease()).files.map((file) => file.path));
const workerModules = files.filter((file) => !TEST.test(file) && (["server/worker/main.ts", "server/worker/host.ts"].includes(file) || under(file, "server/runtimes")));
for (const from of workerModules) {
  for (const { to } of edges.filter((edge) => edge.from === from && !edge.type)) {
    if (!shipped.has(to)) violations.add(`${from} -> ${to} (R14)`);
    else if (!workerModules.includes(to)) workerModules.push(to);
  }
}

if (existsSync(join(root, "shared"))) violations.add("shared/ (R3)");
for (const entry of ENTRIES) if (!existsSync(join(root, entry))) violations.add(`${entry} (R17)`);

const found = [...violations].sort();

test("every relative production import resolves", () => {
  assert.deepEqual(unresolved, []);
});

test("no import breaks a dependency rule", () => {
  assert.deepEqual(found, [], "fix these (rules in docs/map.md)");
});

test.each([
  ["src/lib/navigation.fixture.json", "server/http/static-files.fixture.json"],
  ["src/lib/settings/settings.fixture.json", "server/hui-settings.fixture.json"],
  ["src/lib/theme/shadcn-theme.fixture.json", "server/themes.fixture.json"],
  ["src/lib/composer/slash-commands.fixture.json", "server/sessions/slash-commands.fixture.json"],
  ["src/lib/composer/command-references.fixture.json", "server/runtimes/command-references.fixture.json"],
  ["src/lib/session/tree.fixture.json", "server/sessions/session-tree.fixture.json"],
  ["src/lib/subagent-completion.fixture.json", "server/agent-tools/subagent-completion.fixture.json"],
  ["src/lib/markdown/github-links.fixture.json", "server/integrations/github-links.fixture.json"],
  ["src/lib/markdown/datadog-links.fixture.json", "server/integrations/datadog-links.fixture.json"],
  ["src/lib/run-error.fixture.json", "server/sessions/digest.fixture.json"],
  ["src/lib/session-stages.fixture.json", "server/sessions/session-stages.fixture.json"],
  ["src/lib/transcript-metrics.fixture.json", "server/runtimes/transcript-metrics.fixture.json"],
  ["src/api/session-list.fixture.json", "server/sessions/list.fixture.json"],
  ["src/api/files.fixture.json", "server/files.fixture.json"],
  ["src/api/browser.fixture.json", "server/browser/transport.fixture.json"],
  ["src/lib/diff/view-state.fixture.json", "server/git/diff.fixture.json"],
  ["src/lib/bots/facts.fixture.json", "server/bots/facts.fixture.json"],
  ["src/lib/bots/triggers.fixture.json", "server/bots/triggers-format.fixture.json"],
  ["src/api/backlog.fixture.json", "server/backlog.fixture.json"],
  ["src/lib/task-suggestions.fixture.json", "server/agent-tools/task-suggestions.fixture.json"],
  ["src/lib/backlog-start.fixture.json", "server/git/branch-names.fixture.json"],
  ["src/lib/worktrees.fixture.json", "server/git/worktrees.fixture.json"],
  ["src/lib/progress-card.fixture.json", "server/sessions/progress-card.fixture.json"],
  ["src/lib/thinking.fixture.json", "server/sessions/thinking.fixture.json"],
  ["src/lib/bots/templates.fixture.json", "server/bots/templates/formats.fixture.json"],
  ["src/lib/bots/export-preview.fixture.json", "server/bots/export-format.fixture.json"],
  ["src/lib/bots/bots.fixture.json", "server/bots-format.fixture.json"],
  ["src/lib/voice/calls.fixture.json", "server/calls-format.fixture.json"],
  ["src/lib/voice/languages.fixture.json", "server/bots/voice-languages.fixture.json"],
  ["src/lib/widgets.fixture.json", "server/agent-tools/widget-sandbox.fixture.json"],
])("runtime fixtures stay byte-identical: %s and %s", async (browser, server) => {
  assert.equal(await readFile(join(root, browser), "utf8"), await readFile(join(root, server), "utf8"));
});
