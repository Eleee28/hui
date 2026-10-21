/** Public session payloads: the `SessionView` wire shape, groups, stages, list updates, questionnaires and metrics. */
import { Type, type Static } from "typebox";
import { SessionPullRequest } from "./github.ts";

export const JiraStatusCategory = Type.Union([
  Type.Literal("new"), Type.Literal("indeterminate"), Type.Literal("done"),
], { $id: "JiraStatusCategory" });
export type JiraStatusCategory = Static<typeof JiraStatusCategory>;

export const SessionJiraIssue = Type.Object({
  key: Type.String(), url: Type.String(), summary: Type.Optional(Type.String()), status: Type.Optional(Type.String()),
  statusCategory: Type.Optional(JiraStatusCategory), issueType: Type.Optional(Type.String()), description: Type.Optional(Type.String()),
}, { $id: "SessionJiraIssue" });
export type SessionJiraIssue = Static<typeof SessionJiraIssue>;

export const SessionStage = Type.Union([
  Type.Literal("investigation"), Type.Literal("implementation"), Type.Literal("testing"), Type.Literal("done"),
], { $id: "SessionStage" });
export type SessionStage = Static<typeof SessionStage>;

export const SessionStageSource = Type.Union([
  Type.Literal("operator"), Type.Literal("agent"), Type.Literal("pullRequest"),
], { $id: "SessionStageSource" });
export type SessionStageSource = Static<typeof SessionStageSource>;

export const SessionStageOrigin = Type.Union([SessionStageSource, Type.Literal("default")], { $id: "SessionStageOrigin" });
export type SessionStageOrigin = Static<typeof SessionStageOrigin>;

export const SessionStatus = Type.Union([
  Type.Literal("idle"), Type.Literal("running"), Type.Literal("waiting"), Type.Literal("starting"), Type.Literal("error"),
  Type.Literal("reconnecting"), Type.Literal("disconnected"),
], { $id: "SessionStatus" });
export type SessionStatus = Static<typeof SessionStatus>;

export const WorktreeProgress = Type.Object({
  phase: Type.Union([
    Type.Literal("naming"), Type.Literal("preparing"), Type.Literal("checkout"), Type.Literal("filtering"), Type.Literal("finalizing"),
  ]),
  percent: Type.Optional(Type.Number()), completed: Type.Optional(Type.Number()), total: Type.Optional(Type.Number()),
}, { $id: "WorktreeProgress" });
export type WorktreeProgress = Static<typeof WorktreeProgress>;

export const ThinkingLevel = Type.Union([
  Type.Literal("off"), Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"),
  Type.Literal("xhigh"), Type.Literal("max"), Type.Literal("ultra"),
], { $id: "ThinkingLevel" });
export type ThinkingLevel = Static<typeof ThinkingLevel>;

export const ProgressStep = Type.Object({
  step: Type.String(), status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]),
}, { $id: "ProgressStep" });
export type ProgressStep = Static<typeof ProgressStep>;

export const ProgressCard = Type.Object({ markdown: Type.String(), steps: Type.Array(ProgressStep) }, { $id: "ProgressCard" });
export type ProgressCard = Static<typeof ProgressCard>;

export const SubagentStatus = Type.Union([
  Type.Literal("starting"), Type.Literal("running"), Type.Literal("completed"), Type.Literal("failed"), Type.Literal("cancelled"),
  Type.Literal("timed_out"), Type.Literal("interrupted"),
], { $id: "SubagentStatus" });
export type SubagentStatus = Static<typeof SubagentStatus>;

export const SessionSubagent = Type.Object({
  taskId: Type.String(), task: Type.String(), label: Type.Optional(Type.String()), status: SubagentStatus,
  startedAt: Type.String(), updatedAt: Type.String(), endedAt: Type.Optional(Type.String()),
  summary: Type.Optional(Type.String()), error: Type.Optional(Type.String()),
  completionDelivery: Type.Optional(Type.Union([Type.Literal("pending"), Type.Literal("delivered")])),
  collect: Type.Optional(Type.Literal(true)),
}, { $id: "SessionSubagent" });
export type SessionSubagent = Static<typeof SessionSubagent>;

