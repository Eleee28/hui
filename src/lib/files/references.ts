/**
 * File references in agent text: which inline code spans and Markdown link targets look like a path the chat could
 * open in the Files view (`src/lib/x.ts`, `./a/b.md`, `/abs/path`, `~/x`, optionally `:42`, `:42:7` or `#L42`). This
 * is only the cheap, syntactic first pass and is deliberately conservative — commands, calls, versions, flags, URLs,
 * globs and prose never qualify. Whether a candidate really exists inside the conversation's working directory is
 * the gateway's answer (`POST /__hui/sessions/:id/files/resolve`, through `file-link-store.ts`); only then does the
 * chat show it as a link.
 */

export type FileReference = {
  /** The path as written, without its line suffix (`src/x.ts`, `./a.md`, `/abs/b`, `~/c`, `docs/`). */
  path: string;
  /** 1-based line, when the reference named one. */
  line?: number;
  /** 1-based column, when the reference named one with its line. */
  column?: number;
};

/** Longest reference considered; anything longer is prose or data, not a path someone wrote down. */
const MAX_REFERENCE_LENGTH = 400;
/** `:12`, `:12:3`, `:12-20` (a range opens at its first line), `#L12`, `#L12C3`, `#L12-L20`. */
const LINE_SUFFIX = /(?::(\d{1,7})(?::(\d{1,5}))?(?:-\d{1,7})?|#L(\d{1,7})(?:C(\d{1,5}))?(?:-L?\d{1,7}(?:C\d{1,5})?)?)$/u;
/** Characters a path in agent prose is made of. No spaces, quotes, parentheses, globs, `$` or `=`: those are
 * commands, calls, templates and assignments. */
const PATH_CHARACTERS = /^[A-Za-z0-9._\-/@+~]+$/u;
/** Any `scheme:` prefix (URLs, `mailto:`, `C:\`): never a path here. A digit after the colon is a line suffix. */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:(?!\d)/u;
/** A file name with an extension that starts with a letter, so versions (`1.2.3`, `v2.0`) and `e.g.` do not count. */
const NAME_WITH_EXTENSION = /^[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*\.[A-Za-z][A-Za-z0-9]{0,11}$/u;
/** A dotfile such as `.gitignore`, `.env` or `.github`. */
const DOTFILE = /^\.[A-Za-z0-9][A-Za-z0-9._-]*$/u;
/** Well-known files without an extension, accepted on their own. */
const BARE_NAMES = new Set([
  "Makefile", "Dockerfile", "Containerfile", "Justfile", "Procfile", "Gemfile", "Rakefile", "Brewfile", "Vagrantfile",
  "LICENSE", "NOTICE", "CHANGELOG", "CODEOWNERS", "AUTHORS",
]);

function positive(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

/** Whether a suffix-free path is shaped like a path: several segments, or one name that is clearly a file. */
function pathShaped(path: string): boolean {
  if (!PATH_CHARACTERS.test(path)) return false;
  if (path.startsWith("-") || path.includes("//")) return false;
  // `~` only as the home prefix.
  const tilde = path.indexOf("~");
  if (tilde > 0 || (tilde === 0 && !path.startsWith("~/"))) return false;
  const segments = path.split("/").filter((segment) => segment !== "");
  if (!segments.length) return false;
  if (segments.some((segment) => /^\.{3,}$/u.test(segment) || segment.includes("..") && segment !== "..")) return false;
  const named = segments.filter((segment) => segment !== "." && segment !== ".." && segment !== "~");
  if (!named.length) return false;
  // Something in it must read as a name: `1920/1080` and `+/-` do not.
  if (!named.some((segment) => /[A-Za-z]/u.test(segment))) return false;
  const name = named[named.length - 1]!;
  if (name.endsWith(".")) return false;
  // Several segments, a rooted path or a trailing slash (a folder: `docs/`).
  if (segments.length > 1 || path.startsWith("/") || path.startsWith("./") || path.startsWith("../") || path.startsWith("~/") || path.endsWith("/")) return true;
  return NAME_WITH_EXTENSION.test(name) || DOTFILE.test(name) || BARE_NAMES.has(name);
}

/**
 * The file reference an inline code span's text (or a Markdown link's label) spells, or `undefined`. The whole text
 * must be one path: `npm test`, `foo()`, `1.2.3`, `--flag` and `https://…` are not.
 */
export function parseFileReference(text: string): FileReference | undefined {
  const value = text.trim();
  if (!value || value.length > MAX_REFERENCE_LENGTH) return undefined;
  if (/\s/u.test(value) || SCHEME.test(value)) return undefined;
  const suffix = LINE_SUFFIX.exec(value);
  const path = suffix ? value.slice(0, suffix.index) : value;
  if (!pathShaped(path)) return undefined;
  const line = positive(suffix?.[1] ?? suffix?.[3]);
  const column = line === undefined ? undefined : positive(suffix?.[2] ?? suffix?.[4]);
  return { path, ...(line !== undefined ? { line } : {}), ...(column !== undefined ? { column } : {}) };
}

/**
 * The file reference a Markdown link target names: a relative or absolute path (percent-encoding decoded), or a
 * `file://` URL. Web, mail and in-page (`#…`) targets are not files.
 */
export function parseFileLinkTarget(href: string): FileReference | undefined {
  let value = href.trim();
  if (!value || value.startsWith("#") || value.startsWith("?")) return undefined;
  if (/^file:\/\//iu.test(value)) {
    value = value.replace(/^file:\/\/(?:localhost)?/iu, "");
    if (!value.startsWith("/")) return undefined;
  }
  try {
    value = decodeURIComponent(value);
  } catch {
    return undefined;
  }
  return parseFileReference(value);
}
