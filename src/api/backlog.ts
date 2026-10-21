/** Browser half of the Kanban backlog. The server owns `backlog.json` and the
 * Jira credential; this module only moves views and explicit operator input. */
import type { BacklogItem, BacklogStartInput, BacklogView, BacklogJiraState, BacklogStartResponse, BacklogJiraResponse, BacklogJiraCreateRequest, SuggestedBranchName } from "./schema/backlog.ts";
import type { SessionJiraIssue } from "./schema/sessions.ts";
import type { JiraDraft, JiraDraftResponse } from "./schema/jira.ts";
import type { TaskSuggestion, TaskSuggestionBacklogResponse } from "./schema/task-suggestions.ts";
import { fetchJson } from "./request.ts";

export type { BacklogItem, BacklogJiraState, BacklogView, SuggestedBranchName } from "./schema/backlog.ts";

const BACKLOG_LIMITS = {
  title: 200,
  problem: 12_000,
  fix: 8_000,
  cwd: 4_096,
  group: 200,
} as const;

export function backlogItemPrompt(item: Pick<BacklogItem, "kind" | "title" | "problem" | "fix" | "jira">): string {
  const link = item.jira ? [`Jira: [${item.jira.key}](${item.jira.url})`] : [];
  if (item.kind === "jira") {
    const summary = item.jira?.summary || item.title;
    return [
      `# ${item.jira ? `${item.jira.key}: ` : ""}${summary}`,
      ...link,
      "## Description",
      item.jira?.description?.trim() || "No description in Jira. Investigate and confirm the scope before changing code.",
    ].join("\n\n");
  }
  return [
    `# ${item.title}`,
    ...link,
    "## Problem", item.problem?.trim() || "Not described.",
    "## Proposed fix",
    item.fix?.trim() || "Not known yet. Investigate and confirm the root cause before changing code.",
  ].join("\n\n");
}

export function backlogItemMarkdown(item: BacklogItem): string {
  return backlogItemPrompt(item);
}

function text(value: unknown, maximum: number): string {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

/** Browser-side normalization of `GET /__hui/backlog`; drops malformed rows. */
export function parseBacklogView(value: unknown): BacklogView {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const items = Array.isArray(raw["items"]) ? raw["items"].flatMap((entry): BacklogItem[] => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    const kind = row["kind"] === "jira" || row["kind"] === "local" ? row["kind"] : undefined;
    const id = text(row["id"], 200);
    const title = text(row["title"], BACKLOG_LIMITS.title);
    if (!kind || !id || !title) return [];
    const jiraRaw = row["jira"] && typeof row["jira"] === "object" ? row["jira"] as Record<string, unknown> : undefined;
    const jira = jiraRaw && typeof jiraRaw["key"] === "string" && typeof jiraRaw["url"] === "string"
      ? jiraRaw as unknown as SessionJiraIssue
      : undefined;
    if (kind === "jira" && !jira) return [];
    const cwd = text(row["cwd"], BACKLOG_LIMITS.cwd);
    const problem = text(row["problem"], BACKLOG_LIMITS.problem);
    const fix = text(row["fix"], BACKLOG_LIMITS.fix);
    const createdAt = text(row["createdAt"], 40);
    return [{
      id, kind, title, group: text(row["group"], BACKLOG_LIMITS.group),
      ...(cwd ? { cwd } : {}), ...(problem ? { problem } : {}), ...(fix ? { fix } : {}),
      ...(createdAt ? { createdAt } : {}), ...(jira ? { jira } : {}),
    }];
  }) : [];
  const jiraRaw = raw["jira"] && typeof raw["jira"] === "object" ? raw["jira"] as Record<string, unknown> : {};
  const jira: BacklogJiraState = jiraRaw["status"] === "ok"
    ? { status: "ok" }
    : jiraRaw["status"] === "unavailable"
      ? { status: "unavailable", message: text(jiraRaw["message"], 400) || "Jira could not be reached." }
      : { status: "unconfigured" };
  return { items, jira };
}

const BACKLOG_URL = "/__hui/backlog";
const JSON_HEADERS = { "content-type": "application/json" } as const;

function itemUrl(id: string, action = ""): string {
  return `${BACKLOG_URL}/items/${encodeURIComponent(id)}${action ? `/${action}` : ""}`;
}

/** `refresh` bypasses the short Jira cache (the board's Refresh button). */
export async function loadBacklog(refresh = false): Promise<BacklogView> {
  return parseBacklogView(await fetchJson<unknown>(`${BACKLOG_URL}${refresh ? "?refresh=1" : ""}`, { signal: AbortSignal.timeout(30_000) }));
}

export async function setBacklogItemGroup(id: string, group: string): Promise<BacklogView> {
  return parseBacklogView(await fetchJson<unknown>(itemUrl(id), {
    method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ group }), signal: AbortSignal.timeout(30_000),
  }));
}

export async function removeBacklogItem(id: string): Promise<BacklogView> {
  return parseBacklogView(await fetchJson<unknown>(itemUrl(id), { method: "DELETE", signal: AbortSignal.timeout(30_000) }));
}

/** Creates the session (and worktree) and waits for its runtime to accept the
 * first prompt, so this can take as long as a cold boot plus a checkout. */
export async function startBacklogItem(id: string, input: BacklogStartInput): Promise<BacklogStartResponse> {
  const body = await fetchJson<BacklogStartResponse>(itemUrl(id, "start"), {
    method: "POST", headers: JSON_HEADERS, body: JSON.stringify(input),
    signal: AbortSignal.timeout(input.worktree ? 10 * 60_000 : 90_000),
  });
  return { session: body.session, backlog: parseBacklogView(body.backlog) };
}

/** The utility model's suggestion for the part of a new worktree branch after
 * the configured prefix; the server falls back to the title's words. */
export async function suggestBacklogBranchName(id: string, cwd: string, signal?: AbortSignal): Promise<SuggestedBranchName> {
  const body = await fetchJson<Partial<Record<keyof SuggestedBranchName, unknown>>>(itemUrl(id, "branch-name"), {
    method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ cwd }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000),
  });
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) throw new Error("No branch name was suggested.");
  return { name, source: body.source === "model" ? "model" : "fallback" };
}

export async function addSuggestionToBacklog(sessionId: string, suggestionId: string): Promise<TaskSuggestion[]> {
  return (await fetchJson<TaskSuggestionBacklogResponse>(
    `/__hui/sessions/${encodeURIComponent(sessionId)}/suggestions/${encodeURIComponent(suggestionId)}/backlog`,
    { method: "POST", headers: JSON_HEADERS, body: "{}", signal: AbortSignal.timeout(30_000) },
  )).suggestions;
}

export async function draftBacklogJira(id: string, project: string): Promise<JiraDraft> {
  return (await fetchJson<JiraDraftResponse>(itemUrl(id, "jira/draft"), {
    method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ project }), signal: AbortSignal.timeout(120_000),
  })).draft;
}

export async function createBacklogJira(
  id: string,
  input: Required<BacklogJiraCreateRequest>,
): Promise<BacklogJiraResponse> {
  return fetchJson(itemUrl(id, "jira"), { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(input), signal: AbortSignal.timeout(30_000) });
}

export async function linkBacklogJira(id: string, key: string): Promise<BacklogJiraResponse> {
  return fetchJson(itemUrl(id, "jira/link"), { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ key }), signal: AbortSignal.timeout(30_000) });
}
