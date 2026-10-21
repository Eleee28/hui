/** Git branch-name components for new worktrees and utility-model suggestions. */

/** Longest suggested name; the full branch adds the prefix and maybe `-N`. */
export const SUGGESTED_BRANCH_NAME_MAX = 40;
const SUGGESTED_BRANCH_WORDS_MAX = 5;
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
export function worktreeSlug(title: string): string {
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

/**
 * Normalizes a utility-model answer to a mini description: the first line,
 * without labels, quotes, the branch prefix, any path segments before the last
 * slash, Jira keys and leading type words (feature, fix, chore, …). Empty when
 * nothing useful remains, so the caller can fall back.
 */
export function normalizeSuggestedBranchName(value: string, options: { prefix?: string; jiraKey?: string } = {}): string {
  let text = value.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? "";
  text = text.replace(/^(?:branch(?:\s+name)?|name|suggestion)\s*:\s*/iu, "").replace(/[`"'“”‘’]/gu, "").trim();
  const prefix = options.prefix?.trim() ?? "";
  if (prefix && text.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase())) text = text.slice(prefix.length);
  text = text.split("/").map((part) => part.trim()).filter(Boolean).at(-1) ?? "";
  const prefixWords = new Set([...TYPE_WORDS, ...slugWords(prefix)]);
  return joinBounded(dropLeading(slugWords(withoutJiraKeys(text, options.jiraKey ?? "")), prefixWords), SUGGESTED_BRANCH_WORDS_MAX);
}

/** Deterministic name from a task title: its first few meaningful words. */
export function fallbackBranchName(title: string, jiraKey = ""): string {
  const words = dropLeading(slugWords(withoutJiraKeys(title, jiraKey)), TYPE_WORDS);
  const meaningful = words.filter((word) => !STOP_WORDS.has(word));
  return joinBounded(meaningful.length ? meaningful : words, FALLBACK_BRANCH_WORDS)
    || worktreeSlug(title).slice(0, SUGGESTED_BRANCH_NAME_MAX).replace(/-+$/u, "");
}
