/**
 * Reads the document behind a configured PI skill, extension or package so the UI can show it: the skill file,
 * the extension source, or a package's README or package.json. Resources are addressed by their configuration
 * id, never by a path from the browser, and every read is size-bounded.
 */
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";

import { PI_AGENT_DIR, readConfiguredPackageSourcesAt, readPiConfigAt } from "./config.ts";
import { configuredResourceId } from "../runtimes/resource-policy.ts";

const MAX_DOCUMENT_BYTES = 256 * 1024;
const README_NAMES = ["readme.md", "readme.markdown", "readme", "package.json"];

import type { PiResourceDocument } from "../api/pi.ts";
export type { PiResourceDocument } from "../api/pi.ts";

export class PiResourceNotFoundError extends Error {
  override name = "PiResourceNotFoundError";
}

function formatFor(path: string): PiResourceDocument["format"] {
  const name = basename(path).toLowerCase();
  if (name.endsWith(".md") || name.endsWith(".markdown")) return "markdown";
  if (name.endsWith(".json")) return "json";
  return "code";
}

async function readBounded(path: string): Promise<{ content: string; truncated: boolean }> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(MAX_DOCUMENT_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return {
      content: buffer.subarray(0, Math.min(bytesRead, MAX_DOCUMENT_BYTES)).toString("utf8"),
      truncated: bytesRead > MAX_DOCUMENT_BYTES,
    };
  } finally {
    await handle.close();
  }
}

async function readableFile(path: string): Promise<string | undefined> {
  try {
    return (await stat(path)).isFile() ? path : undefined;
  } catch {
    return undefined;
  }
}

async function documentationFile(path: string): Promise<string | undefined> {
  const info = await stat(path).catch(() => undefined);
  if (!info) return undefined;
  if (info.isFile()) return path;
  if (!info.isDirectory()) return undefined;
  const entries = await readdir(path).catch(() => []);
  const byLowerName = new Map(entries.map((entry) => [entry.toLowerCase(), entry]));
  for (const candidate of README_NAMES) {
    const match = byLowerName.get(candidate);
    if (match) {
      const file = await readableFile(join(path, match));
      if (file) return file;
    }
  }
  return undefined;
}

function resolveExtensionPath(agentDir: string, source: string): string {
  if (source === "~") return homedir();
  if (source.startsWith("~/")) return resolve(homedir(), source.slice(2));
  return isAbsolute(source) ? source : resolve(agentDir, source);
}

async function packagePath(agentDir: string, source: string): Promise<string | undefined> {
  const settingsManager = SettingsManager.create(agentDir, agentDir);
  const manager = new DefaultPackageManager({ cwd: agentDir, agentDir, settingsManager });
  return manager.getInstalledPath(source, "user");
}

function documentTitle(kind: PiResourceDocument["kind"], label: string): string {
  if (kind === "skill") return label;
  return kind === "package" ? `${label} package` : label;
}

export async function readPiResourceDocumentAt(
  agentDir: string,
  kind: "skill" | "plugin",
  id: string,
): Promise<PiResourceDocument> {
  if (!/^[a-f0-9]{24}$/u.test(id)) throw new PiResourceNotFoundError("Resource not found.");
  const snapshot = await readPiConfigAt(agentDir);
  let resourceKind: PiResourceDocument["kind"];
  let label: string;
  let path: string | undefined;

  if (kind === "skill") {
    const skill = snapshot.skills.find((entry) => entry.id === id);
    if (!skill) throw new PiResourceNotFoundError("Skill not found.");
    resourceKind = "skill";
    label = skill.name;
    path = skill.path;
  } else {
    const resource = snapshot.settings.resources.find((entry) => entry.id === id);
    if (!resource) throw new PiResourceNotFoundError("Plugin not found.");
    resourceKind = resource.kind;
    label = resource.label;
    if (resource.kind === "extension") {
      const settings = SettingsManager.create(agentDir, agentDir).getGlobalSettings();
      const source = settings.extensions?.find((entry) => configuredResourceId("extension", entry) === id);
      path = source ? resolveExtensionPath(agentDir, source) : undefined;
    } else {
      const source = (await readConfiguredPackageSourcesAt(agentDir))
        .find((entry) => configuredResourceId("package", entry) === id);
      path = source ? await packagePath(agentDir, source) : undefined;
    }
  }

  const file = path ? await documentationFile(path) : undefined;
  if (!file) {
    throw new PiResourceNotFoundError(
      resourceKind === "package"
        ? "The package is not installed or has no readable README/package.json."
        : "The resource file is not available.",
    );
  }
  const { content, truncated } = await readBounded(file);
  return {
    id,
    kind: resourceKind,
    title: documentTitle(resourceKind, label),
    fileName: basename(file),
    format: formatFor(file),
    content,
    truncated,
  };
}

export function readPiResourceDocument(kind: "skill" | "plugin", id: string): Promise<PiResourceDocument> {
  return readPiResourceDocumentAt(PI_AGENT_DIR, kind, id);
}
