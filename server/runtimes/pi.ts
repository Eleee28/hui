/**
 * PI adapter. The HUI-owned SDK worker and opt-in CLI fallback share PI's RPC
 * transport. Both live outside the gateway; only the SDK exposes inspection.
 *
 * The protocol is documented in pi's `docs/rpc.md`: JSONL commands on stdin,
 * JSONL responses and events on stdout. Strictly `\n`-delimited — Node's
 * `readline` is explicitly not compliant, because it also splits on U+2028 and
 * U+2029, which are legal inside JSON strings.
 */
import { piEnvironment } from "./pi-environment.ts";
import { RuntimeTimings, sanitizeMetrics } from "./transcript-metrics.ts";
import { parseCallRecord } from "../calls-format.ts";
import { resolveCommandReference } from "./command-references.ts";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { relayCredentials, secretEnv } from "../worker/credentials.ts";
import { fileURLToPath } from "node:url";
import { enabledBundledSkillPaths, isBundledSkillPreference } from "../pi/bundled-skills.ts";
import { resolvePiAgentDir } from "../pi/paths.ts";
import { PROVIDERS_DIR, readProviderSelections } from "./hui-models.ts";
import { filterConfiguredModels } from "./pi-models.ts";
import { modelControls, piThinking } from "./model-controls.ts";
import { piBackend } from "./pi-backend.ts";
import { piCommand } from "./pi-command.ts";
import { SdkInspector } from "./sdk-inspector.ts";
import { RuntimeOutputError } from "./types.ts";
import type { RuntimeInspection } from "./types.ts";

import type {
  CompactionReason,
  TranscriptAttachment,
  AgentRuntime,
  PromptAttachment,
  RuntimeEvent,
  RuntimeCommand,
  RuntimeModel,
  RuntimeQuestion,
  RuntimeQuestionResponse,
  RuntimeQueue,
  RuntimeRewindTarget,
  RuntimeSession,
  RuntimeUsage,
  TranscriptEntry,
} from "./types.ts";
import { agentToolEnvironment } from "../agent-tools/bridge.ts";
import { readHuiSettings } from "../hui-settings.ts";

const START_TIMEOUT_MS = 30_000;
const PROMPT_TIMEOUT_MS = 10_000;
/** PI answers `compact` only once the summary is written. */
const COMPACT_TIMEOUT_MS = 30 * 60_000;

type RpcResponse = { success?: boolean; error?: string; data?: unknown; acceptedEarly?: boolean };
type PendingRpc = {
  commandType: string;
  resolve: (response: RpcResponse) => void;
};

/** pi's own message shape, narrowed to what a transcript needs. */
type PiContentPart = {
  type?: unknown;
  text?: unknown;
  thinking?: unknown;
  id?: unknown;
  name?: unknown;
  arguments?: unknown;
};
type PiMessage = { role?: unknown; content?: unknown };

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function latestRunUsage(messages: readonly unknown[]): Pick<RuntimeUsage, "inputTokens" | "outputTokens" | "costUsd"> {
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let hasUsage = false;
  let hasCost = false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message)) continue;
    if (message["role"] === "user") break;
    // PI attributes nested tool and model calls (ctx.executeTool, classifiers)
    // to the calling tool's result, and counts it in its own session totals.
    if ((message["role"] !== "assistant" && message["role"] !== "toolResult") || !isRecord(message["usage"])) continue;
    const usage = message["usage"];
    inputTokens += finiteNumber(usage["input"] ?? usage["inputTokens"]);
    outputTokens += finiteNumber(usage["output"] ?? usage["outputTokens"]);
    hasUsage = true;
    const cost = usage["cost"];
    const totalCost = isRecord(cost) ? cost["total"] : cost;
    if (typeof totalCost === "number" && Number.isFinite(totalCost) && totalCost >= 0) {
      costUsd += totalCost;
      hasCost = true;
    }
  }
  return { inputTokens, outputTokens, costUsd: hasUsage && hasCost ? costUsd : null };
}

export function runtimeUsage(stats: unknown, messages: readonly unknown[]): RuntimeUsage | undefined {
  if (!isRecord(stats) || !isRecord(stats["contextUsage"])) return undefined;
  const context = stats["contextUsage"];
  const contextWindow = finiteNumber(context["contextWindow"]);
  if (!contextWindow) return undefined;
  const rawTokens = context["tokens"];
  const rawPercent = context["percent"];
  return {
    contextTokens: typeof rawTokens === "number" && Number.isFinite(rawTokens) && rawTokens >= 0 ? rawTokens : null,
    contextWindow,
    percent: typeof rawPercent === "number" && Number.isFinite(rawPercent) && rawPercent >= 0 ? Math.min(100, rawPercent) : null,
    ...latestRunUsage(messages),
  };
}

const ATTACHMENT_MANIFEST_PREFIX = "<!-- hui-attachments:v1:";
const ATTACHMENT_MANIFEST_PATTERN = /(?:\n\n)?<!-- hui-attachments:v1:([A-Za-z0-9_-]+) -->$/;

type DurableAttachment =
  | { kind: "image"; name: string; mimeType: string }
  | { kind: "file"; name: string; path: string };

function isSafeAttachmentName(name: string): boolean {
  const characters = [...name];
  return (
    characters.length > 0 &&
    characters.length <= 128 &&
    name.trim().length > 0 &&
    name !== "." &&
    name !== ".." &&
    !/[\\/\p{Cc}]/u.test(name)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Preserve PI's invocation names and precedence, without exposing source paths. */
export function runtimeCommands(value: unknown): RuntimeCommand[] {
  if (!Array.isArray(value)) throw new Error("PI returned an invalid command catalog.");
  const commands = new Map<string, RuntimeCommand>();
  for (const item of value) {
    if (!isRecord(item)) continue;
    const name = item["name"];
    const source = item["source"];
    if (typeof name !== "string" || !name || name.startsWith("/") || /[\s\p{Cc}]/u.test(name)) continue;
    if (source !== "extension" && source !== "skill" && source !== "prompt") continue;
    if (!commands.has(name)) commands.set(name, {
      name,
      description: typeof item["description"] === "string" ? item["description"] : "",
      source,
    });
  }
  return [...commands.values()];
}

/** pi reports a full model object; only these fields are trusted. Unknown
 * shapes degrade to `undefined` rather than a half-filled model chip. */
export function toRuntimeModel(raw: unknown): RuntimeModel | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const value = raw as Record<string, unknown>;
  const id = value["id"] ?? value["modelId"];
  const provider = value["provider"];
  if (typeof id !== "string" || !id) {
    return undefined;
  }
  const name = value["name"] ?? value["displayName"];
  return {
    id,
    provider: typeof provider === "string" ? provider : "",
    name: typeof name === "string" && name ? name : id,
    ...(typeof value["contextWindow"] === "number" && Number.isFinite(value["contextWindow"]) && value["contextWindow"] > 0 ? { contextWindow: value["contextWindow"] } : {}),
    ...(typeof value["maxTokens"] === "number" && Number.isFinite(value["maxTokens"]) && value["maxTokens"] > 0 ? { maxTokens: value["maxTokens"] } : {}),
    // PI's full model record carries its API; a bare reference leaves the levels unknown.
    ...(typeof value["api"] === "string" ? modelControls({ ...value, api: value["api"], id }) : {}),
  };
}

function printable(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return undefined;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** PI wraps tool output in `{ content: [{ type: "text", text: ... }] }`.
 * Prefer the human-readable content and only fall back to JSON for custom
 * result shapes. */
export function toolOutput(value: unknown): string | undefined {
  const content = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value["content"])
      ? value["content"]
      : undefined;
  if (content) {
    // An initial empty PI content array means no output yet, not a printable
    // JSON result. Keep protocol envelopes out of the generic transcript.
    if (content.length === 0) return "";
    const texts = content
      .filter(isRecord)
      .filter((part) => part["type"] === "text" && typeof part["text"] === "string")
      .map((part) => part["text"] as string);
    if (texts.length) return texts.join("");
  }
  return printable(value);
}

function toolDetails(value: unknown): unknown {
  return isRecord(value) && value["details"] !== undefined ? value["details"] : undefined;
}

function attachmentManifest(attachments: readonly PromptAttachment[]): string {
  const durable: DurableAttachment[] = attachments.map((item) =>
    item.kind === "image"
      ? { kind: item.kind, name: item.name, mimeType: item.mimeType }
      : { kind: item.kind, name: item.name, path: item.path },
  );
  const encoded = Buffer.from(JSON.stringify(durable), "utf8").toString("base64url");
  return `${ATTACHMENT_MANIFEST_PREFIX}${encoded} -->`;
}

function decodeAttachmentManifest(encoded: string): DurableAttachment[] | undefined {
  try {
    const decoded = Buffer.from(encoded, "base64url");
    if (decoded.toString("base64url") !== encoded) return undefined;
    const raw: unknown = JSON.parse(decoded.toString("utf8"));
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 8) return undefined;
    const attachments: DurableAttachment[] = [];
    for (const item of raw) {
      if (!isRecord(item) || typeof item["name"] !== "string" || !isSafeAttachmentName(item["name"])) {
        return undefined;
      }
      if (item["kind"] === "image" && typeof item["mimeType"] === "string") {
        attachments.push({ kind: "image", name: item["name"], mimeType: item["mimeType"] });
      } else if (item["kind"] === "file" && typeof item["path"] === "string" && item["path"]) {
        attachments.push({ kind: "file", name: item["name"], path: item["path"] });
      } else {
        return undefined;
      }
    }
    return attachments;
  } catch {
    return undefined;
  }
}

