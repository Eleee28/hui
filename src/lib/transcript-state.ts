/**
 * Client-side transcript reducer: normalising transcript entries from the gateway and folding streamed
 * runtime events into rows, including optimistic user messages until the runtime accepts them. The runtime's
 * transcript stays authoritative; these rows are a projection for rendering.
 */
import { sanitizeMetrics } from "./transcript-metrics.ts";
import type { RuntimeEvent, TranscriptAttachment, TranscriptItem } from "../api/sessions.ts";
import { parseCallRecord } from "./voice/calls.ts";

let localSequence = 0;

export function localTranscriptId(prefix: string): string {
  localSequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${localSequence.toString(36)}`;
}

type TranscriptProjection = { streaming?: boolean };

/** Keeps the reducer tolerant while an older gateway is still running. */
export function normalizeTranscript(
  entries: readonly unknown[],
  projection: TranscriptProjection = {},
): TranscriptItem[] {
  const lastUser = entries.findLastIndex((raw) => {
    if (!raw || typeof raw !== "object") return false;
    const entry = raw as Record<string, unknown>;
    return (entry.kind === "message" || entry.kind === undefined) && entry.role === "user";
  });
  const activeAssistant = projection.streaming
    ? entries.findLastIndex((raw, index) => {
        if (index <= lastUser || !raw || typeof raw !== "object") return false;
        const entry = raw as Record<string, unknown>;
        return (
          !(typeof entry.id === "string" && entry.id) &&
          (entry.kind === "message" || entry.kind === undefined) &&
          entry.role === "assistant"
        );
      })
    : -1;
  const activeThinking = projection.streaming
    ? entries.findLastIndex((raw, index) => {
        if (index <= lastUser || !raw || typeof raw !== "object") return false;
        const entry = raw as Record<string, unknown>;
        return !(typeof entry.id === "string" && entry.id) && entry.kind === "thinking";
      })
    : -1;
  const result: TranscriptItem[] = [];
  entries.forEach((raw, index) => {
    if (!raw || typeof raw !== "object") return;
    const entry = raw as Record<string, unknown>;
    const metrics = sanitizeMetrics(entry.metrics);
    const metadata = Object.keys(metrics).length ? { metrics } : {};
    const id =
      typeof entry.id === "string" && entry.id
        ? entry.id
        : index === activeAssistant
          ? "streaming-assistant"
          : index === activeThinking
            ? "streaming-thinking"
            : `history-${index}`;
    if (entry.kind === "thinking" && typeof entry.text === "string") {
      result.push({ kind: "thinking", id, text: entry.text, ...metadata });
      return;
    }
    if (entry.kind === "tool" && typeof entry.name === "string") {
      const failed = entry.failed === true;
      result.push({
        kind: "tool",
        ...metadata,
        id,
        name: entry.name,
        ...(entry.args !== undefined ? { args: entry.args } : {}),
        ...(typeof entry.output === "string" ? { output: entry.output } : {}),
        ...(entry.details !== undefined ? { details: entry.details } : {}),
        failed,
        status:
          entry.status === "running" || entry.status === "failed" || entry.status === "succeeded"
            ? entry.status
            : failed
              ? "failed"
              : typeof entry.output === "string"
                ? "succeeded"
                : "running",
      });
      return;
    }
    if (entry.kind === "compaction" && typeof entry.summary === "string") {
      result.push({ kind: "compaction", id, summary: entry.summary, tokensBefore: typeof entry.tokensBefore === "number" ? entry.tokensBefore : 0 });
      return;
    }
    // A GPT-Live call's record: one card (chat-call.ts).
    if (entry.kind === "call") {
      const record = parseCallRecord(entry);
      if (record) result.push({ kind: "call", id, ...record });
      return;
    }
    if (entry.kind === "error" && (typeof entry.text === "string" || typeof entry.message === "string")) {
      result.push({ kind: "error", id, text: (entry.text ?? entry.message) as string });
      return;
    }
    const role = entry.role;
    if ((entry.kind === "message" || entry.kind === undefined) && (role === "user" || role === "assistant")) {
      const message: TranscriptItem = {
        kind: "message",
        ...metadata,
        id,
        ...(typeof entry.entryId === "string" ? { entryId: entry.entryId } : {}),
        role,
        text: typeof entry.text === "string" ? entry.text : "",
        ...(Array.isArray(entry.attachments) ? { attachments: entry.attachments as (string | TranscriptAttachment)[] } : {}),
      };
      result.push(message);
      if (typeof entry.error === "string" && entry.error) {
        result.push({ kind: "error", id: `${id}-error`, text: entry.error });
      }
    }
  });
  return result;
}

function updateById(
  items: readonly TranscriptItem[],
  id: string,
  update: (item: TranscriptItem) => TranscriptItem,
): TranscriptItem[] {
  const index = items.findIndex((item) => item.id === id);
  if (index < 0) return [...items];
  const next = [...items];
  next[index] = update(next[index]!);
  return next;
}

function updateAt(
  items: readonly TranscriptItem[],
  index: number,
  update: (item: TranscriptItem) => TranscriptItem,
): TranscriptItem[] {
  if (index < 0) return [...items];
  const next = [...items];
  next[index] = update(next[index]!);
  return next;
}

function latestToolIndex(items: readonly TranscriptItem[], id: string): number {
  return items.findLastIndex((item) => item.kind === "tool" && item.id === id);
}

export function reduceTranscript(
  items: readonly TranscriptItem[],
  event: RuntimeEvent,
): TranscriptItem[] {
  switch (event.type) {
    case "text": {
      const id = event.id ?? "streaming-assistant";
      const index = items.findLastIndex(
        (item) => item.id === id && item.kind === "message" && item.role === "assistant",
      );
      const current = index >= 0 ? items[index] : undefined;
      if (current?.kind === "message" && current.role === "assistant") {
        return updateAt(items, index, (item) => ({
          ...(item as Extract<TranscriptItem, { kind: "message" }>),
          text: (item as Extract<TranscriptItem, { kind: "message" }>).text + event.delta,
        }));
      }
      return [...items, { kind: "message", id, role: "assistant", text: event.delta }];
    }
    case "thinking": {
      const id = event.id ?? "streaming-thinking";
      const index = items.findLastIndex((item) => item.id === id && item.kind === "thinking");
      const current = index >= 0 ? items[index] : undefined;
      if (current?.kind === "thinking") {
        return updateAt(items, index, (item) => ({
          ...(item as Extract<TranscriptItem, { kind: "thinking" }>),
          text: (item as Extract<TranscriptItem, { kind: "thinking" }>).text + event.delta,
        }));
      }
      return [...items, { kind: "thinking", id, text: event.delta }];
    }
    case "tool_start":
      return [
        ...items,
        {
          kind: "tool",
          id: event.id,
          name: event.name,
          ...(event.args !== undefined ? { args: event.args } : {}),
          status: "running",
        },
      ];
    case "tool_update": {
      const index = latestToolIndex(items, event.id);
      const current = index >= 0 ? items[index] : undefined;
      if (current?.kind !== "tool") {
        return [
          ...items,
          {
            kind: "tool",
            id: event.id,
            name: event.name ?? "tool",
            output: event.output,
            ...(event.details !== undefined ? { details: event.details } : {}),
            status: "running",
          },
        ];
      }
      return updateAt(items, index, (item) => ({
        ...(item as Extract<TranscriptItem, { kind: "tool" }>),
        ...(event.output !== undefined ? { output: event.output } : {}),
        ...(event.details !== undefined ? { details: event.details } : {}),
      }));
    }
    case "tool_end": {
      const index = latestToolIndex(items, event.id);
      const current = index >= 0 ? items[index] : undefined;
      const completed: TranscriptItem = {
        kind: "tool",
        id: event.id,
        name: event.name,
        ...(current?.kind === "tool" && current.args !== undefined ? { args: current.args } : {}),
        ...(event.output !== undefined ? { output: event.output } : {}),
        ...(event.details !== undefined ? { details: event.details } : {}),
        failed: event.failed === true,
        status: event.failed ? "failed" : "succeeded",
      };
      return current ? updateAt(items, index, () => completed) : [...items, completed];
    }
    case "error":
      return [...items, { kind: "error", id: localTranscriptId("error"), text: event.message }];
    default:
      return [...items];
  }
}

export function appendPendingUser(
  items: readonly TranscriptItem[],
  id: string,
  text: string,
  attachments: readonly (string | TranscriptAttachment)[],
): TranscriptItem[] {
  return [
    ...items,
    {
      kind: "message",
      id,
      role: "user",
      text,
      ...(attachments.length ? { attachments } : {}),
      pending: true,
    },
  ];
}

/** The gateway's copy of a prompt this screen just sent has no image previews until PI's history
 * holds it: keep the local previews meanwhile, rather than flipping the images to file cards. */
export function keepSentPreviews(next: TranscriptItem[], previous: readonly TranscriptItem[]): TranscriptItem[] {
  const isUser = (item: TranscriptItem) => item.kind === "message" && item.role === "user";
  const hasPreview = (item: TranscriptItem | undefined) =>
    item?.kind === "message" && item.attachments?.some((attachment) => typeof attachment !== "string" && attachment.url);
  const index = next.findLastIndex(isUser);
  const incoming = next[index];
  const local = previous.findLast(isUser);
  if (incoming?.kind !== "message" || local?.kind !== "message" || !incoming.attachments?.length
    || hasPreview(incoming) || !hasPreview(local) || local.text !== incoming.text) return next;
  return next.with(index, { ...incoming, attachments: local.attachments! });
}

export function settlePendingUser(
  items: readonly TranscriptItem[],
  id: string,
  accepted: boolean,
): TranscriptItem[] {
  return updateById(items, id, (item) =>
    item.kind === "message" ? { ...item, pending: false, failed: !accepted } : item,
  );
}
