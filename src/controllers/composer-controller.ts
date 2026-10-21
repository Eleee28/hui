/**
 * `ComposerController` owns the open conversation's composer outside `hui-app.ts`: its draft and attachments, kept
 * per session through `lib/composer/drafts.ts`, with the sessions that hold a draft (the sidebar's pencil); the slash
 * command menu and the commands it lists; local path and bot mention completion; sending a prompt, a steer, a
 * follow-up or a composer command (`/clear`, `/reload`, `/compact`, `/btw` with its side chat), with the first prompt
 * of a launched session held until it is idle; stopping a turn, compacting, rewinding to a message, the Fork dialog's
 * target and answering a question; and the session's message queue, with the edit of one queued message and the
 * requests that edit, remove, move and steer queued messages. The shell reads its props, measures its textarea and
 * hands it the queue from the conversation's snapshots and events.
 */
import type { LitElement, ReactiveControllerHost } from "lit";
import { abortSession, answerQuestion as answerQuestionRequest, askSideQuestion, cancelCompaction, clearSession, compactSession, continueSession, followUpSession, loadCommands, mutateQueuedMessage, reloadSession, rewindSession, sendPrompt, steerSession, type Attachment, type PromptMode, type QuestionResponse, type QueueSnapshot, type RewindTarget, type RuntimeCommand, type SessionSnapshot, type SessionStatus, type SessionView, type TranscriptAttachment } from "../api/sessions.ts";
import { readTranscriptAttachments } from "../api/attachments.ts";
import { loadLocalPathSuggestions } from "../api/local-paths.ts";
import type { ForkTarget } from "../components/fork-dialog.ts";
import { attachmentPreview, readAttachment, validateAttachmentTotal } from "../lib/attachments.ts";
import type { BotView } from "../lib/bots/bots.ts";
import { listComposerDraftSessionIds, mayUseComposerDraftKey, mergeComposerDraft, NEW_SESSION_DRAFT_KEY, readComposerDraft, sessionDraftKey, sessionIdFromDraftKey, writeComposerDraft } from "../lib/composer/drafts.ts";
import { SendRequests } from "../lib/composer/send-requests.ts";
import { EMPTY_QUEUE, streamingAfterSubmission } from "../lib/composer/state.ts";
import { botMentionSuggestions, completeLocalPath, type LocalPathQuery, type LocalPathSuggestion } from "../lib/local-paths.ts";
import { isSelectedSession, shouldFlushLaunchPrompt, type NoteLevel } from "../lib/session/ui-state.ts";
import { botChatCommandRefusal, completeCommandReference, composerCommands, filterSlashCommands, parseClearCommand, parseCompactCommand, parseReloadCommand, slashCommandQuery, type CommandQuery, type ComposerCommand } from "../lib/composer/slash-commands.ts";
import { appendPendingUser, localTranscriptId, settlePendingUser } from "../lib/transcript-state.ts";
import type { HomeProps } from "../views/home.ts";
import type { ConversationController } from "./conversation-controller.ts";

type ComposerDeps = {
  conversation: ConversationController;
  showNote: (message: string, level?: NoteLevel) => void;
  handleUpdateCommand: (text: string, attachments: readonly Attachment[]) => boolean;
  embeddedPane: () => boolean;
  draftChanged: (sessionId: string, hasDraft: boolean) => void;
  composerSession: () => SessionView | undefined;
  draftCommands: () => readonly RuntimeCommand[];
  defaultCwd: () => string | undefined;
  mentionable: () => readonly BotView[];
  textarea: () => HTMLTextAreaElement | null;
  launching: () => boolean;
};

type ComposerHost = ReactiveControllerHost & Pick<LitElement, "renderRoot">;

export class ComposerController {
  /** The composer's live text, deliberately not rendered from: a keystroke only
   * changes what its own textarea already shows, so typing must not re-render
   * the transcript behind it. Code-owned changes go through `setDraft`. */
  draft = "";
  /** Bumped by `setDraft` so the shell measures a textarea whose value code
   * replaced, never one the operator is typing into. */
  draftRevision = 0;
  /** Picked but not yet sent; cleared on send and on switching session. */
  attachments: readonly Attachment[] = [];
  draftSessionIds: ReadonlySet<string> = new Set();
  draftKey = NEW_SESSION_DRAFT_KEY;
  draftLoad = 0;
  draftEdit = 0;
  draftHydrated = false;
  pendingCommandBrowse = false;
  commands: readonly RuntimeCommand[] = [];
  commandsLoading = false;
  commandsError = "";
  slashQuery: CommandQuery | null = null;
  slashActiveIndex = 0;
  localPathQuery: LocalPathQuery | null = null;
  localPaths: readonly LocalPathSuggestion[] = [];
  localPathsLoading = false;
  localPathsError = "";
  localPathActiveIndex = 0;
  queue: QueueSnapshot = EMPTY_QUEUE;
  queueEditingId = "";
  queueEditingText = "";
  sending = false;
  rewindPending = false;
  /** The Fork from here dialog: the session and reply it forks from. While it is open, the chat's fork buttons rest. */
  forkTarget: ForkTarget | undefined;
  sideChat: HomeProps["sideChat"];
  /** First prompt composed on New Session, released only after PI reports idle. */
  pendingLaunchPrompt = "";
  pendingLaunchAttachments: readonly Attachment[] = [];
  readonly #host: ComposerHost;
  readonly #deps: ComposerDeps;
  readonly #conversation: ConversationController;
  /** Request ids for composer sends, so resending one the gateway already took never runs it twice. */
  readonly #sendRequests = new SendRequests();
  #draftIndicatorRevision = 0;
  #commandsLoaded = false;
  #commandsRequest = 0;
  #localPathsRequest = 0;
  #localPathCwd = "";

