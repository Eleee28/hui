/**
 * `/__hui/github…`: the `gh` connection and its device login (`github.ts`), link previews (`github-previews.ts`)
 * and the contributions calendar (`github-contributions.ts`), plus `GET /__hui/session-activity`, the sessions' own
 * days shown beside it. `hui.ts` applies the `x-hui` guard before dispatching here.
 */
import { FIRST_YEAR as GITHUB_FIRST_YEAR, type GitHubContributionsReader, latestYear } from "../integrations/github-contributions.ts";
import type { GitHubPreviews } from "../integrations/github-previews.ts";
import { type GitHubCli, GitHubCliError } from "../integrations/github.ts";
import { reply, type JsonResult, type RouteRequest } from "../http/route.ts";
import type { RouteSchema } from "../api/index.ts";
import { GitHubConnection, GitHubContributions, GitHubError, GitHubPreviewsResponse, SessionActivity, routeSchemas as githubRouteSchemas } from "../api/github.ts";
import { activityRange, readSessionActivity } from "../sessions/activity.ts";
import { readRegistry } from "../sessions/sessions.ts";
import { MAX_GITHUB_EMBEDS, parseGitHubUrl } from "../integrations/github-links.ts";

export const routeSchemas: RouteSchema[] = githubRouteSchemas;

const GITHUB_ROUTE = "/__hui/github";
const GITHUB_LOGIN_ROUTE = `${GITHUB_ROUTE}/login`;
const GITHUB_PREVIEWS_ROUTE = `${GITHUB_ROUTE}/previews`;
const GITHUB_CONTRIBUTIONS_ROUTE = `${GITHUB_ROUTE}/contributions`;
const SESSION_ACTIVITY_ROUTE = "/__hui/session-activity";

export function createGitHubRoutes(deps: {
  githubCli: GitHubCli;
  githubPreviews: GitHubPreviews;
  githubContributions: GitHubContributionsReader;
}) {
  async function handle(request: RouteRequest): Promise<JsonResult | undefined> {
    const { method, path } = request;
    const { githubCli, githubPreviews, githubContributions } = deps;

    if (path === GITHUB_ROUTE) {
      if (method !== "GET") return reply(GitHubError, { error: "method not allowed" }, 405);
      return reply(GitHubConnection, await githubCli.connection());
    }

    if (path === GITHUB_PREVIEWS_ROUTE) {
      if (method !== "GET") return reply(GitHubError, { error: "method not allowed" }, 405);
      const urls = request.query.getAll("url");
      if (urls.length === 0 || urls.length > MAX_GITHUB_EMBEDS || urls.some((url) => url.length > 500 || !parseGitHubUrl(url))) {
        return reply(GitHubError, { error: `Pass 1-${MAX_GITHUB_EMBEDS} github.com repository, pull request or issue URLs.` }, 400);
      }
      return reply(GitHubPreviewsResponse, { previews: await Promise.all(urls.map((url) => githubPreviews.lookup(url))) });
    }

    if (path === SESSION_ACTIVITY_ROUTE) {
      if (method !== "GET") return reply(GitHubError, { error: "method not allowed" }, 405);
      const range = activityRange(request.query);
      if (!range) return reply(GitHubError, { error: "from and to must be epoch milliseconds, to after from and at most 31 days apart." }, 400);
      try {
        return reply(SessionActivity, await readSessionActivity(await readRegistry(), range.from, range.to));
      } catch (error) {
        return reply(GitHubError, { error: error instanceof Error ? error.message : "Session activity could not be read." }, 500);
      }
    }

    if (path === GITHUB_CONTRIBUTIONS_ROUTE) {
      if (method !== "GET") return reply(GitHubError, { error: "method not allowed" }, 405);
      const params = request.query;
      const year = params.has("year") ? Number(params.get("year")) : undefined;
      if (year !== undefined && !(Number.isInteger(year) && year >= GITHUB_FIRST_YEAR && year <= latestYear())) {
        return reply(GitHubError, { error: `year must be ${GITHUB_FIRST_YEAR}-${latestYear()}.` }, 400);
      }
      try {
        return reply(GitHubContributions, await githubContributions.read(year, params.get("refresh") === "1"));
      } catch (error) {
        return reply(GitHubError, { error: error instanceof Error ? error.message : "GitHub activity could not be read." }, 502);
      }
    }

    if (path === GITHUB_LOGIN_ROUTE) {
      if (method !== "POST" && method !== "DELETE") return reply(GitHubError, { error: "method not allowed" }, 405);
      try {
        const result = method === "POST" ? await githubCli.startLogin() : await githubCli.cancelLogin();
        if (result.status === "connected") githubPreviews.clearFailures();
        return reply(GitHubConnection, result);
      } catch (error) {
        return reply(GitHubError, { error: error instanceof Error ? error.message : "Could not sign in to GitHub." }, error instanceof GitHubCliError ? error.status : 500);
      }
    }

    return undefined;
  }

  return { handle };
}