export const SessionView = Type.Object({
  progress: Type.Optional(ProgressCard),
  pullRequests: Type.Optional(Type.Array(SessionPullRequest)),
  jiraIssues: Type.Optional(Type.Array(SessionJiraIssue)),
  id: Type.String(),
  title: Type.String(),
  group: Type.String(),
  cwd: Type.String(),
  displayCwd: Type.String(),
  worker: Type.Optional(Type.Object({ id: Type.String(), name: Type.String() })),
  tool: Type.String(),
  status: SessionStatus,
  creating: Type.Optional(WorktreeProgress),
  creationError: Type.Optional(Type.String()),
  initialPrompt: Type.Optional(Type.String()),
  runtime: Type.Optional(Type.Object({
    active: Type.Literal(true), memoryBytes: Type.Optional(Type.Number()), bootDurationMs: Type.Optional(Type.Number()),
  })),
  interrupted: Type.Optional(Type.Literal(true)),
  background: Type.Optional(Type.Literal(true)),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.String()),
  pinned: Type.Optional(Type.Literal(true)),
  archived: Type.Optional(Type.Literal(true)),
  unread: Type.Optional(Type.Literal(true)),
  icon: Type.Optional(Type.String()),
  parentId: Type.Optional(Type.String()),
  subagent: Type.Optional(SessionSubagent),
  bot: Type.Optional(Type.Object({ id: Type.String(), handle: Type.String(), name: Type.String() })),
  stage: SessionStage,
  stageOrigin: SessionStageOrigin,
  createdAt: Type.String(),
  updatedAt: Type.String(),
}, { $id: "SessionView" });
export type SessionView = Static<typeof SessionView>;

const groupDefaults = {
  label: Type.String(),
  cwd: Type.Optional(Type.String()),
  workspaceMode: Type.Optional(Type.Union([Type.Literal("branch"), Type.Literal("worktree")])),
  baseRef: Type.Optional(Type.String()),
};

export const SessionGroup = Type.Object({ ...groupDefaults, sessions: Type.Array(SessionView) }, { $id: "SessionGroup" });
export type SessionGroup = Static<typeof SessionGroup>;

export const SessionListLayoutGroup = Type.Object({ ...groupDefaults, ids: Type.Array(Type.String()) }, { $id: "SessionListLayoutGroup" });
export type SessionListLayoutGroup = Static<typeof SessionListLayoutGroup>;

export const SessionListUpdate = Type.Object({
  revision: Type.Number(), groups: Type.Optional(Type.Array(SessionListLayoutGroup)), upserts: Type.Array(SessionView),
}, { $id: "SessionListUpdate" });
export type SessionListUpdate = Static<typeof SessionListUpdate>;

export const SessionList = Type.Object({ revision: Type.Number(), groups: Type.Array(SessionGroup) }, { $id: "SessionList" });
export type SessionList = Static<typeof SessionList>;

export const QuestionnaireOption = Type.Object({
  label: Type.String(), description: Type.String(), preview: Type.Optional(Type.String()),
}, { $id: "QuestionnaireOption" });
export type QuestionnaireOption = Static<typeof QuestionnaireOption>;

export const QuestionnaireQuestion = Type.Object({
  header: Type.String(), question: Type.String(), multiSelect: Type.Boolean(), options: Type.Array(QuestionnaireOption),
}, { $id: "QuestionnaireQuestion" });
export type QuestionnaireQuestion = Static<typeof QuestionnaireQuestion>;

export const QuestionnaireAnswer = Type.Object({
  header: Type.String(), question: Type.String(), selected: Type.Array(Type.String()), preview: Type.Optional(Type.String()),
}, { $id: "QuestionnaireAnswer" });
export type QuestionnaireAnswer = Static<typeof QuestionnaireAnswer>;

export const QuestionnaireResult = Type.Object({
  cancelled: Type.Boolean(), answers: Type.Array(QuestionnaireAnswer),
  timedOut: Type.Optional(Type.Literal(true)), timeoutMinutes: Type.Optional(Type.Number()),
}, { $id: "QuestionnaireResult" });
export type QuestionnaireResult = Static<typeof QuestionnaireResult>;

export const TranscriptMetrics = Type.Object({
  timestamp: Type.Optional(Type.Number()), completedAt: Type.Optional(Type.Number()), durationMs: Type.Optional(Type.Number()),
  inputTokens: Type.Optional(Type.Number()), outputTokens: Type.Optional(Type.Number()),
  cacheReadTokens: Type.Optional(Type.Number()), cacheWriteTokens: Type.Optional(Type.Number()), costUsd: Type.Optional(Type.Number()),
}, { $id: "TranscriptMetrics" });
export type TranscriptMetrics = Static<typeof TranscriptMetrics>;

export const SessionError = Type.Object({ error: Type.String() }, { $id: "SessionError" });
export type SessionError = Static<typeof SessionError>;