  constructor(host: ComposerHost, deps: ComposerDeps) {
    this.#host = host;
    this.#deps = deps;
    this.#conversation = deps.conversation;
  }

  persistDraft(
    key = this.draftKey,
    text = this.draft,
    attachments: readonly Attachment[] = this.attachments,
  ) {
    if (!mayUseComposerDraftKey(this.#deps.embeddedPane(), key)) return;
    const sessionId = sessionIdFromDraftKey(key);
    if (sessionId) {
      const hasDraft = Boolean(text || attachments.length);
      this.markSessionDraft(sessionId, hasDraft);
      this.#deps.draftChanged(sessionId, hasDraft);
    }
    return writeComposerDraft(key, { text, attachments });
  }

  markSessionDraft(sessionId: string, hasDraft: boolean): void {
    if (this.draftSessionIds.has(sessionId) === hasDraft) return;
    const next = new Set(this.draftSessionIds);
    hasDraft ? next.add(sessionId) : next.delete(sessionId);
    this.#draftIndicatorRevision += 1;
    this.draftSessionIds = next;
    this.#host.requestUpdate();
  }

  refreshDraftIndicators(): void {
    const revision = this.#draftIndicatorRevision;
    void listComposerDraftSessionIds().then((sessionIds) => {
      if (revision !== this.#draftIndicatorRevision) return;
      this.draftSessionIds = new Set(sessionIds);
      this.#host.requestUpdate();
    });
  }

  switchDraft(key: string): void {
    if (!mayUseComposerDraftKey(this.#deps.embeddedPane(), key)) return;
    if (key === this.draftKey && this.draftHydrated) return;
    if (key !== this.draftKey) void this.persistDraft();
    this.draftKey = key;
    this.draftHydrated = true;
    const load = ++this.draftLoad;
    const edit = ++this.draftEdit;
    this.setDraft("");
    this.attachments = [];
    void readComposerDraft(key).then((draft) => {
      if (load !== this.draftLoad || edit !== this.draftEdit || key !== this.draftKey) return;
      this.setDraft(draft.text);
      this.attachments = draft.attachments;
    });
  }

  /** A keystroke. The textarea already shows this text, so the value itself
   * needs no update; only what the draft makes the composer show (Send/Stop
   * instead of nothing to send) does, and that flips at most twice per message. */
  #typeDraft = (draft: string) => {
    const hadText = this.draft.trim() !== "";
    this.draftEdit += 1;
    this.draft = draft;
    if ((draft.trim() !== "") !== hadText) this.#host.requestUpdate();
    void this.persistDraft();
  };

  /** A draft HUI set, not one typed into the textarea: it has to reach the
   * value, the controls derived from it and the textarea's measured height. */
  setDraft(draft: string): void {
    this.draft = draft;
    this.draftRevision += 1;
    this.#host.requestUpdate();
  }

  updateDraft = (draft: string) => {
    this.draftEdit += 1;
    this.setDraft(draft);
    void this.persistDraft();
  };

  resetCommands(): void {
    this.#commandsRequest += 1;
    this.commands = [];
    this.#commandsLoaded = false;
    this.commandsLoading = false;
    this.commandsError = "";
    this.slashQuery = null;
    this.slashActiveIndex = 0;
    this.#host.requestUpdate();
  }

  closeCommands(): void {
    this.slashQuery = null;
    this.#host.requestUpdate();
  }

  resetLocalPaths(): void {
    this.#localPathsRequest += 1;
    // Typing text that opens no `@` mention repeats this reset on every
    // keystroke, and reassigning the values it already holds would schedule a
    // second full app render alongside the draft's own update.
    if (this.localPathQuery === null && this.localPaths.length === 0 && !this.localPathsLoading
      && this.localPathsError === "" && this.localPathActiveIndex === 0 && this.#localPathCwd === "") {
      return;
    }
    this.localPathQuery = null;
    this.localPaths = [];
    this.localPathsLoading = false;
    this.localPathsError = "";
    this.localPathActiveIndex = 0;
    this.#localPathCwd = "";
    this.#host.requestUpdate();
  }

  browseCommands(textarea: HTMLTextAreaElement): void {
    this.pendingCommandBrowse = false;
    textarea.focus();
    textarea.setSelectionRange(this.draft.length, this.draft.length);
    this.#setCommandQuery(slashCommandQuery(this.draft, this.draft.length));
  }

  #requestCommands = () => {
    const session = this.#deps.composerSession();
    if (!session || session.status === "starting" || session.status === "error" || this.commandsLoading) return;
    const request = ++this.#commandsRequest;
    const current = () => this.#conversation.selected?.id === session.id && request === this.#commandsRequest;
    const returnFocus = document.activeElement?.closest(".slash-menu") !== null;
    this.commandsLoading = true;
    this.commandsError = "";
    this.#host.requestUpdate();
    void loadCommands(session.id).then((commands) => {
      if (!current()) return;
      this.commands = commands;
      this.#commandsLoaded = true;
      this.slashActiveIndex = 0;
      if (returnFocus) void this.#host.updateComplete.then(() => {
        if (current() && this.slashQuery !== null) this.#deps.textarea()?.focus();
      });
    }).catch((error: unknown) => {
      if (current()) this.commandsError = error instanceof Error ? error.message : "Could not load commands.";
    }).finally(() => {
      if (!current()) return;
      this.commandsLoading = false;
      this.#host.requestUpdate();
    });
  };

  #runtimeCommands(): readonly RuntimeCommand[] {
    if (this.#deps.composerSession()) return this.commands;
    return this.#deps.draftCommands();
  }

  #menuCommands(): ComposerCommand[] {
    const query = this.slashQuery ?? { text: "", start: 0 };
    const runtime = this.#runtimeCommands();
    if (query.start > 0) return filterSlashCommands(runtime.filter((command) => command.source === "skill"), query.text.slice(1));
    const session = this.#deps.composerSession();
    return filterSlashCommands(query.text.startsWith("$") ? runtime : composerCommands(runtime, !!session, Boolean(session?.bot)), query.text);
  }

