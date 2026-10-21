/**
 * Browser half of importing and exporting bots (contract in docs/api.md#importing-and-exporting-bots). The browser
 * never reads a template itself: it packs the picked file, folder, link or text for the gateway and narrows the
 * preview and export review it answers. The requests live in src/api/bot-templates.ts.
 */
import type { BotExportReview, BotImportPreview, BotImportSource } from "../../api/schema/bot-templates.ts";

export type { BotExportGroup, BotExportReview, BotImportPreview, BotImportResult, BotImportSource } from "../../api/schema/bot-templates.ts";

/** The formats HUI reads, by id, with the name the preview shows. */
export const BOT_TEMPLATE_FORMATS = {
  grok: "Grok Bot",
  openclaw: "OpenClaw workspace",
  "claude-code": "Claude Code subagent",
  letta: "Letta agent file",
  "character-card": "Character card",
  crewai: "CrewAI agents.yaml",
  hui: "HUI bot export",
  text: "Plain text",
} as const;

/** What one import may hold, as the gateway enforces them: the dialog refuses what it would refuse anyway. */
export const BOT_TEMPLATE_LIMITS = {
  /** One file as the import takes it (a zip, a PNG card, a JSON or Markdown file), in bytes. */
  fileBytes: 8 * 1024 * 1024,
  /** A folder's files, or a zip's unpacked: in bytes, and how many. */
  totalBytes: 16 * 1024 * 1024,
  files: 1_000,
  /** Pasted text, in characters. */
  text: 2_000_000,
  /** A Grok Bot page, in bytes, as fetched. */
  pageBytes: 4 * 1024 * 1024,
  skills: 50,
  /** One skill's instructions, in characters. */
  skill: 100_000,
  routines: 50,
  memories: 500,
  integrations: 100,
  /** The files beside one skill's SKILL.md: how many, each one and all of them, in bytes. */
  skillFiles: 50,
  skillFileBytes: 256 * 1024,
  skillFilesBytes: 2 * 1024 * 1024,
  /** A HUI template's open points, needs and triggers (a bot has at most 20 triggers). */
  open: 100,
  needs: 30,
  triggers: 20,
} as const;

/** Where an import's source comes from, as the dialog's tabs name them. */
export type BotImportTab = "file" | "link" | "paste";

/** What the File tab picked: a file or a folder, ready to send, with what to call it. */
export type PickedSource = { label: string; source: BotImportSource; size: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Bytes as base64, in chunks a call stack takes. */
export function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

const megabytes = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;

/** One picked file; refused here when the gateway would refuse it anyway. */
export async function pickedFile(file: Pick<File, "name" | "size" | "arrayBuffer">): Promise<PickedSource> {
  if (file.size > BOT_TEMPLATE_LIMITS.fileBytes) throw new Error(`${file.name} is larger than ${megabytes(BOT_TEMPLATE_LIMITS.fileBytes)}.`);
  return { label: file.name, size: file.size, source: { kind: "file", name: file.name, data: base64(new Uint8Array(await file.arrayBuffer())) } };
}

/** A picked folder (`webkitdirectory`): each file by its path inside it. */
export async function pickedFolder(files: readonly Pick<File, "name" | "size" | "arrayBuffer" | "webkitRelativePath">[]): Promise<PickedSource> {
  if (!files.length) throw new Error("That folder is empty.");
  if (files.length > BOT_TEMPLATE_LIMITS.files) throw new Error(`That folder holds ${files.length} files; HUI imports at most ${BOT_TEMPLATE_LIMITS.files}.`);
  const size = files.reduce((sum, file) => sum + file.size, 0);
  if (size > BOT_TEMPLATE_LIMITS.totalBytes) throw new Error(`That folder holds more than ${megabytes(BOT_TEMPLATE_LIMITS.totalBytes)}.`);
  const entries = await Promise.all(files.map(async (file) => ({ path: file.webkitRelativePath || file.name, data: base64(new Uint8Array(await file.arrayBuffer())) })));
  const folder = entries[0]!.path.split("/")[0] ?? "folder";
  return { label: `${folder}/ (${files.length} file${files.length === 1 ? "" : "s"})`, size, source: { kind: "files", files: entries } };
}

/** The source the dialog's state describes, or what is missing. */
export function importSource(tab: BotImportTab, state: { picked?: PickedSource | undefined; url: string; text: string }): BotImportSource | string {
  if (tab === "file") return state.picked?.source ?? "Choose a file or a folder first.";
  if (tab === "link") return state.url.trim() ? { kind: "url", url: state.url.trim() } : "Paste a Grok Bot marketplace link first.";
  return state.text.trim() ? { kind: "text", text: state.text } : "Paste a template first.";
}

/** The gateway's preview, narrowed: a malformed answer is an error, never half a preview. */
export function parseBotImportPreview(body: unknown): BotImportPreview {
  if (!isRecord(body) || !isRecord(body["template"]) || !isRecord(body["bot"]) || typeof body["soul"] !== "string") throw new Error("The import preview did not come back.");
  const lists = ["skills", "routines", "integrations", "disabledTools", "disabledSkills", "open", "needs", "triggers", "dropped", "notes"];
  if (lists.some((key) => !Array.isArray(body[key])) || !isRecord(body["memories"])) throw new Error("The import preview did not come back.");
  const format = (body["template"] as { format?: unknown }).format;
  if (typeof format !== "string" || !(format in BOT_TEMPLATE_FORMATS)) throw new Error("The import preview names a format this HUI does not know.");
  return body as unknown as BotImportPreview;
}

/** The file name a download's Content-Disposition gives, else `fallback`. */
export function downloadName(disposition: string | null, fallback: string): string {
  const encoded = /filename\*=UTF-8''([^;]+)/iu.exec(disposition ?? "")?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch { /* the plain name below */ }
  }
  return /filename="([^"]+)"/iu.exec(disposition ?? "")?.[1] ?? fallback;
}

/** The gateway's review, narrowed: a malformed answer is an error, never half a review. */
export function parseBotExportReview(body: unknown): BotExportReview {
  const lists = ["parts", "cleanup", "changes", "files", "needs", "leftOut"];
  if (!isRecord(body) || typeof body["id"] !== "string" || !isRecord(body["meta"]) || lists.some((key) => !Array.isArray(body[key]))) throw new Error("The export review did not come back.");
  return body as unknown as BotExportReview;
}
