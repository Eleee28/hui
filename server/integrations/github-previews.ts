/** GitHub previews for chat embeds and pull request badges.
 *
 * Lookups that arrive together become one read-only `gh api graphql` query, one
 * alias per item, made with the GitHub CLI login that Settings → Integrations →
 * GitHub establishes, so private repositories the operator can read preview too.
 * What the active account cannot preview, every other github.com account `gh` is
 * signed in to tries in turn; such an account's token goes only into its `gh`
 * child's `GH_TOKEN` and is never kept. Results are cached in gateway memory with
 * state-dependent lifetimes; concurrent requests for one item share a lookup.
 * `gh` diagnostics never reach the browser: failures become a coarse reason.
 */
import { execFile, type ExecFileException } from "node:child_process";

import { githubRefKey, parseGitHubUrl } from "./github-links.ts";
import type { GitHubPreview, GitHubPreviewError, GitHubPreviewResult } from "../api/github.ts";
import type { GitHubRef } from "./github-links.ts";
import type { PullRequestState } from "../api/github.ts";
import { GH_ENV, GITHUB_HOST, parseAccounts } from "./github.ts";
import { pullRequestBodyPreview, type PullRequestFetcher } from "./pull-requests.ts";

const MAX_TITLE = 300;
const MAX_DESCRIPTION = 400;
const MAX_LABELS = 6;
/** Lookups this close together share one `gh` call. */
const BATCH_WINDOW_MS = 20;
/** Items per query; each pull request and issue brings its whole body. */
const BATCH_SIZE = 25;
const CALLS_AT_ONCE = 2;
/** Listing accounts checks every token with GitHub, about a second. */
const LOGINS_TTL_MS = 10 * 60_000;

/** What GitHub answered: an alias whose item failed is null, with an error naming it in `path`. */
export type GraphQLResponse = { data: Record<string, unknown>; errors?: { type?: string; path?: unknown[] }[] };
export type GitHubGraphQL = {
  /** One query as `login`, or as `gh`'s active account; rejects with a classified reason when GitHub answered no data. */
  query: (query: string, login?: string) => Promise<GraphQLResponse>;
  /** The github.com accounts `gh` is signed in to besides the active one. */
  otherLogins: () => Promise<string[]>;
};

export class GitHubApiError extends Error {
  readonly reason: GitHubPreviewError;
  constructor(reason: GitHubPreviewError) {
    super(`GitHub lookup failed: ${reason}`);
    this.name = "GitHubApiError";
    this.reason = reason;
  }
}

/** Maps a failed `gh api` run to a reason without keeping its output. */
export function classifyGhFailure(error: unknown): GitHubPreviewError {
  const failure = error as { stderr?: unknown; code?: unknown } | undefined;
  if (failure?.code === "ENOENT") return "cli_missing";
  const stderr = typeof failure?.stderr === "string" ? failure.stderr : "";
  if (/HTTP 404|Not Found/u.test(stderr)) return "not_found";
  if (failure?.code === 4 || /gh auth login|HTTP 401|Bad credentials|not logged in/iu.test(stderr)) return "signed_out";
  return "unavailable";
}

