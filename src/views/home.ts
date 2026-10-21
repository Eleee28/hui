/**
 * The chat view and the New Session form, as render functions of `HomeProps`: launch form, transcript (with who sent
 * each message HUI delivered from a bot, a session, a routine or a trigger, and what the agent handed a bot),
 * composer and its pickers, queue, questions, session header and bot identity. All state arrives in props and changes
 * leave through callbacks; the app element owns that state, and the chat projection decides the transcript's rows.
 */
import { formatCount, metricSummary, relativeTime, replyDraft } from "../lib/message-metadata.ts";
import { renderDirectoryPicker } from "./directory-picker.ts";
import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { renderPaneMoveHandle } from "./pane-move-handle.ts";
import { matchesModelSearch, modelSearchText } from "../lib/model-selection.ts";
import { sessionGroupLabel, unreachableHost } from "../lib/session/sessions.ts";
import type {
  Attachment,
  RuntimeModel,
  RuntimeUsage,
  RuntimeQuestion,
  QuestionResponse,
  PromptMode,
  QueueSnapshot,
  RewindTarget,
  RuntimeCompaction,
  TranscriptAttachment,
  SessionConnection,
  SessionGroup,
  SessionStatus,
  SessionView,
  SubagentTaskView,
  TranscriptItem,
  GitCheckoutInfo,
  WorktreeProgress,
} from "../api/sessions.ts";
import { attachmentPreview } from "../lib/attachments.ts";
import { renderAttachmentFileIcon, resolveAttachmentFileIcon } from "../lib/attachment-file-icon.ts";
import { latestSubagentBatch, subagentElapsed, subagentVisualState, type SubagentVisualState } from "../lib/subagent-activity.ts";
import { composerEnterMode, composerPlaceholder } from "../lib/composer/state.ts";
import { APPLE_PLATFORM } from "../lib/shortcut-binding.ts";
import { compactionBlocks, noteAnnouncement, type NoteLevel } from "../lib/session/ui-state.ts";
import { adjustTextareaHeight as syncComposerTextarea } from "../lib/composer/textarea.ts";
import { icons } from "../lib/icons.ts";
import { isThinkingLevel, PI_THINKING_LEVELS, THINKING_LABELS, THINKING_LEVELS, type ThinkingLevel } from "../lib/thinking.ts";
import { forkPoint } from "../lib/fork-point.ts";
import { closeDropdownOnEscape, labelDropdown } from "../lib/web-awesome.ts";
import type { SplitDirection } from "../lib/session/multiplexer.ts";
import { renderAgentMarkdown, renderMarkdown } from "../lib/markdown/markdown.ts";
import "../components/file-link.ts";
import "../components/github-embeds.ts";
import "../components/datadog-embeds.ts";
import "../components/browser-preview.ts";
import "../components/widget-card.ts";
import "../components/questionnaire-card.ts";
import type { QuestionnaireQuestion, QuestionnaireResult } from "../api/schema/sessions.ts";
import { handleCodeBlockDisclosure, markdownBlocks } from "../lib/markdown/blocks.ts";
import { openMessageContextMenu } from "../lib/message-context-menu.ts";
import { progressCardFromTranscript } from "../lib/progress-card.ts";
import { mediaSizeLabel, presentedMediaFromDetails, type PresentedMediaItem } from "../lib/presented-media.ts";
import { widgetView, type WidgetView } from "../lib/widgets.ts";
import type { RunErrorNotice } from "../lib/run-error.ts";
import { renderProviderBrandIcon } from "../lib/provider-icons.ts";
import { parseSlackLink } from "../lib/markdown/slack-link.ts";
import { activityLabel, attributedMessage, browserPreviewRow, projectChatTranscript, workingLabel, type ChatActivity, type ChatMessage, type ChatProjectionRow, type MessageSender } from "./chat/projection.ts";
import { conversationMarkers } from "./chat/position-rail-model.ts";
import { positionRail } from "./chat/position-rail.ts";
import { readToolPresentation, renderReadToolCard, renderToolFileReference, toolFilePath } from "./chat/read-tool-card.ts";
import { commandToolPresentation, renderCommandToolCard } from "./chat/command-tool-card.ts";
import { codemodeToolPresentation, renderCodemodeToolCard } from "./chat/codemode-tool-card.ts";
import { renderTaskSuggestionCard, type TaskSuggestionCardProps } from "./chat/task-suggestion-card.ts";
import { renderWatcherActivity, type WatcherActivityProps } from "./chat/watcher-activity.ts";
import { browserToolSummary } from "../lib/browser-tool-display.ts";
import { toggleNavigationDrawer } from "./shell.ts";
import { renderBotAvatar } from "./bots.ts";
import { chatFaceState, hasRunningTool, type BotFaceState } from "../lib/bots/face.ts";
import { renderCallButton } from "./bot-voice.ts";
import { renderCallCard } from "./chat-call.ts";
import { botLook, previewLine, type BotView } from "../lib/bots/bots.ts";
import { navigationPath } from "../lib/navigation.ts";
import { slashCommandQuery, type CommandQuery } from "../lib/composer/slash-commands.ts";
import { renderSlashMenu, SLASH_MENU_ID, slashOptionId, type SlashMenuProps } from "./slash-menu.ts";
import { localPathQuery, type LocalPathQuery } from "../lib/local-paths.ts";
import { worktreeProgressLabel } from "../lib/worktree-progress.ts";
import {
  LOCAL_PATH_MENU_ID,
  localPathOptionId,
  renderLocalPathMenu,
  type LocalPathMenuProps,
} from "./local-path-menu.ts";
import { loadViewAssets } from "../lib/view-assets.ts";

loadViewAssets(() => import("../styles/openclaw-chat.css"), () => import("../styles/openclaw-launch.css"));

if (typeof document !== "undefined") {
  document.addEventListener("pointerdown", (event) => {
    document.querySelectorAll<HTMLDetailsElement>(".agent-chat__input details[open]").forEach((picker) => {
      if (event.target instanceof Node && !picker.contains(event.target)) picker.open = false;
    });
  });
  window.addEventListener("resize", () => {
    document.querySelectorAll<HTMLDetailsElement>(".agent-chat__input details[open]").forEach(positionNativePicker);
  });
}

const STATUS_TEXT: Record<SessionStatus, string> = {
  idle: "Idle",
  running: "Running",
  waiting: "Waiting for your answer",
  starting: "Starting",
  error: "Error",
  reconnecting: "Reconnecting",
  disconnected: "Disconnected",
};

const SEND_LONG_PRESS_MS = 450;
export const TRANSCRIPT_SCROLLER_SELECTOR = ".chat-thread";
export const QUESTION_FOCUS_SELECTOR = '.session-question-card :is([role="radio"], [role="checkbox"])[tabindex="0"], .session-question-card input:not([type="hidden"]), .session-question-card textarea';
const sendLongPressTimers = new WeakMap<HTMLElement, number>();
const consumedSendLongPresses = new WeakSet<HTMLElement>();
const composerDragDepth = new WeakMap<HTMLElement, number>();