export function restoreAttachmentNames(text: string, imageCount?: number): {
  text: string;
  attachments?: DurableAttachment[];
} {
  const match = ATTACHMENT_MANIFEST_PATTERN.exec(text);
  if (!match?.[1]) return { text };
  const attachments = decodeAttachmentManifest(match[1]);
  if (!attachments) return { text };
  if (
    imageCount !== undefined &&
    attachments.filter((item) => item.kind === "image").length !== imageCount
  ) return { text };

  let visible = text.slice(0, match.index);
  const fileReferences = attachments
    .filter((item): item is Extract<DurableAttachment, { kind: "file" }> => item.kind === "file")
    .map((item) => `@${item.path}`)
    .join("\n");
  if (fileReferences) {
    if (visible === fileReferences) visible = "";
    else if (visible.endsWith(`\n\n${fileReferences}`)) {
      visible = visible.slice(0, -fileReferences.length - 2);
    } else return { text };
  }
  return { text: visible, attachments };
}

/** Decode one image part of a PI history message; image MIME types only. */
/** One prompt as the runtime receives it: text, attachment paths and the
 * durable attachment manifest, with images as native content blocks. */
export function promptPayload(text: string, attachments: readonly PromptAttachment[]): {
  message: string;
  images?: readonly { type: "image"; data: string; mimeType: string }[];
} {
  const images = attachments.flatMap((item) =>
    item.kind === "image"
      ? [{ type: "image" as const, data: item.dataBase64, mimeType: item.mimeType }]
      : [],
  );
  // A file is handed over as an absolute path, so the agent opens it with its
  // own `read` tool. Inlining the bytes would bypass the tool it already knows
  // how to use, and would not work for anything binary.
  const files = attachments.filter((item) => item.kind === "file");
  const blocks = [
    text,
    ...(files.length ? [files.map((file) => `@${file.path}`).join("\n")] : []),
    ...(attachments.length ? [attachmentManifest(attachments)] : []),
  ];
  const message = blocks.filter((block) => block !== "").join("\n\n");
  return { message, ...(images.length ? { images } : {}) };
}

export function imageFromMessages(
  messages: readonly unknown[],
  message: number,
  image: number,
): { mimeType: string; data: Buffer } | undefined {
  const raw = messages[message];
  if (!isRecord(raw) || raw["role"] !== "user" || !Array.isArray(raw["content"])) return undefined;
  const part = (raw["content"] as unknown[]).filter((item) => isRecord(item) && item["type"] === "image")[image];
  if (!isRecord(part)) return undefined;
  const mimeType = part["mimeType"];
  const data = part["data"];
  if (typeof mimeType !== "string" || !/^image\/[a-z0-9.+-]+$/i.test(mimeType) || /svg/i.test(mimeType)) return undefined;
  if (typeof data !== "string" || !data) return undefined;
  return { mimeType: mimeType.toLowerCase(), data: Buffer.from(data, "base64") };
}

/** The stored path of one file a user attached to a PI history message. */
export function fileFromMessages(messages: readonly unknown[], message: number, file: number): string | undefined {
  const raw = messages[message];
  if (!isRecord(raw) || raw["role"] !== "user") return undefined;
  const content = raw["content"];
  const parts: unknown[] = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
  const imageCount = parts.filter((part) => isRecord(part) && part["type"] === "image").length;
  for (const part of parts) {
    if (!isRecord(part) || part["type"] !== "text" || typeof part["text"] !== "string") continue;
    const attachments = restoreAttachmentNames(part["text"], imageCount).attachments;
    if (attachments) return attachments.flatMap((item) => item.kind === "file" ? [item.path] : [])[file];
  }
  return undefined;
}

