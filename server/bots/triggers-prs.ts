/**
 * The GitHub pull requests a trigger's delivery links to (HUI-18), read through the gateway's GitHub CLI when the
 * delivery goes out: title, author, state, base and head, the description, the changed files with their additions and
 * deletions, and the diff, each bounded, with what was cut said. A bot reviews from the delivery alone, so it needs no
 * shell, and a listener's event can't make it run commands or act on GitHub as the operator. A pull request gh can't
 * read says so instead.
 *
 * Requests go through `gh api --include` with argument arrays (never a shell); `HUI_GITHUB_CLI` points tests at a fake.
 */
import { execFile } from "node:child_process";

import { BOT_TRIGGER_LIMITS } from "./triggers-format.ts";
import { parseGitHubUrl } from "../integrations/github-links.ts";
import { GH_ENV } from "../integrations/github.ts";

/** A diff's text read at most: gh stops past it, and what came is cut to the delivery's budget. */
const MAX_DIFF_BYTES = 8 * 1024 * 1024;
/** Changed files one request lists. */
const FILES_PER_PAGE = 100;

/** One `gh api` GET: the status and the body as text. `accept` asks for another media type (a diff). */
export type GhRaw = (path: string, accept?: string) => Promise<{ status: number; text: string; truncated?: boolean }>;

/** Why gh gave nothing to read. */
export class GhReadError extends Error {
  override name = "GhReadError";
}

