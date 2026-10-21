/** Detects GitHub references synchronously while the browser renders Markdown. */
export const MAX_GITHUB_EMBEDS = 3;

export type GitHubRef =
  | { kind: "repo"; owner: string; repo: string; url: string }
  /** `issue` also covers `owner/repo#N` shorthand; the gateway resolves it to a pull request when it is one. */
  | { kind: "pull" | "issue"; owner: string; repo: string; number: number; url: string };

/** First path segments that are GitHub pages rather than accounts. */
const RESERVED_OWNERS = new Set([
  "about", "apps", "codespaces", "collections", "customer-stories", "enterprise", "explore", "features",
  "issues", "login", "logout", "marketplace", "new", "notifications", "orgs", "organizations", "pricing",
  "pulls", "readme", "search", "security", "settings", "site", "sponsors", "topics", "trending",
]);
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const REPO = /^[A-Za-z0-9._-]{1,100}$/u;
const NUMBER = /^[1-9]\d{0,8}$/u;
const URL_IN_TEXT = /https?:\/\/(?:www\.)?github\.com\/[^\s<>()"'`\]\[{}|\\^]+/giu;
const SHORTHAND = /(?<![\w./@#-])([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})#([1-9]\d{0,8})\b/gu;

function validRepo(owner: string, repo: string): boolean {
  return OWNER.test(owner) && !RESERVED_OWNERS.has(owner.toLowerCase()) && REPO.test(repo) && repo !== "." && repo !== "..";
}

function numbered(kind: "pull" | "issue", owner: string, repo: string, number: number): GitHubRef {
  return { kind, owner, repo, number, url: `https://github.com/${owner}/${repo}/${kind === "pull" ? "pull" : "issues"}/${number}` };
}

/** Parses a github.com repository, pull request or issue URL. Other GitHub pages return undefined. */
export function parseGitHubUrl(raw: string): GitHubRef | undefined {
  let url: URL;
  try { url = new URL(raw); } catch { return undefined; }
  const host = url.hostname.toLowerCase();
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return undefined;
  if (host !== "github.com" && host !== "www.github.com") return undefined;
  const [owner = "", rawRepo = "", section, id] = url.pathname.split("/").filter(Boolean);
  const repo = rawRepo.replace(/\.git$/u, "");
  if (!validRepo(owner, repo)) return undefined;
  if ((section === "pull" || section === "issues") && id && NUMBER.test(id)) {
    return numbered(section === "pull" ? "pull" : "issue", owner, repo, Number(id));
  }
  if (section === "pulls" || section === "issues" || section === "pull") {
    return { kind: "repo", owner, repo, url: `https://github.com/${owner}/${repo}` };
  }
  return { kind: "repo", owner, repo, url: `https://github.com/${owner}/${repo}` };
}

/** Same item regardless of URL spelling; `owner/repo#N` and its pull URL are one item. */
export function githubRefKey(ref: GitHubRef): string {
  const repo = `${ref.owner}/${ref.repo}`.toLowerCase();
  return ref.kind === "repo" ? `repo:${repo}` : `item:${repo}#${ref.number}`;
}

/** Text with fenced and inline code blanked out, keeping offsets. Code is quoted, not referenced.
 * Datadog link previews (`datadog-links.ts`) skip code the same way. */
export function withoutCode(text: string): string {
  const blank = (match: string) => match.replace(/[^\n]/gu, " ");
  return text.replace(/(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\2[^\n]*(?=\n|$)|$)/gu, blank).replace(/`[^`\n]+`/gu, blank);
}

/** GitHub references in reading order, deduplicated and capped at `limit`. */
export function githubRefsInText(text: string, limit = MAX_GITHUB_EMBEDS): GitHubRef[] {
  if (!/github\.com|#\d/u.test(text)) return [];
  const source = withoutCode(text.slice(0, 64 * 1024));
  const found: { index: number; ref: GitHubRef }[] = [];
  for (const match of source.matchAll(URL_IN_TEXT)) {
    const ref = parseGitHubUrl(match[0].replace(/[.,;:!?*_~]+$/u, ""));
    if (ref) found.push({ index: match.index ?? 0, ref });
  }
  for (const match of source.matchAll(SHORTHAND)) {
    const [, owner = "", repo = "", number = "0"] = match;
    if (validRepo(owner, repo)) found.push({ index: match.index ?? 0, ref: numbered("issue", owner, repo, Number(number)) });
  }
  found.sort((a, b) => a.index - b.index);
  const seen = new Set<string>();
  const refs: GitHubRef[] = [];
  for (const { ref } of found) {
    const key = githubRefKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
    if (refs.length >= limit) break;
  }
  return refs;
}
