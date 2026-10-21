/**
 * PI extensions in Durable sessions.
 *
 * Each Durable session loads the PI extensions its PI worker would load
 * (packages and extensions named in PI settings and the `extensions/`
 * directories, HUI's plugin choices applied), as instances of its own, and
 * runs them through PI's own `ExtensionRunner`. The runner's actions and
 * context are bound to the Durable conversation: the session's tools and hooks
 * form one Durable extension (`pi:<HUI session>`), lifecycle events come from
 * the session's event stream, and dialogs become HUI questions. Extension code
 * runs in the gateway process.
 */
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import {
  convertToLlm, createSyntheticSourceInfo, DefaultResourceLoader, ExtensionRunner, ModelRegistry, SessionManager,
  type BuildSystemPromptOptions, type ExtensionError, type ExtensionUIContext, type ExtensionUIDialogOptions,
  type InputSource, type ModelRuntime, type NormalizedBuildSystemPromptOptions, type RegisteredTool, type ResourceLoader,
  type SettingsManager, type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import {
  CompactionEntry, CompactionTask, defineEntry, defineExtension, defineTool, GenerationTask, hook, ResetEntry, SystemEntry, ToolTask,
  type AgentEvent, type CompactionReason, type Conversation, type EntryId, type EntryRecord, type Extension, type NestedToolExecutionResult,
  type ToolExecutionApi, type ToolExecutionResult, type ToolRegistration,
} from "@earendil-works/pi-durable";
import { safeSourceLabel } from "../pi/source-label.ts";
import { createPolicySettingsManager } from "./resource-policy.ts";
import type { RuntimeCommand, RuntimeEvent, RuntimeQuestion, RuntimeQuestionResponse, RuntimeUsage } from "./types.ts";

const internal = async <T>(path: string): Promise<T> =>
  await import(new URL(path, import.meta.resolve("@earendil-works/pi-coding-agent")).href) as T;
/** PI shares extension modules between loads in one directory; each session gets fresh ones, as its own PI process would. */
const { clearExtensionCache } = await internal<{ clearExtensionCache(): void }>("./core/extensions/loader.js");
const { normalizeBuildSystemPromptOptions } = await internal<{
  normalizeBuildSystemPromptOptions(input: BuildSystemPromptOptions): NormalizedBuildSystemPromptOptions;
}>("./core/system-prompt.js");

/** A message an extension sent: the model reads it as user input; the transcript hides it, as for PI sessions. */
export const ExtensionMessageEntry = defineEntry<{ customType: string; display: boolean; forPrompt?: boolean }>("hui.pi-message");
/** One that starts or steers a turn is Durable input instead; its text part carries its custom type, which providers
 * ignore. */
export function isCustomInput(message: unknown): boolean {
  const { role, content } = (message ?? {}) as { role?: unknown; content?: unknown };
  return role === "user" && Array.isArray(content) && typeof (content[0] as { customType?: unknown } | undefined)?.customType === "string";
}
/** State an extension stored with `pi.appendEntry`: kept in the store, never sent to the model. */
export const ExtensionStateEntry = defineEntry<{ customType: string; data?: JsonValue }>("hui.pi-entry");

export type Contribution = { readonly snippet: string; readonly guidelines: readonly string[] };
/** What `before_agent_start` made of the system prompt for one run. */
export type RunPrompt = { readonly forced?: string; readonly options?: NormalizedBuildSystemPromptOptions };
export type CustomMessage = { customType: string; content: string | (TextContent | ImageContent)[]; display: boolean; details?: unknown };
/** What starts a run, as PI's `before_agent_start` tells: a prompt, or an extension's `sendMessage(..., { triggerTurn })`. */
export type StartTrigger =
  | { messageType: "user"; prompt: string; images: readonly ImageContent[] }
  | { messageType: "custom"; message: CustomMessage };
type Question = { question: RuntimeQuestion; settle(response: RuntimeQuestionResponse | undefined): void };
type QuestionDraft = RuntimeQuestion extends infer Each ? Each extends RuntimeQuestion ? Omit<Each, "id"> : never : never;

/** What a Durable session lends its extensions. */
export interface ExtensionSession {
  readonly cwd: string;
  /** A run is going. Its end handlers see it over, as in PI's `agent_settled`. */
  readonly running: boolean;
  /** A run is starting: its `before_agent_start` handlers run, or its input is about to be submitted. */
  readonly starting: boolean;
  /** Once a run that is starting has started, or did not start after all. */
  whenStarted(): Promise<void>;
  /** The conversation the session follows now; a rewind replaces it. */
  conversation(): Conversation;
  /** Entries since the latest reset, oldest first. */
  rows(): readonly EntryRecord[];
  pendingCount(): number;
  currentModel(): { provider: string; id: string } | undefined;
  /** The level the model is sent (HUI's `ultra` is its highest). */
  modelThinking(): string | undefined;
  currentUsage(): RuntimeUsage | undefined;
  setModel(provider: string, id: string): Promise<void>;
  setThinking(level: string): Promise<void>;
  /** Starts a compaction and resolves with the summary entry it placed. */
  compactEntry(instructions?: string): Promise<EntryId>;
  abort(): Promise<void>;
  waitForIdle(): Promise<void>;
  reload(): Promise<void>;
  /** Offers the conversation the tools its extensions keep active. */
  applyTools(): Promise<void>;
  /** `pi.sendUserMessage`: the prompt pipeline without template expansion. */
  sendUserMessage(text: string, images: readonly ImageContent[], deliverAs?: "steer" | "followUp"): Promise<void>;
  /** A custom message that starts or steers a turn: input that bypasses extension handlers. */
  submitInput(message: CustomMessage, whenBusy: "reject" | "steer" | "followUp"): Promise<void>;
  emitRuntime(event: RuntimeEvent): void;
}

/** What the gateway's Durable host lends every session's extensions. */
export interface ExtensionHost {
  readonly agentDir: string;
  readonly modelRuntime: ModelRuntime;
  /** Settles once the store schedules work: until then a write would resume interrupted runs early. */
  readonly resumed: Promise<void>;
  /** Tools every Durable conversation has, before extensions: the coding tools, then HUI's. */
  readonly codingTools: readonly ToolRegistration[];
  readonly huiTools: readonly ToolRegistration[];
  install(extension: Extension): void;
  uninstall(extension: Extension): void;
  resources(cwd: string): Promise<ResourceLoader>;
  /** The base prompt options of a request offering these tools. */
  promptOptions(cwd: string, selectedTools: readonly string[], contributions: Record<string, Contribution>): Promise<BuildSystemPromptOptions>;
  /** The prompt the conversation's latest request carried. */
  lastPrompt(conversation: Conversation): string;
}

export type LoadOptions = {
  host: ExtensionHost;
  session: ExtensionSession;
  huiSessionId: string;
  disabledPluginIds: ReadonlySet<string>;
};

const EMPTY_BOUNDARY = { entries: [], continue: false, context: { contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: false } };
const unsupported = (what: string) => `${what} is not available in Durable sessions.`;
const context = BACKGROUND_CONTEXT;
/** Longest a closing session waits for its extensions' `session_shutdown` before it removes their tools anyway. */
const SHUTDOWN_WAIT_MS = 10_000;
/** PI's module cache is process-wide: loads run one at a time, so each gets the fresh modules it cleared the cache for. */
let loading: Promise<unknown> = Promise.resolve();
/** The run that ended in a batch: its `agent_end` and `agent_settled` follow the batch's own events. */
type RunEnd = { readonly type: "run_settled"; readonly done: () => void };

/** Colours and styles mean nothing in the web UI: every theme function returns its text. */
const PLAIN_THEME = new Proxy({}, { get: () => (...args: unknown[]) => { const text = args.at(-1); return typeof text === "string" ? text : ""; } });

function jsonSafe(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  try { return JSON.parse(JSON.stringify(value)) as JsonValue; } catch { return undefined; }
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
/** PI's `parentToolCallId`, on events and hooks of a call another tool (a codemode script) made. */
const nestedIn = ({ parentToolCallId }: { parentToolCallId?: string }) => parentToolCallId ? { parentToolCallId } : {};
const parentOf = (call: { parent?: { callId: string } }) => nestedIn({ parentToolCallId: call.parent?.callId });
/** A nested call's result as PI's `ctx.executeTool()` returns it. Durable keeps no model output for nested calls: a
 * tool without a schema gives its bounded output, one with a schema its value, which PI also has as `structuredContent`. */
function nestedOutcome(id: string, name: string, args: unknown, tool: ToolRegistration | undefined, nested: NestedToolExecutionResult) {
  const value = nested.structuredOutput;
  const errors = nested.diagnostics.filter((diagnostic) => diagnostic.severity === "error").map((diagnostic) => diagnostic.message).join("\n");
  const content: (TextContent | ImageContent)[] = tool?.structuredOutputSchema !== undefined
    ? value === undefined ? [] : [{ type: "text", text: JSON.stringify(value) }]
    : typeof value === "string" ? (value ? [{ type: "text", text: value }] : [])
      : Array.isArray(value) ? value as unknown as (TextContent | ImageContent)[]
        : (value as { type?: unknown } | undefined)?.type === "image" ? [value as unknown as ImageContent] : [];
  return {
    toolCall: { type: "toolCall" as const, id, name, arguments: (args ?? {}) as Record<string, unknown> },
    result: {
      content: content.length || !nested.isError || !errors ? content : [{ type: "text" as const, text: errors }],
      details: nested.details ?? {},
      ...(tool?.structuredOutputSchema !== undefined && value !== undefined ? { structuredContent: value } : {}),
      ...(nested.usage ? { usage: nested.usage } : {}),
    },
    isError: nested.isError,
    ...(nested.durationMs === undefined ? {} : { durationMs: nested.durationMs }),
  };
}
const textOf = (content: unknown): string => typeof content === "string" ? content : Array.isArray(content)
  ? content.flatMap((part) => (part as { type?: unknown }).type === "text" ? [String((part as { text?: unknown }).text ?? "")] : []).join("")
  : "";
const contentOf = (content: CustomMessage["content"]): (TextContent | ImageContent)[] => typeof content === "string" ? [{ type: "text", text: content }] : content;
const isDeclarable = (tool: RegisteredTool) => ["direct", "model-only"].includes(tool.definition.exposure ?? "direct");
/** A custom message as Durable stores it: a user message that keeps its custom fields, or input whose text part does. */
const isCustom = (message: unknown): boolean =>
  (message as { role?: unknown }).role === "user" && typeof (message as { customType?: unknown }).customType === "string" || isCustomInput(message);
/** The message as PI's extensions see it: a custom message has PI's `custom` role. */
function asPi(message: Message): unknown {
  if (!isCustom(message)) return message;
  const tagged = message.content[0] as { customType?: string; display?: boolean } | undefined;
  const fields = message as Message & { customType?: string; display?: boolean };
  return { ...message, role: "custom", customType: fields.customType ?? tagged?.customType, display: fields.display ?? tagged?.display ?? false };
}

export class DurableExtensions {
  readonly #host: ExtensionHost;
  readonly #session: ExtensionSession;
  readonly #huiSessionId: string;
  readonly #disabledPluginIds: ReadonlySet<string>;
  #settings!: SettingsManager;
  #resources!: ResourceLoader;
  #runner!: ExtensionRunner;
  #loadErrors: string[] = [];
  #reported: string[] = [];
  #extension: Extension;
  /** Tool names `setActiveTools()` chose; undefined: PI's default selection. */
  #active: Set<string> | undefined;
  /** Extension tool calls running now, by call ID: what their `ctx.executeTool()` calls run under. */
  #calls = new Map<string, { api: ToolExecutionApi; context: Context; made: number }>();
  /** The tools nested calls resolve among, as the latest extension tool call's agent had them: `ctx.tools`. */
  #callable: readonly ToolRegistration[] = [];
  #questions = new Map<string, Question>();
  #asked = new Set<() => void>();
  /** Lifecycle events run one after another, never holding up the session's own processing. */
  #queue: Promise<void> = Promise.resolve();
  #disposed = false;
  #stopping = false;
  #run: { controller: AbortController; start: number; turn: number; prompt?: RunPrompt } | undefined;
  /** The signal of the run the event being handled belongs to, which may have ended since. */
  #eventSignal: AbortSignal | undefined;
  /** The prompt `before_agent_start` gave a run that has not started yet. */
  #pendingPrompt: RunPrompt | undefined;
  #nextTurn: CustomMessage[] = [];
  #abortRequested = false;
  /** Base prompt options of the latest prompt, for a command's `ctx.getSystemPromptOptions()`. */
  #promptOptions: BuildSystemPromptOptions | undefined;
  /** The Durable events of the batch the session is processing. */
  #batch: (AgentEvent | RunEnd)[] = [];
  /** Entries extensions asked to write that Durable has not admitted yet. */
  #writes = new Set<Promise<unknown>>();
  /** `ctx.compact()` calls waiting for their own summary, each with its cancel: a new conversation or instances end it. */
  #compactions = new Set<() => void>();
  /** Compaction tasks whose summary a `session_before_compact` handler supplied, as `compaction:<task>`. */
  #suppliedBy = new Set<string>();
  /** Summary entries in the history that `session_compact` reported, or that were there before. */
  #summaries = new Set<EntryId>();
  // `ctx.sessionManager`: an in-memory PI session projected from the Durable history.
  #manager!: SessionManager;
  #projected: EntryRecord[] = [];
  #piIds = new Map<EntryId, string>();
  /** Entries `pi.appendEntry` projected at once, until the store echoes them. */
  #echoes: { customType: string; data: JsonValue | undefined }[] = [];

  private constructor(options: LoadOptions) {
    this.#host = options.host;
    this.#session = options.session;
    this.#huiSessionId = options.huiSessionId;
    this.#disabledPluginIds = options.disabledPluginIds;
    this.#extension = defineExtension({ name: `pi:${options.huiSessionId}` });
  }

  /** The session's extensions, or undefined when its PI setup has none. */
  static async load(options: LoadOptions): Promise<DurableExtensions | undefined> {
    const extensions = new DurableExtensions(options);
    if (await extensions.#load()) return extensions;
    options.host.uninstall(extensions.#extension);
    return undefined;
  }

  /** Loads fresh instances and binds them; whether there is anything to run. */
  async #load(): Promise<boolean> {
    const { cwd } = this.#session;
    this.#settings = createPolicySettingsManager({ cwd, agentDir: this.#host.agentDir, disabledIds: this.#disabledPluginIds });
    const loader = new DefaultResourceLoader({
      cwd, agentDir: this.#host.agentDir, settingsManager: this.#settings,
      noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
    });
    const load = loading.then(async () => {
      clearExtensionCache();
      await loader.reload();
    });
    loading = load.catch(() => undefined);
    await load;
    const loaded = loader.getExtensions();
    this.#loadErrors = loaded.errors.map((item) => `${basename(item.path)}: ${item.error}`);
    this.#resources = await this.#host.resources(cwd);
    this.#manager = SessionManager.inMemory(cwd, { id: this.#huiSessionId });
    this.#projected = [];
    this.#piIds.clear();
    this.#echoes = [];
    this.#runner = new ExtensionRunner(loaded.extensions, loaded.runtime, cwd, this.#sessionManager(), new ModelRegistry(this.#host.modelRuntime));
    this.#stopping = false;
    this.#bind(this.#runner);
    this.#active = undefined;
    this.#rebuild();
    return loaded.extensions.length > 0 || loaded.errors.length > 0;
  }

  /** The Durable extension carrying this session's tools and hooks. */
  get extension(): Extension { return this.#extension; }
  get diagnostics(): readonly string[] { return [...this.#loadErrors, ...this.#reported]; }

  // ── Binding ─────────────────────────────────────────────────────────────

  #bind(runner: ExtensionRunner): void {
    const session = this.#session;
    // First: binding reports the providers extensions registered while loading.
    runner.onError((error) => this.#onError(error));
    runner.bindCore({
      sendMessage: (message, options) => { void this.#sendMessage(message as CustomMessage, options).catch((error: unknown) => this.#report("send_message", error)); },
      sendUserMessage: (content, options) => {
        const parts = typeof content === "string" ? [{ type: "text" as const, text: content }] : content;
        const text = parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
        const images = parts.filter((part): part is ImageContent => part.type === "image");
        void session.sendUserMessage(text, images, options?.deliverAs).catch((error: unknown) => this.#report("send_user_message", error));
      },
      appendEntry: (customType, data) => this.#appendEntry(customType, data),
      setSessionName: (name) => { this.#project().appendSessionInfo(name); },
      getSessionName: () => this.#project().getSessionName(),
      setLabel: (entryId, label) => { this.#project().appendLabelChange(entryId, label); },
      getActiveTools: () => this.#activeNames(),
      getAllTools: () => this.#allTools(),
      getSettings: () => this.#settings.getSettings(),
      setActiveTools: (names) => { this.#active = new Set(names); this.#applyTools(); },
      refreshTools: () => { this.#rebuild(); this.#applyTools(); },
      getCommands: () => [
        ...runner.getRegisteredCommands().map((command) => ({ name: command.invocationName, description: command.description, source: "extension" as const, sourceInfo: command.sourceInfo })),
        ...this.#resources.getPrompts().prompts.map((prompt) => ({ name: prompt.name, description: prompt.description, source: "prompt" as const, sourceInfo: prompt.sourceInfo })),
        ...this.#resources.getSkills().skills.map((skill) => ({ name: `skill:${skill.name}`, description: skill.description, source: "skill" as const, sourceInfo: skill.sourceInfo })),
      ],
      setModel: async (model) => {
        if (!this.#host.modelRuntime.hasConfiguredAuth(model.provider)) return false;
        await session.setModel(model.provider, model.id);
        return true;
      },
      getThinkingLevel: () => (session.modelThinking() ?? "off") as never,
      setThinkingLevel: (level) => { void session.setThinking(level).catch((error: unknown) => this.#report("set_thinking_level", error)); },
    }, {
      getModel: () => this.#model(),
      getScopedModels: () => [],
      // As in PI 1.2.0, a run that is starting counts as busy.
      isIdle: () => !session.running && !session.starting,
      isProjectTrusted: () => this.#settings.isProjectTrusted(),
      executeTool: (callerId, name, args) => this.#executeNested(callerId, name, args) as never,
      getCallableTools: () => this.#callableTools() as never,
      getSignal: () => this.#eventSignal ?? this.#run?.controller.signal,
      abort: () => { this.#abortRequested = true; void session.abort().catch((error: unknown) => this.#report("abort", error)); },
      hasPendingMessages: () => session.pendingCount() > 0,
      shutdown: () => this.#report("shutdown", new Error(unsupported("Shutting down"))),
      getContextUsage: () => {
        const usage = session.currentUsage();
        return usage ? { tokens: usage.contextTokens, contextWindow: usage.contextWindow, percent: usage.percent } : undefined;
      },
      compact: (options) => {
        if (this.#stopping) throw new Error("This extension instance is shutting down.");
        const cancel = () => { options?.onError?.(new Error("Compaction cancelled")); };
        this.#compactions.add(cancel);
        void session.compactEntry(options?.customInstructions).then((id) => {
          this.#project();
          const piId = this.#piIds.get(id);
          // Absent from this session's history: a clear or rewind replaced the conversation it was placed on.
          const entry = piId === undefined ? undefined : this.#manager.getEntry(piId);
          if (entry?.type !== "compaction") throw new Error("Compaction cancelled");
          return entry;
        }).then((entry) => {
          if (this.#compactions.delete(cancel)) options?.onComplete?.({ summary: entry.summary, firstKeptEntryId: entry.firstKeptEntryId, tokensBefore: entry.tokensBefore } as never);
        }, (error: unknown) => {
          if (this.#compactions.delete(cancel)) options?.onError?.(error instanceof Error ? error : new Error(errorText(error)));
        }).catch((error: unknown) => this.#report("compact", error));
      },
      getSystemPrompt: () => this.#host.lastPrompt(session.conversation()),
      getSystemPromptOptions: () => this.#promptOptions ?? { cwd: session.cwd },
    }, {
      // One model runtime serves every Durable session, so no session may change it.
      registerProvider: () => { throw new Error(unsupported("Registering a provider")); },
      registerNativeProvider: () => { throw new Error(unsupported("Registering a provider")); },
      unregisterProvider: () => { throw new Error(unsupported("Unregistering a provider")); },
      registerVirtualModel: () => { throw new Error(unsupported("Registering a model")); },
      unregisterVirtualModel: () => { throw new Error(unsupported("Unregistering a model")); },
    });
    const replace = async () => {
      this.#notice("warning", unsupported("Replacing or branching the session from an extension command"));
      return { cancelled: true };
    };
    runner.bindCommandContext({
      waitForIdle: () => session.waitForIdle(),
      newSession: replace, fork: replace, navigateTree: replace, switchSession: replace,
      reload: () => session.reload(),
    });
    runner.setUIContext(this.#ui(), "rpc");
  }

  #model() {
    const current = this.#session.currentModel();
    return current ? this.#host.modelRuntime.getModel(current.provider, current.id) : undefined;
  }

  // ── Reporting ───────────────────────────────────────────────────────────

  #onError(error: ExtensionError): void {
    const source = /^(?:<|command:)/u.test(error.extensionPath) ? error.extensionPath : basename(error.extensionPath);
    this.#reported.push(`${source} (${error.event}): ${error.error}`);
    if (this.#reported.length > 20) this.#reported.shift();
    this.#notice("warning", `Extension ${source} failed in ${error.event}: ${error.error}`);
  }

  #report(event: string, error: unknown): void {
    this.#onError({ extensionPath: "<runtime>", event, error: errorText(error) });
  }

  #notice(level: "info" | "warning" | "error", message: string): void {
    if (!this.#disposed) this.#session.emitRuntime({ type: "notice", level, message });
  }

  // ── Dialogs ─────────────────────────────────────────────────────────────

  #ui(): ExtensionUIContext {
    const ask = <T>(question: QuestionDraft, opts: ExtensionUIDialogOptions | undefined, fallback: T, parse: (response: RuntimeQuestionResponse) => T): Promise<T> => {
      if (opts?.signal?.aborted || this.#disposed) return Promise.resolve(fallback);
      return new Promise<T>((resolve) => {
        const id = randomUUID();
        const finish = (response: RuntimeQuestionResponse | undefined) => {
          if (!this.#questions.delete(id)) return;
          clearTimeout(timer);
          opts?.signal?.removeEventListener("abort", dismiss);
          resolve(response === undefined ? fallback : parse(response));
        };
        const dismiss = () => finish(undefined);
        const timer = opts?.timeout ? setTimeout(dismiss, opts.timeout) : undefined;
        opts?.signal?.addEventListener("abort", dismiss, { once: true });
        const full = { ...question, id, ...(opts?.timeout ? { timeout: opts.timeout } : {}) } as RuntimeQuestion;
        this.#questions.set(id, { question: full, settle: finish });
        this.#session.emitRuntime({ type: "question", question: full });
        for (const asked of this.#asked) asked();
      });
    };
    const value = (response: RuntimeQuestionResponse) => "value" in response ? response.value : undefined;
    const ignore = () => {};
    return {
      select: (title, options, opts) => ask({ method: "select", title, options: [...options] }, opts, undefined, value),
      confirm: (title, message, opts) => ask({ method: "confirm", title, message }, opts, false, (response) => "confirmed" in response && response.confirmed),
      input: (title, placeholder, opts) => ask({ method: "input", title, ...(placeholder ? { placeholder } : {}) }, opts, undefined, value),
      editor: (title, prefill) => ask({ method: "editor", title, ...(prefill ? { prefill } : {}) }, undefined, undefined, value),
      notify: (message, type) => this.#notice(type ?? "info", message),
      onTerminalInput: () => ignore,
      // Status lines, widgets, editors and custom components are terminal UI; HUI has no surface for them.
      setStatus: ignore, setWorkingMessage: ignore, setWorkingVisible: ignore, setWorkingIndicator: ignore,
      setHiddenThinkingLabel: ignore, setWidget: ignore, setFooter: ignore, setHeader: ignore, setTitle: ignore,
      custom: async () => undefined as never,
      pasteToEditor: ignore, setEditorText: ignore, getEditorText: () => "",
      addAutocompleteProvider: ignore, setEditorComponent: ignore, getEditorComponent: () => undefined,
      get theme() { return PLAIN_THEME as never; },
      getAllThemes: () => [], getTheme: () => undefined,
      setTheme: () => ({ success: false, error: unsupported("Switching themes") }),
      getToolsExpanded: () => false, setToolsExpanded: ignore,
    } as ExtensionUIContext;
  }

  pendingQuestions(): readonly RuntimeQuestion[] {
    return [...this.#questions.values()].map((entry) => entry.question);
  }

  respondQuestion(id: string, response: RuntimeQuestionResponse): void {
    const entry = this.#questions.get(id);
    if (!entry) throw new Error(`Unknown extension question: ${id}`);
    if (entry.question.method === "confirm" ? !("confirmed" in response) : !("value" in response)) {
      throw new Error(entry.question.method === "confirm" ? "A confirmation response is required." : "A text response is required.");
    }
    entry.settle(response);
  }

  cancelQuestion(id: string): void {
    const entry = this.#questions.get(id);
    if (!entry) throw new Error(`Unknown extension question: ${id}`);
    entry.settle(undefined);
  }

  /** Answers every open dialog with its default, as dismissing a PI dialog does. */
  cancelQuestions(): void {
    for (const entry of [...this.#questions.values()]) entry.settle(undefined);
  }

  // ── Tools ───────────────────────────────────────────────────────────────

  /** Extension tools, minus any named like a HUI tool: PI keeps HUI's tools over an extension's. */
  #extensionTools(): RegisteredTool[] {
    const hui = new Set(this.#host.huiTools.map((tool) => tool.name));
    return this.#runner.getAllRegisteredTools().filter((tool) => !hui.has(tool.definition.name));
  }

  /** Rebuilds and installs this session's Durable extension from what the extensions registered. */
  #rebuild(): void {
    const tools = this.#extensionTools().filter(isDeclarable).map((tool) => this.#durableTool(tool));
    this.#extension = defineExtension({ name: `pi:${this.#huiSessionId}`, tools, hooks: this.#hooks() });
    if (!this.#disposed) this.#host.install(this.#extension);
  }

  #durableTool({ definition }: RegisteredTool): ToolRegistration {
    return defineTool({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters as never,
      // Extension tools may have side effects: an interrupted call is reported to the model, never rerun.
      replay: "unsafe",
      ...(definition.executionMode ? { executionMode: definition.executionMode } : {}),
      ...(definition.prepareArguments ? { prepareArguments: definition.prepareArguments as never } : {}),
      execute: async (args, api, callContext) => {
        const signal = callContext.abortSignal;
        this.#callable = await api.agent(callContext).then((agent) => agent.callable, () => this.#callable);
        this.#calls.set(api.callId, { api, context: callContext, made: 0 });
        let shown = "";
        const onUpdate = (partial: { content?: unknown; details?: unknown } | undefined) => {
          const text = textOf(partial?.content);
          if (text !== shown && text.startsWith(shown)) { api.output(text.slice(shown.length)); shown = text; }
          const details = jsonSafe(partial?.details);
          if (details !== undefined) void api.details(details, callContext).catch(() => {});
        };
        try {
          const result = await definition.execute(api.callId, args as never, signal, onUpdate as never, this.#runner.createToolContext(api.callId, signal));
          const details = jsonSafe(result.details);
          return {
            output: result.content ?? [],
            ...(details === undefined ? {} : { details }),
            ...(result.isError ? { isError: true } : {}),
            ...(result.usage ? { usage: result.usage } : {}),
            ...(result.terminate ? { control: { terminate: true as const } } : {}),
          };
        } catch (error) {
          if (signal?.aborted) throw error;
          // A thrown error is the model's error result, as in PI.
          return { output: [{ type: "text", text: errorText(error) }], isError: true };
        } finally {
          this.#calls.delete(api.callId);
        }
      },
    });
  }

  /** PI's `ctx.executeTool()`: a nested call of the extension tool call `callerId`, through Durable's own, which
   * validates it and runs the `tool_call`/`tool_result` hooks. Like PI, it never rejects for a tool failure. */
  async #executeNested(callerId: string, name: string, args: unknown) {
    const call = this.#calls.get(callerId);
    const id = `${callerId}/${call ? ++call.made : 0}`;
    const failed = (text: string) => ({ toolCall: { type: "toolCall" as const, id, name, arguments: {} }, result: { content: [{ type: "text" as const, text }], details: {} }, isError: true });
    if (!call) return failed("Nested tool calls are only available while the calling tool runs");
    if (typeof args !== "object" || args === null || Array.isArray(args)) return failed(`Arguments for ${name} must be an object`);
    try {
      const nested = await call.api.executeTool(name, args as never, call.context);
      return nestedOutcome(id, name, args, this.#callable.find((tool) => tool.name === name), nested);
    } catch (error) {
      return failed(errorText(error));
    }
  }

  /** `ctx.tools`: what `ctx.executeTool()` can call. Each runs as a nested call of the extension tool calling it. */
  #callableTools() {
    return this.#callable.map((tool) => ({
      name: tool.name, label: tool.name, description: tool.description, parameters: tool.parameters,
      ...(tool.structuredOutputSchema ? { outputSchema: tool.structuredOutputSchema } : {}),
      execute: () => Promise.reject(new Error(`Call ${tool.name} with ctx.executeTool().`)),
    }));
  }

  /** Every tool the session knows, as PI's `getAllTools()` reports them. */
  #allTools(): ToolInfo[] {
    const extension = this.#extensionTools();
    const names = new Set(extension.map((tool) => tool.definition.name));
    const info = (tool: ToolRegistration, source: "builtin" | "sdk"): ToolInfo => ({
      name: tool.name, description: tool.description, parameters: tool.parameters, exposure: "direct",
      sourceInfo: createSyntheticSourceInfo(source === "builtin" ? `builtin:${tool.name}` : `<sdk:${tool.name}>`, { source }),
    });
    return [
      ...this.#host.codingTools.filter((tool) => !names.has(tool.name)).map((tool) => info(tool, "builtin")),
      ...extension.map(({ definition, sourceInfo }) => ({
        name: definition.name, description: definition.description, parameters: definition.parameters,
        ...(definition.promptGuidelines ? { promptGuidelines: definition.promptGuidelines } : {}),
        exposure: definition.exposure ?? "direct",
        ...(definition.namespace ? { namespace: definition.namespace } : {}),
        ...(definition.annotations ? { annotations: definition.annotations } : {}),
        sourceInfo,
      })),
      ...this.#host.huiTools.map((tool) => info(tool, "sdk")),
    ];
  }

  /** Active tool names in offer order. By default the coding tools, HUI's and every extension tool that activates on registration. */
  #activeNames(): string[] {
    const declared = new Map(this.#extensionTools().filter(isDeclarable).map((tool) => [tool.definition.name, tool.definition.defaultActive !== false]));
    const all: (readonly [string, boolean])[] = [
      ...this.#host.codingTools.filter((tool) => !declared.has(tool.name)).map((tool) => [tool.name, true] as const),
      ...declared,
      ...this.#host.huiTools.map((tool) => [tool.name, true] as const),
    ];
    return all.filter(([name, byDefault]) => this.#active ? this.#active.has(name) : byDefault).map(([name]) => name);
  }

  /** The tools to leave out of the conversation's offer. */
  inactiveTools(): readonly ToolRegistration[] {
    const active = new Set(this.#activeNames());
    return [...this.#host.codingTools, ...(this.#extension.tools ?? []), ...this.#host.huiTools].filter((tool) => !active.has(tool.name));
  }

  #applyTools(): void {
    void this.#session.applyTools().catch((error: unknown) => this.#report("set_active_tools", error));
  }

  /** Snippets and guidelines extension tools add to the system prompt. */
  contributions(): Record<string, Contribution> {
    return Object.fromEntries(this.#extensionTools().map(({ definition }) => [definition.name, {
      snippet: definition.promptSnippet ?? "", guidelines: definition.promptGuidelines ?? [],
    }]));
  }

  /** The source label inspection shows for an extension tool, as for the PI worker's. */
  sourceOf(name: string): string | undefined {
    const tool = this.#extensionTools().find((each) => each.definition.name === name);
    if (!tool) return undefined;
    const { scope, source, path } = tool.sourceInfo;
    return `${scope} · ${safeSourceLabel(source)} · ${safeSourceLabel(path)}`;
  }

  /** An extension tool as a bot's tool catalog shows it: its label, its prompt snippet and its source label. */
  describe(name: string): { source: string; label?: string; snippet?: string } {
    const tool = this.#extensionTools().find((each) => each.definition.name === name);
    return {
      source: this.sourceOf(name) ?? "extension",
      ...(tool?.definition.label ? { label: tool.definition.label } : {}),
      ...(tool?.definition.promptSnippet ? { snippet: tool.definition.promptSnippet } : {}),
    };
  }

  // ── Hooks inside Durable's tasks ────────────────────────────────────────

  #hooks() {
    return [
      hook(ToolTask, {
        beforeTool: async (call) => {
          if (!this.#runner.hasHandlers("tool_call")) return undefined;
          const input = structuredClone(call.arguments);
          // Handlers edit `input` in place; a throw blocks the call, as in PI.
          const result = await this.#runner.emitToolCall({ type: "tool_call", toolName: call.name, toolCallId: call.id, input, ...parentOf(call) } as never);
          if (result?.block) return { block: result.reason || "Blocked by an extension" };
          return isDeepStrictEqual(input, call.arguments) ? undefined : { arguments: input as never };
        },
        afterTool: async (call, result) => {
          if (!this.#runner.hasHandlers("tool_result")) return undefined;
          const replaced = await this.#runner.emitToolResult({
            type: "tool_result", toolName: call.name, toolCallId: call.id, input: call.arguments,
            content: result.output ?? [], details: result.details, isError: result.isError === true, usage: result.usage, ...parentOf(call),
            ...(result.structuredOutput === undefined ? {} : { structuredContent: result.structuredOutput }),
          } as never);
          if (!replaced) return undefined;
          const details = jsonSafe(replaced.details);
          // As in PI, replaced content drops the structured value a handler did not replace with it: a script never gets
          // what a handler took out of the content. PI's script then gets the replaced text; Durable requires a schema
          // tool's value unless the call failed, so a nested call fails with that text instead.
          const { structuredOutput: _replaced, ...rest } = result;
          const structured = jsonSafe(replaced.structuredContent);
          const dropped = call.parent !== undefined && result.structuredOutput !== undefined && structured === undefined;
          return {
            ...rest,
            ...(structured === undefined ? {} : { structuredOutput: structured }),
            ...(replaced.content ? { output: replaced.content } : {}),
            ...(details === undefined ? {} : { details }),
            ...(replaced.isError === undefined ? {} : { isError: replaced.isError }),
            ...(dropped ? { isError: true } : {}),
            ...(replaced.usage ? { usage: replaced.usage } : {}),
          } satisfies ToolExecutionResult;
        },
      }),
      hook(GenerationTask, {
        beforeRequest: async (request) => {
          if (!this.#runner.hasHandlers("context") && !this.#runner.hasHandlers("context_with_system")) return undefined;
          // Handlers see custom messages as PI's `custom` role; the request carries them as user messages.
          const result = convertToLlm(await this.#runner.emitContext(request.messages.map(asPi) as never));
          return isDeepStrictEqual(result, request.messages) ? undefined : { messages: result };
        },
      }),
      hook(CompactionTask, {
        beforeCompact: async (compaction, api, hookContext) => {
          if (!this.#runner.hasHandlers("session_before_compact")) return undefined;
          const manager = this.#project();
          const result = await this.#runner.emit({
            type: "session_before_compact",
            preparation: {
              firstKeptEntryId: this.#piIds.get(compaction.firstKept) ?? "",
              messagesToSummarize: [...compaction.messages], turnPrefixMessages: [], isSplitTurn: false,
              tokensBefore: this.#session.currentUsage()?.contextTokens ?? 0,
              fileOps: { read: new Set(), written: new Set(), edited: new Set() },
              settings: this.#settings.getCompactionSettings(),
            },
            branchEntries: manager.getBranch(),
            ...(compaction.instructions ? { customInstructions: compaction.instructions } : {}),
            // Durable carries on after every compaction but a manual one, so nothing needs resuming.
            reason: compaction.reason, willRetry: compaction.reason !== "manual",
            signal: hookContext.abortSignal ?? new AbortController().signal,
          } as never) as { cancel?: boolean; compaction?: { summary?: string } } | undefined;
          if (result?.cancel) return { decline: true as const };
          if (!result?.compaction?.summary) return undefined;
          this.#suppliedBy.add(`compaction:${api.taskId}`);
          return { summary: result.compaction.summary };
        },
      }),
    ];
  }

  // ── Session view ────────────────────────────────────────────────────────

  /** `ctx.sessionManager` reads the projection live: it follows the history whenever an extension looks. */
  #sessionManager(): SessionManager {
    return new Proxy({} as SessionManager, {
      get: (_target, key) => {
        const manager = this.#project();
        const value: unknown = Reflect.get(manager, key, manager);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(manager) : value;
      },
    });
  }

  /** Brings the projected PI session up to the Durable history: appends what is new, or starts over after a rewind. */
  #project(): SessionManager {
    const rows = this.#session.rows();
    const count = this.#projected.length;
    if (count > rows.length || (count > 0 && rows[count - 1] !== this.#projected[count - 1])) {
      this.#manager = SessionManager.inMemory(this.#session.cwd, { id: this.#huiSessionId });
      this.#projected = [];
      this.#piIds.clear();
      this.#echoes = [];
    }
    for (const entry of rows.slice(this.#projected.length)) {
      this.#projected.push(entry);
      const id = this.#projectEntry(entry);
      if (id) this.#piIds.set(entry.id, id);
    }
    return this.#manager;
  }

  #projectEntry(entry: EntryRecord): string | undefined {
    const manager = this.#manager;
    if (ExtensionStateEntry.is(entry)) {
      const echo = this.#echoes[0];
      if (echo?.customType === entry.data.customType && isDeepStrictEqual(echo.data, entry.data.data)) {
        this.#echoes.shift();
        return undefined;
      }
      return manager.appendCustomEntry(entry.data.customType, entry.data.data);
    }
    if (ExtensionMessageEntry.is(entry)) {
      const message = entry.model?.[0] as { content?: CustomMessage["content"]; details?: unknown } | undefined;
      return manager.appendCustomMessageEntry(entry.data.customType, message?.content ?? [], entry.data.display, message?.details);
    }
    if (CompactionEntry.is(entry)) {
      const summary = textOf((entry.model?.[0] as { content?: unknown } | undefined)?.content);
      return manager.appendCompaction(summary, entry.head === undefined ? null : this.#piIds.get(entry.head) ?? null, 0);
    }
    if (SystemEntry.is(entry) || ResetEntry.is(entry)) return undefined;
    let id: string | undefined;
    for (const message of entry.model ?? []) id = manager.appendMessage(message as never);
    return id;
  }

  /** Projected at once, as PI appends it; stored as a data-only write, which Durable appends at once, mid-run too. */
  #appendEntry(customType: string, data: unknown): void {
    const json = jsonSafe(data);
    this.#project().appendCustomEntry(customType, json);
    this.#echoes.push({ customType, data: json });
    const conversation = this.#session.conversation();
    void this.#write(() => conversation.submit({ type: "write", entry: {
      kind: ExtensionStateEntry.kind, data: { customType, ...(json === undefined ? {} : { data: json }) },
    } }, context)).catch((error: unknown) => this.#report("append_entry", error));
  }

  /** Admits a write once the store schedules work, so a write from a reopened session cannot resume interrupted runs
   * before every interrupted session reopened. */
  #write<T>(write: () => Promise<T>): Promise<T> {
    const admission = this.#host.resumed.then(write);
    this.#writes.add(admission);
    return admission.finally(() => this.#writes.delete(admission));
  }

  /** Resolves once what extensions wrote so far is admitted: PI appends it at once, so it precedes the next input. */
  async writesAdmitted(): Promise<void> {
    await Promise.allSettled([...this.#writes]);
  }

  async #sendMessage(message: CustomMessage, options: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" } | undefined): Promise<void> {
    const custom: CustomMessage = { ...message, content: message.content ?? [], display: message.display === true };
    if (options?.deliverAs === "nextTurn") { this.#nextTurn.push(custom); return; }
    // As in PI 1.2.0, a run that is starting (its `before_agent_start` handlers run, say) counts as busy: a message for
    // no turn of its own is context ahead of its input, any other goes into the run once it has started.
    if (this.#session.starting && options?.triggerTurn === false) { await this.writeMessages([custom]); return; }
    // Checked again after each wait: another message may have started a run meanwhile.
    while (this.#session.starting) await this.#session.whenStarted();
    const streaming = this.#session.running;
    // As in PI: mid-run it steers (or follows up) unless told not to trigger a turn; idle, it starts a run only when
    // asked to. Otherwise it is context, written as a hidden entry (mid-run at the next boundary).
    if (streaming ? options?.triggerTurn !== false : options?.triggerTurn === true) {
      await this.#session.submitInput(custom, streaming ? options?.deliverAs === "followUp" ? "followUp" : "steer" : "reject");
      return;
    }
    await this.writeMessages([custom]);
  }

  /** Writes custom messages as hidden entries the model reads as user input. */
  async writeMessages(messages: readonly CustomMessage[], forPrompt = false): Promise<void> {
    const conversation = this.#session.conversation();
    for (const message of messages) {
      const details = jsonSafe(message.details);
      await this.#write(() => conversation.submit({ type: "write", entry: {
        kind: ExtensionMessageEntry.kind,
        model: [{ role: "user", content: contentOf(message.content), timestamp: Date.now(), customType: message.customType, ...(details === undefined ? {} : { details }) } as Message],
        data: { customType: message.customType, display: message.display, ...(forPrompt ? { forPrompt: true } : {}) },
      } }, context));
    }
  }

  // ── Prompt pipeline ─────────────────────────────────────────────────────

  commands(): RuntimeCommand[] {
    return this.#runner.getRegisteredCommands().map((command) => ({ name: command.invocationName, description: command.description ?? "", source: "extension" as const }));
  }

  #command(text: string) {
    if (!text.startsWith("/")) return undefined;
    const space = text.indexOf(" ");
    const command = this.#runner.getCommand(space === -1 ? text.slice(1) : text.slice(1, space));
    return command ? { command, args: space === -1 ? "" : text.slice(space + 1) } : undefined;
  }

  isCommand(text: string): boolean {
    return this.#command(text) !== undefined;
  }

  /**
   * Starts `work`. `released` settles with it, or once it first asks the user something: a request waiting on an
   * answer would hold the browser, so PI sessions also take a question as acceptance.
   */
  whileAsking<T>(work: () => Promise<T>): { done: Promise<T>; released: Promise<void> } {
    let release!: () => void;
    const asked = new Promise<void>((resolve) => { release = resolve; });
    this.#asked.add(release);
    const done = (async () => await work())().finally(() => this.#asked.delete(release));
    return { done, released: Promise.race([done, asked]).then(() => undefined) };
  }

  /** Runs an extension command. Resolves once it finishes or first asks the user something; `finished` is its end. */
  async runCommand(text: string): Promise<{ finished: Promise<void> }> {
    const found = this.#command(text);
    if (!found) throw new Error(`Unknown extension command: ${text}`);
    const { done, released } = this.whileAsking(async () => {
      try { await found.command.handler(found.args, this.#runner.createCommandContext()); }
      catch (error) { this.#onError({ extensionPath: `command:${found.command.invocationName}`, event: "command", error: errorText(error) }); }
    });
    await released;
    return { finished: done };
  }

  /** PI's `input` event, the first step of every prompt: undefined when an extension handled the input itself. */
  async input(text: string, images: readonly ImageContent[], source: InputSource, behavior?: "steer" | "followUp") {
    this.#abortRequested = false;
    if (!this.#runner.hasHandlers("input")) return { text, images };
    const result = await this.#runner.emitInput(text, images.length ? [...images] : undefined, source, behavior);
    if (result.action === "handled") return undefined;
    return result.action === "transform" ? { text: result.text, images: result.images ?? images } : { text, images };
  }

  /**
   * PI's `before_agent_start` for input that starts a run, a prompt or an extension's custom message: the custom
   * messages to send with it, and the system prompt the run uses. `aborted` when a handler called `ctx.abort()`, or
   * Stop came, since the prompt's `input` (a custom message has none: since now).
   */
  async beforeAgentStart(trigger: StartTrigger): Promise<{ messages: CustomMessage[]; aborted: boolean }> {
    if (trigger.messageType === "custom") this.#abortRequested = false;
    const queued = this.#nextTurn.splice(0);
    this.#pendingPrompt = undefined;
    const active = this.#activeNames();
    const base = normalizeBuildSystemPromptOptions(await this.#host.promptOptions(this.#session.cwd, active, this.contributions()));
    this.#promptOptions = base;
    let added: CustomMessage[] = [];
    if (this.#runner.hasHandlers("before_agent_start") && !this.#abortRequested) {
      const event = trigger.messageType === "user"
        ? { messageType: "user" as const, prompt: trigger.prompt, ...(trigger.images.length ? { images: [...trigger.images] } : {}) }
        : { messageType: "custom" as const, message: { role: "custom" as const, ...trigger.message, timestamp: Date.now() } };
      const result = await this.#runner.emitBeforeAgentStart(event as never, structuredClone(base));
      const options = result.systemPromptOptions;
      // An edited tool selection becomes the active tools; otherwise the live selection stays authoritative.
      if (!isDeepStrictEqual(options.selectedTools, active)) { this.#active = new Set(options.selectedTools); this.#applyTools(); }
      if (options.forceSystemPrompt !== undefined || !isDeepStrictEqual({ ...options, selectedTools: active }, base)) {
        this.#pendingPrompt = { ...(options.forceSystemPrompt === undefined ? {} : { forced: options.forceSystemPrompt }), options };
      }
      added = result.messages.map((message) => ({ ...message, content: message.content ?? [], display: message.display === true }));
    }
    if (!this.#abortRequested) return { messages: [...queued, ...added], aborted: false };
    // Nothing starts: the next prompt gets the queued messages, and no run takes this prompt.
    this.#nextTurn.unshift(...queued);
    this.#pendingPrompt = undefined;
    return { messages: [], aborted: true };
  }

  /** Stop came while a prompt passed its handlers: the prompt is not sent. */
  abortStart(): void {
    this.#abortRequested = true;
  }

  get startAborted(): boolean {
    return this.#abortRequested;
  }

  /** The prompt `before_agent_start` gave the current run. */
  runPrompt(): RunPrompt | undefined {
    return this.#run ? this.#run.prompt : this.#pendingPrompt;
  }

  // ── Lifecycle events ────────────────────────────────────────────────────

  /** Queues `run` behind the events before it; resolves once it has run. */
  #enqueue(name: string, run: () => Promise<unknown>): Promise<void> {
    const next = this.#queue.then(async () => { if (!this.#disposed) await run(); }).catch((error: unknown) => this.#report(name, error));
    this.#queue = next;
    return next;
  }

  /** Queues a lifecycle event; its handlers see the signal of the run it belongs to as `ctx.signal`. */
  #emit(event: { type: string } & Record<string, unknown>, signal = this.#run?.controller.signal): void {
    if (this.#disposed) return;
    void this.#enqueue(event.type, async () => {
      this.#eventSignal = signal;
      try {
        await (event.type === "message_end" ? this.#runner.emitMessageEnd(event as never) : this.#runner.emit(event as never));
      } finally {
        this.#eventSignal = undefined;
      }
    });
  }

  /** `session_start`, ahead of any event of the session's runs. Resolves once its handlers ran or one asks the user
   * something: the question can only be answered once the session is open. */
  async start(reason: "startup" | "reload" | "new"): Promise<void> {
    this.#knownSummaries();
    await this.whileAsking(() => this.#enqueue("session_start", () => this.#runner.emit({ type: "session_start", reason }))).released;
  }

  /** `session_shutdown` after the events before it; the instances are stale from then on. */
  async #shutdown(reason: "quit" | "reload" | "new"): Promise<void> {
    this.cancelQuestions();
    await this.#enqueue("session_shutdown", () => this.#runner.emit({ type: "session_shutdown", reason }));
    this.#runner.invalidate();
  }

  /** `/reload` or a cleared session: the extensions shut down, load again from disk and start. */
  async restart(reason: "reload" | "new"): Promise<void> {
    this.#stopping = true;
    this.#cancelCompactions();
    await this.#shutdown(reason);
    await this.#load();
    await this.#session.applyTools();
    await this.start(reason);
  }

  /** A Durable event the session processed; `flush()` hands the batch to the extensions. */
  observe(event: AgentEvent): void {
    this.#batch.push(event);
  }

  /**
   * Emits the batch the session just processed in PI's order. Durable commits the input of a run with its start but
   * lists the start last, so that input's messages follow `agent_start` and `turn_start` here, as in PI.
   */
  flush(): void {
    const batch = this.#batch.splice(0);
    const start = batch.find((event): event is Extract<AgentEvent, { type: "run_start" }> => event.type === "run_start");
    const inputs = new Set<EntryId>(start ? batch.flatMap((event) =>
      event.type === "submission" && start.inputs.includes(event.record.id) && "entry" in event.record && event.record.entry !== undefined ? [event.record.entry] : []) : []);
    // A run defers a conversation's summary: the write Durable admitted for it (`compaction:<task>`) places it.
    const writers = new Map(batch.flatMap((event) => event.type === "submission" && event.record.type === "write" && event.record.status === "done"
      && event.record.requestId !== undefined ? [[event.record.entry, event.record.requestId] as const] : []));
    let held: EntryRecord[] = [];
    const release = () => { for (const entry of held) this.#messageEvents(entry); held = []; };
    for (const event of batch) {
      switch (event.type) {
        case "run_start": {
          const rows = this.#session.rows();
          const first = rows.findIndex((entry) => inputs.has(entry.id));
          this.#run = { controller: new AbortController(), start: first === -1 ? rows.length : first, turn: 0, ...(this.#pendingPrompt ? { prompt: this.#pendingPrompt } : {}) };
          this.#pendingPrompt = undefined;
          this.#emit({ type: "agent_start" });
          if (!batch.some((each) => each.type === "turn_start")) release();
          break;
        }
        case "turn_start":
          this.#emit({ type: "turn_start", turnIndex: this.#run?.turn ?? 0, timestamp: Date.now() });
          release();
          break;
        case "turn_end":
          this.#turnEnd();
          break;
        case "message_end":
          if (CompactionEntry.is(event.entry)) this.#compacted(event.entry, writers.get(event.entry.id));
          else if (inputs.has(event.entry.id)) held.push(event.entry);
          else this.#messageEvents(event.entry);
          break;
        case "tool_execution_start":
          this.#emit({ type: "tool_execution_start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args, ...nestedIn(event) });
          break;
        case "tool_execution_end": {
          // Durable reports a model-issued call's result message right after, as `message_end`; a nested call (a
          // codemode script's) ends with its `result`, whose output stayed with the script.
          const result = (event.entry?.model?.[0] ?? event.result) as { content?: unknown; details?: unknown; isError?: boolean } | undefined;
          this.#emit({ type: "tool_execution_end", toolCallId: event.toolCallId, toolName: event.toolName, result: { content: result?.content ?? [], details: result?.details }, isError: result?.isError === true, ...nestedIn(event) });
          break;
        }
        case "run_settled":
          this.#runSettled(event.done);
          break;
        case "snapshot":
          // The stream fell behind and skipped commits, the summaries they placed among them; the session read them.
          for (const entry of this.#session.rows()) if (CompactionEntry.is(entry)) this.#compacted(entry);
          break;
        default:
          break;
      }
    }
    release();
  }

  /** `turn_end` for the newest answer and its tool results. Durable decides continuation itself, so results are ignored. */
  #turnEnd(): void {
    const rows = this.#session.rows();
    const index = rows.findLastIndex((entry) => entry.model?.[0]?.role === "assistant");
    const message = rows[index]?.model?.[0] as (Message & { stopReason?: string }) | undefined;
    if (!message) return;
    const results = rows.slice(index + 1).filter((entry) => entry.model?.[0]?.role === "toolResult");
    this.#project();
    this.#emit({
      type: "turn_end", turnIndex: this.#run ? this.#run.turn++ : 0, message, toolResults: results.map((entry) => entry.model![0]),
      messageEntryId: this.#piIds.get(rows[index]!.id) ?? "", toolResultEntryIds: results.flatMap((entry) => this.#piIds.get(entry.id) ?? []),
      ...EMPTY_BOUNDARY, outcome: message.stopReason === "aborted" ? "aborted" : message.stopReason === "error" ? "error" : "completed",
    });
  }

  /** Message events for the conversation's messages. A summary or reset is no message to PI's extensions. */
  #messageEvents(entry: EntryRecord): void {
    if (SystemEntry.is(entry) || ExtensionStateEntry.is(entry) || CompactionEntry.is(entry) || ResetEntry.is(entry)) return;
    for (const raw of entry.model ?? []) {
      const message = ExtensionMessageEntry.is(entry) ? { ...(asPi(raw) as object), display: entry.data.display } : asPi(raw);
      this.#emit({ type: "message_start", message });
      this.#emit({ type: "message_end", message });
    }
  }

  /** The run settled: `agent_end` with what it added, then `agent_settled`, after the batch's own events. Resolves
   * once their handlers ran: as in PI, the session is idle only then. */
  settled(): Promise<void> {
    return new Promise((done) => { this.#batch.push({ type: "run_settled", done }); });
  }

  #runSettled(done: () => void): void {
    const run = this.#run;
    this.#run = undefined;
    const messages = this.#session.rows().slice(run?.start ?? 0)
      .flatMap((entry) => SystemEntry.is(entry) || ExtensionStateEntry.is(entry) || CompactionEntry.is(entry) ? [] : (entry.model ?? []).map((message) => asPi(message)));
    // A handler checks `ctx.signal` to tell a user's Stop from a failed run.
    this.#emit({ type: "agent_end", messages }, run?.controller.signal);
    this.#emit({ type: "agent_settled" }, run?.controller.signal);
    void this.#queue.then(done);
  }

  /** A summary Durable placed is `session_compact`, with the entry it placed; a compaction that placed none has none. */
  #compacted(entry: EntryRecord, writer?: string): void {
    if (this.#summaries.has(entry.id)) return;
    this.#summaries.add(entry.id);
    this.#project();
    const piId = this.#piIds.get(entry.id);
    const compactionEntry = piId === undefined ? undefined : this.#manager.getEntry(piId);
    if (compactionEntry?.type !== "compaction") return;
    // A blocking compaction appends its summary itself. After a skipped stream the write that placed one is unknown.
    const fromExtension = this.#suppliedBy.delete(writer ?? `compaction:${entry.byTaskId}`);
    const reason = (entry.data as { reason?: CompactionReason } | undefined)?.reason ?? "manual";
    this.#emit({ type: "session_compact", compactionEntry, fromExtension, reason, willRetry: reason !== "manual" });
  }

  /** The summaries already in the history, which no `session_compact` reports. */
  #knownSummaries(): void {
    for (const entry of this.#session.rows()) if (CompactionEntry.is(entry)) this.#summaries.add(entry.id);
  }

  /** The conversation or the instances `ctx.compact()` calls belong to are gone: each fails once, now. */
  #cancelCompactions(): void {
    const pending = [...this.#compactions];
    this.#compactions.clear();
    for (const cancel of pending) {
      try {
        cancel();
      } catch (error) {
        this.#report("compact", error);
      }
    }
  }

  modelSelected(previous: { provider: string; id: string } | undefined): void {
    const model = this.#model();
    const before = previous ? this.#host.modelRuntime.getModel(previous.provider, previous.id) : undefined;
    if (model && (model.provider !== before?.provider || model.id !== before?.id)) this.#emit({ type: "model_select", model, previousModel: before, source: "set" });
  }

  thinkingSelected(previous: string | undefined, level: string): void {
    if (previous !== level) this.#emit({ type: "thinking_level_select", level, previousLevel: previous ?? "off" });
  }

  /** A rewind moved the session to a fork. */
  rewound(): void {
    this.#cancelCompactions();
    this.#knownSummaries();
    const oldLeafId = this.#manager.getLeafId();
    this.#emit({ type: "session_tree", newLeafId: this.#project().getLeafId(), oldLeafId });
  }

  /** Stop: the run's `ctx.signal` aborts and open dialogs close with their defaults. */
  aborted(): void {
    this.#run?.controller.abort();
    this.cancelQuestions();
  }

  /** PI's provider callbacks for a request of this session's runs. */
  requestCallbacks(): { onPayload?: (payload: unknown) => Promise<unknown>; onResponse?: (response: { status: number; headers: Record<string, string> }) => Promise<void> } {
    const runner = this.#runner;
    return {
      ...(runner.hasHandlers("before_provider_request") ? { onPayload: (payload: unknown) => runner.emitBeforeProviderRequest(payload) } : {}),
      ...(runner.hasHandlers("after_provider_response") ? {
        onResponse: async (response: { status: number; headers: Record<string, string> }) => {
          await runner.emit({ type: "after_provider_response", status: response.status, headers: response.headers });
        },
      } : {}),
    };
  }

  /** `session_shutdown`, then the session's tools and hooks leave the registry, at the latest after `SHUTDOWN_WAIT_MS`. */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#stopping = true;
    this.#cancelCompactions();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.#shutdown("quit"), new Promise((resolve) => { timer = setTimeout(resolve, SHUTDOWN_WAIT_MS); })]).finally(() => clearTimeout(timer));
    this.#disposed = true;
    this.#host.uninstall(this.#extension);
  }
}