export function transcriptFrom(messages: readonly unknown[], timings = new RuntimeTimings()): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const tools = new Map<string, number>();
  for (const [messageIndex, raw] of messages.entries()) {
    if (!isRecord(raw)) continue;
    const message = raw as PiMessage & { errorMessage?: unknown; stopReason?: unknown };
    const role = message.role;
    if (role === "compaction") {
      entries.push({ kind: "compaction", summary: typeof raw["summary"] === "string" ? raw["summary"] : "", tokensBefore: finiteNumber(raw["tokensBefore"]) });
      continue;
    }
    // The record of a call with a bot (Durable's `hui.call` entry): one card, its summary and transcript.
    if ((role as string) === "call") {
      const record = parseCallRecord(raw["record"]);
      if (record) entries.push({ kind: "call", ...record });
      continue;
    }
    if (role === "toolResult") {
      const id = typeof raw["toolCallId"] === "string" ? raw["toolCallId"] : "";
      const name = typeof raw["toolName"] === "string" ? raw["toolName"] : "tool";
      const patch = {
        kind: "tool" as const,
        id,
        name,
        output: toolOutput(raw["content"]),
        ...(raw["details"] !== undefined ? { details: raw["details"] } : {}),
        failed: raw["isError"] === true,
      };
      const index = tools.get(id);
      if (id && index !== undefined) {
        entries[index] = { ...entries[index] as Extract<TranscriptEntry, { kind: "tool" }>, ...patch };
      } else {
        if (id) tools.set(id, entries.length);
        entries.push(patch);
      }
      continue;
    }
    if (role !== "user" && role !== "assistant") continue;
    const parts =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : Array.isArray(message.content)
          ? (message.content as PiContentPart[])
          : [];
    const imageCount = parts.filter((part) => part.type === "image").length;
    let durableAttachments: DurableAttachment[] | undefined;
    const normalizedParts = parts.map((part) => {
      if (role !== "user" || part.type !== "text" || typeof part.text !== "string") return part;
      const restored = restoreAttachmentNames(part.text, imageCount);
      if (restored.attachments) durableAttachments = restored.attachments;
      return { ...part, text: restored.text };
    });
    const imageParts = parts.filter((part) => part.type === "image") as Array<PiContentPart & { mimeType?: unknown }>;
    let imageIndex = 0;
    const imageAttachment = (name: string): TranscriptAttachment => {
      const index = imageIndex++;
      const mimeType = imageParts[index]?.mimeType;
      return {
        name,
        kind: "image",
        ...(typeof mimeType === "string" ? { mimeType } : {}),
        source: { message: messageIndex, image: index },
      };
    };
    let fileIndex = 0;
    const attachments: TranscriptAttachment[] = durableAttachments?.map((item) =>
      item.kind === "image" ? imageAttachment(item.name)
        : { name: item.name, kind: "file" as const, source: { message: messageIndex, file: fileIndex++ } },
    ) ?? Array.from({ length: imageCount }, (_, index) => imageAttachment(imageCount > 1 ? `image ${index + 1}` : "image"));
    const usage = isRecord(raw["usage"]) ? raw["usage"] : {};
    const metrics = sanitizeMetrics({
      timestamp: raw["timestamp"],
      ...timings.get("message", raw["timestamp"]),
      ...(role === "assistant" ? {
        inputTokens: usage["input"], outputTokens: usage["output"],
        cacheReadTokens: usage["cacheRead"], cacheWriteTokens: usage["cacheWrite"],
        costUsd: isRecord(usage["cost"]) ? usage["cost"]["total"] : undefined,
      } : {}),
    });
    const metricsPart = normalizedParts.findLast(part => (part.type === "text" && part.text) || (part.type === "thinking" && part.thinking))
      ?? normalizedParts.findLast(part => part.type === "toolCall");
    const entryId = typeof raw["entryId"] === "string" ? { entryId: raw["entryId"] } : {};
    let firstMessagePart = true;
    for (const part of normalizedParts) {
      if (part.type === "text" && typeof part.text === "string" && part.text) {
        entries.push({
          kind: "message",
          role,
          text: part.text,
          ...entryId,
          ...(part === metricsPart && Object.keys(metrics).length ? { metrics } : {}),
          ...(firstMessagePart && attachments.length ? { attachments } : {}),
        });
        firstMessagePart = false;
      } else if (part.type === "thinking" && typeof part.thinking === "string" && part.thinking) {
        entries.push({ kind: "thinking", text: part.thinking, ...(part === metricsPart && Object.keys(metrics).length ? { metrics } : {}) });
      } else if (
        part.type === "toolCall" &&
        typeof part.id === "string" &&
        typeof part.name === "string"
      ) {
        const { durationMs: _modelDuration, completedAt: _modelCompleted, ...callUsage } = metrics;
        const toolMetrics = { ...(part === metricsPart ? callUsage : {}), ...timings.get("tool", part.id, raw["timestamp"]) };
        tools.set(part.id, entries.length);
        entries.push({
          kind: "tool",
          id: part.id,
          name: part.name,
          ...(Object.keys(toolMetrics).length ? { metrics: toolMetrics } : {}),
          ...(part.arguments !== undefined ? { args: part.arguments } : {}),
        });
      }
    }
    if (firstMessagePart && attachments.length) {
      entries.push({ kind: "message", role, text: "", ...entryId, attachments });
    }
    const failed = message.stopReason === "error";
    const error =
      failed && typeof message.errorMessage === "string" && message.errorMessage.trim()
        ? message.errorMessage.trim()
        : undefined;
    if (error) entries.push({ kind: "error", message: error });
  }
  return entries;
}

/** Root-to-leaf entries of PI's active branch, from a `get_entries` response. */
function activePath(raw: unknown): Record<string, unknown>[] {
  if (!isRecord(raw) || !Array.isArray(raw["entries"])) return [];
  const byId = new Map(raw["entries"].filter(isRecord).flatMap((entry) =>
    typeof entry["id"] === "string" ? [[entry["id"], entry] as const] : [],
  ));
  const path: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let cursor = typeof raw["leafId"] === "string" ? raw["leafId"] : undefined;
  while (cursor && !seen.has(cursor) && byId.has(cursor)) {
    seen.add(cursor);
    const entry = byId.get(cursor)!;
    path.push(entry);
    cursor = typeof entry["parentId"] === "string" ? entry["parentId"] : undefined;
  }
  return path.reverse();
}

/** HUI shows the whole active branch, not PI's model context, so compaction
 * never hides history: each compaction stays in place as a marker, and every
 * message keeps its entry id for rewind. Attempts PI hid before retrying stay
 * hidden, as they are in the context.
 * ponytail: context edits that replace content show the original; none of PI's
 * own edits do that, add the replacement when an extension needs it. */
export function branchHistory(raw: unknown): unknown[] {
  const path = activePath(raw);
  // As in PI's projection, the latest edit of an entry wins.
  const edits = new Map(path.flatMap((entry) =>
    entry["type"] === "context_edit" ? [[entry["targetId"], entry["replacement"]] as const] : []));
  return path.flatMap((entry): unknown[] => {
    if (entry["type"] === "compaction") {
      return [{ role: "compaction", summary: entry["summary"], tokensBefore: entry["tokensBefore"] }];
    }
    return entry["type"] === "message" && isRecord(entry["message"]) && edits.get(entry["id"]) !== null
      ? [{ ...entry["message"], entryId: entry["id"] }]
      : [];
  });
}

function runtimeQuestion(raw: Record<string, unknown>): RuntimeQuestion | undefined {
  const id = raw["id"];
  const method = raw["method"];
  const title = raw["title"];
  if (typeof id !== "string" || typeof method !== "string" || typeof title !== "string") {
    return undefined;
  }
  const timeout = typeof raw["timeout"] === "number" && raw["timeout"] >= 0
    ? raw["timeout"]
    : undefined;
  switch (method) {
    case "select": {
      const options = Array.isArray(raw["options"])
        ? raw["options"].filter((item): item is string => typeof item === "string")
        : [];
      return { id, method, title, options, ...(timeout !== undefined ? { timeout } : {}) };
    }
    case "confirm":
      return {
        id,
        method,
        title,
        message: typeof raw["message"] === "string" ? raw["message"] : "",
        ...(timeout !== undefined ? { timeout } : {}),
      };
    case "input":
      return {
        id,
        method,
        title,
        ...(typeof raw["placeholder"] === "string" ? { placeholder: raw["placeholder"] } : {}),
        ...(timeout !== undefined ? { timeout } : {}),
      };
    case "editor":
      return {
        id,
        method,
        title,
        ...(typeof raw["prefill"] === "string" ? { prefill: raw["prefill"] } : {}),
        ...(timeout !== undefined ? { timeout } : {}),
      };
    default:
      return undefined;
  }
}

const compactionReason = (value: unknown): CompactionReason | undefined =>
  value === "manual" || value === "threshold" || value === "overflow" ? value : undefined;

