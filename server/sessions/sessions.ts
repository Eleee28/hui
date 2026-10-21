/**
 * HUI's own session registry.
 *
 * Only HUI writes it, and the conversations themselves stay pi's business — a record here stores *which* pi
 * session to resume, never the messages.
 *
 *   ~/.config/hui/sessions.json
 */
import { constants } from "node:fs";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import { CONFIG_DIR } from "../paths.ts";
import type { SessionStage, SessionStageSource } from "../api/sessions.ts";
import { isSessionStage, isSessionStageSource } from "./session-stages.ts";

const REGISTRY_FILE = join(CONFIG_DIR, "sessions.json");

/** Bumped when the shape changes in a way older code could not read. */
const REGISTRY_VERSION = 2;

export type SessionRecord = {
  id: string;
  title: string;
  /** Flattened group label, e.g. `pr-signal-notifications - v1`. */
  group: string;
  /** The directory the session runs in. */
  cwd: string;
  /** Which runtime adapter drives it. HUI creates only `pi` sessions. */
  tool: string;
  /** pi's own session file, when there is one to resume. On a remote worker
   * both this and `cwd` are paths on that machine. */
  piSessionFile?: string;
  /** Remote worker (workers.json id) that runs the session; absent: local. */
  worker?: string;
  /** `provider/id` the session started on. Persisted so resuming keeps the
   * model the user chose instead of falling back to pi's default. */
  model?: string;
  /** Reasoning budget, same reasoning as `model`. */
  thinking?: string;
  /** Fast mode on, for the models that have one (`RuntimeModel.fast`). */
  fast?: boolean;
  /** Durable crash-recovery marker. Set before HUI hands a new prompt to the
   * runtime and cleared only when that run settles or the operator stops it. */
  runStartedAt?: string;
  /** Temporary recovery journal for runtimes that have not flushed their
   * transcript yet. Cleared with `runStartedAt`; never returned in views. */
  runPrompt?: string;
  /** Failed automatic restart admissions for the current interrupted run.
   * Cleared once a replacement backend turn starts or the run settles. */
  runRecoveryAttempts?: number;
  /** Pinned sessions sort to the top of their group. Persisted like the rest,
   * so a pin survives a gateway restart. */
  pinned?: boolean;
  /** OpenClaw-style organizer metadata. These fields affect only HUI's
   * presentation; PI's transcript and runtime remain untouched. */
  archived?: boolean;
  unread?: boolean;
  icon?: string;
  /** Session that spawned this one through HUI's agent tools. Kept optional so
   * existing version-2 registries remain valid without a migration. */
  parentId?: string;
  /** Durable task projection for a session-born subagent. PI still owns the
   * transcript; HUI only owns lineage and lifecycle presentation. */
  subagent?: SubagentRecord;
  /** The bot (bots.json id) whose forever chat this is. Optional like
   * `parentId`, so existing version-2 registries need no migration. The bot
   * registry decides: a record whose bot is gone is an ordinary session. */
  bot?: string;
  /** Jira work items created for this session from HUI, oldest first. Only
   * the reference is stored; Jira facts are fetched and cached in memory. */
  jiraIssues?: { key: string; url: string }[];
  /** Kanban development stage and who placed it. Absent (or a legacy stored
   * `backlog`, which is dropped on read) means Investigation. An operator
   * placement wins over agent and pull-request updates. */
  stage?: SessionStage;
  stageSource?: SessionStageSource;
  /** Lower-case PR URLs already known at the last explicit placement; they no
   * longer advance the stage. Server-only, never returned in views. */
  stagePullRequests?: string[];
  createdAt: string;
  updatedAt: string;
  /** Where the record came from, so an import can be reported honestly. */
  source?: "hui";
};

export type SubagentStatus =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "interrupted";

export type SubagentRecord = {
  taskId: string;
  task: string;
  label?: string;
  status: SubagentStatus;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  summary?: string;
  error?: string;
  /** Absent on legacy tasks; pending until observed in the parent transcript. */
  completionDelivery?: "pending" | "delivered";
  /** Spawned with `collect: true`: the parent collects the result with `agents_wait`. A collected child waiting for
   * a free slot is saved as `starting`; its queue is in memory, so a restart interrupts it like any active task. */
  collect?: true;
};

