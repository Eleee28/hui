/** Browser client for the Jira integration: the connection, project and issue search, and drafting, creating and
 * linking work items. The server owns the credential; these requests only move credential-free views and explicit
 * user input. */
import type {
  JiraConnection, JiraConnectRequest, JiraCreateRequest, JiraCreateResponse, JiraDraft, JiraDraftResponse,
  JiraIssueMatch, JiraIssuesResponse, JiraLinkResponse, JiraProject, JiraProjectsResponse,
} from "./schema/jira.ts";
import type { SessionView } from "./sessions.ts";
import { fetchJson } from "./request.ts";

const JIRA_URL = "/__hui/jira";

const JSON_HEADERS = { "content-type": "application/json" } as const;

export function loadJiraConnection(): Promise<JiraConnection> {
  return fetchJson<JiraConnection>(JIRA_URL);
}

export function connectJira(input: JiraConnectRequest): Promise<JiraConnection> {
  return fetchJson<JiraConnection>(JIRA_URL, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(20_000),
  });
}

export function setJiraDefaultProject(defaultProject: string): Promise<JiraConnection> {
  return fetchJson<JiraConnection>(JIRA_URL, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ defaultProject }) });
}

export function disconnectJira(): Promise<JiraConnection> {
  return fetchJson<JiraConnection>(JIRA_URL, { method: "DELETE" });
}

/** First page of projects, or Jira's own search when `query` is set. */
export function loadJiraProjects(query = ""): Promise<JiraProjectsResponse> {
  const search = query.trim() ? `?query=${encodeURIComponent(query.trim())}` : "";
  return fetchJson(`${JIRA_URL}/projects${search}`, { signal: AbortSignal.timeout(30_000) });
}

/** Debounced remote search with stale-response protection. */
export function jiraProjectSearch(onResult: (projects: JiraProject[]) => void, onError: (message: string) => void, delayMs = 250) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sequence = 0;
  return (query: string) => {
    if (timer) clearTimeout(timer);
    const term = query.trim();
    if (!term) return;
    timer = setTimeout(() => {
      const request = ++sequence;
      loadJiraProjects(term).then(
        (result) => { if (request === sequence) onResult(result.projects); },
        (error: unknown) => { if (request === sequence) onError(error instanceof Error ? error.message : "Jira projects could not be searched."); },
      );
    }, delayMs);
  };
}

/** Parents plus an agent-written summary, description and parent default.
 * The utility model can take a while, so the timeout is generous. */
export async function draftJiraWorkItem(sessionId: string, project: string, suggestionId = ""): Promise<JiraDraft> {
  return (await fetchJson<JiraDraftResponse>(`/__hui/sessions/${encodeURIComponent(sessionId)}/jira/draft`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ project, ...(suggestionId ? { suggestionId } : {}) }),
    signal: AbortSignal.timeout(120_000),
  })).draft;
}

export async function createJiraWorkItem(
  sessionId: string,
  input: JiraCreateRequest,
): Promise<JiraCreateResponse & { session?: SessionView }> {
  return fetchJson(`/__hui/sessions/${encodeURIComponent(sessionId)}/jira`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(30_000),
  });
}


/** Recently viewed items for an empty query; a key, URL or text otherwise. */
export async function searchJiraIssues(query: string, signal?: AbortSignal): Promise<JiraIssueMatch[]> {
  const search = query.trim() ? `?query=${encodeURIComponent(query.trim())}` : "";
  return (await fetchJson<JiraIssuesResponse>(`${JIRA_URL}/issues${search}`, { signal: signal ?? AbortSignal.timeout(30_000) })).issues;
}

export async function linkJiraWorkItem(sessionId: string, key: string): Promise<JiraLinkResponse & { session?: SessionView }> {
  return fetchJson(`/__hui/sessions/${encodeURIComponent(sessionId)}/jira/link`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ key }),
    signal: AbortSignal.timeout(30_000),
  });
}
