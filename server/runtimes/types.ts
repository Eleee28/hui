/**
 * The contract every tool adapter implements.
 *
 * OpenClaw splits this the same way: an *embedded harness* runs the agent loop
 * in-process, a *CLI backend* spawns a process, and a runtime is selected per
 * model rather than per session. HUI only needs the part a UI talks to, so the
 * contract is deliberately tiny — start or resume a session, send a prompt, and
 * stream what comes back.
 *
 * Two adapters exist: `durable` (Pi Durable, the default for new sessions)
 * and `pi` (PI's SDK worker, kept for existing sessions and as a fallback).
 * Another harness can slot in beside them without any of the UI changing.
 */
import type { TranscriptMetrics } from "./transcript-metrics.ts";
export type { RuntimeInspection, RuntimeTool, ToolCatalogEntry, ToolsCatalog, SessionTools } from "../api/tools.ts";
export type {
  CompactionReason, QueuedMessage, RuntimeCommand, RuntimeCompaction, RuntimeModel, RuntimeQuestion, RuntimeQueue, RuntimeUsage,
} from "../api/session-events.ts";
import type { CompactionReason, RuntimeCommand, RuntimeModel, RuntimeQuestion, RuntimeQueue, RuntimeUsage } from "../api/session-events.ts";
import type { CallRecord } from "../calls-format.ts";

export type RuntimeQuestionResponse = { value: string } | { confirmed: boolean };

/** Everything the browser needs to draw a turn, normalised across tools. */
export type RuntimeEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool_start"; id: string; name: string; args?: unknown }
  | { type: "tool_update"; id: string; name: string; output?: string; details?: unknown }
  | { type: "tool_end"; id: string; name: string; output?: string; details?: unknown; failed?: boolean }
  | { type: "queue_update"; queue: RuntimeQueue }
  | { type: "question"; question: RuntimeQuestion }
  | { type: "notice"; message: string; level: "info" | "warning" | "error"; recovery?: true }
  | { type: "turn_start" }
  | { type: "turn_end" }
  /** `blocking` and `background` as in `RuntimeCompaction`; absent, it blocks and is not background. */
  | { type: "compaction_start"; reason: CompactionReason; blocking?: false; background?: true }
  /** `willRetry`: PI resumes the overflowed turn itself after a summary. */
  | { type: "compaction_end"; reason: CompactionReason; outcome: "done" | "failed" | "cancelled"; willRetry: boolean; message?: string }
  /** The agent stopped entirely. Distinct from `turn_end`: a turn can end while
   * the agent is still working, and the prompt guard follows this one. */
  | { type: "settled"; historyRefreshed?: boolean }
  /** Entries written outside a run (a call's lines) changed the history. Never sent to a browser: an idle session
   * answers it with a fresh snapshot, a busy one shows them when its turn settles. */
  | { type: "history" }
  /** `output` holds the last lines the runtime process wrote to stderr before
   * it failed. It feeds diagnostics only and is never sent to a browser. */
  | { type: "error"; message: string; output?: string };

/** A PI entry id, or a user message the browser shows without one yet (the
 * running prompt or one delivered mid-run), counted from the end of the branch. */
export type RuntimeRewindTarget = string | { userFromEnd: number };

export type RuntimeRewindOptions = {
  /** Stop before a selected user entry so its text can be edited and resent. */
  excludeUserMessage?: boolean;
};

/** One attachment travelling with a prompt. Images go to the model natively; a
 * file is stored by the gateway and handed over as a path the agent can read
 * with its own tools. */
export type PromptAttachment =
  | { kind: "image"; mimeType: string; dataBase64: string; name: string }
  | { kind: "file"; path: string; name: string };

export type StartOptions = {
  /** The directory the agent works in. */
  cwd: string;
  /** Runtime resume reference (PI session file path). Absent means a fresh conversation. */
  sessionFile?: string;
  /** Display name, when the tool supports one. */
  title?: string;
  /** `provider/id` to start on, when the tool supports choosing one. */
  model?: string;
  /** Reasoning budget. */
  thinking?: string;
  /** HUI registry id. PI extensions use it to address their private, local
   * coordination bridge without exposing session state to the browser. */
  huiSessionId?: string;
  /** Remote worker that hosts the session; absent means this machine. */
  worker?: string;
};

/** A caller-owned input identity, deduplicated by runtimes that expose tracked prompt receipts. */
export type RuntimePromptOptions = { requestId: string };
/** The answer recorded for one tracked input, independent of later turns in its conversation. */
export type RuntimePromptResult = { summary?: string };

