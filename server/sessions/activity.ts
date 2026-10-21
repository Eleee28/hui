/**
 * When each HUI session was worked on: the message times of its Durable
 * conversation, split into blocks wherever 30 minutes pass without a message.
 * The Calendar tab of the Contributions page lays these blocks out by week.
 *
 * Only Durable conversations are read; sessions still on PI's worker appear
 * once `hui doctor --fix` moves them. Subagent sessions are left out: their
 * work is the parent session's work.
 */
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { AssistantEntry, ToolResultEntry, UserEntry } from "@earendil-works/pi-durable";
import type { ActivityBlock, ActivitySession, SessionActivity } from "../api/github.ts";
import { durableContext, durableHost, type DurableHost } from "../runtimes/durable-host.ts";
import { textOf } from "../runtimes/durable.ts";
import { WORKTREES_DIR } from "../paths.ts";
import { operatorText } from "./digest.ts";
import type { SessionRecord } from "./sessions.ts";
import { runCommand } from "../git/worktree-inventory.ts";

const ACTIVITY_GAP_MS = 30 * 60_000;
const MAX_RANGE_MS = 31 * 86_400_000;
const FIRST_MESSAGE_MAX = 400;
/** Most sessions stop after their newest entry, so the first page is small. */
const FIRST_PAGE = 20;
const PAGE = 200;

/** A model message as Durable stores it; only the fields activity reads. */
type StoredMessage = { timestamp?: unknown; content?: unknown; provider?: unknown; model?: unknown };
type StoredEntry = { kind: string; model?: readonly StoredMessage[] };

/** One conversation's entries, newest first. */
export type ConversationScan = (conversationId: number) => AsyncIterable<StoredEntry>;

type Point = { time: number; user?: string; model?: string };

/** `from`/`to` query parameters: epoch milliseconds at most 31 days apart. */
export function activityRange(params: URLSearchParams): { from: number; to: number } | undefined {
  const [from, to] = [params.get("from"), params.get("to")].map((value) => /^\d{1,15}$/u.test(value ?? "") ? Number(value) : NaN) as [number, number];
  return to > from && to - from <= MAX_RANGE_MS ? { from, to } : undefined;
}

/** Work is a user, assistant or tool-result entry; compaction summaries, resets and system entries are not. */
function point({ kind }: StoredEntry, message: StoredMessage): Point | undefined {
  const time = message.timestamp;
  if (typeof time !== "number" || !Number.isFinite(time)) return undefined;
  if (kind === UserEntry.kind) {
    const said = operatorText(textOf(message as never));
    return said ? { time, user: said } : { time };
  }
  if (kind === AssistantEntry.kind) {
    return typeof message.model === "string"
      ? { time, model: typeof message.provider === "string" ? `${message.provider}/${message.model}` : message.model }
      : { time };
  }
  return kind === ToolResultEntry.kind ? { time } : undefined;
}

/** Blocks of points no more than the gap apart, oldest first. */
function activityBlocks(points: readonly Point[]): ActivityBlock[] {
  const blocks: ActivityBlock[] = [];
  let block: ActivityBlock | undefined;
  for (const { time, user, model } of [...points].sort((a, b) => a.time - b.time)) {
    if (!block || time - block.end > ACTIVITY_GAP_MS) blocks.push(block = { start: time, end: time });
    block.end = time;
    if (model) block.model = model;
    if (user && block.firstMessage === undefined) {
      block.firstMessage = user.length > FIRST_MESSAGE_MAX ? `${user.slice(0, FIRST_MESSAGE_MAX - 1).trimEnd()}…` : user;
    }
  }
  return blocks;
}

/**
 * Points back to the first silence over the gap before `from`, so a block
 * that began earlier keeps its real start and first message. Newer entries
 * are read first, so the scan stops there instead of reading all history.
 */
