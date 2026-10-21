/** Catalogs the public API areas and builds their portable JSON Schema document without loading services. */
import type { TSchema } from "typebox";
import * as power from "./power.ts";
import * as github from "./github.ts";
import * as datadog from "./datadog.ts";
import * as jira from "./jira.ts";
import * as sessions from "./sessions.ts";
import * as sessionEvents from "./session-events.ts";
import * as bots from "./bots.ts";
import * as botTriggers from "./bot-triggers.ts";
import * as botTemplates from "./bot-templates.ts";
import * as apiSchema from "./api-schema.ts";
import * as settings from "./settings.ts";
import * as pi from "./pi.ts";
import * as providers from "./providers.ts";
import * as tools from "./tools.ts";
import * as automation from "./automation.ts";
import * as updates from "./updates.ts";
import * as workers from "./workers.ts";
import * as terminals from "./terminals.ts";
import * as files from "./files.ts";
import * as diff from "./diff.ts";
import * as browser from "./browser.ts";
import * as backlog from "./backlog.ts";
import * as taskSuggestions from "./task-suggestions.ts";
import * as worktrees from "./worktrees.ts";
import * as watchers from "./watchers.ts";
import * as vscode from "./vscode.ts";
import * as calls from "./calls.ts";
import * as diagnostics from "./diagnostics.ts";
import * as localPaths from "./local-paths.ts";
import * as themes from "./themes.ts";

export type RouteSchema = {
  method: string;
  path: string;
  request?: TSchema;
  response: TSchema;
  events?: TSchema;
};

export const apiAreas = { "api-schema": apiSchema, power, github, datadog, jira, settings, pi, providers, tools, sessions, "session-events": sessionEvents, automation, updates, workers, terminals, files, diff, browser, bots, "bot-triggers": botTriggers, backlog, "task-suggestions": taskSuggestions, worktrees, watchers, "bot-templates": botTemplates, vscode, calls, diagnostics, "local-paths": localPaths, themes };

export function buildApiSchema(version: string) {
  const definitions = new Map<string, unknown>();
  const areas = new Map<string, string[]>();

  function hoist(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => hoist(item));
    if (value === null || typeof value !== "object") return value;
    const entries = Object.entries(value);
    const id = "$id" in value && typeof value.$id === "string" ? value.$id : undefined;
    const schema = Object.fromEntries(entries.filter(([key]) => key !== "$id" || !id).map(([key, child]) => [key, hoist(child)]));
    if (!id) return schema;
    if (!/^[A-Za-z_$][\w$]*$/u.test(id)) throw new Error(`Invalid API schema name: ${id}`);
    if (definitions.has(id) && JSON.stringify(definitions.get(id)) !== JSON.stringify(schema)) throw new Error(`Conflicting API schema: ${id}`);
    definitions.set(id, schema);
    return { $ref: `#/$defs/${id}` };
  }

  function reference(schema: TSchema): { $ref: string } {
    const ref = hoist(schema);
    if (ref && typeof ref === "object" && "$ref" in ref && typeof ref.$ref === "string") return { $ref: ref.$ref };
    throw new Error("Every route payload must have a named schema with $id");
  }

  const routes = [];
  for (const [area, module] of Object.entries(apiAreas)) {
    const names = [];
    for (const value of Object.values(module)) {
      if (typeof value === "object" && value !== null && "$id" in value && typeof value.$id === "string") {
        names.push(value.$id);
        hoist(value);
      }
    }
    areas.set(area, names.sort());
    const routeSchemas: RouteSchema[] = module.routeSchemas;
    for (const route of routeSchemas) {
      routes.push({
        method: route.method,
        path: route.path,
        ...(route.request ? { request: reference(route.request) } : {}),
        response: reference(route.response),
        ...(route.events ? { events: reference(route.events) } : {}),
      });
    }
  }
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema" as const,
    $defs: Object.fromEntries([...definitions].sort(([a], [b]) => a.localeCompare(b))),
    "x-hui-api-version": version,
    "x-hui-areas": Object.fromEntries([...areas].map(([area, names]) => [area, names.sort()])),
    "x-hui-routes": routes.sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`)),
  };
}
