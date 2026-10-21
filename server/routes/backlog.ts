/**
 * `/__hui/backlog…`: the Kanban backlog, grouping and starting items, branch names and local tasks' Jira actions.
 * Lifecycle and persistence stay in `backlog.ts`; `hui.ts` applies the `x-hui` guard before dispatching here.
 */
import { reply, type JsonResult, type RouteRequest } from "../http/route.ts";
import { BacklogError, BacklogJiraResponse, BacklogStartResponse, BacklogView, SuggestedBranchName } from "../api/backlog.ts";
import { JiraDraftResponse } from "../api/jira.ts";
export { routeSchemas } from "../api/backlog.ts";
import {
  BacklogInputError,
  BacklogNotFoundError,
  BacklogStoreError,
  splitItemId,
  type BacklogJiraFeed,
  type BacklogStore,
  type createBacklogLifecycle,
} from "../backlog.ts";
import {
  draftJiraWorkItem,
  jiraKeyFromInput,
  jiraIssueUrl,
  JiraInputError,
  JiraRequestError,
  normalizeProjectKey,
  parentCandidates,
  type JiraClient,
  type JiraConfig,
  type JiraIssueRef,
  type JiraIssueStatuses,
} from "../integrations/jira.ts";
import { readHuiSettings } from "../hui-settings.ts";
import { SessionBusyError } from "../sessions/live-sessions.ts";
import { suggestWorktreeName } from "../pi/model-routing.ts";
import { CONFIG_DIR } from "../paths.ts";
import { runPiUtilityPrompt } from "../runtimes/pi.ts";
import { SessionRegistryError } from "../sessions/sessions.ts";
import { TaskSuggestionInputError, TaskSuggestionNotFoundError, taskSuggestionJiraDescription } from "../agent-tools/task-suggestions.ts";
import { existingDirectory } from "../git/working-directories.ts";

const BACKLOG_ROUTE = "/__hui/backlog";
const BACKLOG_ITEM = /^\/__hui\/backlog\/items\/([^/]+?)(?:\/(start|branch-name|jira|jira\/draft|jira\/link))?$/;

type BacklogRouteDeps = Pick<ReturnType<typeof createBacklogLifecycle>, "listBacklog" | "findBacklogItem" | "startBacklogItem"> & {
  backlogStore: BacklogStore;
  backlogFeed: BacklogJiraFeed;
  jiraConfigReady: Promise<void>;
  jiraConfig(): JiraConfig | undefined;
  jiraClient(): JiraClient;
  jiraStatuses: JiraIssueStatuses;
  createAssignedJiraIssue(client: JiraClient, body: Record<string, unknown>): Promise<{ ref: JiraIssueRef; warning: string }>;
};

export function backlogErrorStatus(error: unknown): number {
  if (error instanceof BacklogNotFoundError || error instanceof TaskSuggestionNotFoundError) return 404;
  if (error instanceof BacklogInputError || error instanceof TaskSuggestionInputError || error instanceof JiraInputError) return 400;
  if (error instanceof SessionBusyError) return 409;
  if (error instanceof JiraRequestError) return 502;
  if (error instanceof BacklogStoreError || error instanceof SessionRegistryError) return 500;
  return error instanceof Error ? 400 : 500;
}

