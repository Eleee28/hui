/**
 * Pure rules for the state of the session shown in Home: merging live statuses, when the composer is locked
 * or released, when to ask for models and flush a launch prompt, and guards that drop late results from a
 * previous session or request.
 */
import type {
  Attachment,
  RuntimeCompaction,
  RuntimeEvent,
  RuntimeModel,
  RuntimeUsage,
  SessionConnection,
  SessionGroup,
  SessionStatus,
  TranscriptItem,
} from "../../api/sessions.ts";

/** A multiplex snapshot is complete for live runtimes. Any registry row it
 * omits is cold, so its process-local status is idle. */
export function mergeSessionStatuses(
  groups: readonly SessionGroup[],
  statuses: ReadonlyMap<string, SessionStatus>,
): SessionGroup[] {
  return groups.map((group) => ({
    ...group,
    sessions: group.sessions.map((session) => ({
      ...session,
      status: statuses.get(session.id) ?? "idle",
    })),
  }));
}

/** Severity of the transient chat notification; it picks the toast's icon and live region. */
export type NoteLevel = "info" | "warning" | "error";

/** The chat note and the recovery notice the current run is narrating, if any. */
type NoteState = { note: string; noteLevel: NoteLevel; recoveryNotice: string };

/**
 * A runtime notice becomes the note. A recovery notice narrates a retry inside
 * the run (a provider retry or the model fallback): once the run settles or
 * fails, its outcome supersedes it, so the toast closes unless another note has
 * replaced it. Any other notice, such as a refused command, stays.
 */
export function noteAfterEvent(state: NoteState, event: RuntimeEvent): NoteState {
  if (event.type === "notice") return { note: event.message, noteLevel: event.level ?? "info", recoveryNotice: event.recovery ? event.message : "" };
  if (event.type !== "settled" && event.type !== "error") return state;
  return state.recoveryNotice && state.note === state.recoveryNotice
    ? { note: "", noteLevel: "info", recoveryNotice: "" }
    : { ...state, recoveryNotice: "" };
}

/** Only errors interrupt assistive technology; other notes are polite status. */
export function noteAnnouncement(level: NoteLevel): "alert" | "status" {
  return level === "error" ? "alert" : "status";
}

/** State that belongs to the session currently shown in Home. */
export type SessionPresentationState = {
  transcript: readonly TranscriptItem[];
  opening: boolean;
  streaming: boolean;
  note: string;
  noteLevel: NoteLevel;
  connectionNote: string;
  models: readonly RuntimeModel[];
  currentModel: RuntimeModel | undefined;
  usage: RuntimeUsage | undefined;
  attachments: readonly Attachment[];
};

/**
 * A successful delete or an explicit close must not leave feedback from the
 * old session on Home. Return fresh arrays so subsequent sessions cannot
 * accidentally share mutable presentation state.
 */
export function emptySessionPresentation(): SessionPresentationState {
  return {
    transcript: [],
    opening: false,
    streaming: false,
    note: "",
    noteLevel: "info",
    connectionNote: "",
    models: [],
    currentModel: undefined,
    usage: undefined,
    attachments: [],
  };
}

/**
 * Model discovery needs a live runtime. Mark the request before issuing it,
 * then repeated idle/status frames cannot create a request loop.
 */
export function shouldRequestModels(
  sessionId: string,
  status: SessionStatus,
  requestedFor: string,
): boolean {
  return requestedFor !== sessionId && (
    status === "idle" || status === "running" || status === "waiting"
  );
}

/** A turn event can lock the composer, but only status can settle it again. */
export function streamingAfterEvent(
  streaming: boolean,
  event: "turn_start" | "turn_end" | "settled",
): boolean {
  return event === "turn_start" ? true : streaming;
}

/** A running compaction the session's run waits for (PI's, or Durable's
 * blocking one); its divider stands in for the working indicator. One the
 * runtime runs beside the conversation leaves the run working. */
export function compactionBlocks(compaction: RuntimeCompaction | undefined): boolean {
  return compaction?.status === "running" && compaction.blocking !== false;
}

/** The runtime status frame is authoritative for composer availability. */
export function streamingForStatus(status: SessionStatus): boolean {
  return status === "running" || status === "waiting";
}

/**
 * A prompt composed on New Session belongs to the new session, but PI may
 * still be booting when the create request resolves. Release it exactly once
 * after both the runtime and its event stream are ready.
 */
export function shouldFlushLaunchPrompt(
  prompt: string,
  status: SessionStatus | undefined,
  connection: SessionConnection,
  opening: boolean,
): boolean {
  return prompt.length > 0 && status === "idle" && connection === "live" && !opening;
}

/** Guards asynchronous results against a session switch or deletion. */
export function isSelectedSession(sessionId: string, selectedId: string | undefined): boolean {
  return sessionId === selectedId;
}

/**
 * An open response belongs to both a session and one concrete attempt. Session
 * identity alone is insufficient: retry A2 can finish before stale A1.
 */
export function isCurrentSessionRequest(
  sessionId: string,
  selectedId: string | undefined,
  requestToken: number,
  currentToken: number,
): boolean {
  return sessionId === selectedId && requestToken === currentToken;
}

/**
 * A failed list request may retry on a later ready status for the same active
 * session. A late failure from an old session must not release the new gate.
 */
export function modelRequestMarkerAfterFailure(
  requestedFor: string,
  failedSessionId: string,
  selectedId: string | undefined,
): string {
  return requestedFor === failedSessionId && selectedId === failedSessionId
    ? ""
    : requestedFor;
}
