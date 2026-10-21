/** Parsers for HUI's reserved session and update commands. */
export function parseUpdateCommand(text: string): "update" | "check" | "invalid" | null {
  const trimmed = text.trim();
  if (!/^\/update(?:\s|$)/u.test(trimmed)) return null;
  if (trimmed === "/update") return "update";
  if (/^\/update\s+--check$/u.test(trimmed)) return "check";
  return "invalid";
}

function parseBareCommand<Name extends string>(text: string, name: Name): Name | "invalid" | null {
  const trimmed = text.trim();
  if (!new RegExp(`^/${name}(?:\\s|$)`, "u").test(trimmed)) return null;
  return trimmed === `/${name}` ? name : "invalid";
}
export const parseClearCommand = (text: string) => parseBareCommand(text, "clear");
export const parseReloadCommand = (text: string) => parseBareCommand(text, "reload");

export function parseCompactCommand(text: string): { instructions?: string } | undefined {
  const match = /^\/compact(?:\s+([\s\S]*))?$/u.exec(text.trim());
  if (!match) return undefined;
  const instructions = match[1]?.trim();
  return instructions ? { instructions } : {};
}