export type RuntimeSession = {
  /** Root process owned by this runtime, when the adapter launches one. HUI
   * uses it only for ephemeral resource telemetry; it is never persisted. */
  readonly processId?: number;
  /** A fresh read of the initialized registry and effective prompt. */
  inspect?(): Promise<import("../api/tools.ts").RuntimeInspection>;
  /** The owning runtime's conversation identity. */
  readonly sessionId: string;
  /** Where the conversation is stored, once the tool has decided. */
  readonly sessionFile: string | undefined;
  readonly isStreaming: boolean;
  /** The runtime itself continues runs interrupted by a gateway restart, so
   * HUI must never replay them with a recovery prompt. */
  readonly resumesInterruptedRuns?: boolean;
  prompt(text: string, attachments?: readonly PromptAttachment[], options?: RuntimePromptOptions): Promise<void>;
  /** Queue an instruction before the next model call while the agent is busy. */
  steer?(text: string, attachments?: readonly PromptAttachment[]): Promise<void>;
  /** Queue work to begin only after the current agent run has settled. */
  followUp?(text: string, attachments?: readonly PromptAttachment[], options?: RuntimePromptOptions): Promise<void>;
  /** Reacquire and await an already-admitted input by its caller-owned identity. Never sends new input. */
  waitForTrackedPrompt?(requestId: string): Promise<RuntimePromptResult>;
  /** Withdraw that queued input or abort only the active task that owns it, never a later, unrelated run. */
  cancelTrackedPrompt?(requestId: string): Promise<void>;
  /** Returns an unsubscribe function. */
  subscribe(listener: (event: RuntimeEvent) => void): () => void;
  /*
   * Model and abort are optional: a tool that cannot do them should not have to
   * pretend. The gateway reports what a runtime offers rather than showing a
   * control that silently does nothing.
   */
  /** The model in use, when the tool can report it. */
  currentModel?(): RuntimeModel | undefined;
  /** Context and latest-run usage reported by the runtime. */
  currentUsage?(): RuntimeUsage | undefined;
  /** Models this tool can switch to. */
  listModels?(): Promise<readonly RuntimeModel[]>;
  /** Commands actually loaded in this session's workspace. */
  listCommands?(): Promise<readonly RuntimeCommand[]>;
  /** Switch model for the rest of the session. */
  setModel?(provider: string, id: string): Promise<void>;
  currentThinking?(): string | undefined;
  setThinking?(level: string): Promise<void>;
  /** Fast mode: the session's requests to a model with one (`RuntimeModel.fast`) ask for it. */
  currentFast?(): boolean;
  setFast?(on: boolean): Promise<void>;
  pendingQueue?(): RuntimeQueue;
  pendingQuestions?(): readonly RuntimeQuestion[];
  respondQuestion?(id: string, response: RuntimeQuestionResponse): Promise<void>;
  cancelQuestion?(id: string): Promise<void>;
  /** Stop the turn in flight, keeping the session. */
  abort?(): Promise<void>;
  /** Replace the runtime conversation with a fresh one while keeping HUI's
   * session metadata and leaving the previous runtime transcript untouched. */
  clear?(): Promise<void>;
  /** Re-read extensions, skills, prompts and context files in place. */
  reload?(): Promise<void>;
  /** Start a summary of older context; compaction events report progress and outcome. */
  compact?(instructions?: string): Promise<void>;
  /** Cancel a manual compaction run beside the conversation (`blocking: false`),
   * resolving once its end is reported. Stop cancels one that blocks. */
  cancelCompaction?(): Promise<void>;
  /** Move the active leaf without deleting the branch being left. */
  rewind?(target: RuntimeRewindTarget, options?: RuntimeRewindOptions): Promise<void>;
  /** Copy the history up to a history entry (the latest one when absent) into a
   * new conversation and return its resume reference. This session is unchanged
   * and may keep running; the copy starts idle, working in `cwd` when given
   * (a new worktree) and in this session's directory otherwise. */
  fork?(entryId?: string, options?: { cwd?: string }): Promise<string>;
  /** Resume the model from the current non-assistant tail without a user prompt. */
  continueRun?(): Promise<void>;
  /** Fires when the tool's process ends on its own, so a gateway can mark the
   * session failed rather than wait on a session that is already gone. A
   * runtime hosted elsewhere also fires it, with `unreachable`, when only the
   * connection to it ended and the session goes on there. */
  onExit?(listener: (unreachable?: RuntimeUnreachableError) => void): () => void;
  /** Bytes of an image attached to a history message, located by the
   * `source` of a transcript attachment. */
  attachmentImage?(message: number, image: number): Promise<{ mimeType: string; data: Buffer } | undefined>;
  /** Stored path of a file the user attached; the gateway confines it to HUI's attachment store. */
  attachmentFile?(message: number, file: number): string | undefined;
  /** Messages already in the conversation, for a first paint. */
  transcript(): TranscriptEntry[];
  dispose(): void;
};

/** An attachment shown on a transcript message. `source` locates its bytes
 * inside the runtime's history and is replaced by an opaque gateway `url`
 * before leaving the server. */
export type TranscriptAttachment = {
  name: string;
  kind: "image" | "file";
  mimeType?: string;
  url?: string;
  source?: { message: number; image: number } | { message: number; file: number };
};

export type TranscriptEntry = { metrics?: TranscriptMetrics } & (
  | {
      kind: "message";
      role: "user" | "assistant";
      text: string;
      /** PI session entry the message came from; the rewind target. */
      entryId?: string;
      /** Files or images the user attached to that turn. */
      attachments?: readonly TranscriptAttachment[];
    }
  /** The record of a GPT-Live call with a bot: one card with its summary and transcript. No turn ran for it. */
  | ({ kind: "call" } & CallRecord)
  /** Where PI summarized everything before its kept window. */
  | { kind: "compaction"; summary: string; tokensBefore: number }
  | { kind: "thinking"; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      args?: unknown;
      output?: string;
      details?: unknown;
      failed?: boolean;
    }
  | { kind: "error"; message: string });

export type AgentRuntime = {
  /** Runtime adapter ID, such as `pi`. */
  readonly id: string;
  start(options: StartOptions): Promise<RuntimeSession>;
};

/** The host of a runtime that runs elsewhere cannot be reached, which says
 * nothing about the session: it goes on there. `reconnecting` says whether
 * HUI retries by itself. */
export class RuntimeUnreachableError extends Error {
  readonly reconnecting: boolean;

  constructor(message: string, reconnecting: boolean) {
    super(message);
    this.name = "RuntimeUnreachableError";
    this.reconnecting = reconnecting;
  }
}

/** A runtime that failed to start, with the process output that explains why.
 * `message` is user-facing; `output` feeds diagnostics only. */
export class RuntimeOutputError extends Error {
  readonly output: string;

  constructor(message: string, output: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeOutputError";
    this.output = output;
  }
}