export function ghGraphQL(command = "gh", env: NodeJS.ProcessEnv = process.env): GitHubGraphQL {
  const run = (args: string[], extra?: Record<string, string>, input?: string) =>
    new Promise<{ error: ExecFileException | null; stdout: string; stderr: string }>((resolve) => {
      const child = execFile(command, args, { env: { ...env, ...GH_ENV, ...extra }, timeout: 15_000, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
        (error, stdout, stderr) => resolve({ error, stdout, stderr }));
      // A gh that exits before reading the query (signed out) breaks the pipe; the callback reports why it exited.
      child.stdin?.on("error", () => {});
      child.stdin?.end(input);
    });
  return {
    async query(query, login) {
      const token = login ? (await run(["auth", "token", "--hostname", GITHUB_HOST, "--user", login])).stdout.trim() : "";
      if (login && !token) throw new GitHubApiError("signed_out");
      const { error, stdout, stderr } = await run(["api", "graphql", "--input", "-"], token ? { GH_TOKEN: token } : undefined, JSON.stringify({ query }));
      // gh exits 1 when any alias failed, after printing GitHub's answer with the others' data.
      let response: unknown;
      try { response = JSON.parse(stdout); } catch { /* no answer from GitHub */ }
      const data = record(response)["data"];
      if (data && typeof data === "object") return response as GraphQLResponse;
      // The callback form does not attach stderr to the error; classify with both.
      throw new GitHubApiError(error ? classifyGhFailure({ code: error.code, stderr }) : "unavailable");
    },
    async otherLogins() {
      const { stdout } = await run(["auth", "status", "--hostname", GITHUB_HOST, "--json", "hosts"]);
      return parseAccounts(stdout).filter((account) => !account.active).map((account) => account.login);
    },
  };
}

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const str = (value: unknown, limit = MAX_TITLE) => typeof value === "string" ? value.trim().slice(0, limit) : "";
const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
const login = (value: unknown) => str(record(value)["login"], 60) || undefined;
const optional = <K extends string>(key: K, value: string | undefined) => value ? { [key]: value } as Record<K, string> : {};
const total = (connection: unknown) => count(record(connection)["totalCount"]);

const REPO_FIELDS = "nameWithOwner description stargazerCount forkCount primaryLanguage { name } isPrivate isArchived";
// An issue's `state` is another enum than a pull request's, so it needs its own name to merge (GraphQL's
// FieldsInSetCanMerge: https://spec.graphql.org/October2021/#sec-Field-Selection-Merging).
const ITEM_FIELDS = "__typename"
  + " ... on PullRequest { number title state isDraft body author { login } additions deletions changedFiles comments { totalCount } reviewThreads { totalCount } }"
  + ` ... on Issue { number title issueState: state stateReason body author { login } comments { totalCount } labels(first: ${MAX_LABELS}) { nodes { name } } }`;

/** One query for every reference, `i<N>` answering `refs[N]`. Owners and names are validated by `parseGitHubUrl`. */
function previewQuery(refs: readonly GitHubRef[]): string {
  return `{ ${refs.map((ref, index) => {
    const repository = `i${index}: repository(owner: ${JSON.stringify(ref.owner)}, name: ${JSON.stringify(ref.repo)})`;
    return ref.kind === "repo" ? `${repository} { ${REPO_FIELDS} }` : `${repository} { item: issueOrPullRequest(number: ${ref.number}) { ${ITEM_FIELDS} } }`;
  }).join(" ")} }`;
}

export function parseRepoPreview(raw: unknown): GitHubPreview {
  const data = record(raw);
  const fullName = str(data["nameWithOwner"], 200);
  if (!fullName) throw new GitHubApiError("unavailable");
  return {
    kind: "repo",
    url: `https://github.com/${fullName}`,
    fullName,
    ...optional("description", str(data["description"], MAX_DESCRIPTION)),
    stars: count(data["stargazerCount"]),
    forks: count(data["forkCount"]),
    ...optional("language", str(record(data["primaryLanguage"])["name"], 40)),
    private: data["isPrivate"] === true,
    archived: data["isArchived"] === true,
  };
}

export function parsePullPreview(raw: unknown, repository: string): GitHubPreview {
  const data = record(raw);
  const number = count(data["number"]);
  if (!number) throw new GitHubApiError("unavailable");
  const state: PullRequestState = data["state"] === "MERGED" ? "merged"
    : data["state"] === "CLOSED" ? "closed" : data["isDraft"] === true ? "draft" : "open";
  const body = typeof data["body"] === "string" ? pullRequestBodyPreview(data["body"]) : "";
  return {
    kind: "pull",
    url: `https://github.com/${repository}/pull/${number}`,
    repository,
    number,
    title: str(data["title"]),
    state,
    ...optional("author", login(data["author"])),
    additions: count(data["additions"]),
    deletions: count(data["deletions"]),
    changedFiles: count(data["changedFiles"]),
    // Review threads stand in for REST's review comments, which GraphQL does not count.
    comments: total(data["comments"]) + total(data["reviewThreads"]),
    ...optional("body", body),
  };
}

export function parseIssuePreview(raw: unknown, repository: string): GitHubPreview {
  const data = record(raw);
  const number = count(data["number"]);
  if (!number) throw new GitHubApiError("unavailable");
  const nodes = record(data["labels"])["nodes"];
  const labels = Array.isArray(nodes) ? nodes.map((label) => str(record(label)["name"], 50)).filter(Boolean).slice(0, MAX_LABELS) : [];
  const body = typeof data["body"] === "string" ? pullRequestBodyPreview(data["body"]) : "";
  return {
    kind: "issue",
    url: `https://github.com/${repository}/issues/${number}`,
    repository,
    number,
    title: str(data["title"]),
    state: data["issueState"] === "CLOSED" ? "closed" : "open",
    ...optional("stateReason", str(data["stateReason"], 30).toLowerCase()),
    ...optional("author", login(data["author"])),
    comments: total(data["comments"]),
    labels,
    ...optional("body", body),
  };
}

function previewResult(ref: GitHubRef, response: GraphQLResponse, alias: string): GitHubPreviewResult {
  const value = response.data[alias];
  const node = ref.kind === "repo" ? value : record(value)["item"];
  if (!node) {
    const failure = response.errors?.find((error) => error.path?.[0] === alias);
    return { url: ref.url, error: failure?.type === "NOT_FOUND" ? "not_found" : "unavailable" };
  }
  const repository = `${ref.owner}/${ref.repo}`;
  try {
    if (ref.kind === "repo") return { url: ref.url, preview: parseRepoPreview(node) };
    return { url: ref.url, preview: record(node)["__typename"] === "PullRequest" ? parsePullPreview(node, repository) : parseIssuePreview(node, repository) };
  } catch {
    return { url: ref.url, error: "unavailable" };
  }
}

export type GitHubPreviewOptions = {
  now?: () => number;
  maxEntries?: number;
};

type CacheEntry = { expires: number; result: Promise<GitHubPreviewResult> };
type Pending = { ref: GitHubRef; resolve: (result: GitHubPreviewResult) => void };

/** Lifetime of a result: live items refresh quickly, settled ones and failures slowly. */
export function previewTtlMs(result: GitHubPreviewResult): number {
  const preview = result.preview;
  if (!preview) {
    if (result.error === "not_found") return 5 * 60_000;
    if (result.error === "unavailable") return 60_000;
    return 15_000; // signed_out / cli_missing clear soon after the operator fixes them
  }
  if (preview.kind === "repo") return 10 * 60_000;
  if (preview.kind === "pull") return preview.state === "open" || preview.state === "draft" ? 60_000 : 15 * 60_000;
  return preview.state === "open" ? 2 * 60_000 : 15 * 60_000;
}

export class GitHubPreviews {
  readonly #api: GitHubGraphQL;
  readonly #now: () => number;
  readonly #maxEntries: number;
  readonly #cache = new Map<string, CacheEntry>();
  readonly #pending: Pending[] = [];
  #window?: ReturnType<typeof setTimeout>;
  #running = 0;
  #otherLogins?: { until: number; logins: Promise<string[]> };

  constructor(api: GitHubGraphQL = ghGraphQL(), options: GitHubPreviewOptions = {}) {
    this.#api = api;
    this.#now = options.now ?? Date.now;
    this.#maxEntries = Math.max(1, options.maxEntries ?? 500);
  }

  /** Preview for a github.com URL. Never rejects; an unusable URL is `not_found`. Every spelling of one item
   * (`owner/repo#N`, its issue or pull URL) shares one lookup. */
  lookup(url: string): Promise<GitHubPreviewResult> {
    const ref = parseGitHubUrl(url);
    if (!ref) return Promise.resolve({ url, error: "not_found" });
    const key = githubRefKey(ref);
    const asAsked = (result: GitHubPreviewResult) => ({ ...result, url: ref.url });
    const cached = this.#cache.get(key);
    if (cached && cached.expires > this.#now()) return cached.result.then(asAsked);
    const entry: CacheEntry = { expires: Number.POSITIVE_INFINITY, result: this.#fetch(ref) };
    this.#cache.delete(key);
    this.#cache.set(key, entry);
    this.#evict();
    void entry.result.then((result) => { entry.expires = this.#now() + previewTtlMs(result); });
    return entry.result.then(asAsked);
  }

  /** Forgets failures and the accounts, e.g. after the operator signs in. */
  clearFailures(): void {
    this.#otherLogins = undefined;
    for (const [key, entry] of this.#cache) {
      void entry.result.then((result) => { if (result.error && this.#cache.get(key) === entry) this.#cache.delete(key); });
    }
  }

  #evict(): void {
    for (const key of this.#cache.keys()) {
      if (this.#cache.size <= this.#maxEntries) return;
      this.#cache.delete(key);
    }
  }

  #fetch(ref: GitHubRef): Promise<GitHubPreviewResult> {
    return new Promise((resolve) => {
      this.#pending.push({ ref, resolve });
      this.#window ??= setTimeout(() => { this.#window = undefined; this.#drain(); }, BATCH_WINDOW_MS);
    });
  }

  /** Lookups waiting for a free call go out together in the next one. */
  #drain(): void {
    while (this.#running < CALLS_AT_ONCE && this.#pending.length) {
      const batch = this.#pending.splice(0, BATCH_SIZE);
      this.#running += 1;
      void this.#send(batch).finally(() => { this.#running -= 1; this.#drain(); });
    }
  }

  /** As the active account, then what it could not preview as each other account in turn. An item no account
   * previews keeps the active account's answer. */
  async #send(batch: readonly Pending[]): Promise<void> {
    const results = await this.#query(batch.map(({ ref }) => ref));
    let missing = results.flatMap((result, index) => result.preview ? [] : [index]);
    if (missing.length) {
      for (const login of await this.#logins()) {
        const retried = await this.#query(missing.map((index) => batch[index]!.ref), login);
        retried.forEach((result, position) => { if (result.preview) results[missing[position]!] = result; });
        missing = missing.filter((index) => !results[index]!.preview);
        if (!missing.length) break;
      }
    }
    batch.forEach(({ resolve }, index) => resolve(results[index]!));
  }

  async #query(refs: readonly GitHubRef[], login?: string): Promise<GitHubPreviewResult[]> {
    try {
      const response = await this.#api.query(previewQuery(refs), login);
      return refs.map((ref, index) => previewResult(ref, response, `i${index}`));
    } catch (error) {
      const reason = error instanceof GitHubApiError ? error.reason : "unavailable";
      return refs.map((ref) => ({ url: ref.url, error: reason }));
    }
  }

  #logins(): Promise<string[]> {
    if (!this.#otherLogins || this.#otherLogins.until <= this.#now()) {
      const logins = this.#api.otherLogins().catch(() => {
        this.#otherLogins = undefined;
        return [];
      });
      this.#otherLogins = { until: this.#now() + LOGINS_TTL_MS, logins };
    }
    return this.#otherLogins.logins;
  }
}

/** Pull request badge facts from the same previews, so badges and embeds agree. */
export function previewPullRequestFetcher(previews: GitHubPreviews): PullRequestFetcher {
  return async (url) => {
    const result = await previews.lookup(url);
    if (result.preview?.kind !== "pull") throw new GitHubApiError(result.error ?? "not_found");
    return { state: result.preview.state, title: result.preview.title, body: result.preview.body ?? "" };
  };
}