export class SessionRegistryError extends Error {
  override name = "SessionRegistryError";
}

export class SessionNotFoundError extends Error {
  override name = "SessionNotFoundError";
}

export type SessionGroupConfig = {
  label: string;
  /** Defaults for sessions created from this group. HUI owns these values;
   * PI only sees them when the user starts a session. */
  cwd?: string;
  workspaceMode?: "branch" | "worktree";
  baseRef?: string;
};

type Registry = {
  version: number;
  sessions: SessionRecord[];
  groups: SessionGroupConfig[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

const SUBAGENT_STATUSES = new Set<SubagentStatus>([
  "starting",
  "running",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
]);

function toSubagent(raw: unknown): SubagentRecord | undefined {
  if (!isRecord(raw)) return undefined;
  const taskId = str(raw["taskId"]).trim();
  const task = str(raw["task"]).trim();
  const status = str(raw["status"]) as SubagentStatus;
  const startedAt = str(raw["startedAt"]);
  const updatedAt = str(raw["updatedAt"]);
  if (!taskId || !task || !SUBAGENT_STATUSES.has(status) || !startedAt || !updatedAt) {
    return undefined;
  }
  const label = str(raw["label"]).trim();
  const endedAt = str(raw["endedAt"]);
  const summary = str(raw["summary"]);
  const error = str(raw["error"]);
  return {
    taskId,
    task,
    status,
    startedAt,
    updatedAt,
    ...(label ? { label } : {}),
    ...(endedAt ? { endedAt } : {}),
    ...(summary ? { summary } : {}),
    ...(error ? { error } : {}),
    ...(raw["completionDelivery"] === "pending" || raw["completionDelivery"] === "delivered"
      ? { completionDelivery: raw["completionDelivery"] } : {}),
    ...(raw["collect"] === true ? { collect: true as const } : {}),
  };
}

/** Every field is checked, because the file is hand-editable and predates any
 * schema we might add. */
function toRecord(raw: unknown): SessionRecord | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const id = str(raw["id"]).trim();
  const cwd = str(raw["cwd"]).trim();
  if (!id || !cwd) {
    return undefined;
  }
  const piSessionFile = str(raw["piSessionFile"]).trim();
  const worker = str(raw["worker"]).trim();
  const model = str(raw["model"]).trim();
  const thinking = str(raw["thinking"]).trim();
  const runStartedAt = str(raw["runStartedAt"]).trim();
  const runPrompt = str(raw["runPrompt"]);
  const runRecoveryAttempts = typeof raw["runRecoveryAttempts"] === "number"
    && Number.isInteger(raw["runRecoveryAttempts"])
    && raw["runRecoveryAttempts"] >= 0
      ? raw["runRecoveryAttempts"]
      : undefined;
  const parentId = str(raw["parentId"]).trim();
  const bot = str(raw["bot"]).trim();
  const subagent = raw["subagent"] === undefined ? undefined : toSubagent(raw["subagent"]);
  if (raw["subagent"] !== undefined && !subagent) return undefined;
  const jiraIssues = Array.isArray(raw["jiraIssues"])
    ? raw["jiraIssues"].flatMap((item) => {
      if (!isRecord(item)) return [];
      const key = str(item["key"]).trim();
      const url = str(item["url"]).trim();
      return /^[A-Z][A-Z0-9_]{0,19}-[1-9]\d{0,8}$/u.test(key) && /^https?:\/\/[^/\s]+\/browse\//u.test(url) ? [{ key, url }] : [];
    }).slice(-20)
    : [];
  const source = str(raw["source"]);
  const icon = str(raw["icon"]).trim();
  const stage = isSessionStage(raw["stage"]) ? raw["stage"] : undefined;
  const stageSource = stage && isSessionStageSource(raw["stageSource"]) ? raw["stageSource"] : undefined;
  const stagePullRequests = Array.isArray(raw["stagePullRequests"])
    ? raw["stagePullRequests"].filter((url): url is string => typeof url === "string" && /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/u.test(url)).slice(-20)
    : [];
  return {
    id,
    title: str(raw["title"]).trim() || id,
    group: str(raw["group"]).trim(),
    cwd,
    tool: str(raw["tool"]).trim() || "pi",
    ...(piSessionFile ? { piSessionFile } : {}),
    ...(worker ? { worker } : {}),
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    ...(raw["fast"] === true ? { fast: true } : {}),
    ...(runStartedAt ? { runStartedAt } : {}),
    ...(runPrompt ? { runPrompt } : {}),
    ...(runRecoveryAttempts !== undefined ? { runRecoveryAttempts } : {}),
    ...(raw["pinned"] === true ? { pinned: true } : {}),
    ...(raw["archived"] === true ? { archived: true } : {}),
    ...(raw["unread"] === true ? { unread: true } : {}),
    ...(icon ? { icon } : {}),
    ...(parentId ? { parentId } : {}),
    ...(subagent ? { subagent } : {}),
    ...(bot ? { bot } : {}),
    ...(jiraIssues.length ? { jiraIssues } : {}),
    ...(stage ? { stage, stageSource: stageSource ?? "agent" } : {}),
    ...(stagePullRequests.length ? { stagePullRequests } : {}),
    createdAt: str(raw["createdAt"]),
    updatedAt: str(raw["updatedAt"]),
    ...(source === "hui" ? { source } : {}),
  };
}

function toGroupConfig(raw: unknown): SessionGroupConfig | undefined {
  if (!isRecord(raw)) return undefined;
  const label = str(raw["label"]).trim();
  if (!label || label === "ungrouped") return undefined;
  const cwd = str(raw["cwd"]).trim();
  const workspaceMode = raw["workspaceMode"];
  const baseRef = str(raw["baseRef"]).trim();
  if (workspaceMode !== undefined && workspaceMode !== "branch" && workspaceMode !== "worktree") return undefined;
  return { label, ...(cwd ? { cwd } : {}),
    ...(workspaceMode ? { workspaceMode } : {}), ...(baseRef ? { baseRef } : {}) };
}

function normalizeGroups(
  groups: readonly SessionGroupConfig[],
  sessions: readonly SessionRecord[],
): SessionGroupConfig[] {
  const byLabel = new Map<string, SessionGroupConfig>();
  for (const group of groups) {
    if (!byLabel.has(group.label)) byLabel.set(group.label, group);
  }
  for (const label of sessions.map((session) => session.group).filter(Boolean).toSorted()) {
    if (!byLabel.has(label)) byLabel.set(label, { label });
  }
  return [...byLabel.values()];
}

async function readRegistryState(): Promise<Registry> {
  let source: string;
  try {
    source = await readFile(REGISTRY_FILE, "utf8");
  } catch (error) {
    if (isRecord(error) && error["code"] === "ENOENT") {
      return { version: REGISTRY_VERSION, sessions: [], groups: [] };
    }
    throw new SessionRegistryError("HUI's session registry could not be read.", { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new SessionRegistryError("HUI's session registry is not valid JSON.", { cause: error });
  }
  if (!isRecord(parsed) || !Array.isArray(parsed["sessions"])) {
    throw new SessionRegistryError("HUI's session registry has an invalid shape.");
  }
  const records = parsed["sessions"].map(toRecord);
  if (records.some((record) => record === undefined)) {
    throw new SessionRegistryError("HUI's session registry contains an invalid session record.");
  }
  const rawGroups = Array.isArray(parsed["groups"]) ? parsed["groups"].map(toGroupConfig) : [];
  if (rawGroups.some((group) => group === undefined)) {
    throw new SessionRegistryError("HUI's session registry contains an invalid group record.");
  }
  const sessions = records as SessionRecord[];
  return {
    version: REGISTRY_VERSION,
    sessions,
    groups: normalizeGroups(rawGroups as SessionGroupConfig[], sessions),
  };
}

export async function readRegistry(): Promise<SessionRecord[]> {
  return (await readRegistryState()).sessions;
}

export async function readSessionGroups(): Promise<SessionGroupConfig[]> {
  return (await readRegistryState()).groups;
}

export async function readSessionRegistry(): Promise<{
  sessions: SessionRecord[];
  groups: SessionGroupConfig[];
}> {
  const registry = await readRegistryState();
  return { sessions: registry.sessions, groups: registry.groups };
}

/**
 * Writes through a temporary file and renames, so a crash mid-write cannot leave
 * a truncated registry behind.
 */
async function writeRegistryState(registry: Registry): Promise<void> {
  try {
    await mkdir(dirname(REGISTRY_FILE), { recursive: true });
    // A unique temporary name: two writers (a boot racing a rename, or two HUI
    // instances) must not clobber each other and fail the rename.
    const temporary = `${REGISTRY_FILE}.${process.pid}-${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
    await rename(temporary, REGISTRY_FILE);
  } catch (error) {
    throw new SessionRegistryError("HUI's session registry could not be written.", {
      cause: error,
    });
  }
}

/** Copies the registry into `backups/` in HUI's directory, named by time, before a migration changes it. */
export async function backupRegistry(): Promise<string> {
  const directory = join(CONFIG_DIR, "backups");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const backup = join(directory, `sessions-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
  await copyFile(REGISTRY_FILE, backup, constants.COPYFILE_EXCL);
  return backup;
}

export async function writeRegistry(sessions: readonly SessionRecord[]): Promise<void> {
  await writeRegistryState({
    version: REGISTRY_VERSION,
    sessions: [...sessions],
    groups: normalizeGroups([], sessions),
  });
}

/**
 * Serialises every in-process read/modify/write of the registry.
 *
 * A unique temporary filename prevents two writes from clobbering the same
 * temp file, but it does not prevent a slower writer from replacing a newer
 * snapshot. Session boot, rename and prompt activity can all write at once, so
 * callers that mutate existing state must use this function rather than pair
 * `readRegistry` and `writeRegistry` themselves.
 */
let registryMutation = Promise.resolve();

export function updateRegistry(
  mutate: (sessions: readonly SessionRecord[]) => readonly SessionRecord[],
): Promise<SessionRecord[]> {
  const operation = registryMutation.then(async () => {
    const current = await readRegistryState();
    const next = [...mutate(current.sessions)];
    await writeRegistryState({
      version: REGISTRY_VERSION,
      sessions: next,
      groups: normalizeGroups(current.groups, next),
    });
    return next;
  });
  // A failed mutation must not poison the queue for all later requests.
  registryMutation = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

function updateRegistryState(
  mutate: (registry: Readonly<Registry>) => Registry,
): Promise<Registry> {
  const operation = registryMutation.then(async () => {
    const current = await readRegistryState();
    const next = mutate(current);
    const normalized = {
      version: REGISTRY_VERSION,
      sessions: [...next.sessions],
      groups: normalizeGroups(next.groups, next.sessions),
    };
    await writeRegistryState(normalized);
    return normalized;
  });
  registryMutation = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

export async function createSessionGroup(label: string): Promise<SessionGroupConfig> {
  let created: SessionGroupConfig | undefined;
  await updateRegistryState((registry) => {
    if (registry.groups.some((group) => group.label === label)) {
      throw new Error(`A group named "${label}" already exists.`);
    }
    created = { label };
    return { ...registry, groups: [...registry.groups, created] };
  });
  if (!created) throw new Error("The group was not created.");
  return created;
}

export async function updateSessionGroup(
  label: string,
  patch: { label?: string; cwd?: string; workspaceMode?: "branch" | "worktree" | ""; baseRef?: string },
): Promise<SessionGroupConfig> {
  let updated: SessionGroupConfig | undefined;
  await updateRegistryState((registry) => {
    const current = registry.groups.find((group) => group.label === label);
    if (!current) throw new Error(`Unknown group: ${label}`);
    const nextLabel = patch.label ?? label;
    if (
      nextLabel !== label &&
      registry.groups.some((group) => group.label === nextLabel)
    ) {
      throw new Error(`A group named "${nextLabel}" already exists.`);
    }
    updated = {
      ...current,
      label: nextLabel,
      ...(patch.workspaceMode !== undefined ? { workspaceMode: patch.workspaceMode || undefined } : {}),
      ...(patch.baseRef !== undefined ? { baseRef: patch.baseRef || undefined } : {}),
      ...(patch.cwd !== undefined ? (patch.cwd ? { cwd: patch.cwd } : { cwd: undefined }) : {}),
    };
    return {
      ...registry,
      groups: registry.groups.map((group) => (group.label === label ? updated! : group)),
      sessions: registry.sessions.map((session) =>
        session.group === label ? { ...session, group: nextLabel } : session,
      ),
    };
  });
  if (!updated) throw new Error(`Unknown group: ${label}`);
  return updated;
}

export async function deleteSessionGroup(label: string): Promise<void> {
  await updateRegistryState((registry) => {
    if (!registry.groups.some((group) => group.label === label)) {
      throw new Error(`Unknown group: ${label}`);
    }
    return {
      ...registry,
      groups: registry.groups.filter((group) => group.label !== label),
      sessions: registry.sessions.map((session) =>
        session.group === label ? { ...session, group: "" } : session,
      ),
    };
  });
}

/**
 * Replaces the catalog order, which is also the sidebar order. The request must
 * name every current group exactly once, so a stale browser cannot drop or
 * resurrect a group that another tab created, renamed or deleted meanwhile.
 */
export async function reorderSessionGroups(labels: readonly string[]): Promise<void> {
  await updateRegistryState((registry) => {
    const current = registry.groups.map((group) => group.label);
    const unique = new Set(labels);
    if (
      unique.size !== labels.length ||
      labels.length !== current.length ||
      current.some((label) => !unique.has(label))
    ) {
      throw new Error("The group list changed. Refresh and try again.");
    }
    const byLabel = new Map(registry.groups.map((group) => [group.label, group]));
    return { ...registry, groups: labels.map((label) => byLabel.get(label)!) };
  });
}

/** Adds or replaces by id, keeping the registry sorted for stable rendering. */
export function upsert(
  sessions: readonly SessionRecord[],
  incoming: readonly SessionRecord[],
): SessionRecord[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  for (const record of incoming) {
    const existing = byId.get(record.id);
    byId.set(record.id, existing ? { ...existing, ...record } : record);
  }
  return [...byId.values()];
}

export function remove(sessions: readonly SessionRecord[], id: string): SessionRecord[] {
  return sessions.filter((session) => session.id !== id);
}

export type SessionGroup = SessionGroupConfig & { sessions: SessionRecord[] };

/** Groups in catalog order with `ungrouped` last; sessions pinned first, then
 * most-recently-updated first inside each. */
export function groupSessions(
  sessions: readonly SessionRecord[],
  configuredGroups: readonly SessionGroupConfig[] = [],
): SessionGroup[] {
  const byGroup = new Map<string, SessionRecord[]>();
  for (const group of configuredGroups) byGroup.set(group.label, []);
  for (const session of sessions) {
    const label = session.group || "ungrouped";
    const list = byGroup.get(label);
    if (list) {
      list.push(session);
    } else {
      byGroup.set(label, [session]);
    }
  }
  return [...byGroup.entries()]
    .map(([label, list]) => ({
      ...(configuredGroups.find((group) => group.label === label) ?? { label }),
      label,
      sessions: list.toSorted((a, b) => {
        // Pinned first, then most recently updated. Pinning is the user saying
        // "this one matters"; recency should not override that.
        if (Boolean(a.pinned) !== Boolean(b.pinned)) {
          return a.pinned ? -1 : 1;
        }
        return b.updatedAt.localeCompare(a.updatedAt);
      }),
    }))
    // A stable sort keeps the user's catalog order and only moves `ungrouped`.
    .toSorted((a, b) => Number(a.label === "ungrouped") - Number(b.label === "ungrouped"));
}