export const SessionOk = Type.Object({ ok: Type.Literal(true) }, { $id: "SessionOk" });
export type SessionOk = Static<typeof SessionOk>;

export const SessionSearchResult = Type.Object({
  hits: Type.Array(Type.Object({ id: Type.String(), snippet: Type.String(), matches: Type.Number() })),
  unsearched: Type.Array(Type.Object({ worker: Type.String(), error: Type.String() })),
}, { $id: "SessionSearchResult" });
export type SessionSearchResult = Static<typeof SessionSearchResult>;

export const SessionResponse = Type.Object({ session: SessionView }, { $id: "SessionResponse" });
export type SessionResponse = Static<typeof SessionResponse>;

export const SessionPromptResponse = Type.Object({
  ok: Type.Literal(true), duplicate: Type.Optional(Type.Literal(true)),
}, { $id: "SessionPromptResponse" });
export type SessionPromptResponse = Static<typeof SessionPromptResponse>;

export const SessionFastResponse = Type.Object({ fast: Type.Boolean() }, { $id: "SessionFastResponse" });
export type SessionFastResponse = Static<typeof SessionFastResponse>;

export const SessionConnectResponse = Type.Object({ url: Type.String() }, { $id: "SessionConnectResponse" });
export type SessionConnectResponse = Static<typeof SessionConnectResponse>;

export const SessionQueueRequest = Type.Union([
  Type.Object({ operation: Type.Literal("edit"), itemId: Type.String(), text: Type.String() }),
  Type.Object({ operation: Type.Literal("remove"), itemId: Type.String() }),
  Type.Object({ operation: Type.Literal("move"), itemId: Type.String(), toIndex: Type.Number() }),
  Type.Object({ operation: Type.Literal("steer"), itemId: Type.String() }),
], { $id: "SessionQueueRequest" });
export type SessionQueueRequest = Static<typeof SessionQueueRequest>;

export const SessionStatusUpdate = Type.Object({
  id: Type.String(), status: SessionStatus, unread: Type.Optional(Type.Boolean()), creating: Type.Optional(WorktreeProgress),
  creationError: Type.Optional(Type.String()), title: Type.Optional(Type.String()),
}, { $id: "SessionStatusUpdate" });
export type SessionStatusUpdate = Static<typeof SessionStatusUpdate>;

export const SessionStatusStreamFrame = Type.Union([
  Type.Object({ event: Type.Literal("snapshot"), data: Type.Object({ statuses: Type.Array(SessionStatusUpdate) }) }),
  Type.Object({ event: Type.Literal("status"), data: SessionStatusUpdate }),
  Type.Object({ event: Type.Literal("sessions"), data: SessionListUpdate }),
], { $id: "SessionStatusStreamFrame" });
export type SessionStatusStreamFrame = Static<typeof SessionStatusStreamFrame>;

export const sessionRouteSchemas = [
  { method: "GET", path: "/__hui/sessions/events", response: SessionStatusStreamFrame, events: SessionStatusStreamFrame },
  { method: "GET", path: "/__hui/sessions", response: SessionList },
  { method: "GET", path: "/__hui/sessions/search", response: SessionSearchResult },
  { method: "POST", path: "/__hui/sessions", response: SessionResponse },
  { method: "PATCH", path: "/__hui/sessions/:id", response: SessionResponse },
  { method: "DELETE", path: "/__hui/sessions/:id", response: SessionOk },
  { method: "POST", path: "/__hui/session-groups", response: SessionList },
  { method: "PUT", path: "/__hui/session-groups", response: SessionList },
  { method: "PATCH", path: "/__hui/session-groups/:name", response: SessionList },
  { method: "DELETE", path: "/__hui/session-groups/:name", response: SessionList },
];

export const sessionActionRouteSchemas = [
  ...["prompt", "steer", "follow-up"].map((action) => ({ method: "POST", path: `/__hui/sessions/:id/${action}`, response: SessionPromptResponse })),
  ...["continue", "compact", "reload", "abort", "rewind", "resume", "question"].map((action) => ({ method: "POST", path: `/__hui/sessions/:id/${action}`, response: SessionOk })),
  { method: "DELETE", path: "/__hui/sessions/:id/compact", response: SessionOk },
  { method: "POST", path: "/__hui/sessions/:id/fork", response: SessionResponse },
  { method: "POST", path: "/__hui/sessions/:id/fast", response: SessionFastResponse },
  { method: "POST", path: "/__hui/sessions/:id/queue", request: SessionQueueRequest, response: SessionOk },
];

export const routeSchemas = [...sessionRouteSchemas, ...sessionActionRouteSchemas];