/** `gh api --include`'s output: the status line, the headers (lowercased) and the body. */
export function parseGhInclude(stdout: string): { status: number; headers: Record<string, string>; body: string } | undefined {
  const start = /^HTTP\/[\d.]+ (\d{3})[^\n]*\n/u.exec(stdout);
  if (!start) return undefined;
  const rest = stdout.slice(start[0].length);
  const end = /\r?\n\r?\n/u.exec(rest);
  const head = end ? rest.slice(0, end.index) : rest;
  const headers: Record<string, string> = {};
  for (const line of head.split(/\r?\n/u)) {
    const colon = line.indexOf(":");
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { status: Number(start[1]), headers, body: end ? rest.slice(end.index + end[0].length) : "" };
}

/** `gh api --include -H "Accept: …" <path>`, run with argument arrays. */
export function ghRaw(command = "gh", env: NodeJS.ProcessEnv = process.env): GhRaw {
  const childEnv = { ...env, ...GH_ENV };
  return (path, accept = "application/vnd.github+json") => new Promise((resolve, reject) => {
    execFile(command, ["api", "--include", "-H", `Accept: ${accept}`, path], { env: childEnv, timeout: 30_000, maxBuffer: MAX_DIFF_BYTES, encoding: "utf8" }, (error, stdout) => {
      const output = typeof stdout === "string" ? stdout : "";
      const included = parseGhInclude(output);
      if (!included) {
        reject(new GhReadError(error?.code === "ENOENT" ? "The GitHub CLI (gh) is not installed on the gateway's machine." : "GitHub could not be reached through gh."));
        return;
      }
      // Past maxBuffer gh is stopped: what came so far is a diff's beginning.
      resolve({ status: included.status, text: included.body, ...(error && (error as { code?: unknown }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? { truncated: true } : {}) });
    });
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown, max = 300): string => (typeof value === "string" ? value.slice(0, max) : "");
const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);
const oneLine = (value: string, max: number) => {
  const flat = value.replace(/\s+/gu, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
};

function failure(status: number, body: string): string {
  if (status === 401) return "gh is not signed in to GitHub: sign in under Settings → Integrations → GitHub.";
  if (status === 403) return "GitHub refused it (the gh account has no access, or its rate limit is spent).";
  if (status === 404) return "GitHub has no such pull request, or the gh account can't see it.";
  let message = "";
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    message = typeof parsed.message === "string" ? oneLine(parsed.message, 200) : "";
  } catch {
    // Not JSON: the status says enough.
  }
  return `GitHub answered HTTP ${status}${message ? `: ${message}` : ""}.`;
}

async function json(gh: GhRaw, path: string): Promise<unknown> {
  const answer = await gh(path);
  if (answer.status < 200 || answer.status >= 300) throw new GhReadError(failure(answer.status, answer.text));
  try {
    return JSON.parse(answer.text);
  } catch {
    throw new GhReadError("GitHub answered something HUI could not read.");
  }
}

function quote(body: string, max: number): string {
  const trimmed = body.replace(/\r\n?/gu, "\n").trim();
  if (!trimmed) return "  (no description)";
  const cut = trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}…` : trimmed;
  return cut.split("\n").map((line) => `  > ${line}`).join("\n");
}

const STATUS_MARKS: Readonly<Record<string, string>> = { added: "A", removed: "D", modified: "M", renamed: "R", copied: "C", changed: "M", unchanged: "=" };

/** `acme/widgets#42` for a pull request URL. */
export function pullRequestName(url: string): string {
  const ref = parseGitHubUrl(url);
  return ref && ref.kind !== "repo" ? `${ref.owner}/${ref.repo}#${ref.number}` : url;
}

/** A fence longer than any run of backticks in the text, so the diff can't close it. */
function fence(body: string): string {
  const longest = Math.max(0, ...[...body.matchAll(/`+/gu)].map((match) => match[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

/** A diff cut to `budget` characters at a line's end, with what was cut said. */
export function boundedDiff(diff: string, budget: number, readTruncated = false): string {
  const total = diff.length;
  let shown = diff;
  let note = "";
  if (total > budget) {
    const cut = diff.slice(0, Math.max(0, budget));
    const end = cut.lastIndexOf("\n");
    shown = end > budget * 0.5 ? cut.slice(0, end) : cut;
    note = readTruncated
      ? `Diff (the first ${shown.length.toLocaleString("en-US")} characters; it is larger than ${MAX_DIFF_BYTES / 1024 / 1024} MB, the rest is cut):`
      : `Diff (the first ${shown.length.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} characters; the rest is cut):`;
  } else if (readTruncated) {
    note = `Diff (larger than ${MAX_DIFF_BYTES / 1024 / 1024} MB; what was read is shown, the rest is cut):`;
  } else note = "Diff:";
  const marks = fence(shown);
  return [note, `${marks}diff`, shown.replace(/\n+$/u, ""), marks].join("\n");
}

/**
 * One pull request as a delivery shows it, its diff within `diffBudget` characters. Never throws: what gh can't read
 * is said in the text.
 */
export async function readPullRequest(gh: GhRaw, url: string, diffBudget: number): Promise<string> {
  const ref = parseGitHubUrl(url);
  if (!ref || ref.kind !== "pull") return `${url}: not a GitHub pull request link.`;
  const name = `${ref.owner}/${ref.repo}#${ref.number}`;
  const base = `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`;
  let pull: Record<string, unknown>;
  try {
    const answer = await json(gh, base);
    if (!isRecord(answer)) throw new GhReadError("GitHub answered something HUI could not read.");
    pull = answer;
  } catch (error) {
    return `Pull request ${name}: gh could not read it. ${error instanceof Error ? error.message : String(error)}\n  ${ref.url}`;
  }
  const user = isRecord(pull["user"]) ? str(pull["user"]["login"], 60) : "";
  const head = isRecord(pull["head"]) ? str(pull["head"]["ref"], 200) : "";
  const baseRef = isRecord(pull["base"]) ? str(pull["base"]["ref"], 200) : "";
  const merged = typeof pull["merged_at"] === "string" || pull["merged"] === true;
  const state = merged ? "merged" : pull["state"] === "closed" ? "closed" : pull["draft"] === true ? "open, draft" : "open";
  const files = count(pull["changed_files"]);
  const lines = [
    `Pull request ${name} "${oneLine(str(pull["title"], 300), 200)}" by ${user ? `@${user}` : "someone"} · ${state} · ${head || "?"} → ${baseRef || "?"} · +${count(pull["additions"])} −${count(pull["deletions"])} in ${files} file${files === 1 ? "" : "s"}`,
    `  ${str(pull["html_url"], 500) || ref.url}`,
    "Description:",
    quote(str(pull["body"], 60_000), BOT_TRIGGER_LIMITS.prDescription),
  ];
  try {
    const listed = await json(gh, `${base}/files?per_page=${FILES_PER_PAGE}`);
    const entries = Array.isArray(listed) ? listed.filter(isRecord) : [];
    const shown = entries.slice(0, BOT_TRIGGER_LIMITS.prFiles);
    lines.push(`Changed files (${Math.max(files, entries.length)}):`);
    for (const entry of shown) {
      const mark = STATUS_MARKS[str(entry["status"], 20)] ?? "M";
      const previous = str(entry["previous_filename"], 300);
      lines.push(`  ${mark} ${previous ? `${previous} → ` : ""}${str(entry["filename"], 300)} (+${count(entry["additions"])} −${count(entry["deletions"])})`);
    }
    const rest = Math.max(files, entries.length) - shown.length;
    if (rest > 0) lines.push(`  … and ${rest} more file${rest === 1 ? "" : "s"}`);
  } catch (error) {
    lines.push(`Changed files: gh could not read them. ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const answer = await gh(base, "application/vnd.github.diff");
    if (answer.status === 406 || answer.status === 422) lines.push("Diff: GitHub won't produce it for a pull request this large; the changed files above say what changed.");
    else if (answer.status < 200 || answer.status >= 300) lines.push(`Diff: gh could not read it. ${failure(answer.status, answer.text)}`);
    else lines.push(boundedDiff(answer.text, diffBudget, answer.truncated === true));
  } catch (error) {
    lines.push(`Diff: gh could not read it. ${error instanceof Error ? error.message : String(error)}`);
  }
  return lines.join("\n");
}

/** The pull requests of one delivery, each read once, their diffs sharing `BOT_TRIGGER_LIMITS.prDiffs` evenly. */
export function pullRequestReader(gh: GhRaw): (urls: readonly string[], diffBudget?: number) => Promise<Map<string, string>> {
  return async (urls, diffBudget) => {
    const unique = [...new Set(urls)];
    const each = Math.max(2_000, Math.floor((diffBudget ?? BOT_TRIGGER_LIMITS.prDiffs) / Math.max(1, unique.length)));
    const read = new Map<string, string>();
    for (const url of unique) read.set(url, await readPullRequest(gh, url, each));
    return read;
  };
}
