/**
 * Read-only view of the `pi` coding agent's own configuration.
 *
 * `pi` already knows which skills, tools, and models it has; the dashboard must
 * not keep a second copy that drifts. So this module discovers what pi has
 * installed and reports it, and never writes to `~/.pi`.
 *
 * Layout it reads (see pi's `getAgentDir()` + `getSettingsPath()`):
 *
 *   ~/.pi/agent/settings.json     skills[], extensions[], packages[], defaults
 *   ~/.pi/agent/skills/           default skills directory
 *
 * Everything degrades: a missing file, unreadable directory, or malformed entry
 * yields an empty list rather than an error. A dashboard that refuses to render
 * because a settings file has a typo is worse than one that shows less.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { piRuntime } from "../runtimes/pi.ts";
import type { PiTool, PiSkill, PiModel, PiConfiguredResource, PiSnapshot, PiModelCatalogEntry } from "../api/pi.ts";
import { resolvePiAgentDir } from "./paths.ts";
import { shippedTools } from "../runtimes/tool-catalog.ts";
import { safeSourceLabel } from "./source-label.ts";
import { configuredResourceId } from "../runtimes/resource-policy.ts";
import { bundledSkillRoot, bundledSkills } from "./bundled-skills.ts";
import { isThinkingLevel } from "../sessions/thinking.ts";
export { safeSourceLabel } from "./source-label.ts";

export { resolvePiAgentDir } from "./paths.ts";

export const PI_AGENT_DIR = resolvePiAgentDir();

const SETTINGS_FILE = "settings.json";
const SKILLS_DIR = "skills";
const AUTH_FILE = "auth.json";


export type { PiTool, PiSkill, PiModel, PiSettingsSummary, PiConfiguredResource, PiSnapshot } from "../api/pi.ts";
type CatalogEntry = PiModelCatalogEntry;
type CatalogProbeSession = {
  listModels(): Promise<readonly CatalogEntry[]>;
  dispose(): void;
};
type CatalogResult = { catalog: readonly CatalogEntry[]; error?: string };

/** Coalesce concurrent dashboard reads and cache both success and failure. A
 * broken provider must not let repeated refreshes accumulate PI processes. */
export function createModelCatalogReader(
  probe: () => Promise<CatalogProbeSession>,
  ttlMs = 30_000,
) {
  let cached: { expiresAt: number; result: CatalogResult } | undefined;
  let pending: Promise<CatalogResult> | undefined;
  let revision = 0;
  const read = async (): Promise<CatalogResult> => {
    if (cached && cached.expiresAt > Date.now()) return cached.result;
    if (pending) return pending;
    pending = (async () => {
      for (;;) {
        const startedRevision = revision;
        let session: CatalogProbeSession | undefined;
        let result: CatalogResult;
        try {
          session = await probe();
          const models = await session.listModels();
          result = { catalog: models.map(({ provider, id, name, contextWindow, maxTokens, thinkingLevels, fast }) => ({
            provider, id, name, ...(contextWindow === undefined ? {} : { contextWindow }), ...(maxTokens === undefined ? {} : { maxTokens }),
            ...(thinkingLevels ? { thinkingLevels } : {}), ...(fast ? { fast } : {}),
          })) };
        } catch (error) {
          result = { catalog: [], error: error instanceof Error ? error.message : "unknown error" };
        } finally { session?.dispose(); }
        // A login/save during discovery must not republish the stale catalog.
        if (startedRevision !== revision) continue;
        cached = { expiresAt: Date.now() + ttlMs, result };
        return result;
      }
    })().finally(() => { pending = undefined; });
    return pending;
  };
  return Object.assign(read, { invalidate: () => { revision++; cached = undefined; } });
}

const readModelCatalog = createModelCatalogReader(() =>
  piRuntime.start({ cwd: PI_AGENT_DIR, noSession: true, safeProbe: true }),
);

export function invalidateModelCatalog() { readModelCatalog.invalidate(); }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

/** Package sources are either a bare string or an object with filtering. */
function packageSources(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (typeof entry === "string") {
      return [entry];
    }
    if (isRecord(entry) && typeof entry["source"] === "string") {
      return [entry["source"]];
    }
    return [];
  });
}

/** Exact package sources are server-only mutation identifiers. The browser
 * continues to receive redacted labels from `safeSourceLabel`. */
export async function readConfiguredPackageSourcesAt(agentDir: string): Promise<readonly string[]> {
  const raw = await readJson(join(agentDir, SETTINGS_FILE));
  return packageSources(isRecord(raw) ? raw["packages"] : undefined);
}

/**
 * Skills use the Agent Skills frontmatter (`name`, `description`). Parsed by
 * hand over the first block only: a full YAML parser is a dependency this does
 * not earn, and anything unparseable still reports the directory name.
 */
function parseFrontmatter(source: string): { name?: string; description?: string } {
  if (!source.startsWith("---")) {
    return {};
  }
  const end = source.indexOf("\n---", 3);
  if (end === -1) {
    return {};
  }
  const block = source.slice(3, end);
  const read = (key: string): string | undefined => {
    const match = block.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, "m"));
    if (!match?.[1]) {
      return undefined;
    }
    return match[1].trim().replace(/^["']|["']$/g, "");
  };
  return { name: read("name"), description: read("description") };
}

