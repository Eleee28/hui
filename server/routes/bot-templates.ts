/**
 * Importing and exporting bots over `/__hui/bots` (HUI-18); see docs/api.md#importing-and-exporting-bots.
 *
 *   POST /__hui/bots/import/preview     { source, pick?, worker? } → BotImportPreview; nothing is created
 *   POST /__hui/bots/import             { template, worker? } → 201 BotImportResult
 *   POST /__hui/bots/:id/export/review  → BotExportReview: the bot cleaned and read by the utility model, kept as its latest
 *   POST /__hui/bots/:id/export         { review, picks } → the template as `<name>.hui-bot.zip`; 409 once the bot changed
 *
 * `import` is a reserved handle, so no bot's `/__hui/bots/:id` is ever this route.
 */
import { AutomationConflictError, AutomationInputError } from "../automation.ts";
import type { BotExportService } from "../bots/export.ts";
import type { BotTemplateService } from "../bots/template-import.ts";
import { botErrorStatus } from "./bots.ts";
import { reply, type RouteRequest, type RouteResult } from "../http/route.ts";
import type { RouteSchema } from "../api/index.ts";
import { BotExportReview, BotImportPreview, BotImportResult, routeSchemas as botTemplateRouteSchemas } from "../api/bot-templates.ts";
import { BotInputError } from "../bots/bots.ts";
import { TemplateFormatError } from "../bots/templates/common.ts";
import { TemplateFetchError } from "../bots/templates/fetch.ts";

export const routeSchemas: RouteSchema[] = botTemplateRouteSchemas;

export const BOT_IMPORT_ROUTE = "/__hui/bots/import";
export const BOT_IMPORT_PREVIEW_ROUTE = "/__hui/bots/import/preview";
const EXPORT = /^\/__hui\/bots\/([A-Za-z0-9_-]{1,100})\/export(\/review)?$/u;
/** The picks for a review. */
const PICKS_BODY_BYTES = 256 * 1024;
/** A source in base64: a folder of 16 MB, a third more, and its paths. */
const SOURCE_BODY_BYTES = 32 * 1024 * 1024;
/** A template as a preview returned it. */
const TEMPLATE_BODY_BYTES = 24 * 1024 * 1024;

/** 400 for a source or template HUI can't read, 502 when x.ai can't be fetched; the rest as the bot routes map them. */
export function templateErrorStatus(error: unknown): number {
  if (error instanceof TemplateFormatError || error instanceof AutomationInputError) return 400;
  if (error instanceof TemplateFetchError) return 502;
  if (error instanceof AutomationConflictError) return 409;
  return botErrorStatus(error);
}

export function createBotTemplateRoutes(deps: { service: BotTemplateService; exports: BotExportService }) {
  const { service, exports } = deps;

  async function json(request: RouteRequest, maxBytes: number): Promise<unknown> {
    try {
      return await request.json(maxBytes);
    } catch (error) {
      throw new BotInputError(error instanceof SyntaxError ? "The request body must be JSON." : `The request body is larger than ${maxBytes / 1024 / 1024} MB.`);
    }
  }

  async function handle(request: RouteRequest): Promise<RouteResult | undefined> {
    const exported = EXPORT.exec(request.path);
    if (request.path !== BOT_IMPORT_ROUTE && request.path !== BOT_IMPORT_PREVIEW_ROUTE && !exported) return undefined;
    try {
      if (exported) {
        if (request.method !== "POST") return { status: 405, body: { error: "method not allowed" } };
        if (exported[2]) return reply(BotExportReview, await exports.review(exported[1]!));
        const file = await exports.export(exported[1]!, await json(request, PICKS_BODY_BYTES));
        const ascii = file.name.replace(/[^A-Za-z0-9._-]/gu, "_");
        const disposition = `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`;
        return { status: 200, file: { mimeType: "application/zip", data: file.data, headers: { "content-disposition": disposition } } };
      }
      if (request.method !== "POST") return { status: 405, body: { error: "method not allowed" } };
      if (request.path === BOT_IMPORT_PREVIEW_ROUTE) return reply(BotImportPreview, await service.preview(await json(request, SOURCE_BODY_BYTES)));
      return reply(BotImportResult, await service.create(await json(request, TEMPLATE_BODY_BYTES)), 201);
    } catch (error) {
      return { status: templateErrorStatus(error), body: { error: error instanceof Error ? error.message : "The import failed." } };
    }
  }

  return { handle };
}
