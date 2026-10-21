/**
 * Pure rules for the chat composer: what Enter does, when a draft may be sent, how a prompt locks and
 * unlocks it, and how a rejected submission comes back without overwriting newer text. The view holds the
 * state; these helpers keep its transitions testable.
 */
import type {
  Attachment,
  PromptMode,
  QueueSnapshot,
  RuntimeQuestion,
  SessionStatus,
} from "../../api/sessions.ts";

export const EMPTY_QUEUE: QueueSnapshot = { steering: [], followUp: [] };

export function composerEnterMode(input: {
  streaming: boolean;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  isComposing: boolean;
  coarsePointer?: boolean;
  sendShortcut?: "enter" | "modifierEnter";
}): PromptMode | "newline" | undefined {
  if (input.isComposing) return undefined;
  if (input.shiftKey) return "newline";
  if (input.coarsePointer && !input.ctrlKey && !input.metaKey) return "newline";
  if (input.sendShortcut === "modifierEnter" && !input.ctrlKey && !input.metaKey) return "newline";
  if (!input.streaming) return "prompt";
  return input.ctrlKey || input.metaKey ? "followUp" : "steer";
}

/**
 * What the empty chat composer says. While a run is busy on a keyboard device it names both busy actions, so
 * queueing a follow-up for after the run is discoverable where the operator types: ⌘ on Apple platforms, Ctrl
 * elsewhere. Touch devices keep the short text, since plain Enter is a line break there and Send's hold menu
 * offers Enqueue.
 */
export function composerPlaceholder(input: {
  status?: SessionStatus;
  reconnecting: boolean;
  streaming: boolean;
  coarsePointer: boolean;
  sendShortcut?: "enter" | "modifierEnter";
  applePlatform: boolean;
}): string {
  if (input.status === "disconnected") return "Draft while disconnected…";
  if (input.reconnecting) return "Draft while HUI reconnects…";
  if (!input.streaming) return "Send a message…";
  if (input.coarsePointer) return "Add to this run…";
  const queue = `${input.applePlatform ? "⌘↵" : "Ctrl+↵"} queues for later`;
  // With the modifier-Enter preference plain Enter is a line break, so only Send steers.
  return input.sendShortcut === "modifierEnter" ? `Send adds to this run · ${queue}` : `↵ adds to this run · ${queue}`;
}

/**
 * A normal prompt locks immediately, but accepting its HTTP request must not
 * re-lock a turn that already settled over SSE. Local providers can finish the
 * whole turn while the server is still persisting the activity timestamp.
 */
export function streamingAfterSubmission(
  current: boolean,
  mode: PromptMode,
  phase: "started" | "accepted" | "rejected" | "duplicate",
  status: SessionStatus,
): boolean {
  if (mode !== "prompt") return current;
  if (phase === "started") return true;
  if (phase === "accepted") return current;
  // Rejected, or a resend of a send the gateway had already taken: nothing new started, so the session's status decides.
  return status === "running" || status === "waiting";
}

export function canSubmitComposer(input: {
  draft: string;
  hasImage: boolean;
  opening: boolean;
  sending: boolean;
  connection: "live" | "reconnecting" | "stopped";
}): boolean {
  return Boolean(input.draft.trim() || input.hasImage) && !input.opening && !input.sending && input.connection === "live";
}

/**
 * A submission is removed from the composer before its request starts, so a
 * user can begin the next draft without a late acknowledgement erasing it.
 * If the request fails, recover the old payload without overwriting newer work.
 * The UI locks during the short acknowledgement window, but merging remains a
 * defensive invariant for delayed programmatic updates.
 */
export function restoreRejectedSubmission(
  currentDraft: string,
  currentAttachments: readonly Attachment[],
  sentDraft: string,
  sentAttachments: readonly Attachment[],
): { draft: string; attachments: readonly Attachment[] } {
  return {
    draft: currentDraft ? `${sentDraft}\n\n${currentDraft}` : sentDraft,
    attachments: [...sentAttachments, ...currentAttachments],
  };
}

export function questionAnswer(
  question: RuntimeQuestion,
  value: string,
): { value?: string; confirmed?: boolean } {
  return question.method === "confirm" ? { confirmed: value === "true" } : { value };
}
