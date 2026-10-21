/**
 * `/__hui/jira…`: the Jira connection (connect, default project, disconnect), project and work item search, and
 * `POST /__hui/sessions/:id/jira[/draft|/link]` (create, draft or link a session's work item), over `jira.ts`.
 * `hui.ts` owns the connection state, passes it in and applies the `x-hui` guard before dispatching here.
 */
import { homedir } from "node:os";
import { reply, type JsonResult, type RouteRequest } from "../http/route.ts";
import type { RouteSchema } from "../api/index.ts";
import {
  JiraConnection, JiraCreateResponse, JiraDraftResponse, JiraError, JiraIssuesResponse, JiraLinkResponse,
  JiraProjectsResponse, routeSchemas as jiraRouteSchemas,
} from "../api/jira.ts";
import { readHuiSettings } from "../hui-settings.ts";
import {
  draftJiraWorkItem,
  findJiraIssues,
  JiraClient,
  type JiraConfig,
  type JiraConfigStore,
  jiraConnectionView,
  JiraInputError,
  type JiraIssueStatuses,
  jiraIssueUrl,
  jiraKeyFromInput,
  JiraRequestError,
  mergeJiraRefs,
  normalizeJiraSite,
  normalizeProjectKey,
  parentCandidates,
} from "../integrations/jira.ts";
import { liveSessions } from "../sessions/live-sessions.ts";
import { runPiUtilityPrompt } from "../runtimes/pi.ts";
import { sessionDigest } from "../sessions/digest.ts";
import { readRegistry, type SessionRecord, updateRegistry } from "../sessions/sessions.ts";
import type { SessionStatus, SessionView } from "../api/sessions.ts";
import { TaskSuggestionNotFoundError, type TaskSuggestionStore } from "../agent-tools/task-suggestions.ts";
import { taskSuggestionJiraDescription } from "../agent-tools/task-suggestions.ts";

export const routeSchemas: RouteSchema[] = jiraRouteSchemas;

const JIRA_ROUTE = "/__hui/jira";
const JIRA_PROJECTS_ROUTE = `${JIRA_ROUTE}/projects`;
const JIRA_ISSUES_ROUTE = `${JIRA_ROUTE}/issues`;
/** Create (POST) or draft (POST …/draft) a Jira work item for one session. */
const SESSION_JIRA = /^\/__hui\/sessions\/([^/]+)\/jira(?:\/(draft|link))?$/;

function jiraErrorStatus(error: unknown): number {
  if (error instanceof JiraInputError) return 400;
  if (error instanceof JiraRequestError) return 502;
  return 500;
}

