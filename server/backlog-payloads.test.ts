import { expectTypeOf, test } from "vitest";
import type * as Backlog from "./api/backlog.ts";
import type * as Tasks from "./api/task-suggestions.ts";
import type * as Worktrees from "./api/worktrees.ts";
import type * as Watchers from "./api/watchers.ts";
import type * as Sessions from "./api/sessions.ts";
import type { SessionJiraIssue, SessionStage } from "./api/sessions.ts";
import type { SessionPullRequest } from "./api/github.ts";

type LegacyBacklogItemKind = "jira" | "local";
type LegacyBacklogItem = {
  id: string;
  kind: LegacyBacklogItemKind;
  title: string;
  group: string;
  cwd?: string;
  problem?: string;
  fix?: string;
  createdAt?: string;
  jira?: SessionJiraIssue;
};
type LegacyBacklogJiraState =
  | { status: "ok" }
  | { status: "unconfigured" }
  | { status: "unavailable"; message: string };

type LegacyBacklogView = { items: LegacyBacklogItem[]; jira: LegacyBacklogJiraState };
type LegacyBacklogStartInput = {
  cwd: string;
  worktree: boolean;
  branchName?: string;
  baseRef?: string;
  stage: SessionStage;
  group: string;
};
type LegacyTaskSuggestion = {
  id: string;
  title: string;
  problem: string;
  fix: string;
  cwd: string;
  worker?: string;
  createdAt: string;
};
type LegacyTaskSuggestionStartMode = "session" | "worktree" | "current";
type LegacyWorktreeSessionRef = {
  id: string;
  title: string;
  archived: boolean;
};
type LegacyWorktreeRow = {
  repository: string;
  path: string;
  displayPath: string;
  branch: string;
  head: string;
  detached: boolean;
  managed: boolean;
  sessions: readonly LegacyWorktreeSessionRef[];
  pullRequests?: readonly SessionPullRequest[];
  dirty?: boolean;
  bytes?: number;
  merged: boolean;
  risks: readonly LegacyWorktreeRisk[];
  unavailable?: readonly ("pullRequests" | "dirty" | "bytes")[];
  removal?: "queued" | "removing";
  remainingBytes?: number;
};
type LegacyWorktreeRisk = "dirty" | "unknown" | "locked" | "running" | "missing" | "external";
type LegacyWorktreeInventory = {
  worktrees: readonly LegacyWorktreeRow[];
  diagnostics: readonly string[];
  pending: boolean;
};
type LegacyWorktreeRemovalMode = "single" | "merged";
type LegacyWorktreeRemovalResult = {
  path: string;
  label: string;
  removed: boolean;
  branchDeleted: boolean;
  error?: string;
};
type LegacyWatcherState = "running" | "done" | "failed" | "stopped" | "dead";
type LegacyWatcher = {
  id: string;
  purpose: string;
  target: string;
  outcome: string;
  command: string;
  logPath: string;
  state: LegacyWatcherState;
  pid: number | null;
  exitCode?: number;
  startedAt: string;
  endedAt?: string;
  lastLine: string;
  keepRunning?: true;
};
type LegacyProgressStepStatus = "pending" | "in_progress" | "completed";
type LegacyProgressStep = { step: string; status: LegacyProgressStepStatus };
type LegacyProgressCard = {
  markdown: string;
  steps: LegacyProgressStep[];
};

type LegacyMemorySource = {
  workspace: string;
  path: string;
  relativePath: string;
  kind: "context" | "memory";
  bytes: number;
  modifiedAt: string;
};

type LegacyWorktreeView = {
  repository: string;
  path: string;
  branch: string;
  head: string;
  bare: boolean;
  detached: boolean;
  sessionIds: readonly string[];
};

type LegacyWorkspaceInspection = {
  workspaces: readonly string[];
  memory: readonly LegacyMemorySource[];
  worktrees: readonly LegacyWorktreeView[];
  diagnostics: readonly string[];
};

type LegacyThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
type LegacySuggestedBranchName = { name: string; source: "model" | "fallback" };
type LegacyWatcherLog = { id: string; lines: string[]; truncated: boolean };

test("backlog, task, worktree, watcher and progress schemas preserve existing payload types", () => {
  expectTypeOf<LegacyMemorySource>().toEqualTypeOf<Worktrees.MemorySource>();
  expectTypeOf<LegacyWorktreeView>().toEqualTypeOf<Worktrees.WorktreeView>();
  expectTypeOf<LegacyWorkspaceInspection>().toEqualTypeOf<Worktrees.WorkspaceInspection>();
  expectTypeOf<LegacyThinkingLevel>().toEqualTypeOf<Sessions.ThinkingLevel>();
  expectTypeOf<LegacySuggestedBranchName>().toEqualTypeOf<Backlog.SuggestedBranchName>();
  expectTypeOf<LegacyWatcherLog>().toEqualTypeOf<Watchers.WatcherLog>();
  expectTypeOf<LegacyBacklogItemKind>().toEqualTypeOf<Backlog.BacklogItemKind>();
  expectTypeOf<LegacyBacklogItem>().toEqualTypeOf<Backlog.BacklogItem>();
  expectTypeOf<LegacyBacklogJiraState>().toEqualTypeOf<Backlog.BacklogJiraState>();
  expectTypeOf<LegacyBacklogView>().toEqualTypeOf<Backlog.BacklogView>();
  expectTypeOf<LegacyBacklogStartInput>().toEqualTypeOf<Backlog.BacklogStartInput>();
  expectTypeOf<LegacyTaskSuggestion>().toEqualTypeOf<Tasks.TaskSuggestion>();
  expectTypeOf<LegacyTaskSuggestionStartMode>().toEqualTypeOf<Tasks.TaskSuggestionStartMode>();
  expectTypeOf<LegacyWorktreeSessionRef>().toEqualTypeOf<Worktrees.WorktreeSessionRef>();
  expectTypeOf<LegacyWorktreeRow>().toEqualTypeOf<Worktrees.WorktreeRow>();
  expectTypeOf<LegacyWorktreeRisk>().toEqualTypeOf<Worktrees.WorktreeRisk>();
  expectTypeOf<LegacyWorktreeInventory>().toEqualTypeOf<Worktrees.WorktreeInventory>();
  expectTypeOf<LegacyWorktreeRemovalMode>().toEqualTypeOf<Worktrees.WorktreeRemovalMode>();
  expectTypeOf<LegacyWorktreeRemovalResult>().toEqualTypeOf<Worktrees.WorktreeRemovalResult>();
  expectTypeOf<LegacyWatcherState>().toEqualTypeOf<Watchers.WatcherState>();
  expectTypeOf<LegacyWatcher>().toEqualTypeOf<Watchers.Watcher>();
  expectTypeOf<LegacyProgressStepStatus>().toEqualTypeOf<Sessions.ProgressStep["status"]>();
  expectTypeOf<LegacyProgressStep>().toEqualTypeOf<Sessions.ProgressStep>();
  expectTypeOf<LegacyProgressCard>().toEqualTypeOf<Sessions.ProgressCard>();
});
