/**
 * The Tools page catalog: HUI's shipped tools and default prompt, the PI backend and SDK version, and the
 * extension and package sources named in PI's settings. It reads settings.json as data only: no runtime
 * creation, model requests, package resolution or extension code.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolvePiAgentDir } from "../pi/paths.ts";
import { safeSourceLabel } from "../pi/source-label.ts";
import { shippedTools } from "../runtimes/tool-catalog.ts";
import { HUI_DEFAULT_PROMPT, HUI_PROMPT_REVISION } from "../runtimes/hui-prompt.ts";
import { piBackend, PI_SDK_VERSION } from "../runtimes/pi-backend.ts";
import type { ToolsCatalog } from "../runtimes/types.ts";

export async function readToolsCatalog(agentDir = resolvePiAgentDir()): Promise<ToolsCatalog> {
  const sources: string[] = [];
  const diagnostics: string[] = [];
  try {
    const text = await readFile(join(agentDir, "settings.json"), "utf8");
    if (text.length > 2_000_000) throw new Error("Settings exceed the 2 MB catalog limit.");
    const settings = JSON.parse(text) as Record<string, unknown>;
    if (!settings || Array.isArray(settings) || typeof settings !== "object") throw new Error("Settings must be an object.");
    for (const key of ["extensions", "packages"]) {
      const entries = settings[key];
      if (entries === undefined) continue;
      if (!Array.isArray(entries)) { diagnostics.push(`${key} must be an array.`); continue; }
      for (const entry of entries) {
        const source = typeof entry === "string" ? entry : entry?.source;
        if (typeof source === "string") sources.push(safeSourceLabel(source));
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") diagnostics.push("PI settings could not be read. Configured sources are unavailable.");
  }
  return {
    backend: piBackend(), sdkVersion: PI_SDK_VERSION, tools: shippedTools(), sources, diagnostics,
    prompt: { revision: HUI_PROMPT_REVISION, text: HUI_DEFAULT_PROMPT },
  };
}
