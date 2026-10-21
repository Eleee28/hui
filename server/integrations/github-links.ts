/** Parses and keys GitHub references for the gateway's previews and listeners. */
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
