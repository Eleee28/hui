/** Browser aliases are resolved against the owning runtime's catalog, never paths. */
export type CallableCommand = { name: string; source: "skill" | "extension" | "prompt" | "hui" };

export function commandReference(command: CallableCommand, catalog: readonly CallableCommand[]): string {
  if (command.source === "prompt" || command.source === "hui") return `/${command.name}`;
  const short = command.source === "skill" ? command.name.replace(/^skill:/u, "") : command.name;
  const collision = catalog.some((other) => other !== command && other.name !== command.name
    && (other.source === "skill" || other.source === "extension")
    && (other.name === short || other.name.replace(/^skill:/u, "") === short));
  return `$${collision ? command.name : short}`;
}

export function resolveCommandReference(text: string, catalog: readonly CallableCommand[]): string {
  const token = /^\$([^\s]+)(?=\s|$)/u.exec(text);
  if (!token) return text;
  const matches = catalog.filter((command) => (command.source === "skill" || command.source === "extension")
    && (commandReference(command, catalog) === token[0] || command.name === token[1]));
  if (matches.length !== 1) return text;
  return `/${matches[0]!.name}${text.slice(token[0].length)}`;
}
