/**
 * The catalog of tools HUI ships, for the Tools settings: PI's builtins with their default state, followed by
 * HUI's own tools.
 */
import type { ToolCatalogEntry } from "./types.ts";
import { huiToolDefinitions } from "./hui-tools.ts";

/** Shipped capabilities, not a claim about an initialized session. A parity
 * test compares this list with the pinned SDK's actual builtin registry. */
const PI_TOOLS = [
  ["read", "Read files and images", true],
  ["bash", "Run shell commands", true],
  ["edit", "Apply exact text replacements", true],
  ["write", "Create or replace files", true],
  ["grep", "Search file contents", false],
  ["find", "Find files by pattern", false],
  ["ls", "List directory contents", false],
  ["powershell", "Run PowerShell commands (requires PowerShell)", false],
] as const;

export function shippedTools(): ToolCatalogEntry[] {
  return [
    ...PI_TOOLS.map(([name, description, defaultEnabled]) => ({ name, description, defaultEnabled, source: "PI" })),
    ...huiToolDefinitions().map(({ name, description }) => ({ name, description, defaultEnabled: true, source: "HUI" })),
  ];
}
