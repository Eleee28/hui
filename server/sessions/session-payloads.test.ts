import { expectTypeOf, test } from "vitest";
import type * as Api from "../api/sessions.ts";
import type { SessionPullRequest } from "../api/github.ts";
import type { SubagentRecord } from "./sessions.ts";

type LegacySessionStatus = "idle" | "running" | "waiting" | "starting" | "error" | "reconnecting" | "disconnected";
type LegacySessionStage = "investigation" | "implementation" | "testing" | "done";
type LegacySessionStageSource = "operator" | "agent" | "pullRequest";
type LegacySessionStageOrigin = LegacySessionStageSource | "default";
type LegacyWorktreeProgress = {
  phase: "naming" | "preparing" | "checkout" | "filtering" | "finalizing";
  percent?: number;
  completed?: number;
  total?: number;
};
type LegacyProgressCard = { markdown: string; steps: { step: string; status: "pending" | "in_progress" | "completed" }[] };

type LegacySessionView = {
  progress?: LegacyProgressCard;
  pullRequests?: SessionPullRequest[];
  jiraIssues?: Api.SessionJiraIssue[];
  id: string;
  title: string;
  group: string;
  cwd: string;
  displayCwd: string;
  worker?: { id: string; name: string };
  tool: string;
  status: LegacySessionStatus;
  creating?: LegacyWorktreeProgress;
  creationError?: string;
  initialPrompt?: string;
  runtime?: { active: true; memoryBytes?: number; bootDurationMs?: number };
  interrupted?: true;
  background?: true;
  model?: string;
  thinking?: string;
  pinned?: true;
  archived?: true;
  unread?: true;
  icon?: string;
  parentId?: string;
  subagent?: SubagentRecord;
  bot?: { id: string; handle: string; name: string };
  stage: LegacySessionStage;
  stageOrigin: LegacySessionStageOrigin;
  createdAt: string;
  updatedAt: string;
};

type LegacySessionGroup<S> = { label: string; cwd?: string; workspaceMode?: "branch" | "worktree"; baseRef?: string; sessions: S[] };
type LegacyLayout = (Omit<LegacySessionGroup<never>, "sessions"> & { ids: string[] })[];
type LegacySessionListUpdate = { revision: number; groups?: LegacyLayout; upserts: LegacySessionView[] };

type LegacyQuestionnaireOption = { label: string; description: string; preview?: string };
type LegacyQuestionnaireQuestion = { header: string; question: string; multiSelect: boolean; options: LegacyQuestionnaireOption[] };
type LegacyQuestionnaireAnswer = { header: string; question: string; selected: string[]; preview?: string };
type LegacyQuestionnaireResult = { cancelled: boolean; answers: LegacyQuestionnaireAnswer[]; timedOut?: true; timeoutMinutes?: number };

type LegacyTranscriptMetrics = {
  timestamp?: number;
  completedAt?: number;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
};

test("the session schemas preserve their existing server types", () => {
  expectTypeOf<LegacySessionStatus>().toMatchTypeOf<Api.SessionStatus>();
  expectTypeOf<Api.SessionStatus>().toMatchTypeOf<LegacySessionStatus>();
  expectTypeOf<LegacySessionStage>().toMatchTypeOf<Api.SessionStage>();
  expectTypeOf<Api.SessionStage>().toMatchTypeOf<LegacySessionStage>();
  expectTypeOf<LegacySessionStageSource>().toMatchTypeOf<Api.SessionStageSource>();
  expectTypeOf<Api.SessionStageSource>().toMatchTypeOf<LegacySessionStageSource>();
  expectTypeOf<LegacySessionStageOrigin>().toMatchTypeOf<Api.SessionStageOrigin>();
  expectTypeOf<Api.SessionStageOrigin>().toMatchTypeOf<LegacySessionStageOrigin>();
  expectTypeOf<LegacyWorktreeProgress>().toMatchTypeOf<Api.WorktreeProgress>();
  expectTypeOf<Api.WorktreeProgress>().toMatchTypeOf<LegacyWorktreeProgress>();
  expectTypeOf<SubagentRecord>().toMatchTypeOf<Api.SessionSubagent>();
  expectTypeOf<Api.SessionSubagent>().toMatchTypeOf<SubagentRecord>();
  expectTypeOf<LegacySessionView>().toMatchTypeOf<Api.SessionView>();
  expectTypeOf<Api.SessionView>().toMatchTypeOf<LegacySessionView>();
  expectTypeOf<LegacySessionGroup<LegacySessionView>>().toMatchTypeOf<Api.SessionGroup>();
  expectTypeOf<Api.SessionGroup>().toMatchTypeOf<LegacySessionGroup<LegacySessionView>>();
  expectTypeOf<LegacySessionListUpdate>().toMatchTypeOf<Api.SessionListUpdate>();
  expectTypeOf<Api.SessionListUpdate>().toMatchTypeOf<LegacySessionListUpdate>();
  expectTypeOf<LegacyQuestionnaireQuestion>().toMatchTypeOf<Api.QuestionnaireQuestion>();
  expectTypeOf<Api.QuestionnaireQuestion>().toMatchTypeOf<LegacyQuestionnaireQuestion>();
  expectTypeOf<LegacyQuestionnaireResult>().toMatchTypeOf<Api.QuestionnaireResult>();
  expectTypeOf<Api.QuestionnaireResult>().toMatchTypeOf<LegacyQuestionnaireResult>();
  expectTypeOf<LegacyTranscriptMetrics>().toMatchTypeOf<Api.TranscriptMetrics>();
  expectTypeOf<Api.TranscriptMetrics>().toMatchTypeOf<LegacyTranscriptMetrics>();
});
