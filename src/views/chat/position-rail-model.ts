/**
 * Pure model for the conversation position rail: which messages get a marker, which one is current at a scroll
 * position, and how keys move between markers. It reads projected rows and measured positions only; the view does
 * the measuring and scrolling.
 */
import { attributedMessage, type ChatProjectionRow, type MessageSender } from "./projection.ts";

export type ConversationMarker = {
  id: string;
  label: string;
  preview: string;
};

/** A message HUI delivered from someone else, by who sent it. */
const senderLabel = (sender: MessageSender) => `From ${sender.kind === "bot" ? `@${sender.handle}` : sender.kind === "session" ? sender.title
  : sender.kind === "parent" ? "the parent session" : sender.name}`;

/** Index the rendered messages, never the tools/reasoning inside disclosures. */
export function conversationMarkers(rows: readonly ChatProjectionRow[]): ConversationMarker[] {
  return rows.flatMap((row) => row.kind === "messages" ? row.messages.map((message) => {
    const shown = row.sender ? attributedMessage(message.text)?.body ?? message.text : message.text;
    const text = (shown.trim() || message.attachments?.join(", ") || "Empty message").replace(/\s+/g, " ");
    // Bound by code points so previews cannot split an emoji's surrogate pair.
    const preview = Array.from(text).slice(0, 140).join("");
    return {
      id: message.id,
      label: row.sender ? senderLabel(row.sender) : message.role === "user" ? "User message" : "Assistant message",
      preview: preview.length < text.length ? `${preview}…` : preview,
    };
  }) : []);
}

export type MessagePosition = { id: string; top: number; bottom: number };

/** The message at the viewport centre, or the final message at the live edge. */
export function conversationPosition(
  positions: readonly MessagePosition[],
  scrollTop: number,
  viewportHeight: number,
  scrollHeight: number,
): { activeId: string | undefined; visibleIds: Set<string> } {
  const visibleIds = new Set(positions.filter((p) => p.bottom > scrollTop && p.top < scrollTop + viewportHeight).map((p) => p.id));
  const activeId = scrollHeight - scrollTop - viewportHeight <= 1
    ? positions.at(-1)?.id
    : (positions.findLast((p) => p.top <= scrollTop + viewportHeight / 2) ?? positions[0])?.id;
  return { activeId, visibleIds };
}

export function conversationFocusIndex(key: string, index: number, count: number): number | undefined {
  if (!count) return undefined;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowUp" || key === "ArrowLeft") return Math.max(0, index - 1);
  if (key === "ArrowDown" || key === "ArrowRight") return Math.min(count - 1, index + 1);
  return undefined;
}
