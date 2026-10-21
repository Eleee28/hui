/** Remote-worker command parsing, shell formatting and public view types for Node callers. */
export type { WorkerState, WorkerView, WorkerInput } from "../api/workers.ts";

/** Splits a connect command like a POSIX shell would for plain words and
 * single/double quotes; no expansion or operators. */
export function parseCommand(text: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  let started = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === "\"" && /["\\$`]/u.test(text[index + 1] ?? "")) current += text[++index];
      else current += char;
    } else if (char === "'" || char === "\"") { quote = char; started = true; }
    else if (char === "\\" && index + 1 < text.length) { current += text[++index]; started = true; }
    else if (/\s/u.test(char)) {
      if (started) words.push(current);
      current = "";
      started = false;
    } else { current += char; started = true; }
  }
  if (quote) throw new Error("The connect command has an unclosed quote.");
  if (started) words.push(current);
  return words;
}

/** POSIX single-quoting. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function formatCommand(words: readonly string[]): string {
  return words.map((word) => /^[\w@%+=:,./-]+$/u.test(word) ? word : shellQuote(word)).join(" ");
}