  #setCommandQuery = (query: CommandQuery | null) => {
    // Scheduling an update on every keystroke re-renders the whole app: only a
    // changed query may schedule one.
    if (query?.text !== this.slashQuery?.text || query?.start !== this.slashQuery?.start) {
      this.slashActiveIndex = 0;
      this.slashQuery = query;
      this.#host.requestUpdate();
    }
    if (query !== null && !this.#commandsLoaded && !this.commandsError) this.#requestCommands();
  };

  #selectSlashCommand = (command: ComposerCommand) => {
    const completed = completeCommandReference(this.draft, command, this.#runtimeCommands(), this.slashQuery?.start ?? 0);
    this.updateDraft(completed.text);
    this.resetLocalPaths();
    this.slashQuery = null;
    void this.#host.updateComplete.then(() => {
      const textarea = this.#deps.textarea();
      if (!textarea) return;
      textarea.value = completed.text;
      textarea.focus();
      textarea.setSelectionRange(completed.caret, completed.caret);
    });
  };

  #commandKeydown = (event: KeyboardEvent) => {
    if (this.slashQuery === null || event.isComposing || !(event.target instanceof HTMLTextAreaElement)) return;
    const commands = this.#menuCommands();
    const paths = this.localPathQuery ? this.localPaths : [];
    const count = commands.length + paths.length;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.closeCommands();
      this.resetLocalPaths();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if ((this.commandsLoading || this.localPathsLoading) && !count && (event.key === "Enter" || event.key === "Tab")) {
      event.preventDefault();
      return;
    }
    if (!count) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      this.slashActiveIndex = (this.slashActiveIndex + (event.key === "ArrowDown" ? 1 : -1) + count) % count;
      this.#host.requestUpdate();
      void this.#host.updateComplete.then(() => this.#host.renderRoot.querySelector('.slash-menu [aria-selected="true"]')?.scrollIntoView({ block: "nearest" }));
    } else if (event.key === "Enter" || event.key === "Tab") {
      const command = commands[this.slashActiveIndex];
      if (command) {
        event.preventDefault();
        this.#selectSlashCommand(command);
      } else {
        const path = paths[this.slashActiveIndex - commands.length];
        if (path) { event.preventDefault(); this.#selectLocalPath(path); }
      }
    }
  };

  #setLocalPathQuery = (query: LocalPathQuery | null, cwd?: string) => {
    if (!query) {
      this.resetLocalPaths();
      return;
    }
    const workspace = this.#deps.composerSession()?.cwd || cwd?.trim() || this.#deps.defaultCwd() || "~/";
    const sameQuery = this.localPathQuery?.input === query.input
      && this.localPathQuery.start === query.start
      && this.localPathQuery.end === query.end
      && this.localPathQuery.mention === query.mention
      && this.#localPathCwd === workspace;
    this.localPathQuery = query;
    this.#localPathCwd = workspace;
    if (sameQuery && (this.localPathsLoading || this.localPaths.length > 0 || this.localPathsError)) return;
    this.#host.requestUpdate();
    this.localPathActiveIndex = 0;
    this.slashActiveIndex = 0;
    // A mention tags a bot as well as naming a file: the bots it matches come first, at once. A session still on PI's SDK
    // worker has no message_bot.
    const selected = this.#conversation.selected;
    const bots = query.mention && selected?.tool !== "pi" ? botMentionSuggestions(this.#deps.mentionable(), query.input, selected?.bot?.id) : [];
    this.localPaths = bots;
    const request = ++this.#localPathsRequest;
    this.localPathsLoading = true;
    this.localPathsError = "";
    void loadLocalPathSuggestions(workspace, query.input).then((paths) => {
      if (request !== this.#localPathsRequest) return;
      this.localPaths = [...bots, ...paths];
    }).catch((error: unknown) => {
      if (request !== this.#localPathsRequest) return;
      this.localPaths = bots;
      this.localPathsError = error instanceof Error ? error.message : "Could not load local paths.";
    }).finally(() => {
      if (request !== this.#localPathsRequest) return;
      this.localPathsLoading = false;
      this.#host.requestUpdate();
    });
  };

  #retryLocalPaths = () => {
    const query = this.localPathQuery;
    const cwd = this.#localPathCwd;
    this.resetLocalPaths();
    if (query) this.#setLocalPathQuery(query, cwd);
  };

  #selectLocalPath = (suggestion: LocalPathSuggestion) => {
    const query = this.localPathQuery;
    if (!query) return;
    this.slashQuery = null;
    const completed = completeLocalPath(this.draft, query, suggestion);
    this.updateDraft(completed.text);
    if (suggestion.kind === "directory") {
      this.#setLocalPathQuery({
        input: suggestion.path,
        start: query.start,
        end: completed.caret,
        mention: query.mention,
      }, this.#localPathCwd);
    } else {
      this.resetLocalPaths();
    }
    void this.#host.updateComplete.then(() => {
      const textarea = this.#deps.textarea();
      if (!textarea) return;
      textarea.value = completed.text;
      textarea.focus();
      textarea.setSelectionRange(completed.caret, completed.caret);
      if (suggestion.kind !== "directory") {
        requestAnimationFrame(() => this.resetLocalPaths());
      }
    });
  };

  #localPathKeydown = (event: KeyboardEvent) => {
    if (this.slashQuery !== null || !this.localPathQuery || event.isComposing || !(event.target instanceof HTMLTextAreaElement)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.resetLocalPaths();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if (this.localPathsLoading && (event.key === "Enter" || event.key === "Tab")) {
      event.preventDefault();
      return;
    }
    if (!this.localPaths.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      this.localPathActiveIndex = (this.localPathActiveIndex + (event.key === "ArrowDown" ? 1 : -1) + this.localPaths.length) % this.localPaths.length;
      this.#host.requestUpdate();
      void this.#host.updateComplete.then(() => this.#host.renderRoot.querySelector('.mention-menu [aria-selected="true"]')?.scrollIntoView({ block: "nearest" }));
    } else if (event.key === "Enter" || event.key === "Tab") {
      const suggestion = this.localPaths[this.localPathActiveIndex];
      if (suggestion) {
        event.preventDefault();
        this.#selectLocalPath(suggestion);
      }
    }
  };

  #addAttachments = (files: readonly File[]) => {
    const key = this.draftKey;
    if (this.sending || this.#deps.launching()) {
      return;
    }
    void Promise.all(files.map((file) => readAttachment(file)))
      .then(async (added) => {
        if (key !== this.draftKey) {
          const stored = await readComposerDraft(key);
          const attachments = [...stored.attachments, ...added];
          validateAttachmentTotal(attachments);
          await this.persistDraft(key, stored.text, attachments);
          return;
        }
        const next = [...this.attachments, ...added];
        validateAttachmentTotal(next);
        this.draftEdit += 1;
        this.attachments = next;
        this.#host.requestUpdate();
        await this.persistDraft();
      })
      .catch((error: unknown) => {
        if (key !== this.draftKey) {
          return;
        }
        this.#deps.showNote(error instanceof Error ? error.message : "Could not read that file.", "error");
      });
  };

  #removeAttachment = (index: number) => {
    if (this.sending) return;
    this.draftEdit += 1;
    this.attachments = this.attachments.filter((_, at) => at !== index);
    this.#host.requestUpdate();
    void this.persistDraft();
  };

  adoptQueue(queue: QueueSnapshot): void {
    this.queue = queue;
    this.#host.requestUpdate();
  }

  adoptSnapshot({ queue }: SessionSnapshot): void {
    this.adoptQueue(queue);
    if (this.queueEditingId && !queue.items?.some((item) => item.id === this.queueEditingId)) this.#setQueueEdit("", "");
  }

  #setQueueEdit(id: string, text: string): void {
    this.queueEditingId = id;
    this.queueEditingText = text;
    this.#host.requestUpdate();
  }

  #queueMutation(mutation: Parameters<typeof mutateQueuedMessage>[1], onSuccess?: () => void): void {
    const session = this.#conversation.selected;
    if (!session) return;
    void mutateQueuedMessage(session.id, mutation)
      .then(() => {
        if (isSelectedSession(session.id, this.#conversation.selected?.id)) onSuccess?.();
      })
      .catch((error: unknown) => {
        if (!isSelectedSession(session.id, this.#conversation.selected?.id)) return;
        this.#deps.showNote(error instanceof Error ? error.message : "Could not update the queue.", "error");
      });
  }

  followStatus(status: SessionStatus): void {
    if (status === "idle") {
      this.flushLaunchPrompt();
    } else if ((status === "error" || status === "reconnecting" || status === "disconnected") && this.pendingLaunchPrompt) {
      this.draftEdit += 1;
      this.setDraft(this.pendingLaunchPrompt);
      this.attachments = this.pendingLaunchAttachments;
      this.pendingLaunchPrompt = "";
      this.pendingLaunchAttachments = [];
      void this.persistDraft();
    }
  }

  resetSession(): void {
    this.resetCommands();
    this.resetLocalPaths();
    this.pendingCommandBrowse = false;
    this.sending = false;
    this.adoptQueue(EMPTY_QUEUE);
    this.sideChat = undefined;
  }

  clearSession(): void {
    this.switchDraft(NEW_SESSION_DRAFT_KEY);
    this.pendingLaunchPrompt = "";
    this.pendingLaunchAttachments = [];
    this.rewindPending = false;
    this.#host.requestUpdate();
  }

  closeSideChat(): void {
    this.sideChat = undefined;
    this.#host.requestUpdate();
  }

  #showSideChat(sideChat: NonNullable<HomeProps["sideChat"]>): void {
    this.sideChat = sideChat;
    this.#host.requestUpdate();
  }

  closeFork(): void {
    this.forkTarget = undefined;
    this.#host.requestUpdate();
  }

  flushLaunchPrompt(): void {
    const prompt = this.pendingLaunchPrompt;
    if (!shouldFlushLaunchPrompt(prompt, this.#conversation.selected?.status, this.#conversation.connection, this.#conversation.opening)) {
      return;
    }
    const attachments = this.pendingLaunchAttachments;
    this.pendingLaunchPrompt = "";
    this.pendingLaunchAttachments = [];
    this.send(prompt, attachments);
  }

  send = (text: string, attachments: readonly Attachment[] = [], mode: PromptMode = "prompt") => {
    if (this.#deps.handleUpdateCommand(text, attachments)) return;
    const session = this.#conversation.selected;
    const trimmed = text.trim();
    const hasImage = attachments.some((item) => item.kind === "image");
    if (!session || (!trimmed && !hasImage) || this.#conversation.opening || this.sending || this.#conversation.connection !== "live") {
      return;
    }
    // The gateway refuses these for a bot's permanent chat; say why without a round trip.
    const botRefusal = session.bot ? botChatCommandRefusal(trimmed) : undefined;
    if (botRefusal) {
      this.#deps.showNote(botRefusal, "error");
      return;
    }
    const clearCommand = parseClearCommand(trimmed);
    const reloadCommand = parseReloadCommand(trimmed);
    const command = clearCommand ? "clear" : reloadCommand ? "reload" : undefined;
    if (command) {
      if ((clearCommand ?? reloadCommand) === "invalid" || attachments.length) {
        this.#deps.showNote(`Use /${command} without arguments or attachments.`, "error");
        return;
      }
      if (mode !== "prompt" || this.#conversation.streaming || session.status !== "idle") {
        this.#deps.showNote(`Finish or stop active work before ${command}ing the session.`, "error");
        return;
      }
      this.#deps.showNote("", "info");
      this.sending = true;
      this.#host.requestUpdate();
      this.draftEdit += 1;
      this.setDraft("");
      this.attachments = [];
      void this.persistDraft(sessionDraftKey(session.id), "", []);
      const run = command === "clear"
        ? clearSession(session.id).then((snapshot) => {
          if (!isSelectedSession(session.id, this.#conversation.selected?.id)) return;
          this.#conversation.applySnapshot(snapshot);
          this.closeSideChat();
          this.#deps.showNote("Session context cleared.");
        })
        : reloadSession(session.id).then(() => {
          if (!isSelectedSession(session.id, this.#conversation.selected?.id)) return;
          // Skills, prompts and extension commands may have changed.
          this.resetCommands();
          this.#deps.showNote("Reloaded extensions, skills, prompts and context files.");
        });
      void run.catch(async (error: unknown) => {
        if (await this.#restoreSentDraft(session.id, text, attachments)) {
          this.#deps.showNote(error instanceof Error ? error.message : `Could not ${command} that session.`, "error");
        }
      }).finally(() => {
        if (isSelectedSession(session.id, this.#conversation.selected?.id)) {
          this.sending = false;
          this.#host.requestUpdate();
        }
      });
      return;
    }
    const compact = parseCompactCommand(trimmed);
    if (compact) {
      if (attachments.length || mode !== "prompt") {
        this.#deps.showNote(attachments.length ? "Use /compact without attachments." : "Finish or stop active work before compacting the session.", "error");
        return;
      }
      this.#compactNow(compact.instructions, text);
      return;
    }
    const sideQuestion = /^\/(?:btw|side)(?:\s+([\s\S]+))?$/iu.exec(trimmed)?.[1]?.trim();
    if (/^\/(?:btw|side)(?:\s|$)/iu.test(trimmed)) {
      if (!sideQuestion) {
        this.#deps.showNote("Add a question after /btw. Example: /btw which file are we editing?", "error");
        return;
      }
      if (attachments.length) {
        this.#deps.showNote("/btw does not support attachments in this build.", "error");
        return;
      }
      this.draftEdit += 1;
      this.setDraft("");
      void this.persistDraft(sessionDraftKey(session.id), "", []);
      this.#showSideChat({ question: sideQuestion, answer: "", model: "", loading: true, error: "" });
      void askSideQuestion(session.id, sideQuestion).then((result) => {
        if (isSelectedSession(session.id, this.#conversation.selected?.id)) {
          this.#showSideChat({ ...result, loading: false, error: "" });
        }
      }).catch((error: unknown) => {
        if (isSelectedSession(session.id, this.#conversation.selected?.id)) {
          this.#showSideChat({
            question: sideQuestion,
            answer: "",
            model: "",
            loading: false,
            error: error instanceof Error ? error.message : "The side question failed.",
          });
        }
      });
      return;
    }
    const pendingId = localTranscriptId("user");
    this.#deps.showNote("", "info");
    this.sending = true;
    this.#host.requestUpdate();
    // Claim this exact payload before awaiting HTTP. The composer stays locked
    // for the short acknowledgement window, so a rejection can restore this
    // transaction without mixing it with a second draft.
    this.draftEdit += 1;
    this.setDraft("");
    this.attachments = [];
    void this.persistDraft(sessionDraftKey(session.id), "", []);
    this.#conversation.streaming = streamingAfterSubmission(
      this.#conversation.streaming,
      mode,
      "started",
      session.status,
    );
    const sentAttachments = attachments.map((item) => ({ name: item.name, kind: item.kind, mimeType: item.mimeType, ...(attachmentPreview(item) ? { url: attachmentPreview(item) } : {}) }));
    if (mode === "prompt") {
      this.#conversation.transcript = appendPendingUser(this.#conversation.transcript, pendingId, trimmed, sentAttachments);
    }
    this.#host.requestUpdate();
    const request = mode === "steer" ? steerSession : mode === "followUp" ? followUpSession : sendPrompt;
    // A resend of a send that failed on the way keeps its id, whatever the mode is now: a prompt the gateway took
    // started a run, so its resend comes back as a steer or follow-up.
    const { requestId, earlierRow } = this.#sendRequests.take(session.id, trimmed, attachments);
    void request(session.id, trimmed, attachments, requestId)
      .then(({ duplicate }) => {
        if (!isSelectedSession(session.id, this.#conversation.selected?.id)) return;
        // The gateway had the first attempt all along: its message is in the session, so drop the local copies.
        if (duplicate) this.#conversation.transcript = this.#conversation.transcript.filter((item) => item.id !== pendingId && item.id !== earlierRow);
        else if (mode === "prompt") this.#conversation.transcript = settlePendingUser(this.#conversation.transcript, pendingId, true);
        this.#conversation.streaming = streamingAfterSubmission(
          this.#conversation.streaming,
          mode,
          duplicate ? "duplicate" : "accepted",
          this.#conversation.selected?.status ?? session.status,
        );
        this.#host.requestUpdate();
      })
      .catch(async (error: unknown) => {
        this.#sendRequests.failed(session.id, requestId, trimmed, attachments, mode === "prompt" ? pendingId : undefined);
        const stillSelected = isSelectedSession(session.id, this.#conversation.selected?.id);
        // The gateway's snapshots may have replaced the local row and then withdrawn theirs: show it failed again.
        if (stillSelected && mode === "prompt") this.#conversation.transcript = settlePendingUser(this.#conversation.transcript.some((item) => item.id === pendingId)
          ? this.#conversation.transcript : appendPendingUser(this.#conversation.transcript, pendingId, trimmed, sentAttachments), pendingId, false);
        this.#host.requestUpdate();
        const stored = stillSelected
          ? { text: this.draft, attachments: this.attachments }
          : await readComposerDraft(sessionDraftKey(session.id));
        const restored = mergeComposerDraft(stored, { text, attachments });
        await this.persistDraft(sessionDraftKey(session.id), restored.text, restored.attachments);
        if (!stillSelected) return;
        this.draftEdit += 1;
        this.setDraft(restored.text);
        this.attachments = restored.attachments;
        this.#conversation.streaming = streamingAfterSubmission(
          this.#conversation.streaming,
          mode,
          "rejected",
          this.#conversation.selected?.status ?? session.status,
        );
        this.#host.requestUpdate();
        this.#deps.showNote(error instanceof Error ? error.message : "Could not send that prompt.", "error");
      })
      .finally(() => {
        if (isSelectedSession(session.id, this.#conversation.selected?.id)) {
          this.sending = false;
          this.#host.requestUpdate();
        }
      });
  };

  #continueInterrupted = () => {
    const session = this.#conversation.selected;
    if (!session?.interrupted || this.sending || this.#conversation.opening || this.#conversation.connection !== "live") return;
    this.#deps.showNote("", "info");
    this.sending = true;
    this.#host.requestUpdate();
    void continueSession(session.id)
      .catch((error: unknown) => {
        if (!isSelectedSession(session.id, this.#conversation.selected?.id)) return;
        this.#deps.showNote(error instanceof Error ? error.message : "Could not continue that run.", "error");
      })
      .finally(() => {
        if (isSelectedSession(session.id, this.#conversation.selected?.id)) {
          this.sending = false;
          this.#host.requestUpdate();
        }
      });
  };

  abort = () => {
    const session = this.#conversation.selected;
    if (!session || this.#conversation.stopping) {
      return;
    }
    this.#conversation.stopping = true;
    this.#host.requestUpdate();
    void abortSession(session.id)
      .catch((error: unknown) => {
        if (!isSelectedSession(session.id, this.#conversation.selected?.id)) return;
        this.#deps.showNote(error instanceof Error ? error.message : "Could not stop that turn.", "error");
      })
      .finally(() => {
        if (!isSelectedSession(session.id, this.#conversation.selected?.id)) return;
        this.#conversation.stopping = false;
        this.#host.requestUpdate();
      });
  };

  /** The outcome arrives as `compaction_end`: the divider then reads cancelled. */
  #cancelCompactionNow(): void {
    const session = this.#conversation.selected;
    if (!session) return;
    void cancelCompaction(session.id).catch((error: unknown) => {
      if (!isSelectedSession(session.id, this.#conversation.selected?.id)) return;
      this.#deps.showNote(error instanceof Error ? error.message : "Could not cancel that compaction.", "error");
    });
  }

  /** `typed` is the `/compact` draft, cleared now and given back if HUI refuses. */
  #compactNow(instructions?: string, typed?: string) {
    const session = this.#conversation.selected;
    if (!session || this.sending) return;
    if (this.#conversation.streaming || session.status !== "idle") {
      this.#deps.showNote("Finish or stop active work before compacting the session.", "error");
      return;
    }
    if (this.#conversation.compaction?.status === "running") {
      this.#deps.showNote("A compaction is already running.", "error");
      return;
    }
    this.#deps.showNote("", "info");
    this.sending = true;
    this.#host.requestUpdate();
    if (typed !== undefined) {
      this.draftEdit += 1;
      this.setDraft("");
      void this.persistDraft(sessionDraftKey(session.id), "", []);
    }
    // Progress and the outcome arrive as compaction events.
    void compactSession(session.id, instructions).catch(async (error: unknown) => {
      if (typed !== undefined ? await this.#restoreSentDraft(session.id, typed, []) : isSelectedSession(session.id, this.#conversation.selected?.id)) {
        this.#deps.showNote(error instanceof Error ? error.message : "Could not compact that session.", "error");
      }
    }).finally(() => {
      if (isSelectedSession(session.id, this.#conversation.selected?.id)) {
        this.sending = false;
        this.#host.requestUpdate();
      }
    });
  }

  /** Puts a refused command back into the composer, merged with anything typed
   * since. True while that session is still selected. */
  async #restoreSentDraft(sessionId: string, text: string, attachments: readonly Attachment[]): Promise<boolean> {
    const stillSelected = isSelectedSession(sessionId, this.#conversation.selected?.id);
    const stored = stillSelected
      ? { text: this.draft, attachments: this.attachments }
      : await readComposerDraft(sessionDraftKey(sessionId));
    const restored = mergeComposerDraft(stored, { text, attachments });
    await this.persistDraft(sessionDraftKey(sessionId), restored.text, restored.attachments);
    if (!stillSelected) return false;
    this.draftEdit += 1;
    this.setDraft(restored.text);
    this.attachments = restored.attachments;
    return true;
  }

  #rewindToMessage = (target: RewindTarget, text: string, sent: readonly (string | TranscriptAttachment)[] = []) => {
    const session = this.#conversation.selected;
    if (!session || this.#conversation.opening || this.rewindPending) return;
    this.rewindPending = true;
    this.#host.requestUpdate();
    this.#deps.showNote("", "info");
    // Read the attachments first: their URLs point into the branch the rewind leaves.
    void readTranscriptAttachments(sent)
      .then(async (attachments) => {
        await rewindSession(session.id, target, true);
        if (!isSelectedSession(session.id, this.#conversation.selected?.id)) return;
        this.draftEdit += 1;
        this.setDraft(text);
        this.attachments = attachments;
        await this.persistDraft();
        await this.#host.updateComplete;
        if (!isSelectedSession(session.id, this.#conversation.selected?.id)) return;
        this.#deps.textarea()?.focus();
        this.#deps.textarea()?.setSelectionRange(text.length, text.length);
        this.#deps.showNote("Message restored to the composer. The previous branch is kept.", "info");
      })
      .catch((error: unknown) => {
        if (!isSelectedSession(session.id, this.#conversation.selected?.id)) return;
        this.#deps.showNote(error instanceof Error ? error.message : "Could not rewind that message.", "error");
      })
      .finally(() => {
        if (isSelectedSession(session.id, this.#conversation.selected?.id)) {
          this.rewindPending = false;
          this.#host.requestUpdate();
        }
      });
  };

  /** Asks where the fork works (same checkout or a new worktree); the dialog copies the history and `forked` opens
   * the copy. The source session is left running or idle as it was. */
  #forkFromMessage = (entryId: string) => {
    const session = this.#conversation.selected;
    if (!session || this.#conversation.opening || this.forkTarget) return;
    void import("../components/fork-dialog.ts").then(() => {
      this.forkTarget = { session, entryId };
      this.#host.requestUpdate();
    });
  };

  #answerQuestion = (answer: QuestionResponse) => {
    const session = this.#conversation.selected;
    const question = this.#conversation.question;
    if (!session || !question) return;
    this.#conversation.question = undefined;
    this.#host.requestUpdate();
    void answerQuestionRequest(session.id, question.id, answer)
      .then(() => {
        // The next question may already be showing (parallel calls): leave focus in it.
        if (isSelectedSession(session.id, this.#conversation.selected?.id) && !this.#conversation.question) this.#conversation.restoreQuestionFocus();
      })
      .catch((error: unknown) => {
        if (!isSelectedSession(session.id, this.#conversation.selected?.id)) return;
        this.#conversation.question = question;
        this.#host.requestUpdate();
        this.#deps.showNote(error instanceof Error ? error.message : "Could not answer pi.", "error");
      });
  };

  props(): Pick<HomeProps, "sending" | "rewindPending" | "forkPending" | "sideChat" | "onCloseSideChat" | "onSendPrompt" | "onContinueInterrupted" | "onAbort" | "onRewind" | "onFork" | "onCompact" | "onCancelCompaction" | "onAnswerQuestion" | "draft" | "attachments" | "onDraftChange" | "onDraftInput" | "commandMenu" | "onCommandQuery" | "onCommandKeydown" | "localPathMenu" | "onLocalPathQuery" | "onLocalPathKeydown" | "onAddAttachments" | "onRemoveAttachment" | "queue" | "queueEditingId" | "queueEditingText" | "onQueueEdit" | "onQueueEditChange" | "onQueueEditSubmit" | "onQueueEditCancel" | "onQueueRemove" | "onQueueMove" | "onQueueSteer"> {
    const conversation = this.#conversation;
    const sending = this.sending;
    return {
      sending,
      rewindPending: this.rewindPending,
      forkPending: Boolean(this.forkTarget),
      sideChat: this.sideChat,
      onCloseSideChat: () => this.closeSideChat(),
      onSendPrompt: this.send,
      onContinueInterrupted: this.#continueInterrupted,
      onAbort: this.abort,
      onRewind: this.#rewindToMessage,
      onFork: this.#forkFromMessage,
      onCompact: () => this.#compactNow(),
      onCancelCompaction: () => this.#cancelCompactionNow(),
      onAnswerQuestion: this.#answerQuestion,
      draft: this.draft,
      attachments: this.attachments,
      onDraftChange: this.updateDraft,
      onDraftInput: this.#typeDraft,
      commandMenu: {
        open: this.slashQuery !== null && !sending && !conversation.opening && !this.#deps.launching() && (!this.#deps.composerSession() || conversation.connection === "live"),
        commands: this.#menuCommands(),
        catalog: this.#runtimeCommands(),
        paths: this.localPathQuery ? this.localPaths : undefined,
        pathsLoading: this.localPathsLoading,
        pathsError: this.localPathsError,
        onSelectPath: this.#selectLocalPath,
        onRetryPaths: this.#retryLocalPaths,
        activeIndex: this.slashActiveIndex,
        loading: this.commandsLoading,
        error: this.commandsError,
        streaming: conversation.streaming,
        onSelect: this.#selectSlashCommand,
        onRetry: this.#requestCommands,
      },
      onCommandQuery: this.#setCommandQuery,
      onCommandKeydown: this.#commandKeydown,
      localPathMenu: {
        open: this.localPathQuery !== null && this.slashQuery === null && !sending && !conversation.opening && conversation.connection === "live",
        paths: this.localPaths,
        activeIndex: this.localPathActiveIndex,
        loading: this.localPathsLoading,
        error: this.localPathsError,
        onSelect: this.#selectLocalPath,
        onRetry: this.#retryLocalPaths,
      },
      onLocalPathQuery: this.#setLocalPathQuery,
      onLocalPathKeydown: this.#localPathKeydown,
      onAddAttachments: this.#addAttachments,
      onRemoveAttachment: this.#removeAttachment,
      queue: this.queue,
      queueEditingId: this.queueEditingId,
      queueEditingText: this.queueEditingText,
      onQueueEdit: (id) => {
        const item = this.queue.items?.find((candidate) => candidate.id === id);
        if (!item) return;
        this.#setQueueEdit(id, item.text);
      },
      onQueueEditChange: (text) => this.#setQueueEdit(this.queueEditingId, text),
      onQueueEditSubmit: () => {
        const itemId = this.queueEditingId;
        const text = this.queueEditingText.trim();
        if (!itemId || !text) return;
        this.#queueMutation({ operation: "edit", itemId, text }, () => this.#setQueueEdit("", ""));
      },
      onQueueEditCancel: () => this.#setQueueEdit("", ""),
      onQueueRemove: (itemId) => this.#queueMutation({ operation: "remove", itemId }),
      onQueueMove: (itemId, toIndex) => this.#queueMutation({ operation: "move", itemId, toIndex }),
      onQueueSteer: (itemId) => this.#queueMutation({ operation: "steer", itemId }),
    };
  }
}