const arrowUpIcon = icons.arrowUp;
const chevronDownIcon = icons.chevronDown;
const chevronUpIcon = icons.chevronUp;
const checkIcon = icons.check;
const circleIcon = icons.circle;
const stopIcon = icons.stop;
const copyIcon = icons.copy;
const rewindIcon = icons.rotateCcw;
const continueIcon = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 5 11 7-11 7Z"></path></svg>`;
const queueIcon = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 5H3"></path><path d="M16 12H3"></path><path d="M9 19H3"></path><path d="m16 16-3 3 3 3"></path><path d="M21 5v12a2 2 0 0 1-2 2h-6"></path></svg>`;
const gripIcon = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="9" cy="5" r="1"></circle><circle cx="15" cy="5" r="1"></circle><circle cx="9" cy="12" r="1"></circle><circle cx="15" cy="12" r="1"></circle><circle cx="9" cy="19" r="1"></circle><circle cx="15" cy="19" r="1"></circle></svg>`;
// Orbiting-dot activity mark shared by the working indicator and subagent rows.
const orbitIcon = html`<span class="hui-orbit" aria-hidden="true"><i></i><i></i><i></i></span>`;
const PASTED_TEXT_ATTACHMENT_THRESHOLD = 4_000;
function renderProviderIcon(provider: string, trigger = false) {
  return renderProviderBrandIcon(
    provider,
    trigger ? "chat-controls__trigger-provider-icon" : "chat-controls__provider-icon",
    !trigger,
  );
}

/** Render reads it for the composer's placeholder, so it answers false where there is no window (Node render tests). */
function hasCoarsePointer(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(pointer: coarse)").matches === true || navigator.maxTouchPoints > 0;
}

function updateComposerDraft(props: HomeProps, textarea: HTMLTextAreaElement) {
  props.onDraftInput(textarea.value);
  updateCompletionQueries(props, textarea);
  syncComposerTextarea(textarea);
}

function updateCompletionQueries(props: HomeProps, textarea: HTMLTextAreaElement) {
  props.onCommandQuery(slashCommandQuery(textarea.value, textarea.selectionStart, textarea.selectionEnd));
  const cwd = textarea.closest("form")?.elements.namedItem("cwd");
  props.onLocalPathQuery(
    localPathQuery(textarea.value, textarea.selectionStart, textarea.selectionEnd),
    cwd instanceof HTMLInputElement ? cwd.value : undefined,
  );
}

function onComposerPaste(props: HomeProps) {
  return (event: ClipboardEvent) => {
    if (props.sending || !event.clipboardData) return;
    const images = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (images.length > 0) {
      event.preventDefault();
      props.onAddAttachments(images);
      return;
    }
    const text = event.clipboardData.getData("text/plain");
    if (text.length < PASTED_TEXT_ATTACHMENT_THRESHOLD) return;
    event.preventDefault();
    props.onAddAttachments([new File([text], "pasted-text.txt", { type: "text/plain" })]);
  };
}

function hasDraggedFiles(transfer: DataTransfer | null): boolean {
  return transfer !== null && Array.from(transfer.types).includes("Files");
}

function onComposerDragEnter(event: DragEvent) {
  const surface = event.currentTarget;
  if (!(surface instanceof HTMLElement) || !hasDraggedFiles(event.dataTransfer)) return;
  const depth = (composerDragDepth.get(surface) ?? 0) + 1;
  composerDragDepth.set(surface, depth);
  surface.setAttribute("data-attachment-drop-active", "");
  surface.closest(".chat")?.setAttribute("data-attachment-drop-active", "");
}

function onComposerDragLeave(event: DragEvent) {
  const surface = event.currentTarget;
  if (!(surface instanceof HTMLElement)) return;
  const depth = Math.max(0, (composerDragDepth.get(surface) ?? 0) - 1);
  composerDragDepth.set(surface, depth);
  if (depth === 0) clearComposerDrag(surface);
}

function clearComposerDrag(surface: HTMLElement) {
  composerDragDepth.delete(surface);
  surface.removeAttribute("data-attachment-drop-active");
  surface.closest(".chat")?.removeAttribute("data-attachment-drop-active");
}

function focusComposerFromSurface(event: MouseEvent) {
  const target = event.target;
  if (!(target instanceof Element) || target.closest("button, summary, select, input, textarea, details, a")) return;
  (event.currentTarget as HTMLElement).querySelector<HTMLTextAreaElement>("textarea")?.focus();
}

export type HomeProps = {
  session: SessionView | undefined;
  /** File references in the agent's replies and tool cards may open in this conversation's Files view. */
  fileLinks?: boolean;
  mobileNavLayout?: boolean;
  groups: readonly SessionGroup[];
  /** Any session by id, a bot's chat and subagents included (session lists leave those out): names and links the
   * session a message came from. */
  findSession: (id: string) => SessionView | undefined;
  transcript: readonly TranscriptItem[];
  subagents: readonly SubagentTaskView[];
  /** Waiting on the server to open or start the runtime. */
  opening: boolean;
  /** The open request failed, so there is no transcript to show; onRetry asks again. */
  openError?: string;
  /** A turn is in flight, so the composer is locked. */
  streaming: boolean;
  sending: boolean;
  stopping: boolean;
  continuing: boolean;
  rewindPending: boolean;
  forkPending: boolean;
  draft: string;
  chatPreferences: {
    collapseTaskProgress: boolean;
    sendShortcut: "enter" | "modifierEnter";
    githubEmbeds: boolean;
    datadogEmbeds: boolean;
  };
  queue: QueueSnapshot;
  thinking: string;
  /** Fast mode; absent while the runtime cannot change speed. */
  fast?: boolean;
  question: RuntimeQuestion | undefined;
  connection: SessionConnection;
  copiedId: string;
  /** Activity disclosures explicitly opened by the user. Runs are collapsed by default. */
  expandedActivityIds: ReadonlySet<string>;
  showScrollToBottom: boolean;
  /** Models the session can switch to; empty when the tool cannot list any. */
  models: readonly RuntimeModel[];
  /** The model in use, when the tool reports one. */
  currentModel: RuntimeModel | undefined;
  usage: RuntimeUsage | undefined;
  /** A running compaction, or one that ended without a summary. */
  compaction: RuntimeCompaction | undefined;
  /** Files picked but not yet sent. */
  attachments: readonly Attachment[];
  launching: boolean;
  note: string;
  noteLevel: NoteLevel;
  sideChat?: {
    question: string;
    answer: string;
    model: string;
    loading: boolean;
    error: string;
  };
  onCloseSideChat: () => void;
  onDismissNote: () => void;
  /** A muted line about the event stream: reconnecting, or why it stopped. */
  connectionNote: string;
  onLaunch: (input: { cwd: string; title?: string; group?: string; prompt?: string; commandDraft?: string; model?: string; thinking?: string; fast?: boolean; worktree?: boolean; branchName?: string; baseRef?: string; worker?: string }) => void;
  onSelectSession: (session: SessionView) => void;
  /** Pane identity keeps controls unique when the same session is split twice. */
  controlScope?: string;
  onSplitPane?: (direction: SplitDirection) => void;
  onOpenTerminal?: () => void;
  /** Shown once the agent has used the browser in this conversation. */
  onOpenBrowser?: () => void;
  /** Live preview of the agent's browser under its latest browser activity;
   * absent while the browser tool is off. `visible` is false for hidden panes. */
  browserPreview?: { visible: boolean; onExpand?: () => void };
  terminalOpening?: boolean;
  terminalError?: string;
  /** Present while the workspace has more than one pane. */
  onClosePane?: () => void;
  paneMovable?: boolean;
  onSelectSubagent: (sessionId: string) => void;
  /** Pending `suggest_task` cards for the open session. */
  taskSuggestions?: TaskSuggestionCardProps;
  /** HUI-run background watchers for the open session. */
  watchers?: WatcherActivityProps;
  onDraftChange: (draft: string) => void;
  onDraftInput: (draft: string) => void;
  commandMenu: SlashMenuProps;
  onCommandQuery: (query: CommandQuery | null) => void;
  onCommandKeydown: (event: KeyboardEvent) => void;
  localPathMenu: LocalPathMenuProps;
  onLocalPathQuery: (query: LocalPathQuery | null, cwd?: string) => void;
  onLocalPathKeydown: (event: KeyboardEvent) => void;
  onSendPrompt: (text: string, attachments: readonly Attachment[], mode: PromptMode) => void;
  onContinueInterrupted: () => void;
  queueEditingId: string;
  queueEditingText: string;
  onQueueEdit: (id: string) => void;
  onQueueEditChange: (text: string) => void;
  onQueueEditSubmit: () => void;
  onQueueEditCancel: () => void;
  onQueueRemove: (id: string) => void;
  onQueueMove: (id: string, toIndex: number) => void;
  onQueueSteer: (id: string) => void;
  /** The settled run's terminal error, unless the operator dismissed it. */
  runError?: RunErrorNotice;
  onContinueAfterError: () => void;
  onDismissRunError: () => void;
  onSelectModel: (provider: string, modelId: string) => void;
  onSelectThinking: (level: string) => void;
  onSelectFast: (fast: boolean) => void;
  onAbort: () => void;
  onContinue: () => void;
  /** Rewind to before a user message, restoring its text and attachments to the composer. */
  onRewind: (target: RewindTarget, text: string, attachments?: readonly (string | TranscriptAttachment)[]) => void;
  /** Copies the history up to a reply into a new session and opens it; this session is left as it is. */
  onFork: (entryId: string) => void;
  /** Same as sending `/compact`. */
  onCompact: () => void;
  /** Cancels a manual compaction running beside the conversation (Durable's). */
  onCancelCompaction: () => void;
  onAddAttachments: (files: readonly File[]) => void;
  onRemoveAttachment: (index: number) => void;
  onCopy: (text: string, id: string) => Promise<boolean>;
  onActivityExpanded: (id: string, expanded: boolean) => void;
  onAnswerQuestion: (answer: QuestionResponse) => void;
  onTranscriptScroll: (element: HTMLElement) => void;
  onTranscriptNavigate: (thread: HTMLElement, top: number) => void;
  onScrollToBottom: () => void;
  renaming: boolean;
  confirmingDelete: boolean;
  onCancelRename: () => void;
  onRename: (title: string) => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
  onRetry: () => void;
  /** Connects the machine a disconnected session runs on again. */
  onReconnect: () => void;
  launchDefaults?: { group: string; cwd: string };
  /** Remote workers a new session can run on; none hides the picker. */
  launchWorkers?: readonly { id: string; name: string; state: string }[];
  /** Selected worker id; absent runs the session on this machine. */
  launchWorker?: string;
  onSelectLaunchWorker?: (id: string | undefined) => void;
  launchModels: readonly RuntimeModel[];
  launchModel: RuntimeModel | undefined;
  launchThinking: string;
  launchFast: boolean;
  onSelectLaunchModel: (provider: string, modelId: string) => void;
  onSelectLaunchThinking: (level: string) => void;
  onSelectLaunchFast: (fast: boolean) => void;
  directorySuggestions: readonly string[];
  onDirectoryInput: (value: string) => void;
  branchPrefix: string;
  gitCheckout?: GitCheckoutInfo;
  gitCheckoutLoading: boolean;
  workspaceWorktree: boolean;
  workspaceBaseRef: string;
  workspaceBranchSuggestionsOpen: boolean;
  workspaceBranch: string;
  /** Set while the gateway still creates the shown session's Git worktree. */
  worktreeProgress?: WorktreeProgress;
  /** Why the gateway could not create this session's Git worktree. */
  worktreeError?: string;
  onWorkspaceMode: (worktree: boolean) => void;
  onWorkspaceBaseRef: (baseRef: string) => void;
  onWorkspaceBranchSuggestionsOpen: (open: boolean) => void;
  onWorkspaceBranch: (branch: string) => void;
  onOpenBranchPrefixSettings: () => void;
  /** Present when this pane is a bot's permanent chat in the bot view. */
  bot?: HomeBot;
  /** The bots whose faces show on the messages they sent and on what the agent sent them. */
  bots?: readonly Pick<BotView, "id" | "handle" | "name" | "avatar">[];
  /** Opens a bot's chat; without it a bot's name is not a link. */
  onOpenBot?: (botId: string) => void;
  /** The bot header's Call button: present while the bot can be called; starts a call or returns to the one under way. */
  call?: { inCall: boolean; onCall: () => void };
};

/** What the bot header's ⋯ menu asks the app to do. */
export type BotHeaderAction = "edit" | "archive" | "delete";

/** The bot view's header: who the bot is, its panel (Routines | Memory | Soul | Tools | Settings) and its ⋯ menu. */
export type HomeBot = {
  bot: Pick<BotView, "id" | "name" | "title" | "avatar" | "memory" | "worker">;
  panelOpen: boolean;
  panelId: string;
  onTogglePanel: () => void;
  /** The ⋯ menu: Edit bot…, Archive…, Delete…; without it the header has none. */
  onAction?: (action: BotHeaderAction) => void;
};

function sessionControlId(props: HomeProps, suffix: string): string {
  const owner = (props.session?.id ?? "new-session").replace(/[^a-zA-Z0-9_-]/g, "-");
  return `${suffix}-${props.controlScope ? `${props.controlScope}-` : ""}${owner}`;
}

/** Every chat notification, runtime notices included, uses the shell toast in
 * the trailing top corner. Info toasts carry no icon, as upstream's do. */
function renderNote(props: HomeProps) {
  if (!props.note) {
    return nothing;
  }
  return html`<div class="app-toast chat-operation-toast" data-level=${props.noteLevel} role=${noteAnnouncement(props.noteLevel)} aria-atomic="true">
    ${props.noteLevel === "info" ? nothing : html`<span class="app-toast__icon" aria-hidden="true">${icons.alertTriangle}</span>`}
    <span class="app-toast__message">${props.note}</span>
    <button type="button" class="app-toast__dismiss" aria-label="Dismiss notification" @click=${props.onDismissNote}>${icons.close}</button>
  </div>`;
}

/* ── new session ─────────────────────────────────────────────────────────── */

function renderLaunchFeedback(props: HomeProps) {
  if (!props.note) return nothing;
  const failed = props.noteLevel === "error";
  return html`
    <div id="launch-feedback"
      class="callout ${failed ? "danger" : ""} new-session-page__alert new-session-page__feedback"
      role=${noteAnnouncement(props.noteLevel)} aria-atomic="true">
      ${failed ? html`<span class="new-session-page__alert-icon" aria-hidden="true">${icons.alertTriangle}</span>` : nothing}
      <div class="callout__content new-session-page__alert-message">
        ${failed ? html`<strong>Could not start session</strong>` : nothing}
        <span class="new-session-page__feedback-detail">${props.note}</span>
      </div>
    </div>
  `;
}

function onSubmit(props: HomeProps) {
  return (event: SubmitEvent) => {
    event.preventDefault();
    if (props.gitCheckoutLoading) return;
    const form = event.currentTarget;
    if (!(form instanceof HTMLFormElement)) {
      return;
    }
    const value = (name: string) => {
      const field = form.elements.namedItem(name);
      return field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement
        ? field.value.trim()
        : "";
    };
    const browseCommands = event.submitter instanceof HTMLButtonElement && event.submitter.value === "commands";
    const prompt = browseCommands ? "" : value("prompt");
    props.onLaunch({
      cwd: value("cwd"),
      ...(browseCommands ? { commandDraft: value("prompt") } : {}),
      ...(prompt ? { prompt } : {}),
      ...(value("group") ? { group: value("group") } : {}),
      ...(props.launchModel ? { model: modelValue(props.launchModel) } : {}),
      ...(props.launchThinking ? { thinking: props.launchThinking } : {}),
      ...(props.launchFast && props.launchModel?.fast ? { fast: true } : {}),
      ...(props.launchWorker ? { worker: props.launchWorker } : props.workspaceWorktree ? {
        worktree: true,
        ...(props.workspaceBranch ? { branchName: props.workspaceBranch } : {}),
        ...(props.workspaceBaseRef ? { baseRef: props.workspaceBaseRef } : {}),
      } : props.workspaceBaseRef && props.workspaceBaseRef !== props.gitCheckout?.headBranch ? {
        baseRef: props.workspaceBaseRef,
      } : {}),
    });
  };
}

/** Where the session runs: this machine or a remote worker. */
function renderWorkerPicker(props: HomeProps) {
  const workers = props.launchWorkers ?? [];
  const selected = workers.find((worker) => worker.id === props.launchWorker);
  const local = html`<span class="new-session-page__target-icon">${icons.terminal}</span>`;
  if (!workers.length) return html`<span class="new-session-page__trigger new-session-page__runtime">${local}Local</span>`;
  const choose = (event: Event, id: string | undefined) => {
    (event.currentTarget as HTMLElement).closest("details")?.removeAttribute("open");
    props.onSelectLaunchWorker?.(id);
  };
  return html`<details class="new-session-page__group-picker new-session-page__worker-picker" @keydown=${closeComposerPicker}>
    <summary class="new-session-page__trigger new-session-page__runtime" aria-label="Choose where the session runs">
      <span class="new-session-page__target-icon">${selected ? icons.globe : icons.terminal}</span><span data-launch-worker>${selected?.name ?? "Local"}</span>
      <span class="new-session-page__trigger-chevron" aria-hidden="true">${chevronDownIcon}</span>
    </summary>
    <div class="new-session-page__group-menu new-session-page__worker-menu" role="menu" aria-label="Run on">
      <button type="button" role="menuitemradio" aria-checked=${String(!selected)} @click=${(event: Event) => choose(event, undefined)}>${local}Local</button>
      <div class="session-menu__separator" role="separator"></div>
      <div class="new-session-page__menu-note">Remote workers</div>
      ${workers.map((worker) => html`<button type="button" role="menuitemradio" aria-checked=${String(worker.id === selected?.id)}
        @click=${(event: Event) => choose(event, worker.id)}><span class="new-session-page__target-icon">${icons.globe}</span>${worker.name}${worker.state === "connected" ? "" : html` <span class="settings-row__muted">· ${worker.state === "error" ? "offline" : worker.state}</span>`}</button>`)}
    </div>
  </details>`;
}

function renderCheckoutPicker(props: HomeProps) {
  const checkout = props.gitCheckout;
  if (!checkout?.available) return nothing;
  const baseRef = props.workspaceBaseRef || checkout.headBranch || checkout.defaultBranch || "HEAD";
  const label = props.workspaceWorktree
    ? `New worktree from ${baseRef}`
    : baseRef;
  const branchQuery = props.workspaceBaseRef.trim().toLocaleLowerCase();
  const defaultBranchSuggestion = checkout.defaultBranch.trim();
  const matchingBranches = checkout.branches
    .filter((branch) => !branchQuery || branch.toLocaleLowerCase().includes(branchQuery))
    .filter((branch) => branch !== defaultBranchSuggestion);
  const branchSuggestions = [
    ...(defaultBranchSuggestion ? [defaultBranchSuggestion] : []),
    ...matchingBranches,
  ]
    .slice(0, 6);
  return html`
    <span class="new-session-page__select">
      <button
        id="new-session-checkout-trigger"
        type="button"
        class="new-session-page__trigger"
        title="Checkout"
        aria-label=${`Checkout: ${label}`}
        aria-haspopup="dialog"
        ?disabled=${props.launching || props.gitCheckoutLoading}
      >
        <span class="new-session-page__target-icon" aria-hidden="true">${icons.gitBranch}</span>
        <span class="new-session-page__trigger-label">${label}</span>
        <span class="new-session-page__trigger-chevron" aria-hidden="true">${chevronDownIcon}</span>
      </button>
    </span>
    <wa-popover
      class="new-session-page__select new-session-page__checkout-popover new-session-page__picker-popover"
      for="new-session-checkout-trigger"
      placement="bottom-start"
      without-arrow
    >
      <div class="new-session-page__picker-root">
        <div class="new-session-page__menu-title">Checkout</div>
        <button
          type="button"
          class="new-session-page__checkout-option"
          role="menuitemradio"
          aria-checked=${String(!props.workspaceWorktree)}
          @click=${() => props.onWorkspaceMode(false)}
        >
          <span class="new-session-page__checkout-option-icon" aria-hidden="true">${icons.folder}</span>
          <span class="new-session-page__checkout-option-copy">
            <strong>Current checkout</strong>
            <small>${checkout.headBranch || "HEAD"}</small>
          </span>
          <span class="new-session-page__checkout-option-check" aria-hidden="true">${!props.workspaceWorktree ? checkIcon : nothing}</span>
        </button>
        <button
          type="button"
          class="new-session-page__checkout-option"
          role="menuitemradio"
          aria-checked=${String(props.workspaceWorktree)}
          @click=${() => props.onWorkspaceMode(true)}
        >
          <span class="new-session-page__checkout-option-icon" aria-hidden="true">${icons.gitBranch}</span>
          <span class="new-session-page__checkout-option-copy">
            <strong>New worktree</strong>
            <small>Isolated copy of the repo</small>
          </span>
          <span class="new-session-page__checkout-option-check" aria-hidden="true">${props.workspaceWorktree ? checkIcon : nothing}</span>
        </button>
        <label class="new-session-page__menu-field">
          <span>From</span>
          <input
            type="text"
            aria-autocomplete="list"
            aria-controls="new-session-branch-options"
            aria-expanded=${String(props.workspaceBranchSuggestionsOpen)}
            ?disabled=${props.launching}
            placeholder=${checkout.defaultBranch || "Branch or commit"}
            .value=${props.workspaceBaseRef}
            @focus=${() => props.onWorkspaceBranchSuggestionsOpen(true)}
            @input=${(event: InputEvent) => {
              if (event.currentTarget instanceof HTMLInputElement) {
                props.onWorkspaceBranchSuggestionsOpen(true);
                props.onWorkspaceBaseRef(event.currentTarget.value.trim());
              }
            }}
            @keydown=${(event: KeyboardEvent) => {
              if (event.key === "Escape") {
                props.onWorkspaceBranchSuggestionsOpen(false);
                if (event.currentTarget instanceof HTMLInputElement) event.currentTarget.blur();
              }
            }}
          />
        </label>
        ${props.workspaceBranchSuggestionsOpen && branchSuggestions.length > 0 && !checkout.branchesUnavailable ? html`
          <div id="new-session-branch-options" class="new-session-page__branch-suggestions" role="listbox" aria-label="Branch suggestions">
            ${branchSuggestions.map((branch) => html`
              <button
                type="button"
                class="new-session-page__branch-option"
                role="option"
                aria-selected=${String(branch === props.workspaceBaseRef)}
                ?disabled=${props.launching}
                @click=${() => {
                  props.onWorkspaceBaseRef(branch);
                  props.onWorkspaceBranchSuggestionsOpen(false);
                }}
              >
                <span class="new-session-page__branch-option-icon" aria-hidden="true">${icons.gitBranch}</span>
                <span class="new-session-page__branch-option-label">${branch}</span>
              </button>
            `)}
          </div>
        ` : nothing}
        <div class="new-session-page__menu-note">
          ${checkout.branchesUnavailable
            ? "Branch suggestions are unavailable. Enter any branch or commit."
            : props.workspaceWorktree
              ? "Suggestions are limited. Enter any branch or commit."
              : "Starts by switching this checkout to the selected branch or commit."}
        </div>
        ${props.workspaceWorktree ? html`
          <label class="new-session-page__menu-field">
            <span>Name</span>
            <input
              type="text"
              ?disabled=${props.launching}
              placeholder="Generated from the prompt"
              .value=${props.workspaceBranch}
              @input=${(event: InputEvent) => {
                if (event.currentTarget instanceof HTMLInputElement) {
                  props.onWorkspaceBranch(event.currentTarget.value.trim());
                }
              }}
            />
          </label>
          <button type="button" class="new-session-page__checkout-option new-session-page__checkout-option--action" @click=${props.onOpenBranchPrefixSettings}>
            <span class="new-session-page__checkout-option-icon" aria-hidden="true">${icons.settings}</span>
            <span class="new-session-page__checkout-option-copy">
              <strong>Configure default prefix</strong>
              <small>Open workspace settings</small>
            </span>
            <span></span>
          </button>
          <div class="new-session-page__menu-note">Creates branch ${props.branchPrefix}&lt;name&gt; in a separate checkout.</div>
        ` : nothing}
      </div>
    </wa-popover>
  `;
}

function renderLaunchForm(props: HomeProps) {
  const commandQuery = slashCommandQuery(props.draft, props.draft.length);
  const groupOptions = [...new Set(props.groups.map((group) => group.label))];
  const initialGroup = props.launchDefaults?.group ?? "";
  const initialGroupLabel = initialGroup || "ungrouped";
  const recent = props.groups
    .flatMap((group) => group.sessions)
    .filter((session) => !session.archived && !session.parentId)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 5);
  return html`
    <div class="agent-chat__welcome new-session-page__welcome">
      <div class="agent-chat__welcome-identity">
        <span class="agent-chat__welcome-avatar"><img src="/pi-logo-3d.png" alt="" aria-hidden="true" /></span>
        <div class="agent-chat__welcome-identity-copy"><h2>PI</h2>
        <p class="agent-chat__hint">Pick where this session works, then say what to do.</p></div>
      </div>
      <form class="launch new-session-page__draft" aria-describedby=${props.note ? "launch-feedback" : nothing} @submit=${onSubmit(props)}>
        <div class="new-session-page__triggers">
          ${renderWorkerPicker(props)}
          ${renderDirectoryPicker({ id: "launch-cwd", label: "Project directory", value: props.launchDefaults?.cwd ?? "~/", suggestions: props.directorySuggestions, onInput: props.onDirectoryInput, inputClass: "new-session-page__trigger", required: true })}
          <details class="new-session-page__group-picker" @keydown=${closeComposerPicker}>
            <summary class="new-session-page__trigger" aria-label="Choose session group">
              <span class="new-session-page__group-label">Group</span>
              <span class="new-session-page__group-value" .textContent=${sessionGroupLabel(initialGroupLabel)}></span>
              <span class="new-session-page__trigger-chevron" aria-hidden="true">${chevronDownIcon}</span>
            </summary>
            <div class="new-session-page__group-menu" role="menu" aria-label="Session group">
              ${["ungrouped", ...groupOptions.filter((label) => label !== "ungrouped")].map((label) => html`
                <button type="button" role="menuitemradio" aria-checked=${String(label === initialGroupLabel)}
                  @click=${(event: Event) => {
                    const option = event.currentTarget as HTMLButtonElement;
                    const picker = option.closest("details");
                    const form = option.closest("form");
                    const input = form?.elements.namedItem("group");
                    if (input instanceof HTMLInputElement) input.value = label === "ungrouped" ? "" : label;
                    const value = picker?.querySelector<HTMLElement>(".new-session-page__group-value");
                    if (value) value.textContent = sessionGroupLabel(label);
                    picker?.querySelectorAll<HTMLElement>("[role=menuitemradio]").forEach((item) => item.setAttribute("aria-checked", String(item === option)));
                    picker?.removeAttribute("open");
                  }}>${sessionGroupLabel(label)}</button>
              `)}
            </div>
          </details>
          <input id="launch-group" name="group" type="hidden" .value=${initialGroup} />
          ${props.launchWorker ? nothing : renderCheckoutPicker(props)}
        </div>
        <div class="agent-chat__composer-shell new-session-page__composer">
          <div class="agent-chat__input agent-chat__input--mobile-toolbar" @click=${focusComposerFromSurface}>
            ${renderLocalPathMenu({ ...props.localPathMenu, id: sessionControlId(props, LOCAL_PATH_MENU_ID) })}
            ${renderSlashMenu({ ...props.commandMenu, id: sessionControlId(props, SLASH_MENU_ID), loading: false, error: "", streaming: false,
              commands: props.commandMenu.commands, browseSession: !props.launching && commandQuery?.start === 0,
              open: props.commandMenu.open && commandQuery !== null })}
            <div class="agent-chat__composer-lede">${renderAttachments(props)}</div>
            <div class="agent-chat__composer-input-row">
              <div class="agent-chat__composer-combobox">
                <textarea id="launch-prompt" class="new-session-page__message" name="prompt" rows="1" dir="auto" required
                  placeholder="What should this session work on?" .value=${props.draft} ?disabled=${props.launching}
                  @paste=${onComposerPaste(props)}
                  @input=${(event: Event) => updateComposerDraft(props, event.target as HTMLTextAreaElement)}
                  @keydown=${(event: KeyboardEvent) => {
                    props.onLocalPathKeydown(event);
                    if (event.defaultPrevented) return;
                    props.onCommandKeydown(event);
                    if (!event.defaultPrevented && event.key === "Enter" && composerEnterMode({
                      streaming: false,
                      shiftKey: event.shiftKey,
                      ctrlKey: event.ctrlKey,
                      metaKey: event.metaKey,
                      isComposing: event.isComposing,
                      coarsePointer: hasCoarsePointer(),
                      sendShortcut: props.chatPreferences.sendShortcut,
                    }) === "prompt") {
                      event.preventDefault();
                      (event.target as HTMLTextAreaElement).form?.requestSubmit();
                    }
                  }}
                  @focus=${(event: FocusEvent) => {
                    const textarea = event.target as HTMLTextAreaElement;
                    syncComposerTextarea(textarea);
                    updateCompletionQueries(props, textarea);
                  }}
                  @click=${(event: Event) => updateCompletionQueries(props, event.target as HTMLTextAreaElement)}
                  @select=${(event: Event) => updateCompletionQueries(props, event.target as HTMLTextAreaElement)}
                  @blur=${(event: FocusEvent) => {
                    if (!(event.relatedTarget instanceof Element) || !event.relatedTarget.closest(".slash-menu")) {
                      props.onCommandQuery(null);
                      props.onLocalPathQuery(null);
                    }
                  }}
                  role="combobox" aria-autocomplete="list" aria-haspopup="listbox"
                  aria-expanded=${String(props.localPathMenu.open || props.commandMenu.open)}
                  aria-controls=${props.localPathMenu.open
                    ? sessionControlId(props, LOCAL_PATH_MENU_ID)
                    : props.commandMenu.open ? sessionControlId(props, SLASH_MENU_ID) : nothing}
                  aria-activedescendant=${props.localPathMenu.open && props.localPathMenu.paths.length
                    ? localPathOptionId(props.localPathMenu.activeIndex, sessionControlId(props, LOCAL_PATH_MENU_ID))
                    : props.commandMenu.open && (props.commandMenu.commands.length || props.commandMenu.paths?.length)
                      ? slashOptionId(props.commandMenu.activeIndex, sessionControlId(props, SLASH_MENU_ID))
                      : nothing}></textarea>
              </div>
            </div>
            <div class="agent-chat__composer-footer">
              <div class="agent-chat__composer-lead">
                ${renderAttachmentPicker(props, props.launching)}
              </div>
              <div class="agent-chat__composer-trail">
                <div class="agent-chat__composer-controls new-session-page__launch-controls chat-controls__model-settings">
                  ${renderModelPicker({
                    models: props.launchModels,
                    current: props.launchModel,
                    disabled: props.launching,
                    onSelect: props.onSelectLaunchModel,
                  })}
                  ${renderThinkingPicker({
                    level: props.launchThinking,
                    // New sessions run on Durable, which adds Ultra to the model's own levels.
                    levels: props.launchModel?.thinkingLevels && [...props.launchModel.thinkingLevels, "ultra"],
                    disabled: props.launching,
                    onSelect: props.onSelectLaunchThinking,
                    ...(props.launchModel?.fast ? { fast: { on: props.launchFast, onSelect: props.onSelectLaunchFast } } : {}),
                  })}
                </div>
                <div class="agent-chat__composer-actions">
                  <button type="submit" class="chat-send-btn chat-send-btn--send launch__submit" value="session" aria-label="Start session" ?disabled=${props.launching || props.gitCheckoutLoading || !props.draft.trim()}>
                    ${props.launching ? html`<span class="btn__spinner"></span>` : arrowUpIcon}
                  </button>
                </div>
              </div>
            </div>
          </div>
          ${renderLaunchFeedback(props)}
        </div>
      </form>
      ${recent.length > 0 ? html`
        <div class="agent-chat__welcome-secondary"><div class="agent-chat__welcome-secondary-inner"><section class="agent-chat__recents new-session-page__recent" aria-label="Recent chats">
          <div class="agent-chat__recents-title">Recent chats</div>
          ${recent.map((session) => html`<button type="button" class="agent-chat__recent new-session-page__recent-row" aria-label=${`Open ${session.title}`} @click=${() => props.onSelectSession(session)}><span class="agent-chat__recent-name">${session.title}</span><time class="agent-chat__recent-time">${new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(Math.round((Date.parse(session.updatedAt) - Date.now()) / 3_600_000), "hour")}</time></button>`)}
        </section></div></div>` : nothing}
    </div>
  `;
}

/* ── transcript ──────────────────────────────────────────────────────────── */

function attachmentName(item: string | { name: string }): string {
  return typeof item === "string" ? item : item.name;
}

function attachmentCard(attachment: string | { name: string }): TemplateResult {
  return html`<div class="chat-assistant-attachment-card chat-assistant-attachment-card--compact" role="listitem"><div class="chat-assistant-attachment-card__header"><div class="chat-assistant-attachment-card__identity">${renderAttachmentFileIcon({ filename: attachmentName(attachment), mode: "large-placeholder" })}<span class="chat-assistant-attachment-card__details"><span class="chat-assistant-attachment-card__title" title=${attachmentName(attachment)}>${attachmentName(attachment)}</span><span class="chat-assistant-attachment-card__meta">${resolveAttachmentFileIcon(attachmentName(attachment)).extensionLabel}</span></span></div><span class="chat-assistant-attachment-card__actions"></span></div></div>`;
}

/** Image attachments with a URL render as a thumbnail; a failed load swaps
 * back to the generic file card. */
function renderMessageAttachment(attachment: string | { name: string; kind?: string; url?: string }): TemplateResult {
  const name = attachmentName(attachment);
  if (typeof attachment === "string" || attachment.kind !== "image" || !attachment.url) return attachmentCard(attachment);
  const fallback = (event: Event) => {
    const figure = (event.target as HTMLElement).closest(".hui-message-attachment-image");
    if (figure) figure.setAttribute("data-failed", "");
  };
  return html`<figure class="hui-message-attachment-image" role="listitem">
    <a class="chat-message-image-button" href=${attachment.url} target="_blank" rel="noopener" data-media-viewer data-media-name=${name} aria-label=${`Open ${name}`} title=${name}>
      <img class="chat-message-image" src=${attachment.url} alt=${name} loading="lazy" decoding="async" @error=${fallback}>
    </a>
    <div class="hui-message-attachment-image__fallback">${attachmentCard(attachment)}</div>
  </figure>`;
}

function printable(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

const codeCopyAttempts = new WeakMap<HTMLElement, symbol>();

async function copyCodeBlock(event: Event, props: HomeProps) {
  if (!(event.target instanceof Element)) return;
  handleCodeBlockDisclosure(event.target);
  const button = event.target.closest<HTMLElement>("[data-copy-code]");
  if (!button) return;
  const content = button.closest(".code-block-wrapper")?.querySelector("code")?.textContent ?? "";
  const code = content.endsWith("\n") ? content.slice(0, -1) : content;
  const attempt = Symbol();
  codeCopyAttempts.set(button, attempt);
  const copied = await props.onCopy(code, `code-${code.slice(0, 40)}`);
  if (!button.isConnected || codeCopyAttempts.get(button) !== attempt) return;
  button.classList.toggle("copied", copied);
  button.classList.toggle("copy-failed", !copied);
  button.setAttribute("aria-label", copied ? "Copied" : "Copy failed");
  window.setTimeout(() => {
    if (!button.isConnected || codeCopyAttempts.get(button) !== attempt) return;
    button.classList.remove("copied", "copy-failed");
    button.setAttribute("aria-label", "Copy code");
    codeCopyAttempts.delete(button);
  }, copied ? 1500 : 2000);
}

/** One hover/focus/dismiss contract for every transcript footer action. */
function renderActionTooltip(id: string, label: string, button: TemplateResult) {
  return html`<span class="chat-action-wrap"
    @pointerenter=${(event: Event) => (event.currentTarget as HTMLElement).removeAttribute("data-dismissed")}
    @focusin=${(event: Event) => (event.currentTarget as HTMLElement).removeAttribute("data-dismissed")}
    @keydown=${(event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); (event.currentTarget as HTMLElement).setAttribute("data-dismissed", ""); } }}>
    ${button}
    <span class="chat-action-tooltip" id=${id} role="tooltip">${label}</span>
  </span>`;
}

function renderCopy(props: HomeProps, text: string, id: string, label = "Copy") {
  const copied = props.copiedId === id;
  const tooltipId = sessionControlId(props, `copy-tooltip-${id}`);
  return renderActionTooltip(tooltipId, copied ? "Copied" : "Copy", html`<button type="button" class="chat-copy-btn turn__copy" data-copy-state=${copied ? "copied" : "idle"} aria-label=${copied ? "Copied" : label} aria-describedby=${tooltipId} @click=${() => props.onCopy(text, id)}>
    <span class="chat-copy-btn__icon chat-tool-card__action-icon">${copied ? checkIcon : copyIcon}</span>
  </button>`);
}

/** Long prompts collapse by default, like ChatGPT; expansion is session-scoped UI state. */
export function isLongPrompt(text: string): boolean {
  return text.length > 700 || text.split("\n").length > 10;
}

/** A user-role message's text: the operator's own (or a routine's or trigger's) plain, a bot's or a session's (`markdown`)
 * rendered as the agents write it. */
function renderUserText(props: HomeProps, item: ChatMessage, embeds: boolean, text = item.text, markdown = false) {
  const slack = embeds ? parseSlackLink(text.trim()) : undefined;
  if (slack) return html`<div class="chat-text chat-text--plain chat-text--rich-link"><hui-slack-link
    data-url=${slack.url}
    data-workspace=${slack.workspace}
    data-channel-id=${slack.channelId}
    data-kind=${slack.kind}
  ></hui-slack-link></div>`;
  if (!isLongPrompt(text)) return markdown ? html`<div class="chat-text">${renderAgentMarkdown(text, embeds)}</div>` : html`<div class="chat-text chat-text--plain">${text}</div>`;
  const id = `${props.session?.id ?? "session"}:prompt:${item.id}`;
  const expanded = props.expandedActivityIds.has(id);
  return html`<div class="chat-text ${markdown ? "" : "chat-text--plain"} chat-text--collapsible ${expanded ? "" : "chat-text--collapsed"}">${markdown ? renderAgentMarkdown(text, embeds) : text}</div>
    <button type="button" class="chat-prompt-toggle" aria-expanded=${expanded ? "true" : "false"} @click=${() => props.onActivityExpanded(id, !expanded)}>
      ${expanded ? "Show less" : "Show more"}<span class="chat-prompt-toggle__icon ${expanded ? "is-open" : ""}" aria-hidden="true">${chevronDownIcon}</span>
    </button>`;
}

function renderMetrics(item: TranscriptItem) {
  const metrics = item.metrics;
  if (!metrics || !metricSummary(metrics)) return nothing;
  return html`<details class="hui-message-metrics">
    <summary>${metricSummary(metrics)}</summary>
    <dl>${([
      ["Input tokens", metrics.inputTokens], ["Output tokens", metrics.outputTokens],
      ["Cache read tokens", metrics.cacheReadTokens], ["Cache write tokens", metrics.cacheWriteTokens],
      ["Cost (USD)", metrics.costUsd],
    ] as const).filter(([, value]) => value !== undefined).map(([label, value]) => html`<div><dt>${label}</dt><dd>${label === "Cost (USD)" ? `$${value!.toFixed(6)}` : formatCount(value!)}</dd></div>`)}</dl>
    <small>Tokens and cost belong to the model call, including reasoning; not individual text fragments. Tool timing excludes model generation.</small>
  </details>`;
}

function replyToMessage(event: Event, props: HomeProps, text: string) {
  const source = event.currentTarget as HTMLElement;
  const root = source.closest("hui-app") ?? source.getRootNode() as Document | ShadowRoot;
  // Typing does not re-render, so props.draft can trail the textarea: quote onto
  // the live value instead of the one this click handler closed over.
  const editor = root.querySelector<HTMLTextAreaElement>(".agent-chat__input textarea");
  props.onDraftChange(replyDraft(editor?.value ?? props.draft, text));
  requestAnimationFrame(() => {
    editor?.focus();
    if (editor) editor.setSelectionRange(editor.value.length, editor.value.length);
  });
}

/** `embeds`: link previews and cards, which only the latest user message and the latest reply draw.
 * `attributed`: a message HUI delivered from someone else, shown without its header. */
function renderMessage(props: HomeProps, item: ChatMessage, embeds: boolean, attributed?: { sender: MessageSender; body: string }): TemplateResult {
  const shown = attributed?.body ?? item.text;
  return html`<div
    class="chat-bubble ${item.attachments?.length ? "chat-bubble--with-files" : ""} ${item.pending ? "streaming" : ""} ${item.failed ? "chat-bubble--failed" : ""}"
    data-message-id=${item.id}
    tabindex="0"
    @contextmenu=${(event: MouseEvent) => openMessageContextMenu(event, shown, (text) => props.onCopy(text, `message-${item.id}`))}
    @keydown=${(event: KeyboardEvent) => openMessageContextMenu(event, shown, (text) => props.onCopy(text, `message-${item.id}`))}
  >
    ${item.attachments?.length
      ? html`<div class="chat-assistant-attachments" role="list" aria-label="Attachments">
          ${item.attachments.map((attachment) => renderMessageAttachment(attachment))}
        </div>`
      : nothing}
    ${attributed ? renderUserText(props, item, embeds, attributed.body, attributed.sender.kind !== "routine" && attributed.sender.kind !== "trigger")
      : item.role === "user" ? renderUserText(props, item, embeds) : html`<div class="chat-text">${renderAgentMarkdown(item.text, embeds)}</div>`}
    ${!embeds || item.pending || item.failed || !props.chatPreferences.githubEmbeds ? nothing : html`<hui-github-embeds .text=${item.text}></hui-github-embeds>`}
    ${!embeds || item.pending || item.failed || !props.chatPreferences.datadogEmbeds ? nothing : html`<hui-datadog-embeds .text=${item.text}></hui-datadog-embeds>`}
    ${renderMetrics(item)}
    ${item.pending ? html`<span class="chat-send-status" role="status">Sending…</span>` : nothing}
    ${item.failed ? html`<span class="chat-send-status chat-send-status--failed" role="alert">Not sent — draft recovered.</span>` : nothing}
  </div>`;
}

function renderActivityItem(props: HomeProps, item: ChatActivity): TemplateResult {
  if (item.kind === "thinking") {
    return html`<div class="chat-activity-message">${renderMarkdown(item.text)}</div>`;
  }
  if (item.kind === "error") {
    return html`<p class="chat-run-error" role="alert">${item.text}</p>`;
  }
  const status = item.status ?? "running";
  const toolRenderer = readToolPresentation(item) ? renderReadToolCard : commandToolPresentation(item) ? renderCommandToolCard
    : codemodeToolPresentation(item) ? renderCodemodeToolCard : null;
  if (toolRenderer) {
    const expansionId = `${props.session?.id ?? "session"}:tool:${props.transcript.indexOf(item)}:${item.id}`;
    const expanded = props.expandedActivityIds.has(expansionId);
    return toolRenderer(item, {
      expanded,
      onToggle: () => props.onActivityExpanded(expansionId, !expanded),
      onCopy: (text) => props.onCopy(text, `tool-${item.id}`),
    });
  }
  const statusLabel = status === "running" ? "Running" : status === "failed" ? "Failed" : "Completed";
  const summary = item.name === "browser" ? browserToolSummary(item.args) : "";
  const filePath = toolFilePath(item);
  return html`<details class="chat-tool-msg-collapse ${status === "running" ? "chat-tool-row--running" : ""}"
    @toggle=${(event: Event) => { const details = event.currentTarget as HTMLDetailsElement; details.classList.toggle("is-open", details.open); }}>
    <summary class="chat-inline-disclosure chat-tool-msg-summary">
      <span class="chat-tool-msg-summary__icon" data-status=${status}>${status === "failed" ? icons.alertTriangle : icons.terminal}</span>
      <span class="chat-tool-disclosure__content">
        <span class="chat-tool-msg-summary__label">${item.name}</span>
        <span class="chat-tool-msg-summary__names">${summary ? `${statusLabel} · ${summary}` : statusLabel}</span>
      </span>
      <span class="chat-tool-row__chevron" aria-hidden="true">${chevronDownIcon}</span>
    </summary>
    <div class="chat-tool-msg-body">
      <div class="chat-tool-card">
        <div class="chat-tool-card__header"><span class="chat-tool-card__detail">${item.name}${filePath ? html` · ${renderToolFileReference(filePath)}` : nothing}</span>
          ${item.output !== undefined ? html`<div class="chat-tool-card__actions">${renderCopy(props, item.output, `tool-${item.id}`, "Copy output")}</div>` : nothing}
        </div>
        ${item.args !== undefined ? html`<section class="chat-tool-card__block"><div class="chat-tool-card__block-header"><span class="chat-tool-card__block-label">Input</span></div><pre class="chat-tool-card__block-content"><code>${printable(item.args)}</code></pre></section>` : nothing}
        ${item.output !== undefined ? html`<section class="chat-tool-card__block"><div class="chat-tool-card__block-header"><span class="chat-tool-card__block-label">Output</span></div><pre class="chat-tool-card__block-content"><code>${item.output || "No output"}</code></pre></section>` : nothing}
      </div>
    </div>
  </details>`;
}

function renderPresentedMediaItem(item: PresentedMediaItem): TemplateResult {
  const meta = `${item.mimeType} · ${mediaSizeLabel(item.size)}`;
  if (item.kind === "image") {
    return html`<figure class="hui-presented-media hui-presented-media--image">
      <a class="chat-message-image-button" href=${item.url} target="_blank" rel="noopener" data-media-viewer data-media-name=${item.name} aria-label=${`Open ${item.name}`}>
        <img class="chat-message-image" src=${item.url} alt=${item.name} loading="lazy" decoding="async">
      </a>
      <figcaption>${item.name}<span>${meta}</span></figcaption>
    </figure>`;
  }
  const player = item.kind === "video"
    ? html`<video controls preload="metadata" src=${item.url}>Your browser cannot play this video.</video>`
    : item.kind === "audio"
      ? html`<audio controls preload="metadata" src=${item.url}>Your browser cannot play this audio.</audio>`
      : nothing;
  return html`<div class="chat-assistant-attachment-card chat-assistant-attachment-card--${item.kind} hui-presented-media">
    <div class="chat-assistant-attachment-card__header">
      <div class="chat-assistant-attachment-card__identity">
        ${renderAttachmentFileIcon({ filename: item.name, mode: "large-placeholder" })}
        <span class="chat-assistant-attachment-card__details">
          <span class="chat-assistant-attachment-card__title" title=${item.name}>${item.name}</span>
          <span class="chat-assistant-attachment-card__meta">${meta}</span>
        </span>
      </div>
      <span class="chat-assistant-attachment-card__actions">
        <a class="chat-assistant-attachment-card__action" href=${item.url} download=${item.name} aria-label=${`Download ${item.name}`} title="Download">${icons.download}</a>
      </span>
    </div>
    ${player}
  </div>`;
}

function presentedMedia(items: readonly ChatActivity[]): PresentedMediaItem[] {
  const item = items.length === 1 ? items[0] : undefined;
  return item?.kind === "tool" && item.name === "present_media" && item.status !== "failed"
    ? presentedMediaFromDetails(item.details)
    : [];
}

/** A show_widget call that is running or accepted. A rejected one stays an
 * ordinary failed tool row, where its error is readable. */
function widgetActivity(items: readonly ChatActivity[]): WidgetView | undefined {
  const item = items.length === 1 ? items[0] : undefined;
  const view = item?.kind === "tool" ? widgetView(item) : undefined;
  return view?.state === "failed" ? undefined : view;
}

type QuestionnaireSummary = QuestionnaireResult & { asked: readonly QuestionnaireQuestion[] };

/** An ended `ask_user_question` call, kept in sight like the card it replaced: what the operator chose, or, when
 * nobody answered in time, what was asked. A running or failed one stays an ordinary tool row. */
function questionnaireSummary(items: readonly ChatActivity[]): QuestionnaireSummary | undefined {
  const item = items.length === 1 ? items[0] : undefined;
  if (item?.kind !== "tool" || item.name !== "ask_user_question" || item.status !== "succeeded") return undefined;
  const details = item.details as Partial<QuestionnaireResult> | undefined;
  // Only HUI's own result: a PI extension's call of the same name (older transcripts) has another shape.
  const answers = details?.answers;
  if (!Array.isArray(answers) || !answers.every((answer) => typeof answer?.header === "string" && Array.isArray(answer.selected))) return undefined;
  if (details?.timedOut !== true) return { cancelled: details?.cancelled === true, answers, asked: [] };
  // The call's own input as the model wrote it, before PI's argument conversion took a lone question for a list of one.
  const raw = (item.args as { questions?: unknown } | undefined)?.questions;
  const asked = [raw ?? []].flat().filter((question): question is QuestionnaireQuestion => Array.isArray((question as Partial<QuestionnaireQuestion> | null)?.options));
  return { cancelled: true, answers: [], timedOut: true, timeoutMinutes: details.timeoutMinutes, asked };
}

function renderQuestionnaireSummary(id: string, result: QuestionnaireSummary): TemplateResult {
  return html`<div class="chat-group tool chat-group--with-footer" data-chat-row-key=${id}>
    <div class="chat-group-messages"><div class=${result.timedOut ? "chat-question-summary chat-question-summary--expired" : "chat-question-summary"} role="note" aria-label=${result.timedOut ? "Unanswered questions" : "Your answers"}>
      ${result.timedOut
        ? html`<div class="chat-question-summary__line"><strong>Expired</strong><span>No answer within ${result.timeoutMinutes} minutes. The agent continued without your answer; reply in the chat to decide.</span></div>
          ${result.asked.map((question) => html`<div class="chat-question-summary__line"><strong>${question.header}</strong><span>${question.question} <span class="chat-question-summary__options">${question.options.map(({ label }) => label).join(", ")}</span></span></div>`)}`
        : result.cancelled || !result.answers.length
        ? html`<div class="chat-question-summary__line"><span>You declined to answer.</span></div>`
        : result.answers.map((answer) => html`<div class="chat-question-summary__line" title=${answer.question}><strong>${answer.header}</strong><span>${answer.selected.join(", ")}</span></div>`)}
    </div></div>
  </div>`;
}

function renderWidgetRow(id: string, widget: WidgetView): TemplateResult {
  return html`<div class="chat-group assistant chat-group--with-footer chat-group--widget" data-chat-row-key=${id}>
    <div class="chat-group-messages"><hui-widget-card
      .widgetTitle=${widget.title}
      .code=${widget.state === "ready" ? widget.code : ""}
      .pending=${widget.state === "pending"}
      .unavailable=${widget.state === "unavailable"}
    ></hui-widget-card></div>
    <div class="chat-group-footer"><div class="chat-group-footer__meta"><span class="chat-sender-name">pi</span></div></div>
  </div>`;
}

/** Who sent a message, as its row shows them: a face or an icon, a name, what the name opens and the bubble's color. */
type SenderView = { name: string; avatar: TemplateResult; color?: string; source?: string; link?: { href: string; open: () => void } };

function senderIcon(glyph: unknown): TemplateResult {
  return html`<span class="chat-sender-icon">${glyph}</span>`;
}

function senderView(props: HomeProps, sender: MessageSender): SenderView {
  if (sender.kind === "bot") {
    const bot = props.bots?.find((candidate) => candidate.handle === sender.handle);
    // It was deleted: its handle, without a face to guess.
    if (!bot) return { name: `@${sender.handle}`, avatar: senderIcon(sender.handle.charAt(0).toUpperCase()) };
    const open = props.onOpenBot;
    return {
      name: bot.name, avatar: renderBotAvatar(bot, "sm"), color: botLook(bot).color,
      ...(open ? { link: { href: navigationPath({ kind: "bot", id: bot.id }), open: () => open(bot.id) } } : {}),
    };
  }
  if (sender.kind === "routine") return { name: sender.name, avatar: senderIcon(icons.calendarClock), source: "Routine" };
  if (sender.kind === "trigger") return { name: sender.name, avatar: senderIcon(icons.radio), source: sender.summary || "Trigger" };
  const id = sender.kind === "parent" ? props.session?.parentId : sender.id;
  const session = id ? props.findSession(id) : undefined;
  return {
    name: session?.title ?? (sender.kind === "parent" ? "Parent session" : sender.title),
    avatar: senderIcon(icons.messageSquare),
    ...(session ? { link: { href: navigationPath(session.bot ? { kind: "bot", id: session.bot.id } : { kind: "session", id: session.id }), open: () => props.onSelectSubagent(session.id) } } : {}),
  };
}

function renderSenderName(view: SenderView): TemplateResult {
  const link = view.link;
  const name = link
    ? html`<a class="chat-sender-name chat-sender-link" href=${link.href} @click=${(event: MouseEvent) => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      link.open();
    }}>${view.name}</a>`
    : html`<span class="chat-sender-name">${view.name}</span>`;
  return html`${name}${view.source ? html`<span class="chat-message-source" title=${view.source}>${view.source}</span>` : nothing}`;
}

/** A `message_bot` call, kept in sight once its turn folds: to whom, and the message, unfolded on request. Until its
 * arguments name a target it stays an ordinary tool row. */
function handoffActivity(items: readonly ChatActivity[]) {
  const item = items.length === 1 ? items[0] : undefined;
  if (item?.kind !== "tool" || item.name !== "message_bot") return undefined;
  const args = typeof item.args === "object" && item.args !== null ? item.args as Record<string, unknown> : {};
  const to = typeof args["to"] === "string" ? args["to"].trim() : "";
  return to ? { item, to, message: typeof args["message"] === "string" ? args["message"] : "" } : undefined;
}

function renderHandoff(props: HomeProps, rowId: string, { item, to, message }: NonNullable<ReturnType<typeof handoffActivity>>): TemplateResult {
  // `message_bot` names a bot by handle or exact name, or a calling agent by its return address.
  const handle = to.replace(/^@/u, "").toLowerCase();
  const bot = props.bots?.find((candidate) => candidate.handle === handle || candidate.name.toLowerCase() === to.toLowerCase());
  const target = senderView(props, to.startsWith("agent:")
    ? { kind: "session", title: "the calling agent", id: to.slice("agent:".length) }
    : { kind: "bot", handle: bot?.handle ?? handle });
  const status = item.status ?? "running";
  const expansionId = `${props.session?.id ?? "session"}:handoff:${props.transcript.indexOf(item)}:${item.id}`;
  return html`<div class="chat-group tool chat-group--with-footer" data-chat-row-key=${rowId}>
    <div class="chat-group-messages">
      <details class="chat-tool-msg-collapse chat-handoff" data-status=${status} style=${target.color ? `--chat-sender-color: ${target.color}` : nothing}
        .open=${props.expandedActivityIds.has(expansionId)}
        @toggle=${(event: Event) => props.onActivityExpanded(expansionId, (event.currentTarget as HTMLDetailsElement).open)}>
        <summary class="chat-inline-disclosure chat-tool-msg-summary">
          <span class="chat-handoff__avatar" aria-hidden="true">${target.avatar}</span>
          <span class="chat-tool-disclosure__content">
            <span class="chat-tool-msg-summary__label">${status === "running" ? "Sending to" : status === "failed" ? "Not sent to" : "Sent to"} <strong>${target.name}</strong></span>
            <span class="chat-tool-msg-summary__preview">${previewLine(message.split(/\n\s*\n/u, 1)[0] ?? "", 160)}</span>
          </span>
          <span class="chat-tool-row__chevron" aria-hidden="true">${chevronDownIcon}</span>
        </summary>
        <div class="chat-handoff__body">
          ${status === "failed" && item.output ? html`<p class="chat-run-error" role="alert">${item.output}</p>` : nothing}
          <div class="chat-text">${renderAgentMarkdown(message)}</div>
        </div>
      </details>
    </div>
  </div>`;
}

function renderSubagentEvent(props: HomeProps, row: Extract<ChatProjectionRow, { kind: "subagentEvent" }>): TemplateResult {
  const failed = row.items.filter((item) => item.status !== "completed").length;
  const label = row.items.length === 1 ? `Subagent finished: ${row.items[0]!.title}` : `${row.items.length} subagents finished`;
  return html`<div class="chat-group system chat-group--subagent-event" data-chat-row-key=${row.id} role="note" aria-label=${label}>
    <div class="chat-group-messages">
      <div class="chat-subagents chat-subagents--event">
        <div class="chat-subagents__event-title">
          <span class="chat-subagents__icon">${renderSubagentStatusIcon(failed ? "failed" : "completed")}</span>
          <span class="chat-subagents__label">${label}</span>
          <span class="chat-subagents__snippet">Automated result · delivered to pi</span>
        </div>
        <div class="chat-subagents__list">${row.items.map((item) => {
          const elapsed = item.startedAt ? subagentElapsed({ status: item.status, startedAt: item.startedAt, ...(item.endedAt ? { endedAt: item.endedAt } : {}) }) : undefined;
          return html`<button type="button" class="chat-subagents__row" data-subagent-session-id=${item.sessionId}
            aria-label=${`Open subagent ${item.title}${elapsed ? `, ${elapsed}` : ""}`}
            @click=${() => props.onSelectSubagent(item.sessionId)}>
            <span class="chat-subagents__icon">${renderSubagentStatusIcon(item.status)}</span>
            <span class="chat-subagents__label">${item.title}</span>
            <span class="chat-subagents__snippet">${item.result.replace(/\s+/g, " ").slice(0, 160)}</span>
            ${elapsed ? html`<span class="chat-subagents__time">${elapsed}</span>` : nothing}
          </button>`;
        })}</div>
      </div>
    </div>
  </div>`;
}

function renderBrowserPreview(props: HomeProps, preview: { pending: boolean; currentTurn: boolean }) {
  const options = props.browserPreview;
  if (!options || !props.session) return nothing;
  return html`<hui-browser-preview
    .sessionId=${props.session.id}
    .live=${props.streaming && preview.currentTurn}
    .pending=${preview.pending}
    .visible=${options.visible}
    .onExpand=${options.onExpand}
  ></hui-browser-preview>`;
}

/** OpenClaw's compaction divider rule: folding lines while PI works, a check once done. */
function compactionRule(label: string, options: { metric?: string; glyph?: boolean } = {}): TemplateResult {
  return html`<div class="chat-divider__rule" role="separator" aria-label=${options.metric ? `${label}, ${options.metric}` : label}>
    <span class="chat-divider__line"></span>
    <span class="chat-divider__label">
      ${options.glyph ? html`<span class="chat-compaction__glyph" aria-hidden="true">${Array.from({ length: 5 }, () => html`<span class="chat-compaction__line"></span>`)}${icons.check}</span>` : nothing}
      <span class="chat-divider__title">${label}</span>
      ${options.metric ? html`<span class="chat-divider__separator" aria-hidden="true">·</span><span class="chat-divider__metric">${options.metric}</span>` : nothing}
    </span>
    <span class="chat-divider__line"></span>
  </div>`;
}

/** The bot header's ⋯ menu, like a roster row's: Edit bot…, Archive…, Delete… (both confirmed in a dialog). */
function renderBotHeaderMenu(bot: HomeBot): TemplateResult {
  return html`<wa-dropdown class="session-menu bot-header-menu" placement="bottom-end" distance="4"
    @keydown=${closeDropdownOnEscape}
    @wa-show=${labelDropdown}
    @wa-select=${(event: CustomEvent<{ item: { value: string } }>) => {
      (event.currentTarget as HTMLElement).querySelector<HTMLElement>('[slot="trigger"]')?.focus();
      const action = event.detail.item.value;
      if (action === "edit" || action === "archive" || action === "delete") bot.onAction?.(action);
    }}>
    <button slot="trigger" type="button" class="btn btn--ghost btn--icon chat-icon-btn bot-header-menu__trigger" aria-label=${`Actions for ${bot.bot.name}`} title="More">${icons.moreHorizontal}</button>
    <wa-dropdown-item value="edit" class="session-menu__item"><span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.edit}</span><span class="session-menu__text">Edit bot…</span></wa-dropdown-item>
    <div class="session-menu__separator" role="separator"></div>
    <wa-dropdown-item value="archive" variant="danger" class="session-menu__item session-menu__item--destructive"><span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.box}</span><span class="session-menu__text">Archive…</span></wa-dropdown-item>
    <wa-dropdown-item value="delete" variant="danger" class="session-menu__item session-menu__item--destructive"><span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.trash}</span><span class="session-menu__text">Delete…</span></wa-dropdown-item>
  </wa-dropdown>`;
}

/** Where HUI started a new bot's first turn: a small centered note, never a bubble of the operator's. */
function renderBotCreated(props: HomeProps, row: Extract<ChatProjectionRow, { kind: "botCreated" }>): TemplateResult {
  const name = row.name || props.bot?.bot.name || "This bot";
  return html`<div class="chat-notice chat-bot-created" data-chat-row-key=${row.id}>${compactionRule(`${name} was created`)}</div>`;
}

/** OpenClaw's completed compaction marker; the summary PI wrote stays readable. */
function renderCompaction(row: Extract<ChatProjectionRow, { kind: "compaction" }>): TemplateResult {
  const metric = row.item.tokensBefore ? `from ${compactTokens(row.item.tokensBefore)} tokens` : "";
  return html`<div class="chat-notice chat-compaction chat-compaction--complete" data-chat-row-key=${row.id}>
    ${compactionRule("Context compacted", { metric, glyph: true })}
    ${row.item.summary ? html`<details class="chat-notice__collapse">
      <summary class="chat-notice__toggle">Show summary</summary>
      <div class="chat-text chat-notice__body">${renderMarkdown(row.item.summary)}</div>
    </details>` : nothing}
  </div>`;
}

function renderTranscriptRows(props: HomeProps, rows: readonly ChatProjectionRow[]): TemplateResult {
  const latestAssistantRowId = rows.findLast((row) => row.kind === "messages" && row.role === "assistant")?.id;
  const latestSent = (role: ChatMessage["role"]) => rows.flatMap((row) => row.kind === "messages" && row.role === role ? row.messages : []).findLast((item) => !item.pending && !item.failed);
  const withEmbeds = [latestSent("user"), latestSent("assistant")];
  const browserPreview = props.browserPreview ? browserPreviewRow(rows) : undefined;
  return html`${rows.map((row, rowIndex) => {
    if (row.kind === "subagentEvent") return renderSubagentEvent(props, row);
    if (row.kind === "botCreated") return renderBotCreated(props, row);
    if (row.kind === "compaction") return renderCompaction(row);
    if (row.kind === "call") return renderCallCard(row.item);
    if (row.kind === "activity") {
      const media = presentedMedia(row.items);
      if (media.length) {
        return html`<div class="chat-group assistant chat-group--with-footer" data-chat-row-key=${row.id}>
          <div class="chat-group-messages"><div class="chat-assistant-attachments" role="list" aria-label="Presented media">
            ${media.map((item) => html`<div role="listitem">${renderPresentedMediaItem(item)}</div>`)}
          </div></div>
          <div class="chat-group-footer"><div class="chat-group-footer__meta"><span class="chat-sender-name">pi</span></div></div>
        </div>`;
      }
      const widget = widgetActivity(row.items);
      if (widget) return renderWidgetRow(row.id, widget);
      const answers = questionnaireSummary(row.items);
      if (answers) return renderQuestionnaireSummary(row.id, answers);
      const handoff = handoffActivity(row.items);
      if (handoff) return renderHandoff(props, row.id, handoff);
      const expansionId = `${props.session?.id ?? "session"}:${row.id}`;
      return html`<div class="chat-group tool chat-group--activity chat-group--with-footer" data-chat-row-key=${row.id}>
        <div class="chat-group-messages">
          <details
            class="chat-activity-group"
            .open=${props.expandedActivityIds.has(expansionId)}
            @toggle=${(event: Event) => {
              const details = event.currentTarget as HTMLDetailsElement;
              props.onActivityExpanded(expansionId, details.open);
            }}
          >
            <summary class="chat-inline-disclosure chat-activity-group__summary">
              <span class="chat-activity-group__icon">${chevronDownIcon}</span>
              <span class="chat-activity-group__label">${activityLabel(row.items, props.streaming)}</span>
            </summary>
            <div class="chat-activity-group__body">${row.items.map((item) => html`<div>${renderActivityItem(props, item)}${renderMetrics(item)}</div>`)}</div>
          </details>
          ${browserPreview?.index === rowIndex ? renderBrowserPreview(props, browserPreview) : nothing}
        </div>
      </div>`;
    }
    const last = row.messages.at(-1);
    // A message HUI delivered from a bot, a session, a routine or a trigger: theirs, on the left, under their name.
    const sender = row.sender ? senderView(props, row.sender) : undefined;
    const lastText = row.sender && last ? attributedMessage(last.text)?.body ?? last.text : last?.text;
    // History refreshed from PI carries entry ids; a prompt sent this run has
    // none yet. A prompt PI refused (failed) was never persisted: no rewind.
    // A bot's chat is permanent: the gateway refuses rewinds, so none is offered.
    // Someone else's message was never the operator's to edit and send again.
    const rewindTo: RewindTarget | undefined = row.role !== "user" || sender || !last || last.failed || props.session?.bot ? undefined
      : last.entryId ?? { userFromEnd: new Set(props.transcript.slice(props.transcript.indexOf(last) + 1)
          .flatMap((item) => item.kind === "message" && item.role === "user" && !item.failed ? [item.entryId ?? item.id] : [])).size };
    const rewindTooltipId = sessionControlId(props, `rewind-tooltip-${row.id}`);
    // Only Pi Durable copies a history into a new conversation; a bot's chat is never forked.
    const forkAt = props.session?.tool === "durable" && !props.session.bot ? forkPoint(props.transcript, last) : undefined;
    const forkTooltipId = sessionControlId(props, `fork-tooltip-${row.id}`);
    return html`<div class="chat-group ${row.role} chat-group--with-footer ${row.id === latestAssistantRowId ? "chat-group--latest-assistant" : ""} ${sender ? "chat-group--peer" : ""}" data-chat-row-key=${row.id}
      style=${sender?.color ? `--chat-sender-color: ${sender.color}` : nothing}>
      ${sender ? html`<span class="chat-sender-avatar" aria-hidden="true">${sender.avatar}</span>` : nothing}
      <div class="chat-group-messages">${row.messages.map((item) => renderMessage(props, item, withEmbeds.includes(item), row.sender ? attributedMessage(item.text) : undefined))}</div>
      ${last?.pending ? nothing : html`<div class="chat-group-footer ${row.role === "user" ? "chat-group-footer--persistent-identity" : ""}">
        <div class="chat-group-footer__meta">${sender ? renderSenderName(sender) : html`<span class="chat-sender-name">${row.role === "user" ? "You" : props.session?.bot?.name ?? "pi"}</span>`}
          ${last?.metrics?.completedAt !== undefined || last?.metrics?.timestamp !== undefined ? html`<time class="chat-group-timestamp" datetime=${new Date(last.metrics.completedAt ?? last.metrics.timestamp!).toISOString()} title=${`${last.metrics.completedAt !== undefined ? "Completed" : "Message created"}: ${new Date(last.metrics.completedAt ?? last.metrics.timestamp!).toLocaleString()}`}>${relativeTime(last.metrics.completedAt ?? last.metrics.timestamp!)}</time>` : nothing}</div>
        ${last && lastText ? html`<div class="chat-group-footer-actions">${renderActionTooltip(sessionControlId(props, `reply-tooltip-${row.id}`), "Reply", html`
          <button type="button" class="chat-copy-btn" aria-label="Reply to message" aria-describedby=${sessionControlId(props, `reply-tooltip-${row.id}`)} @click=${(event: Event) => replyToMessage(event, props, lastText)}>${icons.messageSquare}</button>
        `)}${renderCopy(props, lastText, `message-${last.id}`, sender ? "Copy message" : row.role === "assistant" ? "Copy response" : "Copy prompt")}</div>` : nothing}
        ${rewindTo ? html`<div class="chat-group-footer-actions">
          ${renderActionTooltip(rewindTooltipId, props.rewindPending ? "Rewinding…" : "Rewind", html`
            <button type="button" class="chat-group-rewind" aria-label=${props.rewindPending ? "Rewinding…" : "Rewind to here"} aria-describedby=${rewindTooltipId} ?disabled=${props.rewindPending} @click=${() => props.onRewind(rewindTo, last?.text ?? "", last?.attachments)}>${rewindIcon}</button>
          `)}
        </div>` : nothing}
        ${forkAt ? html`<div class="chat-group-footer-actions">
          ${renderActionTooltip(forkTooltipId, props.forkPending ? "Forking…" : "Fork from here", html`
            <button type="button" class="chat-copy-btn chat-group-fork" aria-label=${props.forkPending ? "Forking…" : "Fork into a new session from here"} aria-describedby=${forkTooltipId} ?disabled=${props.forkPending} @click=${() => props.onFork(forkAt)}>${icons.gitBranch}</button>
          `)}
        </div>` : nothing}
      </div>`}
    </div>`;
  })}`;
}

function renderTranscriptBody(props: HomeProps, rows: readonly ChatProjectionRow[]) {
  if (props.worktreeProgress) {
    return html`<div class="agent-chat__empty agent-chat__creating" role="status" aria-live="polite">
      <div class="agent-chat__creating-copy">
        <span>${worktreeProgressLabel(props.worktreeProgress)}</span>
        ${props.worktreeProgress.percent !== undefined ? html`<strong>${props.worktreeProgress.percent}%</strong>` : nothing}
      </div>
      <wa-progress-bar
        label="Git worktree creation progress"
        .value=${props.worktreeProgress.percent ?? 0}
        ?indeterminate=${props.worktreeProgress.percent === undefined}
      ></wa-progress-bar>
    </div>`;
  }
  if (props.worktreeError) {
    return html`<div class="agent-chat__empty" role="alert">
      <strong>Could not create the Git worktree</strong>
      <span>${props.worktreeError}</span>
      <span>Delete this session to return its prompt to New Session.</span>
    </div>`;
  }
  if (props.opening) {
    return html`<div class="agent-chat__empty agent-chat__creating" role="status" aria-live="polite">
      <span>Loading the conversation…</span>
      <wa-progress-bar label="Loading the conversation" indeterminate></wa-progress-bar>
    </div>`;
  }
  if (props.openError) {
    return html`<div class="agent-chat__empty" role="alert">
      <strong>Could not load this conversation</strong>
      <span>${props.openError}</span>
      <button type="button" class="btn btn--sm retry-session" @click=${props.onRetry}>Try again</button>
    </div>`;
  }
  if (props.session?.status === "starting") {
    return html`<div class="agent-chat__empty" role="status">
      Starting pi — this takes a few seconds.
    </div>`;
  }
  if (props.transcript.length === 0) {
    return props.bot
      ? html`<div class="agent-chat__empty bot-chat-empty" data-face-stage>${renderBotAvatar(props.bot.bot, "lg", { state: botFaceState(props) })}<strong>Say hi to ${props.bot.bot.name}</strong>${props.bot.bot.title ? html`<span>${props.bot.bot.title}</span>` : nothing}</div>`
      : html`<div class="agent-chat__empty"><strong>Start a conversation</strong><span>Send a message below.</span></div>`;
  }
  return html`${renderTranscriptRows(props, rows)}${renderLiveCompaction(props.compaction, props.onCancelCompaction)}${renderWorkingIndicator(props)}`;
}

/** The same divider while PI summarizes, or why it wrote no summary. The
 * finished marker comes from PI's history once it is written. */
function renderLiveCompaction(compaction: RuntimeCompaction | undefined, onCancel: () => void) {
  if (!compaction) return nothing;
  const running = compaction.status === "running";
  const label = running ? (compaction.reason === "overflow" ? "Context is full · compacting…" : "Compacting context…")
    : compaction.status === "cancelled" ? "Compaction cancelled" : "Compaction failed";
  // Stop cancels a compaction that blocks the session. A manual one that runs
  // beside the conversation leaves it idle, so it gets its own action.
  const cancellable = running && compaction.blocking === false && !compaction.background;
  return html`<div class="chat-notice chat-compaction ${running ? "chat-compaction--active" : ""}" role="status" aria-live="polite">
    ${compactionRule(label, { glyph: running })}
    ${compaction.message ? html`<div class="chat-divider__details"><span class="chat-divider__description">${compaction.message}</span></div>` : nothing}
    ${cancellable ? html`<div class="chat-divider__details"><span class="chat-divider__description">
      <button type="button" class="chat-divider__action" @click=${onCancel}>Cancel compaction</button>
    </span></div>` : nothing}
  </div>`;
}

function renderWorkingIndicator(props: HomeProps) {
  if (!props.streaming || props.question || compactionBlocks(props.compaction)) return nothing;
  return html`<div class="chat-group assistant chat-group--working" aria-live="polite">
    <div class="chat-group-messages">
      <div class="chat-working-indicator" role="status">
        <span class="chat-working-indicator__mark" aria-hidden="true"><i></i><i></i><i></i></span>
        <span class="chat-working-indicator__label">${workingLabel(props.transcript)}</span>
      </div>
    </div>
  </div>`;
}

function subagentSnippet(task: SubagentTaskView): string {
  if (task.status === "queued") return "Waiting for a free slot…";
  if (task.status === "starting") return "Starting…";
  if (task.status === "running") return task.summary?.trim() || "Running…";
  if (task.status === "completed") return task.summary?.trim() || "Completed";
  if (task.status === "cancelled") return task.error?.trim() || "Cancelled";
  if (task.status === "timed_out") return task.error?.trim() || "Timed out";
  if (task.status === "interrupted") return task.error?.trim() || "Interrupted";
  return task.error?.trim() || "Failed";
}

function renderSubagentStatusIcon(status: string) {
  const state = subagentVisualState(status);
  if (state === "running") return orbitIcon;
  if (state === "completed") return html`<span class="hui-subagent-status hui-subagent-status--completed">${icons.check}</span>`;
  if (state === "queued") return html`<span class="hui-subagent-status hui-subagent-status--queued">${icons.circle}</span>`;
  if (state === "cancelled") return html`<span class="hui-subagent-status hui-subagent-status--cancelled">${icons.circleX}</span>`;
  return html`<span class="hui-subagent-status hui-subagent-status--failed">${icons.alertTriangle}</span>`;
}

function renderSubagentRow(props: HomeProps, task: SubagentTaskView, now: number) {
  const snippet = subagentSnippet(task).replace(/\s+/g, " ");
  const elapsed = task.status === "queued" ? undefined : subagentElapsed(task, now);
  return html`<button
    class="chat-subagents__row chat-subagents__row--${subagentVisualState(task.status)}"
    data-subagent-task-id=${task.taskId}
    data-subagent-session-id=${task.sessionId}
    type="button"
    aria-label=${`Open subagent ${task.title}${elapsed ? `, ${elapsed}` : ""}`}
    @click=${() => props.onSelectSubagent(task.sessionId)}
  >
    <span class="chat-subagents__icon">${renderSubagentStatusIcon(task.status)}</span>
    <span class="chat-subagents__label">${task.title}</span>
    <span class="chat-subagents__snippet">${snippet}</span>
    ${elapsed ? html`<span class="chat-subagents__time">${elapsed}</span>` : nothing}
  </button>`;
}

/** OpenClaw's Swarm card, between the transcript and the composer, for the latest batch of this session's subagents:
 * one dot per child, counts, and under Child details the children, each opening its session. A batch that all
 * succeeded folds into one row. */
function renderSubagentActivity(props: HomeProps) {
  const now = Date.now();
  const tasks = latestSubagentBatch(props.subagents, now);
  if (tasks.length === 0) return nothing;
  const states = tasks.map((task) => subagentVisualState(task.status));
  const count = (state: SubagentVisualState) => states.filter((each) => each === state).length;
  const running = count("running");
  const queued = count("queued");
  const done = count("completed");
  const failed = tasks.length - running - queued - done;
  const finished = running + queued === 0;
  const succeeded = finished && failed === 0;
  const title = tasks.length === 1 ? tasks[0]!.title : "Parallel tasks";
  const counts = finished
    ? `${done} completed · ${failed} failed or stopped`
    : `${running} running · ${queued} queued · ${failed} failed or stopped`;
  const outcome = html`<span class="chat-swarm__outcome">${props.streaming
    ? "Child runs finished. The parent is processing their results."
    : "Child runs finished. Check the conversation for the final response."}</span>`;
  const markers = (["running", "queued", "failed", "done"] as const).flatMap((marker) =>
    Array.from({ length: { running, queued, failed, done }[marker] }, () => html`<span class="chat-swarm__marker chat-swarm__marker--${marker}"></span>`));
  // Per batch, so a new batch starts folded.
  const id = `subagents:${tasks[0]!.taskId}`;
  const expanded = props.expandedActivityIds.has(id);
  return html`<aside class="chat-swarm" aria-label="Parallel tasks">
    <details class="chat-swarm__group ${succeeded ? "chat-swarm__group--completed" : ""}" .open=${expanded}
      @toggle=${(event: Event) => {
        const open = (event.currentTarget as HTMLDetailsElement).open;
        if (open !== expanded) props.onActivityExpanded(id, open);
      }}>
      <summary class="chat-swarm__summary">${succeeded
        ? html`<span class="chat-swarm__task-icon chat-swarm__task-icon--done" aria-hidden="true">${icons.check}</span>
          <span class="chat-swarm__header"><strong title=${title}>${title}</strong></span>
          <span class="chat-swarm__counts">${done} completed</span>
          <span class="chat-swarm__disclosure"><span class="sr-only">Child details</span>${chevronDownIcon}</span>`
        : html`<span class="chat-swarm__header"><strong title=${title}>${title}</strong><span>${done + failed} of ${tasks.length}</span></span>
          <span class="chat-swarm__markers" aria-hidden="true">${markers}</span>
          <span class="chat-swarm__counts">${counts}</span>
          ${finished ? outcome : nothing}
          <span class="chat-swarm__disclosure">Child details ${chevronDownIcon}</span>`}
      </summary>
      ${succeeded ? outcome : nothing}
      <div class="chat-swarm__tasks">${tasks.map((task) => renderSubagentRow(props, task, now))}</div>
    </details>
  </aside>`;
}

function submitPromptFromForm(props: HomeProps, form: HTMLFormElement, mode: PromptMode) {
  const input = form.elements.namedItem("text");
  const text = input instanceof HTMLTextAreaElement ? input.value.trim() : "";
  // An image alone is a valid prompt; a file alone is not, because the agent
  // still needs to be told what to do with it.
  const hasImage = props.attachments.some((item) => item.kind === "image");
  if (!text && !hasImage) return;
  props.onSendPrompt(text, props.attachments, mode);
}

function onPromptKeydown(props: HomeProps) {
  return (event: KeyboardEvent) => {
    props.onLocalPathKeydown(event);
    if (event.defaultPrevented) return;
    props.onCommandKeydown(event);
    if (event.defaultPrevented) return;
    if (event.key !== "Enter" || !(event.target instanceof HTMLTextAreaElement)) return;
    const mode = composerEnterMode({
      streaming: props.streaming,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      isComposing: event.isComposing,
      coarsePointer: hasCoarsePointer(),
      sendShortcut: props.chatPreferences.sendShortcut,
    });
    if (!mode || mode === "newline") return;
    event.preventDefault();
    const form = event.currentTarget;
    if (form instanceof HTMLFormElement) submitPromptFromForm(props, form, mode);
  };
}

function onPromptSubmit(props: HomeProps) {
  return (event: SubmitEvent) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!(form instanceof HTMLFormElement)) {
      return;
    }
    submitPromptFromForm(props, form, props.streaming ? "steer" : "prompt");
  };
}

function sendModeMenu(button: HTMLElement): HTMLElement | undefined {
  return button.closest(".chat-send-control")?.querySelector<HTMLElement>(".chat-send-mode-menu") ?? undefined;
}

function openSendModeMenu(button: HTMLElement) {
  const menu = sendModeMenu(button);
  if (!menu) return;
  const rect = button.getBoundingClientRect();
  menu.style.left = `${Math.max(8, rect.right - 148)}px`;
  menu.style.top = `${Math.max(8, rect.top - 52)}px`;
  menu.showPopover?.();
}

function beginSendLongPress(props: HomeProps) {
  return (event: PointerEvent) => {
    const button = event.currentTarget;
    if (!(button instanceof HTMLElement) || !props.streaming || event.pointerType === "mouse") return;
    button.setPointerCapture?.(event.pointerId);
    const timer = window.setTimeout(() => {
      sendLongPressTimers.delete(button);
      consumedSendLongPresses.add(button);
      openSendModeMenu(button);
    }, SEND_LONG_PRESS_MS);
    sendLongPressTimers.set(button, timer);
  };
}

function clearSendLongPress(button: HTMLElement) {
  const timer = sendLongPressTimers.get(button);
  if (timer !== undefined) window.clearTimeout(timer);
  sendLongPressTimers.delete(button);
}

function endSendLongPress(event: PointerEvent) {
  const button = event.currentTarget;
  if (!(button instanceof HTMLElement)) return;
  clearSendLongPress(button);
  // A touch release synthesizes a click, which light-dismisses an auto
  // popover. Open it on the next task so it remains available to tap.
  if (consumedSendLongPresses.has(button)) {
    event.preventDefault();
    event.stopPropagation();
    window.setTimeout(() => openSendModeMenu(button), 0);
  }
}

function cancelSendLongPress(event: PointerEvent) {
  const button = event.currentTarget;
  if (!(button instanceof HTMLElement)) return;
  const wasPending = sendLongPressTimers.has(button);
  clearSendLongPress(button);
  // Once the hold has fired, keep the marker through the pointerleave that
  // Chromium emits before its synthetic click. That click must stay cancelled.
  if (wasPending) consumedSendLongPresses.delete(button);
}

function consumeSendLongPress(event: MouseEvent) {
  const button = event.currentTarget;
  if (!(button instanceof HTMLElement) || !consumedSendLongPresses.has(button)) return;
  consumedSendLongPresses.delete(button);
  event.preventDefault();
}

function enqueueFromSendMenu(props: HomeProps) {
  return (event: Event) => {
    const action = event.currentTarget;
    if (!(action instanceof HTMLElement)) return;
    const form = action.closest("form");
    if (!(form instanceof HTMLFormElement)) return;
    action.closest<HTMLElement>(".chat-send-mode-menu")?.hidePopover?.();
    submitPromptFromForm(props, form, "followUp");
  };
}

/** The picker is a hidden input, so the visible control can be a plain button. */
function onPickFiles(props: HomeProps) {
  return (event: Event) => {
    const input = event.target;
    if (input instanceof HTMLInputElement && input.files?.length) {
      props.onAddAttachments(Array.from(input.files));
      // Reset so picking the same file twice still fires a change event.
      input.value = "";
      input.closest("details")?.removeAttribute("open");
    }
  };
}

function openAttachmentInput(event: Event, selector: string) {
  const trigger = event.currentTarget;
  if (!(trigger instanceof HTMLElement)) return;
  trigger.closest("details")?.querySelector<HTMLInputElement>(selector)?.click();
}

function renderAttachmentPicker(props: HomeProps, disabled: boolean) {
  return html`<details class="agent-chat__attach-picker agent-chat__attach-menu" @keydown=${closeComposerPicker} @toggle=${positionComposerPicker}>
    <summary
      class="agent-chat__input-btn agent-chat__input-btn--attach"
      aria-label="Add attachment"
      aria-disabled=${String(disabled)}
      @click=${(event: Event) => {
        if (disabled) {
          event.preventDefault();
          return;
        }
        prepareComposerPicker(event);
      }}
    >${icons.plus}</summary>
    <div class="agent-chat__attach-popup" popover="manual" role="menu" aria-label="Add attachment">
      <button type="button" class="agent-chat__attach-menu-option" role="menuitem" ?disabled=${disabled}
        @click=${(event: Event) => openAttachmentInput(event, ".agent-chat__camera-input")}><span slot="icon" aria-hidden="true">${icons.camera}</span><span data-part="label">Take photo</span></button>
      <button type="button" class="agent-chat__attach-menu-option" role="menuitem" ?disabled=${disabled}
        @click=${(event: Event) => openAttachmentInput(event, ".agent-chat__photo-input")}><span slot="icon" aria-hidden="true">${icons.image}</span><span data-part="label">Photo</span></button>
      <button type="button" class="agent-chat__attach-menu-option" role="menuitem" ?disabled=${disabled}
        @click=${(event: Event) => openAttachmentInput(event, ".agent-chat__generic-file-input")}><span slot="icon" aria-hidden="true">${icons.folder}</span><span data-part="label">File</span></button>
    </div>
    <input type="file" accept="image/*" capture="environment" class="agent-chat__file-input agent-chat__camera-input"
      aria-label="Take photo" ?disabled=${disabled} @change=${onPickFiles(props)} />
    <input type="file" accept="image/*" multiple class="agent-chat__file-input agent-chat__photo-input"
      aria-label="Choose photos" ?disabled=${disabled} @change=${onPickFiles(props)} />
    <input type="file" multiple class="agent-chat__file-input agent-chat__generic-file-input"
      aria-label="Choose files" ?disabled=${disabled} @change=${onPickFiles(props)} />
  </details>`;
}

function renderAttachments(props: HomeProps) {
  if (props.attachments.length === 0) {
    return nothing;
  }
  return html`<ul class="chat-attachments-preview" aria-label="Attached files">
    ${props.attachments.map((item, index) => {
      const preview = attachmentPreview(item);
      return html`<li class="chat-attachment-thumb ${preview ? "" : "chat-attachment-thumb--file"}">
        ${preview
          ? html`<img src=${preview} alt=${item.name} />`
          : html`<span class="chat-attachment-file"><span class="chat-attachment-file__icon" aria-hidden="true">${icons.fileText}</span><span class="chat-attachment-file__body"><span class="chat-attachment-file__name">${item.name}</span><span class="chat-attachment-file__type">File</span></span></span>`}
        <button
          type="button"
          class="chat-attachment-remove"
          aria-label=${`Remove ${item.name}`}
          @click=${() => props.onRemoveAttachment(index)}
        >
          ${icons.close}
        </button>
      </li>`;
    })}
  </ul>`;
}

function renderComposer(props: HomeProps) {
  // Locked for the whole boot too: a prompt sent while pi is starting is rejected.
  const booting = props.opening || props.session?.status === "starting";
  // Unreachable, the session runs elsewhere: drafting stays open, sending waits.
  const unreachable = props.session ? unreachableHost(props.session) : undefined;
  const disconnected = props.connection !== "live" || unreachable !== undefined;
  const showStop = props.streaming && !props.draft.trim() && !props.attachments.some((item) => item.kind === "image");
  const canSend = !booting && !props.sending && !disconnected && Boolean(props.draft.trim() || props.attachments.some((item) => item.kind === "image"));
  return html`
    <div class="agent-chat__composer-shell ${props.question ? "agent-chat__composer-shell--question-composer" : ""}"
      @dragenter=${onComposerDragEnter}
      @dragleave=${onComposerDragLeave}
      @dragover=${(event: DragEvent) => {
        if (!hasDraggedFiles(event.dataTransfer)) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = props.sending ? "none" : "copy";
      }}
      @drop=${(event: DragEvent) => {
        if (!hasDraggedFiles(event.dataTransfer)) return;
        event.preventDefault();
        const surface = event.currentTarget;
        if (surface instanceof HTMLElement) clearComposerDrag(surface);
        if (!props.sending && event.dataTransfer?.files.length) props.onAddAttachments(Array.from(event.dataTransfer.files));
      }}>
      ${renderQuestion(props)}
      ${renderRunError(props, booting || disconnected)}
      ${props.session?.interrupted && !booting ? html`
        <div class="agent-chat__interrupted-recovery" role="status">
          <span class="agent-chat__run-status agent-chat__run-status--interrupted">
            ${icons.alertTriangle}<span class="agent-chat__run-status-label">Previous run interrupted</span>
          </span>
          <span class="agent-chat__interrupted-recovery-copy">HUI recovered the transcript, but the runtime stopped before it finished.</span>
          <button type="button" class="btn btn--sm" ?disabled=${props.sending || disconnected} @click=${props.onContinueInterrupted}>Continue run</button>
        </div>
      ` : nothing}
      ${renderTaskProgress(props)}
      ${renderQueue(props)}
      <form class="agent-chat__input agent-chat__input--chat agent-chat__input--mobile-toolbar ${disconnected ? "agent-chat__input--offline" : ""}"
        @submit=${onPromptSubmit(props)} @keydown=${onPromptKeydown(props)}
        @click=${focusComposerFromSurface}>
        ${renderLocalPathMenu({ ...props.localPathMenu, id: sessionControlId(props, LOCAL_PATH_MENU_ID) })}
        ${renderSlashMenu({ ...props.commandMenu, id: sessionControlId(props, SLASH_MENU_ID) })}
        <div class="agent-chat__composer-lede">${renderAttachments(props)}</div>
        <div class="agent-chat__composer-input-row">
          <div class="agent-chat__composer-combobox">
            <textarea
              name="text"
              rows="1"
              dir="auto"
              .value=${props.draft}
              @input=${(event: Event) => updateComposerDraft(props, event.target as HTMLTextAreaElement)}
              @focus=${(event: FocusEvent) => {
                const textarea = event.target as HTMLTextAreaElement;
                syncComposerTextarea(textarea);
                updateCompletionQueries(props, textarea);
              }}
              @click=${(event: Event) => updateCompletionQueries(props, event.target as HTMLTextAreaElement)}
              @select=${(event: Event) => updateCompletionQueries(props, event.target as HTMLTextAreaElement)}
              @blur=${(event: FocusEvent) => {
                if (!(event.relatedTarget instanceof Element) || !event.relatedTarget.closest(".slash-menu")) {
                  props.onCommandQuery(null);
                  props.onLocalPathQuery(null);
                }
              }}
              @paste=${onComposerPaste(props)}
              placeholder=${composerPlaceholder({
                status: props.session?.status,
                reconnecting: disconnected,
                streaming: props.streaming,
                coarsePointer: hasCoarsePointer(),
                sendShortcut: props.chatPreferences.sendShortcut,
                applePlatform: APPLE_PLATFORM,
              })}
              ?disabled=${booting || props.sending}
              aria-label="Message"
              role="combobox" aria-autocomplete="list" aria-haspopup="listbox"
              aria-expanded=${String(props.localPathMenu.open || props.commandMenu.open)}
              aria-controls=${props.localPathMenu.open
                ? sessionControlId(props, LOCAL_PATH_MENU_ID)
                : props.commandMenu.open ? sessionControlId(props, SLASH_MENU_ID) : nothing}
              aria-activedescendant=${props.localPathMenu.open && props.localPathMenu.paths.length
                ? localPathOptionId(props.localPathMenu.activeIndex, sessionControlId(props, LOCAL_PATH_MENU_ID))
                : props.commandMenu.open && (props.commandMenu.commands.length || props.commandMenu.paths?.length)
                  ? slashOptionId(props.commandMenu.activeIndex, sessionControlId(props, SLASH_MENU_ID))
                  : nothing}
              aria-keyshortcuts="Enter Control+Enter Meta+Enter"
            ></textarea>
          </div>
        </div>
        <div class="agent-chat__composer-footer">
          <div class="agent-chat__composer-lead agent-chat__composer-meta">
            ${renderAttachmentPicker(props, booting || props.sending)}
          </div>
          <div class="agent-chat__composer-trail">
            <div class="agent-chat__composer-controls">
          ${renderContextPicker(props.usage, props.streaming || props.compaction?.status === "running" ? undefined : props.onCompact, !props.session?.bot)}
          <div class="chat-controls__session chat-controls__model chat-controls__model-settings">${renderModelPicker({
            models: props.models,
            current: props.currentModel,
            disabled: props.streaming,
            onSelect: props.onSelectModel,
          })}
          ${renderThinkingPicker({
            level: props.thinking,
            levels: props.currentModel?.thinkingLevels,
            disabled: props.streaming || props.opening,
            onSelect: props.onSelectThinking,
            ...(props.fast !== undefined && props.currentModel?.fast ? { fast: { on: props.fast, onSelect: props.onSelectFast } } : {}),
          })}</div>
            </div>
            <div class="agent-chat__composer-actions">
              <span class="chat-send-control chat-mobile-primary-action chat-desktop-primary-action">
                ${showStop ? html`<button type="button" class="chat-send-btn chat-send-btn--stop" ?disabled=${props.stopping} @click=${props.onAbort} aria-label="Stop">${props.stopping ? html`<span class="btn__spinner"></span>` : stopIcon}</button>` : html`<button type="submit" class="chat-send-btn chat-send-btn--send" ?disabled=${!canSend}
                  aria-label=${props.streaming ? "Steer message; touch and hold to enqueue" : "Send message"}
                  @pointerdown=${beginSendLongPress(props)} @pointerup=${endSendLongPress}
                  @pointercancel=${cancelSendLongPress} @pointerleave=${cancelSendLongPress}
                  @contextmenu=${(event: Event) => event.preventDefault()}
                  @click=${consumeSendLongPress}>
                  ${props.sending ? html`<span class="btn__spinner"></span>` : arrowUpIcon}
                </button>
                ${props.streaming ? html`<div class="chat-send-mode-menu" popover="auto" role="menu" aria-label="Send mode">
                  <button type="button" role="menuitem" @click=${enqueueFromSendMenu(props)}>Enqueue</button>
                </div>` : nothing}`}
              </span>
            </div>
          </div>
        </div>
      </form>
      ${disconnected ? html`<div class="agent-chat__composer-underlaps" data-tone="warn"><div class="agent-chat__composer-status-band" role="status"><span class="agent-chat__composer-status-text">${unreachable ? `${unreachable.status.replace(/…$/u, "")} — draft preserved.` : props.connection === "reconnecting" ? "Reconnecting — draft preserved." : "Stream stopped — draft preserved."}</span></div></div>` : nothing}
    </div>
  `;
}

function renderRunError(props: HomeProps, blocked: boolean) {
  const error = props.runError;
  if (!error || props.streaming) return nothing;
  const copy = renderCopy(props, error.detail, "run-error", "Copy error");
  return html`<div class="chat-composer-neighbor-card chat-composer-neighbor-card--danger chat-error chat-run-error-notice" role="alert">
    <span class="chat-composer-neighbor-card__icon" aria-hidden="true">${icons.alertTriangle}</span>
    ${error.multiline
      ? html`<details class="chat-error__content">
          <summary class="chat-error__summary">
            <strong>${error.summary}</strong>
            <span>Details</span>
            <span class="chat-error__chevron" aria-hidden="true">${chevronDownIcon}</span>
          </summary>
          <pre class="chat-error__diagnostic" tabindex="0" aria-label="Error details">${error.detail}</pre>
        </details>`
      : html`<span class="chat-error__content"><strong>${error.summary}</strong></span>`}
    <span class="chat-run-error-notice__actions">
      ${copy}
      <button type="button" class="btn btn--sm chat-run-error-notice__continue" ?disabled=${blocked || props.sending} @click=${props.onContinueAfterError}>Continue</button>
      <button type="button" class="chat-error__dismiss" aria-label="Dismiss error" title="Dismiss error" @click=${props.onDismissRunError}>${icons.close}</button>
    </span>
  </div>`;
}

function renderTaskProgress(props: HomeProps) {
  const card = progressCardFromTranscript(props.transcript);
  if (!card) return nothing;
  const completed = card.steps.filter((step) => step.status === "completed").length;
  const current = card.steps.find((step) => step.status === "in_progress")
    ?? card.steps.find((step) => step.status === "pending")
    ?? card.steps.at(-1);
  const allComplete = card.steps.length > 0 && completed === card.steps.length;
  return html`<div class="agent-chat__progress-float">
    <details class="session-progress-card session-progress-card--composer" ?open=${!props.chatPreferences.collapseTaskProgress && !allComplete}>
      <summary class="session-progress-card__summary">
        <span class="session-progress-card__summary-indicator ${allComplete ? "session-progress-card__summary-indicator--complete" : ""}" data-status=${current?.status ?? "pending"} aria-hidden="true">${allComplete ? checkIcon : current?.status === "in_progress" ? html`<span class="session-run-spinner"></span>` : circleIcon}</span>
        <span class="session-progress-card__summary-collapsed"><span class="session-progress-card__current">${current?.step ?? "Task progress"}</span></span>
        <span class="session-progress-card__summary-count session-progress-card__summary-count--collapsed">${card.steps.length ? `${completed}/${card.steps.length}` : ""}</span>
        <span class="session-progress-card__summary-expanded"><strong class="session-progress-card__summary-title">Task progress</strong><span class="session-progress-card__summary-count">${card.steps.length ? `${completed} of ${card.steps.length}` : ""}</span></span>
        <span class="session-progress-card__summary-chevron" aria-hidden="true">${chevronDownIcon}</span>
      </summary>
      <div class="session-progress-card__body" role="region" aria-label="Task progress">
        ${card.markdown ? html`<div class="session-progress-card__markdown">${renderMarkdown(card.markdown)}</div>` : nothing}
        ${card.steps.length ? html`<ol class="session-progress-card__steps">${card.steps.map((step) => html`<li class="session-progress-card__step session-progress-card__step--${step.status}" data-status=${step.status}><span class="session-progress-card__step-marker" aria-hidden="true">${step.status === "completed" ? checkIcon : step.status === "in_progress" ? html`<span class="session-run-spinner"></span>` : circleIcon}</span><span>${step.step}</span></li>`)}</ol>` : nothing}
      </div>
    </details>
  </div>`;
}

function renderConnection(props: HomeProps) {
  // Deliberately muted, not an error: a reconnect usually fixes itself, and a
  // scary red row would be a lie about a stream that is already coming back.
  // So is a session whose machine is out of reach: it goes on there.
  const unreachable = props.session ? unreachableHost(props.session) : undefined;
  if (unreachable) {
    return html`<p class="transcript__note" role="status">${unreachable.notice}${props.session?.status === "disconnected"
      ? html` <button type="button" class="btn btn--sm reconnect-session" @click=${props.onReconnect}>Reconnect</button>`
      : nothing}</p>`;
  }
  return props.connectionNote
    ? html`<p class="transcript__note" role="status">${props.connectionNote}</p>`
    : nothing;
}

/** `provider/id`, which is how a model is addressed everywhere else. */
function modelValue(model: RuntimeModel): string {
  return model.provider ? `${model.provider}/${model.id}` : model.id;
}

function thinkingRank(level: string): number {
  return THINKING_LEVELS.indexOf(level as ThinkingLevel);
}

/** The level the model is sent, as PI clamps it: the next one up it has, else its highest. */
function shownThinking(level: string, levels: readonly ThinkingLevel[]): ThinkingLevel {
  return levels.includes(level as ThinkingLevel)
    ? level as ThinkingLevel
    : levels.find((candidate) => thinkingRank(candidate) >= thinkingRank(level)) ?? levels.at(-1) ?? "medium";
}

/** Composer pickers share one popover lane, so a trigger closes its sibling first. */
function prepareComposerPicker(event: Event) {
  const trigger = event.currentTarget;
  if (!(trigger instanceof HTMLElement)) return;
  const details = trigger.closest("details");
  if (!(details instanceof HTMLDetailsElement)) return;
  details.closest(".agent-chat__input")
    ?.querySelectorAll<HTMLDetailsElement>("details[open]")
    .forEach((candidate) => {
      if (candidate !== details) candidate.open = false;
    });
}

/** WA uses a fixed floating host; native details needs the same viewport anchoring. */
function positionComposerPicker(event: Event) {
  const picker = event.currentTarget;
  if (picker instanceof HTMLDetailsElement) positionNativePicker(picker);
}

function positionNativePicker(picker: HTMLDetailsElement) {
  const trigger = picker.querySelector<HTMLElement>("summary");
  const menu = picker.querySelector<HTMLElement>(".chat-controls__inline-select-menu, .agent-chat__attach-popup, .context-usage__popover");
  if (!trigger || !menu) return;
  if (!picker.open) { menu.hidePopover?.(); return; }
  menu.showPopover?.();
  const rect = trigger.getBoundingClientRect();
  menu.style.position = "fixed";
  menu.style.right = "auto";
  menu.style.left = `${Math.max(12, Math.min(rect.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 12))}px`;
  menu.style.bottom = `${window.innerHeight - rect.top + 8}px`;
  menu.style.setProperty("--auto-size-available-height", `${Math.max(80, rect.top - 20)}px`);
}

function closeComposerPicker(event: KeyboardEvent) {
  const details = event.currentTarget;
  if (!(details instanceof HTMLDetailsElement) || !details.open) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    const options = Array.from(details.querySelectorAll<HTMLButtonElement>("button:not(:disabled):not([hidden])"));
    if (!options.length) return;
    event.preventDefault();
    const index = options.indexOf(document.activeElement as HTMLButtonElement);
    options[(index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length]?.focus();
    return;
  }
  if (event.key !== "Escape") return;
  event.preventDefault();
  event.stopPropagation();
  details.open = false;
  details.querySelector<HTMLElement>("summary")?.focus();
}

function compactTokens(value: number): string {
  if (value < 1_000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

/** `onCompact` is absent while the session is busy; `compactable` is false
 * for a bot's permanent chat, whose memory summarizes older messages itself. */
function renderContextPicker(usage: RuntimeUsage | undefined, onCompact?: () => void, compactable = true) {
  const percent = usage?.percent;
  const label = percent === null || percent === undefined
    ? (usage?.contextWindow ? `Context window: ${compactTokens(usage.contextWindow)} · usage unavailable` : "Context usage unavailable")
    : `Context window: ${Math.round(percent)}% used`;
  const circumference = 2 * Math.PI * 6.5;
  const warningMix = Math.min(1, Math.max(0, ((percent ?? 0) - 85) / 10));
  const color = (percent ?? 0) >= 85 ? `color-mix(in srgb, var(--warn) ${(1 - warningMix) * 100}%, var(--danger))` : "var(--muted)";
  return html`<div class="context-usage" style=${`--ctx-color: ${color}`}><details class="chat-controls__context-picker" @keydown=${closeComposerPicker} @toggle=${positionComposerPicker}>
    <summary class="context-ring" aria-label=${label} title=${label} @click=${prepareComposerPicker}>
      <svg class="context-ring__dial" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle class="context-ring__track" cx="8" cy="8" r="6.5" /><circle class="context-ring__fill" cx="8" cy="8" r="6.5" stroke-dasharray=${circumference.toFixed(2)} stroke-dashoffset=${(circumference * (1 - Math.min(100, Math.max(0, percent ?? 0)) / 100)).toFixed(2)} /></svg>
    </summary>
    <section class="context-usage__popover" popover="manual" aria-label="Context usage">
      <div class="context-usage__header"><span class="context-usage__title">Context window</span><strong class="context-usage__context-value">${usage?.contextTokens === null || usage?.contextTokens === undefined ? (usage?.contextWindow ? `${compactTokens(usage.contextWindow)} · occupancy unavailable` : "Unavailable") : `${compactTokens(usage.contextTokens)} / ${compactTokens(usage.contextWindow)} · ${Math.round(percent ?? 0)}%`}</strong></div>
      <div class="context-usage__bar" role="progressbar" aria-label="Context window used" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${percent === null || percent === undefined ? nothing : String(Math.round(percent))}><span style=${`width: ${percent ?? 0}%`}></span></div>
        <div class="context-usage__section-label">Latest run tokens</div>
        ${usage
          ? html`<dl class="context-usage__stats"><div><dt>Input</dt><dd>${compactTokens(usage.inputTokens)}</dd></div><div><dt>Output</dt><dd>${compactTokens(usage.outputTokens)}</dd></div><div><dt>Est. cost</dt><dd>${usage.costUsd === null ? "Unavailable" : `$${usage.costUsd.toFixed(2)}`}</dd></div></dl>`
          : html`<p>The runtime has not reported usage for this session yet.</p>`}
        ${compactable ? html`<button type="button" class="btn btn--ghost btn--sm context-usage__compact" ?disabled=${!onCompact}
          @click=${(event: Event) => { (event.currentTarget as HTMLElement).closest("details")?.removeAttribute("open"); onCompact?.(); }}>Compact now</button>` : nothing}
      </section>
  </details></div>`;
}

type ModelPickerOptions = {
  models: readonly RuntimeModel[];
  current: RuntimeModel | undefined;
  disabled: boolean;
  onSelect: (provider: string, modelId: string) => void;
};

function renderModelPicker(options: ModelPickerOptions) {
  const current = options.current;
  if (options.models.length === 0) {
    const label = current?.name ?? "PI default";
    return html`<span
      class="chat-controls__inline-select-trigger chat-controls__model-trigger chat-controls__inline-select-trigger--disabled"
      role="button"
      aria-disabled="true"
      aria-label=${`Model: ${label}. No model catalog available`}
      title="PI has not reported a model catalog"
    >
      <span class="chat-controls__inline-select-label">${label}</span>
      <span class="chat-controls__inline-select-chevron" aria-hidden="true">${chevronDownIcon}</span>
    </span>`;
  }
  return html`<details class="chat-controls__inline-select chat-controls__model-picker" @keydown=${closeComposerPicker} @toggle=${positionComposerPicker}>
    <summary class="chat-controls__inline-select-trigger chat-controls__model-trigger" aria-label=${`Model: ${current?.name ?? "Select model"}`} @click=${prepareComposerPicker}>
      ${current ? renderProviderIcon(current.provider, true) : nothing}
      <span class="chat-controls__inline-select-label">${current?.name ?? "Select model"}</span>
      <span class="chat-controls__inline-select-chevron" aria-hidden="true">${chevronDownIcon}</span>
    </summary>
    <div class="chat-controls__inline-select-menu chat-controls__model-menu" popover="manual">
      <div class="chat-controls__model-search-wrap">${icons.search}<input class="chat-controls__model-search" type="search" placeholder="Search models" aria-label="Search models" @input=${(event: Event) => {
        const input = event.currentTarget as HTMLInputElement;
        input.closest(".chat-controls__model-menu")?.querySelectorAll<HTMLElement>("[data-model-search]").forEach((row) => { row.hidden = !matchesModelSearch(row.dataset.modelSearch ?? "", input.value); });
      }} /></div>
      <div class="chat-controls__model-options" role="listbox" aria-label="Model">
        ${options.models.map((model) => html`<button type="button"
          class="chat-controls__inline-select-option chat-controls__model-option ${current && modelValue(current) === modelValue(model) ? "chat-controls__inline-select-option--selected" : ""}"
          role="option" aria-selected=${String(Boolean(current && modelValue(current) === modelValue(model)))}
          data-model-search=${modelSearchText(model)}
          ?disabled=${options.disabled}
          @click=${(event: Event) => {
            options.onSelect(model.provider, model.id);
            (event.currentTarget as HTMLElement).closest("details")?.removeAttribute("open");
          }}><span class="chat-controls__model-option-provider">${renderProviderIcon(model.provider)}</span><span class="chat-controls__model-option-copy"><span class="chat-controls__model-option-title"><span class="chat-controls__model-option-name">${model.name}</span><span class="chat-controls__model-option-meta">${model.provider}</span></span></span><span class="chat-controls__model-option-action"><span class="chat-controls__inline-select-check">${current && modelValue(current) === modelValue(model) ? checkIcon : nothing}</span></span></button>`)}
      </div>
    </div>
  </details>`;
}

type ThinkingPickerOptions = {
  level: string;
  /** The model's levels; all of HUI's while it reports none. */
  levels: readonly string[] | undefined;
  disabled: boolean;
  onSelect: (level: string) => void;
  /** Present when the model has a fast mode the session can use. */
  fast?: { on: boolean; onSelect: (fast: boolean) => void };
};

function renderThinkingPicker(options: ThinkingPickerOptions) {
  const known = (options.levels ?? []).filter(isThinkingLevel);
  const levels: readonly ThinkingLevel[] = known.length ? known : PI_THINKING_LEVELS;
  // OpenClaw's glow: on Ultra and on the model's own highest level.
  const top = levels.findLastIndex((candidate) => candidate !== "ultra");
  const boost = (at: number) => levels[at] === "ultra" ? "ultra" : at === top && levels[at] !== "off" ? "max" : "";
  const level = shownThinking(options.level, levels);
  const index = levels.indexOf(level);
  const last = Math.max(1, levels.length - 1);
  const fill = (index / last) * 100;
  const angle = -120 + (level === "off" ? 0 : index / last) * 240;
  const fast = options.fast;
  const disabled = options.disabled || (levels.length < 2 && !fast);
  const label = `Thinking: ${level}${fast?.on ? ", fast" : ""}`;
  return html`<details class="chat-controls__inline-select chat-controls__effort-picker" @keydown=${closeComposerPicker} @toggle=${positionComposerPicker}>
    <summary class="chat-controls__inline-select-trigger chat-controls__effort-trigger ${disabled ? "chat-controls__inline-select-trigger--disabled" : ""}" aria-label=${label} aria-disabled=${String(disabled)} @click=${(event: MouseEvent) => {
      if (disabled) event.preventDefault();
      else prepareComposerPicker(event);
    }}>
      <span class="chat-controls__effort-gauge ${level === "off" ? "chat-controls__effort-gauge--off" : ""}" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path class="chat-controls__effort-gauge-dial" d="M3.34 17a10 10 0 1 1 17.32 0"></path>
          <path class="chat-controls__effort-gauge-needle" d="M12 12V6" style=${`transform: rotate(${angle}deg)`}></path>
          <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"></circle>
        </svg>
        ${fast?.on ? html`<span class="chat-controls__effort-fast-badge">${icons.zap}</span>` : nothing}
      </span>
      ${fast?.on ? html`<span class="chat-controls__effort-zap" aria-hidden="true">${icons.zap}</span>` : nothing}
      <span class="chat-controls__inline-select-label">${THINKING_LABELS[level]}</span>
      <span class="chat-controls__inline-select-chevron" aria-hidden="true">${chevronUpIcon}</span>
    </summary>
    <div class="chat-controls__inline-select-menu chat-controls__effort-menu" popover="manual">
      ${levels.length > 1 ? html`<div class="chat-controls__reasoning-panel">
        <div class="chat-controls__reasoning-head">
          <span class="chat-controls__effort-heading">Effort</span>
          <span class="chat-controls__effort-value" aria-hidden="true" .textContent=${THINKING_LABELS[level]}></span>
        </div>
        <div class="chat-controls__reasoning-slider">
          <div class="chat-controls__reasoning-dots" aria-hidden="true">
            ${levels.map(() => html`<span class="chat-controls__reasoning-dot"></span>`)}
          </div>
          <input
            class="chat-controls__reasoning-range"
            type="range"
            min="0"
            max=${String(levels.length - 1)}
            step="1"
            .value=${String(index)}
            style=${`--reasoning-fill: ${fill}%`}
            data-effort-boost=${boost(index)}
            aria-label="Thinking effort"
            aria-valuetext=${THINKING_LABELS[level]}
            ?disabled=${options.disabled}
            @input=${(event: Event) => {
              const input = event.currentTarget as HTMLInputElement;
              const at = Number(input.value);
              const next = levels[at] ?? level;
              input.style.setProperty("--reasoning-fill", `${(at / last) * 100}%`);
              input.setAttribute("aria-valuetext", THINKING_LABELS[next]);
              input.dataset["effortBoost"] = boost(at);
              const value = input.closest(".chat-controls__reasoning-panel")?.querySelector(".chat-controls__effort-value");
              if (value) value.textContent = THINKING_LABELS[next];
            }}
            @change=${(event: Event) => {
              options.onSelect(levels[Number((event.currentTarget as HTMLInputElement).value)] ?? level);
            }}
          />
        </div>
        <div class="chat-controls__effort-scale" aria-hidden="true"><span>Faster</span><span>Smarter</span></div>
      </div>` : nothing}
      ${fast ? html`<div class="chat-controls__speed-panel">
        <span class="chat-controls__effort-heading">Speed</span>
        <div class="chat-controls__speed-options" role="radiogroup" aria-label="Speed">
          ${([[false, "Standard"], [true, "Fast"]] as const).map(([value, text]) => html`<button type="button" role="radio"
            class="chat-controls__speed-option" aria-checked=${String(fast.on === value)} ?disabled=${options.disabled}
            @click=${() => { if (fast.on !== value) fast.onSelect(value); }}>${text}</button>`)}
        </div>
      </div>` : nothing}
    </div>
  </details>`;
}

const QUEUE_DRAG_MIME = "application/x-hui-queued-message";
const mountedQueueEditors = new WeakSet<HTMLTextAreaElement>();

function mountQueueEditor(element: Element | undefined, value: string) {
  if (!(element instanceof HTMLTextAreaElement) || mountedQueueEditors.has(element)) return;
  mountedQueueEditors.add(element);
  element.value = value;
  queueMicrotask(() => {
    if (!element.isConnected) return;
    element.focus();
    element.setSelectionRange(value.length, value.length);
  });
}

function renderQueue(props: HomeProps) {
  const editable = [...(props.queue.items ?? [])];
  const runtimeFollowUps = props.queue.followUp.slice(0, Math.max(0, props.queue.followUp.length - editable.length));
  const rows = [
    ...props.queue.steering.map((text) => ({ id: "", text, label: "Steer", editable: false })),
    ...runtimeFollowUps.map((text) => ({ id: "", text, label: "Follow up", editable: false })),
    ...editable.map((item) => ({ ...item, label: "Follow up", editable: true })),
  ];
  if (!rows.length) return nothing;
  return html`<section
    class="chat-queue"
    role="status"
    aria-live="polite"
    aria-atomic="false"
    aria-label="Queued messages"
  >
    <div class="chat-queue__scroll" data-scrollable=${rows.length > 3 ? "true" : "false"}
      data-at-start="true" data-at-end=${rows.length > 3 ? "false" : "true"}
      @scroll=${(event: Event) => {
        const scroll = event.currentTarget;
        if (!(scroll instanceof HTMLElement)) return;
        scroll.dataset.atStart = String(scroll.scrollTop <= 1);
        scroll.dataset.atEnd = String(scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 1);
      }}>
      ${rows.map((row, index) => {
        const editing = row.editable && row.id === props.queueEditingId;
        const movable = row.editable && editable.length > 1 && !props.queueEditingId;
        const editableIndex = row.editable ? editable.findIndex((item) => item.id === row.id) : -1;
        return html`<div
          class="chat-queue__item chat-queue__item--no-avatar ${editing ? "chat-queue__item--editing" : ""}"
          data-chat-queue-item=${row.id || `runtime-${index}`}
          @dblclick=${row.editable && !props.queueEditingId ? () => props.onQueueEdit(row.id) : nothing}
          @dragover=${movable ? (event: DragEvent) => {
            if (!event.dataTransfer?.types.includes(QUEUE_DRAG_MIME)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            (event.currentTarget as HTMLElement).classList.add("chat-queue__item--drop-target");
          } : nothing}
          @dragleave=${movable ? (event: DragEvent) => (event.currentTarget as HTMLElement).classList.remove("chat-queue__item--drop-target") : nothing}
          @drop=${movable ? (event: DragEvent) => {
            const target = event.currentTarget as HTMLElement;
            target.classList.remove("chat-queue__item--drop-target");
            const itemId = event.dataTransfer?.getData(QUEUE_DRAG_MIME);
            if (!itemId || itemId === row.id) return;
            event.preventDefault();
            props.onQueueMove(itemId, editableIndex);
          } : nothing}
        >
          ${movable ? html`<button class="chat-queue__leading chat-queue__grip" type="button" draggable="true"
            aria-label="Reorder queued message" aria-keyshortcuts="ArrowUp ArrowDown"
            @dragstart=${(event: DragEvent) => {
              event.dataTransfer?.setData(QUEUE_DRAG_MIME, row.id);
              if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
            }}
            @keydown=${(event: KeyboardEvent) => {
              const delta = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
              if (!delta) return;
              event.preventDefault();
              props.onQueueMove(row.id, editableIndex + delta);
            }}>
            <span class="chat-queue__grip-state chat-queue__grip-state--idle" aria-hidden="true">${queueIcon}</span>
            <span class="chat-queue__grip-state chat-queue__grip-state--active" aria-hidden="true">${gripIcon}</span>
          </button>` : html`<span class="chat-queue__leading chat-queue__icon" aria-hidden="true">${queueIcon}</span>`}
          ${editing ? html`<textarea class="chat-queue__edit-input" rows="1"
            ${ref((element) => mountQueueEditor(element, props.queueEditingText))}
            aria-label="Edit queued message"
            @input=${(event: Event) => props.onQueueEditChange((event.currentTarget as HTMLTextAreaElement).value)}
            @keydown=${(event: KeyboardEvent) => {
              if (event.isComposing) return;
              if (event.key === "Escape") {
                event.preventDefault();
                props.onQueueEditCancel();
              } else if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                props.onQueueEditSubmit();
              }
            }}></textarea>` : html`<div class="chat-queue__copy"><span class="chat-queue__text" title=${row.text}>${row.text}</span><span class="chat-queue__badge">${row.label}</span></div>`}
          <span class="chat-queue__actions">
            ${row.editable && props.streaming && !compactionBlocks(props.compaction) && !editing ? html`<button class="chat-queue__action chat-queue__steer" type="button" aria-label="Steer queued message" @click=${() => props.onQueueSteer(row.id)}>${icons.arrowUp}<span>Steer</span></button>` : nothing}
            ${editing ? html`<button class="chat-queue__edit-submit" type="button" aria-label="Save queued message" @click=${props.onQueueEditSubmit}>${icons.check}</button><button class="chat-queue__edit-cancel" type="button" aria-label="Cancel edit" @click=${props.onQueueEditCancel}>${icons.close}</button>` : nothing}
            ${row.editable && !editing ? html`<button class="chat-queue__remove" type="button" aria-label="Remove queued message" @click=${() => props.onQueueRemove(row.id)}>${icons.trash}</button><button class="chat-queue__more" type="button" aria-label="Edit queued message" @click=${() => props.onQueueEdit(row.id)}>${icons.moreHorizontal}</button>` : nothing}
          </span>
        </div>`;
      })}
    </div>
  </section>`;
}

function selectQuestionOption(form: HTMLFormElement, value: string) {
  const answer = form.elements.namedItem("answer");
  if (!(answer instanceof HTMLInputElement)) return;
  answer.value = value;
  for (const option of form.querySelectorAll<HTMLElement>("[data-question-choice]")) {
    const selected = option.dataset.questionChoice === value;
    option.classList.toggle("chat-question-panel__option--selected", selected);
    if (option.getAttribute("role") === "radio") {
      option.setAttribute("aria-checked", String(selected));
      option.tabIndex = selected ? 0 : -1;
    }
    const marker = option.querySelector<HTMLElement>(".chat-question-panel__option-marker");
    if (marker) marker.textContent = selected && value !== "__custom__" ? "✓" : "";
  }
}

function renderQuestion(props: HomeProps) {
  const question = props.question;
  if (!question) return nothing;
  if (question.method === "questionnaire") {
    // Its previews' code blocks copy and wrap as the transcript's do.
    return html`<div class="agent-chat__question-dock" aria-live="polite" @click=${(event: Event) => { void copyCodeBlock(event, props); }}>
      <hui-questionnaire-card .prompt=${question} .onAnswer=${props.onAnswerQuestion} .idPrefix=${sessionControlId(props, "questionnaire")}></hui-questionnaire-card>
    </div>`;
  }
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const field = form.elements.namedItem("answer");
    let value = field instanceof RadioNodeList
      ? field.value
      : field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement
        ? field.value
        : "";
    if (question.method === "select" && value === "__custom__") {
      const custom = form.elements.namedItem("custom-answer");
      value = custom instanceof HTMLInputElement ? custom.value.trim() : "";
      if (!value) {
        if (custom instanceof HTMLInputElement) custom.focus();
        return;
      }
    }
    if (!value) return;
    props.onAnswerQuestion(question.method === "confirm" ? { confirmed: value === "true" } : { value });
  };
  const choices = question.method === "confirm"
    ? ["Confirm", "Decline"]
    : question.options ?? [];
  const secret = question.method === "secret";
  const titleId = sessionControlId(props, "question-title");
  const reasonId = sessionControlId(props, "question-reason");
  return html`<div class="agent-chat__question-dock" aria-live="polite">
    <form class="session-question-card chat-question-panel" aria-labelledby=${titleId} @submit=${submit}
      @keydown=${(event: KeyboardEvent) => {
        if (event.key === "Escape") {
          // Consumed either way, or the page's Escape would stop the run. Password
          // managers close their menus over a secret's field with it, so only
          // Cancel ends a secret request.
          event.preventDefault();
          if (!secret) props.onAnswerQuestion({ cancelled: true });
          return;
        }
        const target = event.target;
        if (!(target instanceof HTMLElement) || target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && target.type !== "hidden")) {
          return;
        }
        const form = event.currentTarget as HTMLFormElement;
        const options = [...form.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
        if (["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"].includes(event.key) && options.length) {
          event.preventDefault();
          const current = options.findIndex((option) => option === target);
          const direction = ["ArrowDown", "ArrowRight"].includes(event.key) ? 1 : -1;
          const option = options[(current + direction + options.length) % options.length];
          option?.click();
          option?.focus();
          return;
        }
        const number = Number(event.key);
        if (number >= 1 && number <= choices.length + (question.method === "select" ? 1 : 0)) {
          const option = form.querySelector<HTMLElement>(`[data-number="${number}"]`);
          if (option) {
            event.preventDefault();
            if (option instanceof HTMLButtonElement) { option.click(); option.focus(); }
            else option.querySelector<HTMLInputElement>("input")?.focus();
          }
        }
      }}>
      <header class="chat-question-panel__topline"><strong class="chat-question-panel__title">${secret ? "Secret" : "Question"}</strong><span class="chat-question-panel__progress">1/1</span></header>
      <div class="chat-question-panel__heading"><span id=${titleId} class="chat-question-panel__prompt">${question.title || "pi needs your input"}${question.message && !secret ? ` — ${question.message}` : ""}</span></div>
      ${secret ? html`<div class="chat-question-panel__store"><div id=${reasonId}>${question.message}</div><div class="chat-question-panel__store-entry">Kept out of the conversation: the agent gets a temporary file, never the value.</div></div>` : nothing}
      ${question.method === "select" || question.method === "confirm"
        ? html`<input type="hidden" name="answer" value="" /><div class="chat-question-panel__options" role="radiogroup" aria-label=${question.title}>
            ${choices.map((option, index) => html`<button type="button" class="chat-question-panel__option" role="radio" aria-checked="false" tabindex=${index === 0 ? "0" : "-1"} data-number=${String(index + 1)} data-question-choice=${question.method === "confirm" ? String(index === 0) : option}
              @click=${(event: Event) => { const button = event.currentTarget as HTMLButtonElement; if (button.form) selectQuestionOption(button.form, button.dataset.questionChoice ?? ""); }}>
              <span class="chat-question-panel__option-marker" aria-hidden="true"></span>
              <span class="chat-question-panel__option-copy"><strong>${option}</strong></span><kbd>${index + 1}</kbd>
            </button>`)}
            ${question.method === "select" ? html`<label class="chat-question-panel__option chat-question-panel__option--other" data-question-choice="__custom__" data-number=${String(choices.length + 1)}>
              <span class="chat-question-panel__option-marker" aria-hidden="true"></span>
              <input type="text" name="custom-answer" class="chat-question-panel__other" placeholder="Type your own answer here" aria-label="Custom answer"
                @focus=${(event: Event) => { const field = event.currentTarget as HTMLInputElement; if (field.form) selectQuestionOption(field.form, "__custom__"); }} />
              <kbd>${choices.length + 1}</kbd>
            </label>` : nothing}
          </div>`
        : question.method === "editor"
          ? html`<label class="field"><span>Answer</span><textarea class="input" name="answer" aria-label="Answer" rows="6" placeholder=${question.placeholder ?? ""} .value=${question.prefill ?? question.value ?? ""}></textarea></label>`
          : secret
            // A one-time code to browsers, so they do not offer to save it as this site's password.
            ? html`<label class="field"><span>Value</span><input class="input" type="password" name="answer" autocomplete="one-time-code" aria-describedby=${reasonId} /></label>`
            : html`<label class="field"><span>Answer</span><input class="input" name="answer" autocomplete="off" aria-label="Answer" placeholder=${question.placeholder ?? ""} .value=${question.value ?? ""} /></label>`}
      <footer class="chat-question-panel__footer"><button type="button" class="btn btn--sm chat-question-panel__skip" @click=${() => props.onAnswerQuestion({ cancelled: true })}>${secret ? "Cancel" : "Skip"}</button><button type="submit" class="btn btn--sm primary">Submit</button></footer>
    </form>
  </div>`;
}

/** Mirrors the Control UI header rename: a single inline title field that
 * commits on Enter or blur and cancels on Escape. Group membership is not part
 * of a rename; it moves through the sidebar menu or drag and drop. */
function renderSessionEditor(props: HomeProps, session: SessionView) {
  const commit = (input: HTMLInputElement) => {
    const nextTitle = input.value.trim();
    if (nextTitle) props.onRename(nextTitle);
    else props.onCancelRename();
  };
  return html`<div class="transcript__identity chat-pane__crumbs">
    <input
      class="chat-pane__session-title-input"
      name="title"
      type="text"
      aria-label="Session name"
      placeholder="Session name"
      .value=${session.title}
      @keydown=${(event: KeyboardEvent) => {
        if (event.key === "Enter") {
          event.preventDefault();
          if (event.currentTarget instanceof HTMLInputElement) commit(event.currentTarget);
        } else if (event.key === "Escape") {
          event.preventDefault();
          props.onCancelRename();
        }
      }}
      @blur=${(event: FocusEvent) => {
        if (event.currentTarget instanceof HTMLInputElement) commit(event.currentTarget);
      }}
    />
  </div>`;
}

function renderDeleteConfirmation(props: HomeProps, session: SessionView) {
  if (!props.confirmingDelete) return nothing;
  const titleId = sessionControlId(props, "delete-session-title");
  return html`<dialog
    class="hui-modal-dialog delete-session-dialog"
    aria-labelledby=${titleId}
    @cancel=${(event: Event) => {
      event.preventDefault();
      props.onCancelDelete();
    }}
    @keydown=${(event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        props.onCancelDelete();
      }
    }}
  >
    <div class="exec-approval-card">
      <div class="exec-approval-header"><div>
        <div class="exec-approval-title" id=${titleId}>Remove ${session.title} from HUI?</div>
        <div class="exec-approval-sub">HUI will remove this session and all its subagents, including nested subagents, and stop their runtimes. Their PI transcripts remain on disk and are not deleted.</div>
      </div></div>
      <div class="exec-approval-actions">
        <button type="button" class="btn danger" @click=${props.onConfirmDelete}>Remove from HUI</button>
        <button type="button" class="btn delete-session-cancel" autofocus @click=${props.onCancelDelete}>Cancel</button>
      </div>
    </div>
  </dialog>`;
}

/** What a bot's face shows in its open chat: its session's status refined by the live turn (a running tool, a question, a
 * failed run) and its memory. */
function botFaceState(props: HomeProps): BotFaceState {
  return chatFaceState({
    status: props.session?.status ?? "idle",
    streaming: props.streaming,
    question: Boolean(props.question),
    memoryWaiting: Boolean(props.bot?.bot.memory?.waiting),
    toolRunning: props.streaming && hasRunningTool(props.transcript),
    failed: Boolean(props.runError),
  });
}

/** A bot's chat names the bot, its role, the worker it runs on and whether it is summarizing memory. */
function renderBotIdentity(bot: HomeBot, session: SessionView, face: BotFaceState) {
  const status = bot.bot.memory?.waiting ? "Summarizing memory…" : unreachableHost(session)?.status ?? STATUS_TEXT[session.status];
  const worker = bot.bot.worker;
  return html`<div class="transcript__identity chat-pane__crumbs bot-chat-identity">
    ${renderBotAvatar(bot.bot, "md", { state: face })}
    <h2 class="transcript__title chat-pane__session-title" title=${bot.bot.name}>${bot.bot.name}</h2>
    <span class="transcript__meta" title=${worker ? `${worker.name}:${session.cwd}` : session.cwd}>${bot.bot.title ? `${bot.bot.title} · ` : ""}${worker
      ? html`<span class="bot-chat-identity__machine" title=${`Runs on ${worker.name}`}><span class="sr-only">on </span>${icons.globe}<span>${worker.name}</span></span> · `
      : nothing}${status}</span>
  </div>`;
}

function renderHeader(props: HomeProps, session: SessionView) {
  return html`
    <header class="transcript__head chat-pane__header" tabindex="-1" draggable=${props.paneMovable ? "true" : "false"}>
      <div class="chat-pane__header-leading">
        ${renderPaneMoveHandle(props.paneMovable)}
        ${props.mobileNavLayout ? html`<button
          class="btn btn--ghost btn--icon chat-icon-btn chat-pane__nav-toggle"
          type="button"
          aria-label="Open navigation"
          aria-controls="primary-navigation-drawer"
          aria-expanded="false"
          @click=${toggleNavigationDrawer}
        >${icons.menu}</button>` : nothing}
        ${props.renaming ? renderSessionEditor(props, session) : props.bot ? renderBotIdentity(props.bot, session, botFaceState(props)) : html`<div class="transcript__identity chat-pane__crumbs">
          <span class="session-row__dot" data-status=${session.status} aria-hidden="true"></span>
          <h2 class="transcript__title chat-pane__session-title" title=${session.title}>${session.title}</h2>
          <span class="transcript__meta" title=${session.cwd}>
            ${session.parentId ? "Subagent" : session.tool}${session.worker ? ` on ${session.worker.name}` : ""} · ${sessionGroupLabel(session.group)} · ${unreachableHost(session)?.status ?? STATUS_TEXT[session.status]}
          </span>
        </div>`}
        ${session.parentId ? html`<button
          type="button"
          class="btn btn--ghost btn--sm session-history-action"
          aria-label="Open parent"
          title="Open parent"
          @click=${() => props.onSelectSubagent(session.parentId!)}
        ><span class="session-history-action__icon">${icons.arrowLeft}</span><span class="session-history-action__label">Open parent</span></button>` : nothing}
      </div>
      <div class="chat-pane__header-trailing">
        <div class="chat-pane__actions chat-pane__header-actions">
          ${props.bot && props.call ? renderCallButton({ botName: props.bot.bot.name, inCall: props.call.inCall, onCall: props.call.onCall }) : nothing}
          ${props.bot ? html`<button type="button" class="btn btn--ghost btn--icon chat-icon-btn bot-panel-toggle"
            aria-label=${props.bot.panelOpen ? "Hide the bot panel" : "Show the bot panel"} title="Bot panel"
            aria-expanded=${String(props.bot.panelOpen)} aria-controls=${props.bot.panelOpen ? props.bot.panelId : nothing}
            @click=${props.bot.onTogglePanel}>${icons.panelRightOpen}</button>` : nothing}
          ${props.bot?.onAction ? renderBotHeaderMenu(props.bot) : nothing}
          ${props.onOpenBrowser ? html`<button type="button" class="btn btn--ghost btn--icon chat-icon-btn chat-open-browser" aria-label="Open browser view" data-hui-tooltip="Open browser view" @click=${props.onOpenBrowser}>${icons.globe}</button>` : nothing}
          ${props.onOpenTerminal && !session.worker ? html`<button type="button" class="btn btn--ghost btn--icon chat-icon-btn" aria-label="Open terminal" title="Open terminal" ?disabled=${props.terminalOpening} @click=${props.onOpenTerminal}>${icons.squareTerminal}</button>` : nothing}
          <button type="button" class="btn btn--ghost btn--sm session-history-action" ?disabled=${props.opening || props.streaming || props.continuing || props.transcript.length === 0} @click=${props.onContinue} aria-label="Continue without a prompt">
            <span class="session-history-action__icon">${continueIcon}</span><span class="session-history-action__label">${props.continuing ? "Continuing…" : "Continue"}</span>
          </button>
          ${props.onSplitPane ? props.onClosePane ? html`
            <button type="button" class="btn btn--ghost btn--icon chat-icon-btn chat-pane__split-down" aria-label="Split down" title="Split down" @click=${() => props.onSplitPane?.("down")}>${icons.panelBottomOpen}</button>
            <button type="button" class="btn btn--ghost btn--icon chat-icon-btn chat-pane__split-right" aria-label="Split right" title="Split right" @click=${() => props.onSplitPane?.("right")}>${icons.panelRightOpen}</button>
            <wa-dropdown class="chat-pane__split-menu" placement="bottom-end" @wa-select=${(event: CustomEvent<{ item: HTMLElement }>) => {
              const direction = event.detail.item.getAttribute("value");
              // WA restores trigger focus after wa-select; split only after
              // that restoration so it cannot reactivate the source pane.
              if (direction === "down" || direction === "right") queueMicrotask(() => props.onSplitPane?.(direction));
            }}>
              <button slot="trigger" type="button" class="btn btn--ghost btn--icon chat-icon-btn" aria-label="Pane actions" title="Pane actions">${icons.moreHorizontal}</button>
              <wa-dropdown-item value="down">Split down</wa-dropdown-item>
              <wa-dropdown-item value="right">Split right</wa-dropdown-item>
            </wa-dropdown>
          ` : html`<button type="button" class="btn btn--ghost btn--icon chat-icon-btn chat-open-split-view" aria-label="Open split view" title="Open split view" @click=${() => props.onSplitPane?.("right")}>${icons.columns2}</button>` : nothing}
            ${props.onClosePane ? html`
              <button
                type="button"
                class="btn btn--ghost btn--icon chat-icon-btn chat-pane__close-pane"
                aria-label="Close session pane"
                title="Close session pane"
                @click=${props.onClosePane}
              >${icons.close}</button>
            ` : nothing}
        </div>
      </div>
    </header>
    ${renderDeleteConfirmation(props, session)}
    ${props.terminalError ? html`<p class="hui-terminal-error" role="alert">${props.terminalError}</p>` : nothing}
  `;
}

function renderTranscript(props: HomeProps, session: SessionView) {
  const rows = projectChatTranscript(props.transcript.filter((item) => item.kind !== "tool" || item.name !== "progress_card"));
  return html`
    ${renderHeader(props, session)}
    <section class="card chat">
      <div class="chat-workbench">
        <div class="chat-workbench__main">
          <div class="chat-split-container">
            <div class="chat-main">
              <div class="chat-main__conversation-column">
                ${renderNote(props)} ${renderConnection(props)}
                ${session.status === "error" && !props.worktreeError
                  ? html`<div class="chat-error" role="alert"><div class="chat-error__content">The runtime could not start.</div><button type="button" class="btn btn--sm retry-session" @click=${props.onRetry}>Retry session</button></div>`
                  : nothing}
                <div class="chat-main__conversation">
                  ${props.taskSuggestions?.suggestions.length ? html`<div class="chat-gutter-stack">${renderTaskSuggestionCard(props.taskSuggestions)}</div>` : nothing}
                  <div class="chat-thread chat-thread--direct" role="log" aria-live="off" aria-relevant="additions" tabindex="0"
                    @scroll=${(event: Event) => props.onTranscriptScroll(event.currentTarget as HTMLElement)}
                    @click=${(event: Event) => { void copyCodeBlock(event, props); }}>
                    ${positionRail({ sessionId: session.id, markers: props.opening || session.status === "starting" ? [] : conversationMarkers(rows), onNavigate: props.onTranscriptNavigate })}
                    <div class="chat-thread-inner" data-hui-files-session=${props.fileLinks ? session.id : nothing} ${markdownBlocks()}>${renderTranscriptBody(props, rows)}${props.watchers ? renderWatcherActivity(props.watchers) : nothing}</div>
                  </div>
                </div>
                <div class="chat-scroll-to-bottom-wrap"><button type="button" class="chat-scroll-to-bottom" data-visible=${String(props.showScrollToBottom)} ?inert=${!props.showScrollToBottom} aria-hidden=${String(!props.showScrollToBottom)} @click=${props.onScrollToBottom} aria-label="Scroll to latest">${icons.arrowDown}</button></div>
                ${renderSubagentActivity(props)}
                ${renderComposer(props)}
              </div>
            </div>
            ${props.sideChat ? html`
              <aside class="chat-session-rail" aria-label="Side chat">
                <header class="chat-session-rail__header">
                  <div><strong>Side chat</strong><span>Ephemeral · ${props.sideChat.model || "utility model"}</span></div>
                  <button type="button" class="btn btn--ghost btn--icon chat-icon-btn" aria-label="Close side chat" @click=${props.onCloseSideChat}>${icons.close}</button>
                </header>
                <div class="chat-session-rail__thread" role="status" aria-live="polite">
                  <div class="chat-session-rail__question">${props.sideChat.question}</div>
                  ${props.sideChat.loading
                    ? html`<div class="chat-working-indicator"><span class="chat-working-indicator__mark" aria-hidden="true"><i></i><i></i><i></i></span><span>Asking utility model…</span></div>`
                    : props.sideChat.error
                      ? html`<div class="chat-session-rail__error" role="alert">${props.sideChat.error}</div>`
                      : html`<div class="chat-session-rail__answer">${renderMarkdown(props.sideChat.answer)}</div>`}
                </div>
                <p class="chat-session-rail__note">This exchange is not added to the main transcript.</p>
              </aside>
            ` : nothing}
          </div>
        </div>
      </div>
    </section>
  `;
}

export function renderHome(props: HomeProps) {
  return props.session
    ? renderTranscript(props, props.session)
    : renderNewSession(props);
}

/** The routed New Session capability uses the same registry-backed form as Home. */
export function renderNewSession(props: HomeProps) {
  return html`<section class="new-session-page">
    <div class="new-session-page__scroll">${renderLaunchForm({ ...props, session: undefined })}</div>
  </section>`;
}
