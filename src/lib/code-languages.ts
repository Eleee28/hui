/**
 * CodeMirror language support per `FileLanguage` (`files/languages.ts` decides which one a file gets), each loaded
 * on demand: the Files editor (`files/editor.ts`) mounts it, the Diff view (`diff/highlight.ts`) uses its parser to
 * colour changed lines. Importing this module loads no language until one is asked for.
 *
 * The language loading follows AgentsInTheCloud's file editor (packages/files/src/client/editor-language.ts, MIT, see
 * THIRD_PARTY_NOTICES.md); it moved here from `files/editor.ts`.
 */
import { Language, LanguageSupport, StreamLanguage, type StreamParser } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import type { FileLanguage } from "./files/languages.ts";

const legacy = (load: () => Promise<StreamParser<unknown>>) => async (): Promise<Extension> => StreamLanguage.define(await load());

const LANGUAGES: Record<FileLanguage, () => Promise<Extension>> = {
  javascript: async () => (await import("@codemirror/lang-javascript")).javascript(),
  jsx: async () => (await import("@codemirror/lang-javascript")).javascript({ jsx: true }),
  typescript: async () => (await import("@codemirror/lang-javascript")).javascript({ typescript: true }),
  tsx: async () => (await import("@codemirror/lang-javascript")).javascript({ typescript: true, jsx: true }),
  json: async () => (await import("@codemirror/lang-json")).json(),
  css: async () => (await import("@codemirror/lang-css")).css(),
  html: async () => (await import("@codemirror/lang-html")).html(),
  markdown: async () => (await import("@codemirror/lang-markdown")).markdown(),
  python: async () => (await import("@codemirror/lang-python")).python(),
  shell: legacy(async () => (await import("@codemirror/legacy-modes/mode/shell")).shell as StreamParser<unknown>),
  yaml: legacy(async () => (await import("@codemirror/legacy-modes/mode/yaml")).yaml as StreamParser<unknown>),
  toml: legacy(async () => (await import("@codemirror/legacy-modes/mode/toml")).toml as StreamParser<unknown>),
  dockerfile: legacy(async () => (await import("@codemirror/legacy-modes/mode/dockerfile")).dockerFile as StreamParser<unknown>),
  go: legacy(async () => (await import("@codemirror/legacy-modes/mode/go")).go as StreamParser<unknown>),
  rust: legacy(async () => (await import("@codemirror/legacy-modes/mode/rust")).rust as StreamParser<unknown>),
  ruby: legacy(async () => (await import("@codemirror/legacy-modes/mode/ruby")).ruby as StreamParser<unknown>),
  lua: legacy(async () => (await import("@codemirror/legacy-modes/mode/lua")).lua as StreamParser<unknown>),
  sql: legacy(async () => (await import("@codemirror/legacy-modes/mode/sql")).standardSQL as StreamParser<unknown>),
  diff: legacy(async () => (await import("@codemirror/legacy-modes/mode/diff")).diff as StreamParser<unknown>),
  properties: legacy(async () => (await import("@codemirror/legacy-modes/mode/properties")).properties as StreamParser<unknown>),
  nginx: legacy(async () => (await import("@codemirror/legacy-modes/mode/nginx")).nginx as StreamParser<unknown>),
  xml: legacy(async () => (await import("@codemirror/legacy-modes/mode/xml")).xml as StreamParser<unknown>),
  swift: legacy(async () => (await import("@codemirror/legacy-modes/mode/swift")).swift as StreamParser<unknown>),
  plain: async () => [],
};

/** The language's editor extension; plain text (or a failed load) is no extension. */
export function loadLanguage(language: FileLanguage): Promise<Extension> {
  return LANGUAGES[language]().catch((): Extension => []);
}

/** The language's parser, for highlighting text outside an editor; `undefined` for plain text. */
export async function loadLanguageParser(language: FileLanguage): Promise<Language | undefined> {
  const extension = await loadLanguage(language);
  if (extension instanceof LanguageSupport) return extension.language;
  if (extension instanceof Language) return extension;
  return undefined;
}