async function sessionPoints(scan: AsyncIterable<StoredEntry>, from: number): Promise<Point[]> {
  const points: Point[] = [];
  let oldest = Infinity;
  for await (const stored of scan) {
    const entry = (stored.model ?? []).map((message) => point(stored, message)).filter((value) => value !== undefined);
    if (entry.length === 0) continue;
    const newest = Math.max(...entry.map(({ time }) => time));
    if (newest < from && oldest - newest > ACTIVITY_GAP_MS) break;
    points.push(...entry);
    oldest = Math.min(oldest, ...entry.map(({ time }) => time));
  }
  return points;
}

export function durableScan(host: DurableHost = durableHost()): ConversationScan {
  return async function* (conversationId) {
    const harness = await host.open();
    const conversation = await harness.conversation(conversationId as never, durableContext);
    if (!conversation) return;
    let cursor;
    do {
      const page = await conversation.entries({}, cursor ? PAGE : FIRST_PAGE, cursor, durableContext);
      yield* page.items as readonly StoredEntry[];
      cursor = page.next;
      // The store is synchronous SQLite; let the gateway serve other requests between pages.
      await new Promise<void>((resolve) => setImmediate(resolve));
    } while (cursor);
  };
}

const projects = new Map<string, Promise<string>>();

/**
 * The repository a session directory belongs to: Git's common directory, so
 * every worktree and subdirectory of a repository shares it. A removed HUI
 * worktree is named by its parent, `<checkout>-<hash>` (createSessionWorktree):
 * Git still answers for another worktree made from that checkout or, when it
 * was a worktree itself, for that checkout; otherwise the checkout's name.
 * The home directory is always `~`; any other directory outside Git is its own name.
 */
export function repositoryName(cwd: string, worktrees = WORKTREES_DIR, home = homedir()): Promise<string> {
  const key = `${worktrees}\0${home}\0${cwd}`;
  let name = projects.get(key);
  if (!name) projects.set(key, name = resolveRepository(cwd, worktrees, home));
  return name;
}

/** The repository Git reports for a directory, if it can. */
async function gitRepository(cwd: string): Promise<string | undefined> {
  const { code, stdout } = await runCommand("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const common = code === 0 ? stdout.trim() : "";
  if (!common) return undefined;
  return basename(common) === ".git" ? basename(dirname(common)) : basename(common).replace(/\.git$/u, "");
}

async function resolveRepository(cwd: string, worktrees: string, home: string): Promise<string> {
  if (cwd === home) return "~";
  const own = await gitRepository(cwd);
  if (own) return own;
  const [key, branch] = relative(worktrees, cwd).split(sep);
  if (!key || key === ".." || !branch) return basename(cwd);
  const checkout = key.replace(/-[0-9a-f]{12}$/u, "");
  const siblings = (await readdir(join(worktrees, key)).catch(() => [])).map((name) => join(worktrees, key, name));
  const sources = (await readdir(worktrees).catch(() => [])).map((parent) => join(worktrees, parent, checkout));
  for (const candidate of [...siblings, ...sources]) {
    const name = candidate === cwd ? undefined : await gitRepository(candidate);
    if (name) return name;
  }
  return checkout;
}

/** Blocks of every top-level Durable session that overlap `[from, to)`. */
export async function readSessionActivity(
  sessions: readonly SessionRecord[], from: number, to: number,
  { scan = durableScan(), project = repositoryName }: { scan?: ConversationScan; project?: (cwd: string) => Promise<string> } = {},
): Promise<SessionActivity> {
  const result: ActivitySession[] = [];
  for (const session of sessions) {
    const conversation = /^durable:(\d+)$/u.exec(session.piSessionFile ?? "")?.[1];
    if (!conversation || session.parentId || Date.parse(session.createdAt) >= to) continue;
    const blocks = activityBlocks(await sessionPoints(scan(Number(conversation)), from))
      .filter((block) => block.end >= from && block.start < to);
    if (blocks.length === 0) continue;
    result.push({
      id: session.id, title: session.title, group: session.group, project: await project(session.cwd),
      ...(session.archived ? { archived: true } : {}), blocks,
    });
  }
  return { sessions: result };
}