async function readSkillFile(path: string, root: string, fallback: string): Promise<PiSkill> {
  let head = "";
  try {
    head = (await readFile(path, "utf8")).slice(0, 4000);
  } catch {
    // Unreadable file: still list it, so the list matches the directory.
  }
  const { name, description } = parseFrontmatter(head);
  return {
    id: configuredSkillId(path),
    name: name ?? fallback,
    description: description ?? "",
    path,
    root,
  };
}

export function configuredSkillId(path: string): string {
  return configuredResourceId("skill", path);
}

/**
 * A skills root is either a directory of skill directories, or a directory that
 * is itself one skill (`SKILL.md` at its top).
 */
async function readSkillRoot(root: string, diagnostics: string[], required: boolean): Promise<PiSkill[]> {
  if (!(await isDirectory(root))) {
    // The default skills directory simply not existing is the normal state for a
    // fresh pi install. Only a root the user configured is worth reporting.
    if (required) {
      diagnostics.push(`Configured skill path is not a directory: ${root}`);
    }
    return [];
  }
  const own = join(root, "SKILL.md");
  if (await exists(own)) {
    return [await readSkillFile(own, root, root.split("/").at(-1) ?? "skill")];
  }
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    diagnostics.push(`Could not read skill directory: ${root}`);
    return [];
  }
  const found: PiSkill[] = [];
  for (const entry of entries) {
    if (entry.startsWith(".")) {
      continue;
    }
    const dir = join(root, entry);
    if (!(await isDirectory(dir))) {
      continue;
    }
    const file = join(dir, "SKILL.md");
    if (await exists(file)) {
      found.push(await readSkillFile(file, root, entry));
    }
  }
  return found;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function readModel(settings: Record<string, unknown>): PiModel {
  const thinking = settings["defaultThinkingLevel"];
  return {
    defaultProvider: typeof settings["defaultProvider"] === "string" ? settings["defaultProvider"] : "",
    defaultModel: typeof settings["defaultModel"] === "string" ? settings["defaultModel"] : "",
    thinking:
      typeof thinking === "string" && isThinkingLevel(thinking)
        ? thinking
        : null,
    enabled: stringArray(settings["enabledModels"]),
    authenticated: [],
    catalog: [],
  };
}

/** Provider names present in pi's auth store. Values are never read. */
async function authenticatedProviders(agentDir: string): Promise<string[]> {
  const auth = await readJson(join(agentDir, AUTH_FILE));
  if (!isRecord(auth)) {
    return [];
  }
  return Object.keys(auth).filter((key) => {
    const entry = auth[key];
    return isRecord(entry) || typeof entry === "string";
  });
}

/**
 * Reads a pi agent directory. Split out from `readPiConfig` so tests can point
 * it at a fixture instead of the developer's real `~/.pi`.
 */
export async function readPiConfigAt(agentDir: string): Promise<PiSnapshot> {
  const diagnostics: string[] = [];
  const settingsPath = join(agentDir, SETTINGS_FILE);
  const raw = await readJson(settingsPath);
  const settings = isRecord(raw) ? raw : {};
  const settingsExists = await exists(settingsPath);

  const configured = stringArray(settings["skills"]);
  const defaultRoot = join(agentDir, SKILLS_DIR);
  // Configured roots first, then pi's default directory.
  const roots = [...new Set([...configured, defaultRoot])];
  const skills: PiSkill[] = [];
  for (const root of roots) {
    skills.push(...(await readSkillRoot(root, diagnostics, configured.includes(root))));
  }
  for (const bundled of bundledSkills) {
    if (!(await exists(bundled.path))) {
      diagnostics.push(`HUI bundled skill is missing: ${bundled.name}`);
      continue;
    }
    skills.push({
      ...await readSkillFile(bundled.path, bundledSkillRoot, bundled.name),
      id: configuredSkillId(bundled.preferencePath),
      origin: "hui", tags: bundled.tags, preferencePath: bundled.preferencePath,
    });
  }
  // Only report roots that exist, so the list reflects real directories.
  const presentRoots: string[] = [];
  for (const root of roots) {
    if (await isDirectory(root)) {
      presentRoots.push(root);
    }
  }

  const extensionSources = stringArray(settings["extensions"]);
  const packageSourceValues = packageSources(settings["packages"]);
  const extensions = extensionSources.map(safeSourceLabel);
  const packages = packageSourceValues.map(safeSourceLabel);
  const resources: PiConfiguredResource[] = [
    ...packageSourceValues.map((source) => ({
      id: configuredResourceId("package", source), label: safeSourceLabel(source), kind: "package" as const,
    })),
    ...extensionSources.map((source) => ({
      id: configuredResourceId("extension", source), label: safeSourceLabel(source), kind: "extension" as const,
    })),
  ];
  const tools: PiTool[] = shippedTools().map(({ name, source }) => ({
    name, kind: source === "HUI" ? "hui" : "builtin", source,
  }));

  return {
    agentDir,
    settings: { path: settingsPath, exists: settingsExists, packages, extensions, resources, skillRoots: presentRoots },
    skills: skills.sort((a, b) => a.name.localeCompare(b.name)),
    tools,
    model: { ...readModel(settings), authenticated: await authenticatedProviders(agentDir) },
    diagnostics,
  };
}

export async function readPiConfig(): Promise<PiSnapshot> {
  const snapshot = await readPiConfigAt(PI_AGENT_DIR);
  const result = await readModelCatalog();
  return {
    ...snapshot,
    model: { ...snapshot.model, catalog: result.catalog },
    diagnostics: result.error
      ? [...snapshot.diagnostics, `PI model catalog is unavailable: ${result.error}`]
      : snapshot.diagnostics,
  };
}
