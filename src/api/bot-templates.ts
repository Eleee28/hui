/**
 * Client half of importing and exporting bots (`/__hui/bots/import`, `/__hui/bots/:id/export…`; the contract is in
 * docs/api.md#importing-and-exporting-bots): the preview, the import, the export review and the zip download.
 */
import type { BotExportAddition, BotExportGroup, BotExportReview, BotImportPreview, BotImportResult, BotImportSource, BotTemplate } from "./schema/bot-templates.ts";
import { downloadName, parseBotExportReview, parseBotImportPreview } from "../lib/bots/templates.ts";
import { isRecord, parseBot } from "../lib/bots/bots.ts";
import { CLIENT_HEADERS, fetchJson, trackedFetch } from "./request.ts";

const JSON_HEADERS = { "content-type": "application/json" } as const;

/** A preview may fetch a page or unpack an archive; creating starts a chat, its memory and maybe its first turn. */
const IMPORT_TIMEOUT_MS = 90_000;

/** A review has the utility model read every part of the bot (the gateway stops at six minutes). */
const REVIEW_TIMEOUT_MS = 7 * 60_000;

/** `POST /__hui/bots/import/preview`: what creating the source's bot would do. Nothing is created. */
export async function previewBotImport(request: { source: BotImportSource; pick?: string; worker?: string }): Promise<BotImportPreview> {
  return parseBotImportPreview(await fetchJson<unknown>("/__hui/bots/import/preview", {
    method: "POST", headers: JSON_HEADERS, body: JSON.stringify(request), signal: AbortSignal.timeout(IMPORT_TIMEOUT_MS),
  }));
}

/** `POST /__hui/bots/import`: creates the bot a preview showed. */
export async function importBot(template: BotTemplate, worker?: string): Promise<BotImportResult> {
  const body = await fetchJson<unknown>("/__hui/bots/import", {
    method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ template, ...(worker ? { worker } : {}) }), signal: AbortSignal.timeout(IMPORT_TIMEOUT_MS),
  });
  const bot = isRecord(body) ? parseBot(body["bot"]) : undefined;
  if (!isRecord(body) || !bot) throw new Error("The bot was imported but could not be read back.");
  return {
    bot,
    skills: Array.isArray(body["skills"]) ? body["skills"].filter((name): name is string => typeof name === "string") : [],
    routines: typeof body["routines"] === "number" ? body["routines"] : 0,
    opener: body["opener"] === true,
    warnings: Array.isArray(body["warnings"]) ? body["warnings"].filter((line): line is string => typeof line === "string") : [],
  };
}

/** `POST /__hui/bots/:id/export/review`: the bot cleaned and read by Settings' utility model; nothing leaves yet. */
export async function reviewBotExport(id: string): Promise<BotExportReview> {
  return parseBotExportReview(await fetchJson<unknown>(`/__hui/bots/${encodeURIComponent(id)}/export/review`, { method: "POST", signal: AbortSignal.timeout(REVIEW_TIMEOUT_MS) }));
}

/** A refused download: 409 when the review is gone or the bot changed since, which another review fixes. */
export class BotExportError extends Error {
  override name = "BotExportError";
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** `POST /__hui/bots/:id/export` with the review's id and the operator's picks, saved as a download. Resolves with the file's name. */
export async function downloadBotExport(id: string, request: { review: string; picks: Record<string, BotExportGroup>; added?: readonly BotExportAddition[] }, options: { fallbackName: string }): Promise<string> {
  const response = await trackedFetch(`/__hui/bots/${encodeURIComponent(id)}/export`, {
    method: "POST", headers: { ...CLIENT_HEADERS, ...JSON_HEADERS }, body: JSON.stringify(request), cache: "no-store", signal: AbortSignal.timeout(IMPORT_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => undefined) as { error?: string } | undefined;
    throw new BotExportError(detail?.error ?? `The export returned HTTP ${response.status}.`, response.status);
  }
  const name = downloadName(response.headers.get("content-disposition"), options.fallbackName);
  const url = URL.createObjectURL(await response.blob());
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.rel = "noopener";
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  return name;
}
