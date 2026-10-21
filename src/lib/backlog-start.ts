/**
 * Step logic of the Kanban "Start session" dialog, kept pure so the rules the
 * form grows by are testable without Lit.
 *
 * 1. `folder`: only the folder picker; nothing is known about the folder yet.
 * 2. `plain`: the folder is not a Git checkout; the form ends there.
 * 3. `branch`: a Git checkout defaults to Branch with a shared ref picker.
 *    `worktree`: keeps that ref and additionally asks for a branch suffix.
 */
import type { BacklogStartInput } from "../api/schema/backlog.ts";
import type { GitCheckoutInfo } from "../api/sessions.ts";

/** Longest suggested name; the full branch adds the prefix and maybe `-N`. */
const SUGGESTED_BRANCH_NAME_MAX = 40;
const FALLBACK_BRANCH_WORDS = 4;

/** Words that name the kind of change, which the prefix already carries. */
const TYPE_WORDS = new Set([
  "feature", "features", "feat", "fix", "fixes", "bugfix", "bug", "hotfix", "chore",
  "refactor", "docs", "doc", "task", "story", "improvement", "enhancement", "wip",
]);
const STOP_WORDS = new Set([
  "a", "an", "the", "to", "of", "for", "in", "on", "and", "or", "with", "from", "into",
  "by", "at", "is", "be", "when", "that", "this", "it", "as", "so", "our", "we",
]);

/** A readable, bounded Git name component; `session` when nothing is left. */
function worktreeSlug(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48)
    .replace(/-+$/gu, "");
  return slug || "session";
}

function slugWords(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
}

function withoutJiraKeys(text: string, jiraKey: string): string {
  const key = jiraKey.trim().replace(/[^A-Za-z0-9_-]/gu, "");
  const own = key ? new RegExp(`\\b${key}\\b`, "gi") : undefined;
  return (own ? text.replace(own, " ") : text).replace(/\b[A-Z][A-Z0-9]+-\d+\b/gu, " ");
}

function dropLeading(words: string[], unwanted: ReadonlySet<string>): string[] {
  let index = 0;
  while (index < words.length && unwanted.has(words[index]!)) index += 1;
  return words.slice(index);
}

function joinBounded(words: readonly string[], maxWords: number): string {
  let name = "";
  for (const word of words.slice(0, maxWords)) {
    const next = name ? `${name}-${word}` : word;
    if (next.length > SUGGESTED_BRANCH_NAME_MAX) break;
    name = next;
  }
  // A single overlong word is cut rather than dropped.
  return name || (words[0] ?? "").slice(0, SUGGESTED_BRANCH_NAME_MAX);
}

export function fallbackBranchName(title: string, jiraKey = ""): string {
  const words = dropLeading(slugWords(withoutJiraKeys(title, jiraKey)), TYPE_WORDS);
  const meaningful = words.filter((word) => !STOP_WORDS.has(word));
  return joinBounded(meaningful.length ? meaningful : words, FALLBACK_BRANCH_WORDS)
    || worktreeSlug(title).slice(0, SUGGESTED_BRANCH_NAME_MAX).replace(/-+$/u, "");
}

export type BacklogStartMode = "branch" | "worktree";
export type BacklogStartStep = "folder" | "plain" | "branch" | "worktree";

export type BacklogStartState = {
  cwd: string;
  /** The inspection answer for `cwd`; absent while unknown or loading. */
  checkout?: GitCheckoutInfo;
  loading: boolean;
  mode: BacklogStartMode;
  /** Worktree mode: the name after the branch prefix, as typed or suggested. */
  name: string;
  /** Worktree mode: the latest suggestion, used when `name` was cleared. */
  suggestedName: string;
  /** Shared branch or commit; defaults to the repository default in both modes. */
  baseRef: string;
};

export function backlogStartStep(state: Pick<BacklogStartState, "cwd" | "checkout" | "loading" | "mode">): BacklogStartStep {
  if (!state.cwd.trim() || state.loading || !state.checkout) return "folder";
  if (!state.checkout.available) return "plain";
  return state.mode;
}

/** The worktree name Start sends: what the operator typed, else the suggestion. */
export function backlogWorktreeName(state: Pick<BacklogStartState, "name" | "suggestedName">): string {
  return state.name.trim() || state.suggestedName.trim();
}

export function canStartBacklog(state: BacklogStartState): boolean {
  const step = backlogStartStep(state);
  if (step === "plain" || step === "branch") return true;
  return step === "worktree" && Boolean(backlogWorktreeName(state));
}

/** The shared picker handles searching; keep every bounded server suggestion. */
export function backlogBranchOptions(checkout: GitCheckoutInfo): string[] {
  return [...new Set([checkout.defaultBranch, ...checkout.branches].filter(Boolean))];
}

/** The checkout/worktree half of `startBacklogItem`, or undefined when Start
 * is not allowed yet. A branch other than the current head switches the
 * checkout; a worktree always starts from its base ref. */
export function backlogStartRequest(state: BacklogStartState): Pick<BacklogStartInput, "cwd" | "worktree" | "branchName" | "baseRef"> | undefined {
  if (!canStartBacklog(state)) return undefined;
  const cwd = state.cwd.trim();
  const checkout = state.checkout;
  if (!checkout?.available) return { cwd, worktree: false };
  const baseRef = state.baseRef.trim() || checkout.defaultBranch || checkout.headBranch;
  if (state.mode === "branch") {
    return { cwd, worktree: false, ...(baseRef && baseRef !== checkout.headBranch ? { baseRef } : {}) };
  }
  return { cwd, worktree: true, branchName: backlogWorktreeName(state), ...(baseRef ? { baseRef } : {}) };
}
