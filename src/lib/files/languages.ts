/**
 * Which syntax a file gets in the Files editor, decided from its name alone. The editor module maps each id to a
 * CodeMirror language it loads on demand; keeping the choice here keeps it testable without CodeMirror.
 */
export type FileLanguage =
  | "javascript" | "jsx" | "typescript" | "tsx" | "json" | "css" | "html" | "markdown" | "python"
  | "shell" | "yaml" | "toml" | "dockerfile" | "go" | "rust" | "ruby" | "lua" | "sql" | "diff" | "properties"
  | "nginx" | "xml" | "swift" | "plain";

const BY_EXTENSION: Record<string, FileLanguage> = {
  js: "javascript", mjs: "javascript", cjs: "javascript",
  jsx: "jsx",
  ts: "typescript", mts: "typescript", cts: "typescript",
  tsx: "tsx",
  json: "json", jsonc: "json", json5: "json", webmanifest: "json",
  css: "css", scss: "css", less: "css",
  html: "html", htm: "html", vue: "html", svelte: "html",
  md: "markdown", markdown: "markdown", mdx: "markdown",
  py: "python", pyi: "python",
  sh: "shell", bash: "shell", zsh: "shell", fish: "shell", envrc: "shell", nix: "shell",
  yaml: "yaml", yml: "yaml",
  toml: "toml",
  go: "go",
  rs: "rust",
  rb: "ruby",
  lua: "lua",
  sql: "sql",
  diff: "diff", patch: "diff",
  ini: "properties", cfg: "properties", conf: "properties", properties: "properties", env: "properties",
  xml: "xml", svg: "xml", plist: "xml",
  swift: "swift",
};

const BY_NAME: Record<string, FileLanguage> = {
  dockerfile: "dockerfile",
  containerfile: "dockerfile",
  makefile: "shell",
  ".bashrc": "shell",
  ".zshrc": "shell",
  ".profile": "shell",
  ".envrc": "shell",
  ".gitignore": "properties",
  ".npmrc": "properties",
  ".editorconfig": "properties",
  "nginx.conf": "nginx",
};

/** The language for a path. Nix has no grammar among the approved packages, so it borrows the shell mode's
 * comments and strings. */
export function fileLanguage(path: string): FileLanguage {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const named = BY_NAME[name];
  if (named) return named;
  if (name.startsWith("dockerfile.")) return "dockerfile";
  if (name.startsWith(".env")) return "properties";
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "plain";
  return BY_EXTENSION[name.slice(dot + 1)] ?? "plain";
}