export function createJiraRoutes(deps: {
  jiraStore: JiraConfigStore;
  jiraConfig(): JiraConfig | undefined;
  setJiraConfig(config: JiraConfig | undefined): void;
  jiraConfigReady: Promise<void>;
  jiraStatuses: JiraIssueStatuses;
  jiraClient(): JiraClient;
  createAssignedJiraIssue(client: JiraClient, body: Record<string, unknown>): Promise<{ ref: { key: string; url: string }; warning: string }>;
  toView(record: SessionRecord, status: SessionStatus): SessionView;
  taskSuggestions: TaskSuggestionStore;
}) {
  async function handle(request: RouteRequest): Promise<JsonResult | undefined> {
    const { method, path } = request;
    const { jiraStore, jiraConfig, setJiraConfig, jiraConfigReady, jiraStatuses, jiraClient, createAssignedJiraIssue, toView, taskSuggestions } = deps;

    if (path === JIRA_ROUTE) {
      await jiraConfigReady;
      if (method === "GET") return reply(JiraConnection, jiraConnectionView(jiraConfig()));
      if (method === "PUT") {
        try {
          const body = (await request.json()) as Record<string, unknown>;
          const site = normalizeJiraSite(body["site"]);
          const email = typeof body["email"] === "string" ? body["email"].trim() : "";
          if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+$/u.test(email)) throw new JiraInputError("Enter the email address of your Atlassian account.");
          const entered = typeof body["token"] === "string" ? body["token"].trim() : "";
          const current = jiraConfig();
          // An empty token keeps the stored one, but only for the same site and account.
          const token = entered || (current && current.site === site && current.email === email ? current.token : "");
          if (!token) throw new JiraInputError("Paste an Atlassian API token.");
          if (token.length > 1_000) throw new JiraInputError("That API token is too long.");
          const defaultProject = normalizeProjectKey(body["defaultProject"]);
          const client = new JiraClient({ site, email, token });
          const me = await client.myself();
          const next: JiraConfig = {
            site, email, token, defaultProject,
            ...(me.displayName ? { accountName: me.displayName } : {}),
            ...(me.accountId ? { accountId: me.accountId } : {}),
          };
          await jiraStore.write(next);
          if (jiraConfig()?.site !== site || jiraConfig()?.email !== email) jiraStatuses.clear();
          setJiraConfig(next);
          return reply(JiraConnection, jiraConnectionView(next));
        } catch (error) {
          return reply(JiraError, { error: error instanceof Error ? error.message : "Could not connect Jira." }, jiraErrorStatus(error));
        }
      }
      if (method === "PATCH") {
        try {
          if (!jiraConfig()) throw new JiraInputError("Connect Jira in Settings → Integrations first.");
          const body = (await request.json()) as Record<string, unknown>;
          const next = { ...jiraConfig()!, defaultProject: normalizeProjectKey(body["defaultProject"]) };
          await jiraStore.write(next);
          setJiraConfig(next);
          return reply(JiraConnection, jiraConnectionView(next));
        } catch (error) {
          return reply(JiraError, { error: error instanceof Error ? error.message : "Could not save the default project." }, jiraErrorStatus(error));
        }
      }
      if (method === "DELETE") {
        await jiraStore.remove();
        setJiraConfig(undefined);
        jiraStatuses.clear();
        return reply(JiraConnection, jiraConnectionView(undefined));
      }
      return reply(JiraError, { error: "method not allowed" }, 405);
    }

    if (path === JIRA_PROJECTS_ROUTE) {
      await jiraConfigReady;
      if (method !== "GET") return reply(JiraError, { error: "method not allowed" }, 405);
      try {
        const query = request.query.get("query") ?? "";
        if (query.length > 100) throw new JiraInputError("A project search must be at most 100 characters.");
        return reply(JiraProjectsResponse, await jiraClient().projects(query));
      } catch (error) {
        return reply(JiraError, { error: error instanceof Error ? error.message : "Could not list Jira projects." }, jiraErrorStatus(error));
      }
    }

    if (path === JIRA_ISSUES_ROUTE) {
      await jiraConfigReady;
      if (method !== "GET") return reply(JiraError, { error: "method not allowed" }, 405);
      try {
        const query = request.query.get("query") ?? "";
        if (query.length > 200) throw new JiraInputError("A work item search must be at most 200 characters.");
        const client = jiraClient();
        return reply(JiraIssuesResponse, { issues: await findJiraIssues(client, jiraConfig()!.site, query) });
      } catch (error) {
        return reply(JiraError, { error: error instanceof Error ? error.message : "Could not search Jira." }, jiraErrorStatus(error));
      }
    }

    const jiraSession = path.match(SESSION_JIRA);
    if (jiraSession) {
      await jiraConfigReady;
      if (method !== "POST") return reply(JiraError, { error: "method not allowed" }, 405);
      const id = decodeURIComponent(jiraSession[1] ?? "");
      const record = (await readRegistry()).find((session) => session.id === id);
      if (!record) return reply(JiraError, { error: `unknown session: ${id}` }, 404);
      try {
        const body = (await request.json()) as Record<string, unknown>;
        const client = jiraClient();
        if (jiraSession[2] === "link") {
          const key = typeof body["key"] === "string" ? jiraKeyFromInput(body["key"]) : undefined;
          if (!key) throw new JiraInputError("Enter a Jira work item key such as CI-123.");
          // Confirm it exists and is visible before storing the reference.
          const details = await client.issue(key);
          const ref = { key, url: jiraIssueUrl(jiraConfig()!.site, key) };
          const records = await updateRegistry((sessions) => sessions.map((session) => session.id === id
            ? { ...session, jiraIssues: mergeJiraRefs((session.jiraIssues ?? []).filter((item) => item.key !== key), [ref]) }
            : session));
          jiraStatuses.remember(ref, details);
          const next = records.find((session) => session.id === id);
          return reply(JiraLinkResponse, { issue: ref, ...(next ? { session: toView(next, liveSessions.status(id)) } : {}) });
        }
        if (jiraSession[2] === "draft") {
          const project = normalizeProjectKey(body["project"]) || jiraConfig()!.defaultProject;
          if (!project) throw new JiraInputError("Choose a Jira project.");
          const { parents } = await parentCandidates(client, project);
          // A suggestion card is drafted from its own text, not the whole session.
          const suggestion = typeof body["suggestionId"] === "string" && body["suggestionId"]
            ? taskSuggestions.get(id, body["suggestionId"])
            : undefined;
          // A session is drafted from a goal-anchored digest, not a tail slice.
          const digest = suggestion ? undefined : sessionDigest(liveSessions.transcript(id));
          const draft = await draftJiraWorkItem({
            project,
            parents,
            title: suggestion?.title ?? record.title,
            // Utility calls run on this machine, even for remote sessions.
            cwd: record.worker ? homedir() : record.cwd,
            context: suggestion ? taskSuggestionJiraDescription(suggestion) : digest?.text ?? "",
            ...(digest?.goal ? { goal: digest.goal } : {}),
            model: (await readHuiSettings()).models.utility,
            run: runPiUtilityPrompt,
          });
          return reply(JiraDraftResponse, { draft });
        }
        const { ref, warning: assignWarning } = await createAssignedJiraIssue(client, body);
        // Filing a suggestion resolves its card; it may already have been dismissed.
        if (typeof body["suggestionId"] === "string" && body["suggestionId"]) {
          try { taskSuggestions.remove(id, body["suggestionId"]); } catch (error) { if (!(error instanceof TaskSuggestionNotFoundError)) throw error; }
        }
        const records = await updateRegistry((sessions) => sessions.map((session) => session.id === id
          ? { ...session, jiraIssues: mergeJiraRefs(session.jiraIssues ?? [], [ref]) }
          : session));
        const next = records.find((session) => session.id === id);
        return reply(JiraCreateResponse, {
          issue: ref,
          ...(next ? { session: toView(next, liveSessions.status(id)) } : {}),
          ...(assignWarning ? { warning: assignWarning } : {}),
        });
      } catch (error) {
        if (error instanceof TaskSuggestionNotFoundError) return reply(JiraError, { error: error.message }, 404);
        return reply(JiraError, { error: error instanceof Error ? error.message : "Could not create the Jira work item." }, jiraErrorStatus(error));
      }
    }

    return undefined;
  }

  return { handle };
}