/** Maps one pi event onto the runtime contract. Undefined means "ignore". */
export function toRuntimeEvent(raw: Record<string, unknown>): RuntimeEvent | undefined {
  switch (raw["type"]) {
    case "compaction_start": {
      const reason = compactionReason(raw["reason"]);
      return reason ? { type: "compaction_start", reason } : undefined;
    }
    case "compaction_end": {
      const reason = compactionReason(raw["reason"]);
      if (!reason) return undefined;
      // PI prefixes its own heading; HUI's divider already says it failed.
      const message = typeof raw["errorMessage"] === "string"
        ? raw["errorMessage"].replace(/^(?:Auto-compaction|Compaction|Context overflow recovery) failed: /u, "")
        : "";
      return {
        type: "compaction_end",
        reason,
        outcome: raw["result"] ? "done" : raw["aborted"] === true ? "cancelled" : "failed",
        willRetry: raw["willRetry"] === true,
        ...(message ? { message } : {}),
      };
    }
    case "turn_start":
      return { type: "turn_start" };
    case "turn_end":
      return { type: "turn_end" };
    // pi's real name for "the agent stopped". Mapped here rather than in the
    // reader so the contract is testable without a live child process.
    case "agent_end":
      return { type: "settled" };
    case "tool_execution_start": {
      const name = raw["toolName"];
      const id = raw["toolCallId"];
      return typeof name === "string" && typeof id === "string"
        ? { type: "tool_start", id, name, ...(raw["args"] !== undefined ? { args: raw["args"] } : {}) }
        : undefined;
    }
    case "tool_execution_update": {
      const name = raw["toolName"];
      const id = raw["toolCallId"];
      return typeof name === "string" && typeof id === "string"
        ? {
            type: "tool_update", id, name,
            output: toolOutput(raw["partialResult"]),
            ...(toolDetails(raw["partialResult"]) !== undefined ? { details: toolDetails(raw["partialResult"]) } : {}),
          }
        : undefined;
    }
    case "tool_execution_end": {
      const name = raw["toolName"];
      const id = raw["toolCallId"];
      if (typeof name !== "string" || typeof id !== "string") return undefined;
      return {
        type: "tool_end",
        id,
        name,
        output: toolOutput(raw["result"] ?? raw["content"]),
        ...(toolDetails(raw["result"]) !== undefined ? { details: toolDetails(raw["result"]) } : {}),
        failed: raw["isError"] === true,
      };
    }
    case "queue_update":
      return {
        type: "queue_update",
        queue: {
          steering: Array.isArray(raw["steering"])
            ? raw["steering"]
                .filter((item): item is string => typeof item === "string")
                .map((item) => restoreAttachmentNames(item).text)
            : [],
          followUp: Array.isArray(raw["followUp"])
            ? raw["followUp"]
                .filter((item): item is string => typeof item === "string")
                .map((item) => restoreAttachmentNames(item).text)
            : [],
        },
      };
    case "extension_ui_request": {
      const question = runtimeQuestion(raw);
      if (question) return { type: "question", question };
      if (raw["method"] === "notify" && typeof raw["message"] === "string") {
        const level = raw["notifyType"];
        return {
          type: "notice",
          message: raw["message"],
          level: level === "warning" || level === "error" ? level : "info",
        };
      }
      return undefined;
    }
    case "extension_error": {
      const message = raw["error"];
      return { type: "error", message: typeof message === "string" ? message : "Extension error" };
    }
    case "message_update": {
      const delta = raw["assistantMessageEvent"] as Record<string, unknown> | undefined;
      const text = delta?.["delta"];
      if (typeof text !== "string" || !text) {
        return undefined;
      }
      if (delta?.["type"] === "text_delta") {
        return { type: "text", delta: text };
      }
      if (delta?.["type"] === "thinking_delta") {
        return { type: "thinking", delta: text };
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

const STDERR_TAIL_CHARS = 8 * 1024;
const STDERR_SUMMARY_LINES = 6;
/** How long an exit waits for stderr to close so the crash text is included. */
const STDERR_DRAIN_MS = 250;
const STACK_FRAME = /^\s+at\s/u;

/**
 * The informative end of a runtime's stderr, one line per `|`. Only the first
 * frame of each stack trace is kept; caret markers, Node's version trailer and
 * a line repeating `exclude` (the reported message) add nothing.
 */
export function stderrSummary(raw: string, exclude?: string): string {
  const skip = exclude?.trim();
  const lines = raw.split(/\r?\n/u).filter((line) =>
    line.trim() && !/^\s*\^+\s*$/u.test(line) && !/^Node\.js v\d/u.test(line) && line.trim() !== skip);
  return lines
    .filter((line, index) => !(STACK_FRAME.test(line) && STACK_FRAME.test(lines[index - 1] ?? "")))
    .slice(-STDERR_SUMMARY_LINES)
    .map((line) => line.trim())
    .join(" | ");
}

/** An exit code or signal is often the only hint why a runtime vanished (a
 * crash, an out-of-memory kill), so it stays in the error that reaches logs. */
function exitMessage(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal) return `pi exited after ${signal}`;
  return code === null ? "pi exited" : `pi exited with code ${code}`;
}

export class PiSession implements RuntimeSession {
  #child: ChildProcessWithoutNullStreams;
  #agentDir: string | undefined;
  #listeners = new Set<(event: RuntimeEvent) => void>();
  #exitListeners = new Set<() => void>();
  #pending = new Map<string, PendingRpc>();
  /** Prompt RPCs released early because an extension is waiting on HUI. Their
   * eventual response is the extension command's authoritative settle edge. */
  #interactivePrompts = new Set<string>();
  #nextId = 1;
  #buffer = "";
  #messages: unknown[] = [];
  /** Between PI's agent_start and agent_end; unlike #streaming it is not held
   * until HUI's settle refresh finishes. */
  #agentRunning = false;
  #settleAgain = false;
  #compactionStarts = 0;
  #timings = new RuntimeTimings();
  #streaming = false;
  #exited = false;
  /** Bounded stderr tail, attached to diagnostics when the process fails. */
  #stderr = "";
  #model: RuntimeModel | undefined;
  #thinking: string | undefined;
  #usage: RuntimeUsage | undefined;
  #queue: RuntimeQueue = { steering: [], followUp: [] };
  #questions = new Map<string, RuntimeQuestion>();
  #disabledSkillCommands: ReadonlySet<string>;
  #settling: Promise<void> | undefined;
  #inspector: SdkInspector | undefined;
  inspect?: () => Promise<RuntimeInspection>;

  sessionId = "";
  sessionFile: string | undefined;

  get processId(): number | undefined {
    return this.#child.pid;
  }

  /** Attached to a remote run that kept going without this gateway: an `idle`
   * boot then means it finished, not that it died. */
  readonly resumesInterruptedRuns = false;

  constructor(child: ChildProcessWithoutNullStreams, agentDir?: string, disabledSkillNames: readonly string[] = [], sdk = false) {
    this.#child = child;
    this.#agentDir = agentDir;
    this.#disabledSkillCommands = new Set(disabledSkillNames.map((name) => `skill:${name}`));
    if (sdk) {
      this.#inspector = new SdkInspector(child, (message) => { this.#finish(message); child.kill(); });
      this.inspect = () => this.#inspector!.inspect();
    }
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#ingest(chunk));
    // stderr must be drained or the child eventually blocks. pi logs there, so
    // only a bounded tail is kept to explain a failure; it is never streamed.
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.#stderr = (this.#stderr + chunk).slice(-STDERR_TAIL_CHARS);
    });
    child.on("error", (error: Error) => this.#finish(`pi failed: ${error.message}`));
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => this.#finishAfterOutput(exitMessage(code, signal)));
    // A failed write otherwise becomes an unhandled stream error and can take
    // down the gateway. The command callback also resolves the matching RPC.
    child.stdin.on("error", (error: Error) => this.#finish(`pi stdin failed: ${error.message}`));
  }

  /** The informative end of what the process wrote to stderr. */
  recentOutput(exclude?: string): string {
    return stderrSummary(this.#stderr, exclude);
  }

  /** Node can report an exit before the last stderr chunk, usually the crash
   * itself, has been read. Wait briefly for the stream to end first. */
  #finishAfterOutput(message: string): void {
    const stderr = this.#child.stderr;
    if (this.#exited || stderr.readableEnded || stderr.destroyed) {
      this.#finish(message);
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      stderr.off("end", finish);
      stderr.off("close", finish);
      this.#finish(message);
    };
    // A grandchild may keep the pipe open; never wait on it indefinitely.
    const timer = setTimeout(finish, STDERR_DRAIN_MS);
    stderr.once("end", finish);
    stderr.once("close", finish);
  }

  #finish(message: string): void {
    if (this.#exited) return;
    this.#exited = true;
    this.#streaming = false;
    this.#inspector?.close(message);
    this.#questions.clear();
    for (const pending of this.#pending.values()) {
      pending.resolve({ success: false, error: message });
    }
    this.#pending.clear();
    this.#interactivePrompts.clear();
    const output = this.recentOutput(message);
    this.#emit({ type: "error", message, ...(output ? { output } : {}) });
    for (const listener of this.#exitListeners) listener();
    this.#exitListeners.clear();
  }

  /** JSONL framing: split on `\n` only, and tolerate a trailing `\r`. */
  #ingest(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const index = this.#buffer.indexOf("\n");
      if (index === -1) {
        return;
      }
      const line = this.#buffer.slice(0, index).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(index + 1);
      if (line.trim()) {
        this.#handleLine(line);
      }
    }
  }

  #handleLine(line: string): void {
    let raw: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) throw new Error("Expected an RPC object.");
      raw = parsed;
    } catch {
      this.#emit({ type: "error", message: "PI emitted malformed JSONL." });
      return;
    }

    if (raw["type"] === "response") {
      const id = raw["id"];
      const pending = typeof id === "string" ? this.#pending.get(id) : undefined;
      if (pending && typeof id === "string") {
        this.#pending.delete(id);
        pending.resolve(raw as RpcResponse);
      } else if (typeof id === "string" && this.#interactivePrompts.delete(id)) {
        const response = raw as RpcResponse;
        if (!response.success) {
          this.#emit({ type: "error", message: response.error ?? "PI extension command failed." });
        }
        // Extension commands do not emit agent_end. Their delayed RPC response
        // is therefore the only reliable signal that history can be refreshed
        // and the composer unlocked.
        void this.#settleCommandIfIdle();
      }
      return;
    }

    if (raw["type"] === "agent_start" || raw["type"] === "turn_start") {
      this.#streaming = true;
    }
    if (raw["type"] === "agent_start") this.#agentRunning = true;
    else if (raw["type"] === "agent_end") this.#agentRunning = false;

    this.#timings.observe(raw);
    const event = toRuntimeEvent(raw);
    if (!event) return;
    if (event.type === "settled") {
      // A reconnect must never observe idle paired with pre-turn history. PI's
      // transcript is authoritative, so settle only after it has been pulled.
      void this.#settle();
      return;
    }
    if (event.type === "compaction_start") {
      this.#compactionStarts += 1;
      // PI compacts before a prompt it already accepted when the context is full.
      this.#acceptPromptEarly();
    }
    if (event.type === "compaction_end" && !this.#agentRunning && !this.#promptInFlight()) {
      // PI compacts after its agent_end too, and for /compact outside any run.
      // Stay busy until the refreshed history holds the summary; then usage
      // drops and HUI may send what it held. On willRetry PI resumes the
      // overflowed turn, whose agent_end settles.
      this.#streaming = true;
      this.#emit(event);
      if (!event.willRetry) void this.#settle();
      return;
    }
    if (event.type === "queue_update") this.#queue = event.queue;
    if (event.type === "question") {
      this.#questions.set(event.question.id, event.question);
      // Extension commands answer the `prompt` RPC only after their handler
      // returns. A UI request is nevertheless authoritative proof that PI
      // accepted the command. Release HUI's HTTP request now and let the
      // extension response finish independently; otherwise the browser's
      // ordinary request timeout races the human answering the dialog.
      this.#acceptPromptEarly();
    }
    this.#emit(event);
  }

  #emit(event: RuntimeEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  /** A command may finish without agent_end, or start its own agent turn.
   * Read PI's state after the command acknowledgement to distinguish the two. */
  async #settleCommandIfIdle(): Promise<void> {
    const response = await this.#send({ type: "get_state" }, START_TIMEOUT_MS);
    if (!response.success || !isRecord(response.data) || typeof response.data["isStreaming"] !== "boolean") {
      this.#emit({ type: "error", message: response.error ?? "PI could not confirm command completion." });
      return;
    }
    if (!response.data["isStreaming"]) await this.#settle();
  }

  /** A prompt RPC PI has not answered yet; its run or response settles. */
  #promptInFlight(): boolean {
    return this.#interactivePrompts.size > 0 || [...this.#pending.values()].some((pending) => pending.commandType === "prompt");
  }

  #settle(): Promise<void> {
    // A later request may need history written after this refresh began:
    // refresh again inside the same settle, which still reports only once.
    if (this.#settling) { this.#settleAgain = true; return this.#settling; }
    const settling = (async () => {
      let historyRefreshed = true;
      try {
        do {
          this.#settleAgain = false;
          historyRefreshed = true;
          try {
            await this.#refreshMessages();
            await this.#refreshUsage();
          } catch (error) {
            historyRefreshed = false;
            this.#emit({
              type: "error",
              message: error instanceof Error ? error.message : "PI history refresh failed.",
            });
          }
        } while (this.#settleAgain);
      } finally {
        // Synchronously after the last check: any later request starts a new settle.
        this.#settling = undefined;
      }
      // PI started another run meanwhile (one it continues after a compaction,
      // or a prompt it compacted before); that run's agent_end settles.
      if (this.#agentRunning) return;
      this.#streaming = false;
      this.#questions.clear();
      this.#emit({ type: "settled", historyRefreshed });
    })();
    this.#settling = settling;
    return settling;
  }

  #send(command: Record<string, unknown>, timeoutMs: number): Promise<RpcResponse> {
    if (this.#exited) {
      return Promise.resolve({ success: false, error: "pi is not running" });
    }
    const id = `hui-${this.#nextId++}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        resolve({ success: false, error: "pi did not respond in time" });
      }, timeoutMs);
      const pending: PendingRpc = {
        commandType: typeof command["type"] === "string" ? command["type"] : "",
        resolve: (response) => {
          clearTimeout(timer);
          resolve(response);
        },
      };
      this.#pending.set(id, pending);
      try {
        this.#child.stdin.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
          if (error && this.#pending.get(id) === pending) {
            this.#pending.delete(id);
            pending.resolve({ success: false, error: `pi stdin failed: ${error.message}` });
          }
        });
      } catch (error) {
        this.#pending.delete(id);
        pending.resolve({
          success: false,
          error: error instanceof Error ? error.message : "pi stdin failed",
        });
      }
    });
  }

  /** PI accepted the prompt but answers it only after an extension question is
   * answered or a compaction before it finishes. Release HUI's request now; the
   * eventual response is the settle edge. */
  #acceptPromptEarly(): void {
    for (const [id, pending] of this.#pending) {
      if (pending.commandType !== "prompt") continue;
      this.#pending.delete(id);
      this.#interactivePrompts.add(id);
      pending.resolve({ success: true, acceptedEarly: true });
      return;
    }
  }

  async #refreshMessages(): Promise<void> {
    // ponytail: reads every entry of every branch on each refresh (58 MB, ~0.2 s
    // for the largest real session); switch to `get_entries {since}` with a
    // full read after a leaf jump if that becomes a bottleneck.
    const response = await this.#send({ type: "get_entries" }, START_TIMEOUT_MS);
    if (!response.success) throw new Error(response.error ?? "PI history refresh failed.");
    if (!isRecord(response.data) || !Array.isArray(response.data["entries"])) throw new Error("PI returned malformed history.");
    this.#messages = branchHistory(response.data);
  }


  async #refreshUsage(): Promise<void> {
    const response = await this.#send({ type: "get_session_stats" }, START_TIMEOUT_MS);
    if (response.success) this.#usage = runtimeUsage(response.data, this.#messages);
  }

  /** Reads identity and history, so a resumed session paints immediately. */
  async bootstrap(): Promise<void> {
    const state = await this.#send({ type: "get_state" }, START_TIMEOUT_MS);
    if (!state.success) {
      throw new Error(state.error ?? "pi did not report its session state");
    }
    const data = state.data as Record<string, unknown> | undefined;
    this.sessionId = typeof data?.["sessionId"] === "string" ? data["sessionId"] : "";
    this.sessionFile =
      typeof data?.["sessionFile"] === "string" ? data["sessionFile"] : undefined;
    this.#streaming = data?.["isStreaming"] === true;
    this.#model = toRuntimeModel(data?.["model"]);
    this.#thinking = typeof data?.["thinkingLevel"] === "string" ? data["thinkingLevel"] : undefined;
    await this.#refreshMessages();
    await this.#refreshUsage();
  }

  /**
   * pi has no `--name` flag, so a display name is set over RPC once the session
   * exists. Passing it on the command line made pi exit with "Unknown option".
   */
  async setName(name: string): Promise<void> {
    const response = await this.#send({ type: "set_session_name", name }, START_TIMEOUT_MS);
    if (!response.success) throw new Error(response.error ?? "PI could not name the session.");
  }

  #promptPayload(text: string, attachments: readonly PromptAttachment[]) {
    return promptPayload(text, attachments);
  }

  async #resolveReference(text: string, queued = false): Promise<string> {
    if (!/^\$[^\s]+(?:\s|$)/u.test(text)) return text;
    const catalog = await this.listCommands();
    const resolved = resolveCommandReference(text, catalog);
    if (queued && resolved !== text && catalog.some((command) => command.source === "extension"
      && resolved.split(/\s/u, 1)[0] === `/${command.name}`)) {
      throw new Error("Run plugin actions when the session is idle.");
    }
    const [token, name] = /^\$(?:skill:)?([^\s]+)/u.exec(text)!;
    if (resolved === text && this.#disabledSkillCommands.has(`skill:${name}`)) return `/skill:${name}${text.slice(token.length)}`;
    return resolved;
  }

  async prompt(text: string, attachments: readonly PromptAttachment[] = []): Promise<void> {
    text = await this.#resolveReference(text);
    this.#streaming = true;
    const payload = this.#promptPayload(text, attachments);
    const response = await this.#send(
      { type: "prompt", ...payload },
      PROMPT_TIMEOUT_MS,
    );
    if (!response.success) {
      this.#streaming = false;
      throw new Error(response.error ?? "pi refused the prompt");
    }
    if (text.startsWith("/") && !response.acceptedEarly) {
      await this.#settleCommandIfIdle();
    }
  }

  async clear(): Promise<void> {
    if (this.#streaming) throw new Error("Wait for the current run to finish before clearing the session.");
    const response = await this.#send({ type: "new_session" }, START_TIMEOUT_MS);
    if (!response.success) throw new Error(response.error ?? "PI could not clear the session.");
    const result = response.data as Record<string, unknown> | undefined;
    if (result?.["cancelled"] === true) throw new Error("PI cancelled the session clear.");

    const state = await this.#send({ type: "get_state" }, START_TIMEOUT_MS);
    if (!state.success) throw new Error(state.error ?? "PI did not report the cleared session state.");
    const data = state.data as Record<string, unknown> | undefined;
    this.sessionId = typeof data?.["sessionId"] === "string" ? data["sessionId"] : "";
    this.sessionFile = typeof data?.["sessionFile"] === "string" ? data["sessionFile"] : undefined;
    this.#streaming = data?.["isStreaming"] === true;
    this.#model = toRuntimeModel(data?.["model"]);
    this.#thinking = typeof data?.["thinkingLevel"] === "string" ? data["thinkingLevel"] : undefined;
    this.#queue = { steering: [], followUp: [] };
    this.#questions.clear();
    await this.#refreshMessages();
    await this.#refreshUsage();
  }

  async steer(text: string, attachments: readonly PromptAttachment[] = []): Promise<void> {
    text = await this.#resolveReference(text, true);
    const response = await this.#send(
      { type: "steer", ...this.#promptPayload(text, attachments) },
      PROMPT_TIMEOUT_MS,
    );
    if (!response.success) throw new Error(response.error ?? "PI refused the steering message.");
  }

  async followUp(text: string, attachments: readonly PromptAttachment[] = []): Promise<void> {
    text = await this.#resolveReference(text, true);
    const response = await this.#send(
      { type: "follow_up", ...this.#promptPayload(text, attachments) },
      PROMPT_TIMEOUT_MS,
    );
    if (!response.success) throw new Error(response.error ?? "PI refused the follow-up message.");
  }

  currentModel(): RuntimeModel | undefined {
    return this.#model;
  }

  currentUsage(): RuntimeUsage | undefined {
    return this.#usage;
  }

  async listModels(): Promise<readonly RuntimeModel[]> {
    const response = await this.#send({ type: "get_available_models" }, START_TIMEOUT_MS);
    if (!response.success) {
      throw new Error(response.error ?? "pi could not list its models");
    }
    const models = (response.data as Record<string, unknown> | undefined)?.["models"];
    if (!Array.isArray(models)) {
      return [];
    }
    const catalog = models
      .map(toRuntimeModel)
      .filter((model): model is RuntimeModel => model !== undefined);
    return this.#agentDir ? filterConfiguredModels(catalog, this.#agentDir) : catalog;
  }

  async listCommands(): Promise<readonly RuntimeCommand[]> {
    const response = await this.#send({ type: "get_commands" }, START_TIMEOUT_MS);
    if (!response.success) throw new Error(response.error ?? "PI could not list its commands.");
    return runtimeCommands(isRecord(response.data) ? response.data["commands"] : undefined)
      .filter((command) => command.source !== "skill" || !this.#disabledSkillCommands.has(command.name));
  }

  async setModel(provider: string, id: string): Promise<void> {
    const response = await this.#send(
      { type: "set_model", provider, modelId: id },
      START_TIMEOUT_MS,
    );
    if (!response.success) {
      throw new Error(response.error ?? "pi refused that model");
    }
    // Some PI versions acknowledge success without echoing a model object. A
    // successful response is still confirmation of the requested selection,
    // so currentModel must not keep reporting the previous model.
    this.#model = toRuntimeModel(response.data) ?? { provider, id, name: id };
  }

  currentThinking(): string | undefined {
    return this.#thinking;
  }

  /** HUI's `ultra` is Durable's; PI gets its highest level for it. */
  async setThinking(level: string): Promise<void> {
    const sent = piThinking(level);
    const response = await this.#send(
      { type: "set_thinking_level", level: sent },
      START_TIMEOUT_MS,
    );
    if (!response.success) throw new Error(response.error ?? "PI refused that thinking level.");
    this.#thinking = sent;
  }

  pendingQueue(): RuntimeQueue {
    return { steering: [...this.#queue.steering], followUp: [...this.#queue.followUp] };
  }

  pendingQuestions(): readonly RuntimeQuestion[] {
    return [...this.#questions.values()];
  }

  async respondQuestion(id: string, response: RuntimeQuestionResponse): Promise<void> {
    const question = this.#questions.get(id);
    if (!question) throw new Error(`Unknown PI question: ${id}`);
    if (question.method === "confirm") {
      if (!("confirmed" in response)) throw new Error("A confirmation response is required.");
    } else if (!("value" in response)) {
      throw new Error("A text response is required.");
    }
    await this.#write({ type: "extension_ui_response", id, ...response });
    this.#questions.delete(id);
  }

  async cancelQuestion(id: string): Promise<void> {
    if (!this.#questions.has(id)) throw new Error(`Unknown PI question: ${id}`);
    await this.#write({ type: "extension_ui_response", id, cancelled: true });
    this.#questions.delete(id);
  }

  #write(command: Record<string, unknown>): Promise<void> {
    if (this.#exited) return Promise.reject(new Error("pi is not running"));
    return new Promise((resolve, reject) => {
      try {
        this.#child.stdin.write(`${JSON.stringify(command)}\n`, (error) => {
          if (error) reject(error);
          else resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /** PI reports a compaction it starts through its events, failures included;
   * only a refusal before it started (an unavailable runtime) has to be reported. */
  async compact(instructions?: string): Promise<void> {
    const starts = this.#compactionStarts;
    void this.#send({ type: "compact", ...(instructions ? { customInstructions: instructions } : {}) }, COMPACT_TIMEOUT_MS)
      .then((response) => {
        if (response.success || this.#compactionStarts !== starts) return;
        this.#emit({ type: "compaction_end", reason: "manual", outcome: "failed", willRetry: false, message: response.error ?? "PI could not compact." });
      });
  }

  async abort(): Promise<void> {
    const response = await this.#send({ type: "abort" }, PROMPT_TIMEOUT_MS);
    if (!response.success) {
      throw new Error(response.error ?? "pi refused to stop");
    }
    // PI answers abort only once idle, whether or not an agent_end reached us.
    this.#agentRunning = false;
    // Prompt-free continuation starts through the SDK side channel. Asking the
    // worker directly as well keeps its AgentSession authoritative even when
    // the RPC abort acknowledgement races ahead of SDK settlement.
    await this.#inspector?.abort();
    if (this.#settling) await this.#settling;
    else {
      await this.#refreshMessages();
      this.#streaming = false;
    }
  }

  async rewind(target: RuntimeRewindTarget, options?: { excludeUserMessage?: boolean }): Promise<void> {
    if (!this.#inspector) throw new Error("Rewind requires HUI's PI SDK backend.");
    if (this.#streaming) throw new Error("Wait for the current run to finish before rewinding.");
    await this.#inspector.rewind(target, options?.excludeUserMessage);
    await this.#refreshMessages();
    await this.#refreshUsage();
  }

  async reload(): Promise<void> {
    if (!this.#inspector) throw new Error("Reload requires HUI's PI SDK backend.");
    // A remote session re-reads the mirror, so refresh it from this machine first.
    await this.#inspector.reload();
  }

  async continueRun(): Promise<void> {
    if (!this.#inspector) throw new Error("Prompt-free continuation requires HUI's PI SDK backend.");
    if (this.#streaming) throw new Error("That session is already running.");
    this.#streaming = true;
    try {
      await this.#inspector.continueRun();
    } catch (error) {
      this.#streaming = false;
      throw error;
    }
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  onExit(listener: () => void): () => void {
    if (this.#exited) {
      listener();
      return () => {};
    }
    this.#exitListeners.add(listener);
    return () => {
      this.#exitListeners.delete(listener);
    };
  }

  async attachmentImage(message: number, image: number): Promise<{ mimeType: string; data: Buffer } | undefined> {
    return imageFromMessages(this.#messages, message, image);
  }

  attachmentFile(message: number, file: number): string | undefined {
    return fileFromMessages(this.#messages, message, file);
  }

  transcript(): TranscriptEntry[] {
    return transcriptFrom(this.#messages, this.#timings);
  }

  get isStreaming(): boolean {
    return this.#streaming;
  }

  get running(): boolean {
    return !this.#exited;
  }

  dispose(): void {
    if (this.#exited) return;
    this.#exited = true;
    this.#streaming = false;
    this.#inspector?.close("SDK worker was disposed.");
    for (const pending of this.#pending.values()) {
      pending.resolve({ success: false, error: "pi was disposed" });
    }
    this.#pending.clear();
    this.#interactivePrompts.clear();
    this.#questions.clear();
    this.#child.kill();
  }
}

export type HostLaunch = {
  disabledSkills: { name: string; path: string }[];
  bundledSkillPaths: string[];
  disabledPluginIds: string[];
  browserTool: boolean;
  fallbackAuth: string;
};

async function startPi(options: {
  cwd: string;
  sessionFile?: string;
  title?: string;
  model?: string;
  thinking?: string;
  huiSessionId?: string;
  /** Catalog/health probes must not create a transcript owned by PI. */
  noSession?: boolean;
  /** Read-only probes must not load extension code or workspace instructions. */
  safeProbe?: boolean;
  /** SDK only: replace `thinking` with the cheapest level the model is sent. */
  lowestThinking?: boolean;
  /** Explicit selection for compatibility tests and controlled rollback. */
  backend?: "sdk" | "cli";
  /** Isolated test/probe configuration; otherwise use the configured PI path. */
  agentDir?: string;
  /** On a worker host: the gateway's skill and plugin choices, already mapped
   * to this machine, and the remote's own login for when no gateway answers. */
  hostLaunch?: HostLaunch;
}): Promise<PiSession> {
  // HUI's `ultra` is Durable's; PI gets its highest level for it.
  if (options.thinking) options = { ...options, thinking: piThinking(options.thinking) };
  const args = ["--mode", "rpc"];
  const hostLaunch = options.hostLaunch;
  const huiSettings = options.safeProbe ? undefined : await readHuiSettings();
  const browserTool = !options.safeProbe && (hostLaunch ? hostLaunch.browserTool : huiSettings?.browser.enabled !== false);
  if (!options.safeProbe) {
    args.push("--extension", fileURLToPath(new URL("./progress-card-extension.mjs", import.meta.url)));
    args.push("--extension", fileURLToPath(new URL("./agent-tools-extension.mjs", import.meta.url)));
    args.push("--extension", fileURLToPath(new URL("./show-widget-extension.mjs", import.meta.url)));
    if (browserTool) args.push("--extension", fileURLToPath(new URL("./browser-tool-extension.mjs", import.meta.url)));
    args.push("--extension", fileURLToPath(new URL("./skill-policy-extension.mjs", import.meta.url)));
  }
  if (options.noSession) {
    args.push("--no-session");
  }
  if (options.safeProbe) {
    args.push("--no-extensions", "--no-skills", "--no-context-files");
  }
  if (options.sessionFile) {
    args.push("--session", options.sessionFile);
  }
  // `--model` accepts `provider/id`, which is exactly how the record stores it.
  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.thinking) {
    args.push("--thinking", options.thinking);
  }

  const agentDir = options.agentDir ?? resolvePiAgentDir();
  const disabled = huiSettings?.disabledSkills ?? [];
  // Bundled opt-out controls only the fallback. A PI/user/project skill with
  // the same name remains independently configurable through its own path.
  const disabledSkills = hostLaunch?.disabledSkills ?? disabled.filter((entry) => !isBundledSkillPreference(entry));
  const bundledSkillPaths = options.safeProbe ? [] : hostLaunch?.bundledSkillPaths ?? enabledBundledSkillPaths(disabled);
  for (const path of bundledSkillPaths) args.push("--skill", path);
  const disabledPluginIds = hostLaunch?.disabledPluginIds ?? huiSettings?.disabledPlugins.map((plugin) => plugin.id) ?? [];
  const agentToolEnv = options.huiSessionId && !options.safeProbe
    ? await agentToolEnvironment(options.huiSessionId)
    : {};
  const backend = options.backend ?? piBackend();
  if (backend === "cli" && Object.keys(await readProviderSelections()).length) {
    throw new Error("HUI-managed providers require the PI SDK backend. The CLI fallback remains available for PI-owned configuration.");
  }
  if (backend === "cli" && disabledPluginIds.length) {
    throw new Error("HUI plugin disabling requires the PI SDK backend; the CLI fallback was not started.");
  }
  const cli = piCommand(args);
  const env = {
    ...piEnvironment(), ...agentToolEnv, PI_CODING_AGENT_DIR: agentDir,
    HUI_DISABLED_SKILLS: JSON.stringify(disabledSkills),
    ...(hostLaunch ? { HUI_WORKER_BROKER: "1", HUI_WORKER_FALLBACK_AUTH: hostLaunch.fallbackAuth, HUI_PROVIDERS_DIR: PROVIDERS_DIR, HUI_WORKER_SECRETS: JSON.stringify(secretEnv()) } : {}),
  };
  // The launch travels in the environment, not argv: endpoint security agents
  // can SIGKILL an exec whose cwd plus one argument reaches MAXPATHLEN (1024).
  const child = backend === "sdk"
    ? spawn(process.execPath, [fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./pi-sdk-worker.ts" : "./pi-sdk-worker.js", import.meta.url))], {
        cwd: options.cwd, stdio: ["pipe", "pipe", "pipe", "ipc"],
        env: { ...env, HUI_PI_WORKER_LAUNCH: JSON.stringify({ ...withoutHostLaunch(options), agentDir, disabledPluginIds, bundledSkillPaths, browserTool }) },
      }) as ChildProcessWithoutNullStreams
    : spawn(cli.command, cli.args, { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"], env });
  if (hostLaunch && backend === "sdk") relayCredentials(child);

  const session = new PiSession(child, agentDir, disabledSkills.map((skill) => skill.name), backend === "sdk");
  try {
    await session.bootstrap();
    if (session.inspect) await session.inspect();
    if (options.title) {
      // Best effort: a session that boots but cannot be named is still usable,
      // and HUI's own record keeps the title the sidebar shows.
      await session.setName(options.title).catch(() => {});
    }
  } catch (error) {
    const output = session.recentOutput(error instanceof Error ? error.message : undefined);
    session.dispose();
    throw output && error instanceof Error ? new RuntimeOutputError(error.message, output, { cause: error }) : error;
  }
  return session;
}

function withoutHostLaunch<T extends { hostLaunch?: unknown }>(options: T): Omit<T, "hostLaunch"> {
  const { hostLaunch: _launch, ...rest } = options;
  return rest;
}

export const piRuntime = {
  id: "pi",
  start: startPi,
} satisfies AgentRuntime;

/** An empty or stalled utility turn: the provider reported no error, so the
 * same request can succeed on a new attempt. Provider errors are not marked. */
function retryable(message: string): Error {
  return Object.assign(new Error(message), { retryable: true });
}

export function isRetryableUtilityError(error: unknown): boolean {
  return error instanceof Error && (error as { retryable?: unknown }).retryable === true;
}

/** Runs a short, tool-free PI call without creating a durable transcript. Used
 * for HUI-owned utility work such as concise titles and side questions. */
export async function runPiUtilityPrompt(options: {
  cwd: string;
  model: string;
  prompt: string;
  timeoutMs?: number;
  agentDir?: string;
  /** `auto` (default): the cheapest level the model is actually sent (see
   * thinking-level.ts). Any other value is passed to PI as-is; evals use
   * `off` to reproduce the plain request. */
  thinking?: string;
}): Promise<string> {
  const thinking = options.thinking ?? "auto";
  const session = await startPi({
    cwd: options.cwd,
    model: options.model,
    // The CLI fallback cannot inspect the model and receives plain "off".
    thinking: thinking === "auto" ? "off" : thinking,
    lowestThinking: thinking === "auto",
    noSession: true,
    safeProbe: true,
    ...(options.agentDir ? { agentDir: options.agentDir } : {}),
  });
  const timeoutMs = options.timeoutMs ?? 30_000;
  const sentAt = Date.now();
  try {
    return await new Promise<string>((resolve, reject) => {
      let finished = false;
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        unsubscribe();
        if (error) {
          reject(error);
          return;
        }
        const transcript = session.transcript();
        const answer = transcript
          .filter((entry): entry is Extract<TranscriptEntry, { kind: "message" }> =>
            entry.kind === "message" && entry.role === "assistant",
          )
          .at(-1)?.text.trim();
        if (answer) {
          resolve(answer);
          return;
        }
        // A provider failure (quota, auth, 5xx) settles the turn with an error
        // entry and no text; report it instead of a generic empty answer.
        const failure = transcript.findLast((entry) => entry.kind === "error");
        if (failure?.kind === "error" && failure.message.trim()) {
          reject(new Error(failure.message.trim()));
          return;
        }
        // Reasoning models can spend the whole turn thinking and end without
        // text. Say so, since the fix (reasoning level, output budget) differs.
        const reasoning = transcript.filter((entry) => entry.kind === "thinking");
        const tokens = reasoning.reduce((sum, entry) => sum + (entry.metrics?.outputTokens ?? 0), 0);
        const after = ` after ${Math.round((Date.now() - sentAt) / 1000)}s`;
        reject(retryable(reasoning.length
          ? `The utility model returned only reasoning and no answer${after}${tokens ? ` (${tokens} output tokens)` : ""}.`
          : `The utility model returned no answer${after}.`));
      };
      const unsubscribe = session.subscribe((event) => {
        if (event.type === "settled") finish();
        else if (event.type === "error") finish(new Error(event.message));
      });
      const timer = setTimeout(() => {
        void session.abort?.().catch(() => undefined);
        finish(retryable("The utility model timed out."));
      }, timeoutMs);
      timer.unref?.();
      void session.prompt(options.prompt).catch((error: unknown) => {
        finish(error instanceof Error ? error : new Error("The utility model call failed."));
      });
    });
  } finally {
    session.dispose();
  }
}