export function createBacklogRoutes(deps: BacklogRouteDeps) {
  async function handle(request: RouteRequest): Promise<JsonResult | undefined> {
    const { path } = request;
    const { listBacklog, findBacklogItem, startBacklogItem, backlogStore, backlogFeed, jiraConfigReady, jiraConfig, jiraClient, jiraStatuses, createAssignedJiraIssue } = deps;
    if (path === BACKLOG_ROUTE) {
      if (request.method !== "GET") {
        return reply(BacklogError, { error: "method not allowed" }, 405);
      }
      try {
        const force = request.query.get("refresh") === "1";
        return reply(BacklogView, await listBacklog(force));
      } catch (error) {
        return reply(BacklogError, { error: error instanceof Error ? error.message : "Could not read the backlog." }, backlogErrorStatus(error));
      }
    }

    const backlogItem = path.match(BACKLOG_ITEM);
    if (backlogItem) {
      const itemId = decodeURIComponent(backlogItem[1] ?? "");
      const action = backlogItem[2] ?? "";
      const [kind, key] = splitItemId(itemId);
      const allowed = action ? "POST" : request.method === "PATCH" || (request.method === "DELETE" && kind === "local") ? request.method : "";
      if (!kind || !key) {
        return reply(BacklogError, { error: "That item is no longer in the backlog." }, 404);
      }
      if (request.method !== allowed) {
        return reply(BacklogError, { error: "method not allowed" }, 405);
      }
      try {
        if (!action && request.method === "PATCH") {
          const body = (await request.json()) as Record<string, unknown>;
          // A Jira item must still be in the backlog; its metadata is keyed by it.
          await findBacklogItem(itemId);
          await backlogStore.setGroup(itemId, body["group"]);
          return reply(BacklogView, await listBacklog());
        }
        if (!action) {
          await backlogStore.removeTask(key);
          return reply(BacklogView, await listBacklog());
        }
        if (action === "start") {
          const body = (await request.json()) as Record<string, unknown>;
          const session = await startBacklogItem(itemId, body);
          return reply(BacklogStartResponse, { session, backlog: await listBacklog() });
        }
        if (action === "branch-name") {
          const body = (await request.json()) as Record<string, unknown>;
          const item = await findBacklogItem(itemId);
          const cwd = await existingDirectory(body["cwd"]);
          return reply(SuggestedBranchName, await suggestWorktreeName({ cwd, item, settings: await readHuiSettings() }));
        }
        // Jira actions only apply to local tasks without a key yet.
        await jiraConfigReady;
        if (kind !== "local") throw new BacklogInputError("Only local tasks can be filed in or linked to Jira.");
        const task = (await backlogStore.read()).tasks.find((candidate) => candidate.id === key);
        if (!task) throw new BacklogNotFoundError("That task is no longer in the backlog.");
        if (task.jira) throw new BacklogInputError(`That task is already linked to ${task.jira.key}.`);
        const body = (await request.json()) as Record<string, unknown>;
        const client = jiraClient();
        if (action === "jira/draft") {
          const project = normalizeProjectKey(body["project"]) || jiraConfig()!.defaultProject;
          if (!project) throw new JiraInputError("Choose a Jira project.");
          const { parents } = await parentCandidates(client, project);
          const draft = await draftJiraWorkItem({
            project,
            parents,
            title: task.title,
            cwd: task.cwd ?? CONFIG_DIR,
            context: taskSuggestionJiraDescription(task),
            model: (await readHuiSettings()).models.utility,
            run: runPiUtilityPrompt,
          });
          return reply(JiraDraftResponse, { draft });
        }
        if (action === "jira/link") {
          const linkKey = typeof body["key"] === "string" ? jiraKeyFromInput(body["key"]) : undefined;
          if (!linkKey) throw new JiraInputError("Enter a Jira work item key such as CI-123.");
          const details = await client.issue(linkKey);
          const ref = { key: linkKey, url: jiraIssueUrl(jiraConfig()!.site, linkKey) };
          await backlogStore.attachJira(key, ref);
          jiraStatuses.remember(ref, details);
          return reply(BacklogJiraResponse, { issue: ref, backlog: await listBacklog() });
        }
        const { ref, warning } = await createAssignedJiraIssue(client, body);
        try {
          await backlogStore.attachJira(key, ref);
        } catch (error) {
          // The work item exists; report where it went instead of hiding it.
          throw new BacklogInputError(`${ref.key} was created but could not be attached to the task: ${error instanceof Error ? error.message : "unknown error"}`);
        }
        backlogFeed.invalidate();
        return reply(BacklogJiraResponse, { issue: ref, backlog: await listBacklog(), ...(warning ? { warning } : {}) });
      } catch (error) {
        return reply(BacklogError, { error: error instanceof Error ? error.message : "Could not update the backlog." }, backlogErrorStatus(error));
      }
    }
    return undefined;
  }

  return { handle };
}
