/**
 * A session running on a remote worker host, driven through the generic
 * RuntimeSession contract. The host runs the same adapter a local session
 * would (Durable or PI) and sends its state with every reply and event, so
 * the synchronous reads below are never behind the event being handled.
 * Every snapshot carries a sequence: a reply resumes after the events that
 * followed it in the stream, and must not overwrite them with its older
 * state. Losing the connection reads as an exit marked unreachable: the
 * host keeps the session running and a later start reattaches.
 */
import { readFile } from "node:fs/promises";
import { workers, type RemoteSessionLink, type RemoteSessionSink, type RemoteSnapshot } from "../workers.ts";
import type { RemoteState } from "../worker/protocol.ts";
import type { RuntimeInspection } from "./types.ts";
import type { AgentRuntime, PromptAttachment, RuntimeCommand, RuntimeEvent, RuntimeModel, RuntimePromptOptions, RuntimePromptResult, RuntimeSession, RuntimeUnreachableError, StartOptions, TranscriptEntry } from "./types.ts";

type Frame = RemoteSnapshot & { event?: RuntimeEvent };

class RemoteRuntimeSession implements RuntimeSession, RemoteSessionSink {
  #state!: RemoteState;
  #stateSeq = 0;
  #transcript: TranscriptEntry[] = [];
  #transcriptSeq = 0;
  #link!: RemoteSessionLink;
  #worker: string;
  #listeners = new Set<(event: RuntimeEvent) => void>();
  /** Events before the first subscriber, such as a question asked at once. */
  #early: RuntimeEvent[] | undefined = [];
  /** Frames wait here, in order, until the start reply has been taken and
   * behind a transcript being read in pages. */
  #delivery: Promise<void> | undefined;
  #attached!: () => void;
  #exitListeners = new Set<(unreachable?: RuntimeUnreachableError) => void>();
  #ended = false;
  /** Set once lost: how, for listeners that arrive later. */
  #lost: { unreachable?: RuntimeUnreachableError } | undefined;

  constructor(worker: string) {
    this.#worker = worker;
    const attached = new Promise<void>((resolve) => { this.#attached = resolve; });
    this.#delivery = attached;
    void attached.then(() => { if (this.#delivery === attached) this.#delivery = undefined; });
  }

  /** Takes the host's start reply, then the frames that arrived around it. */
  async attach(link: RemoteSessionLink): Promise<void> {
    const { started } = link;
    this.#link = link;
    this.#state = started.state;
    this.#stateSeq = started.seq;
    this.#applyTranscript(started.transcript ?? await link.transcript(started.seq), started.seq);
    // Only what the remote runtime offers is exposed, so the gateway never
    // shows a control that would fail.
    const self = this as unknown as Record<string, unknown>;
    for (const name of ["steer", "followUp", "abort", "setModel", "setThinking", "setFast", "respondQuestion", "cancelQuestion", "compact", "cancelCompaction", "rewind", "fork", "continueRun", "listModels", "listCommands", "inspect", "attachmentImage", "clear", "reload", "waitForTrackedPrompt", "cancelTrackedPrompt"]) {
      if (!started.methods.includes(name)) self[name] = undefined;
    }
    this.#attached();
  }

  get processId(): undefined { return undefined; }
  get sessionId(): string { return this.#state.sessionId; }
  get sessionFile(): string | undefined { return this.#state.sessionFile; }
  get isStreaming(): boolean { return this.#state.isStreaming; }
  get resumesInterruptedRuns(): boolean { return this.#state.resumesInterruptedRuns; }

  /** A frame from the host for this session. */
  receive(frame: Frame): void {
    void this.#deliver(frame);
  }

  /** Applies frames in arrival order: one whose transcript is read in pages
   * holds the rest until it has been read. */
  #deliver(frame: Frame): Promise<void> {
    if (!this.#delivery && !frame.transcriptPaged) {
      this.#apply(frame);
      return Promise.resolve();
    }
    const delivery: Promise<void> = (this.#delivery ?? Promise.resolve()).then(async () => {
      const transcript = frame.transcriptPaged ? await this.#link.transcript(frame.seq ?? 0).catch((error: unknown) => console.error(error)) : undefined;
      this.#apply(transcript ? { ...frame, transcript } : frame);
    }).catch((error: unknown) => console.error(error));
    this.#delivery = delivery;
    void delivery.finally(() => { if (this.#delivery === delivery) this.#delivery = undefined; });
    return delivery;
  }

  #apply(frame: Frame): void {
    if (frame.state && frame.seq !== undefined && frame.seq > this.#stateSeq) {
      this.#state = frame.state;
      this.#stateSeq = frame.seq;
    }
    if (frame.transcript && frame.seq !== undefined) this.#applyTranscript(frame.transcript, frame.seq);
    if (!frame.event) return;
    if (this.#early) this.#early.push(frame.event);
    else for (const listener of [...this.#listeners]) listener(frame.event);
  }

  #applyTranscript(transcript: TranscriptEntry[], seq: number): void {
    if (seq <= this.#transcriptSeq) return;
    this.#transcript = transcript;
    this.#transcriptSeq = seq;
  }

  /** The remote runtime is gone, or only the connection to it (`unreachable`). */
  lost(unreachable?: RuntimeUnreachableError): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#lost = unreachable ? { unreachable } : {};
    for (const listener of [...this.#exitListeners]) listener(unreachable);
  }

  async #call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    if (this.#ended) throw new Error("The remote worker connection is closed.");
    const reply = await this.#link.call(method, args) as Frame & { result?: T };
    await this.#deliver(reply);
    return reply.result as T;
  }

  /** Files are copied to the worker, where the remote agent can read them. */
  async #stage(attachments: readonly PromptAttachment[] = []): Promise<PromptAttachment[]> {
    return Promise.all(attachments.map(async (item) => item.kind === "file"
      ? { ...item, path: await workers.putFile(this.#worker, item.name, await readFile(item.path)) }
      : item));
  }

  async prompt(text: string, attachments?: readonly PromptAttachment[], options?: RuntimePromptOptions): Promise<void> { await this.#call("prompt", text, await this.#stage(attachments), options); }
  async steer(text: string, attachments?: readonly PromptAttachment[]): Promise<void> { await this.#call("steer", text, await this.#stage(attachments)); }
  async followUp(text: string, attachments?: readonly PromptAttachment[], options?: RuntimePromptOptions): Promise<void> { await this.#call("followUp", text, await this.#stage(attachments), options); }
  async waitForTrackedPrompt(requestId: string): Promise<RuntimePromptResult> { return this.#call("waitForTrackedPrompt", requestId); }
  async cancelTrackedPrompt(requestId: string): Promise<void> { await this.#call("cancelTrackedPrompt", requestId); }
  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.#listeners.add(listener);
    // Delivered once the caller has finished subscribing, before anything newer.
    if (this.#early) {
      queueMicrotask(() => {
        const early = this.#early ?? [];
        this.#early = undefined;
        for (const event of early) for (const each of [...this.#listeners]) each(event);
      });
    }
    return () => this.#listeners.delete(listener);
  }
  currentModel() { return this.#state.model; }
  currentUsage() { return this.#state.usage; }
  currentThinking() { return this.#state.thinking; }
  currentFast() { return this.#state.fast === true; }
  pendingQueue() { return this.#state.queue ?? { steering: [], followUp: [] }; }
  pendingQuestions() { return this.#state.questions ?? []; }
  listModels(): Promise<readonly RuntimeModel[]> { return this.#call("listModels"); }
  listCommands(): Promise<readonly RuntimeCommand[]> { return this.#call("listCommands"); }
  inspect(): Promise<RuntimeInspection> { return this.#call("inspect"); }
  async setModel(provider: string, id: string): Promise<void> { await this.#call("setModel", provider, id); }
  async setThinking(level: string): Promise<void> { await this.#call("setThinking", level); }
  async setFast(on: boolean): Promise<void> { await this.#call("setFast", on); }
  async respondQuestion(id: string, response: unknown): Promise<void> { await this.#call("respondQuestion", id, response); }
  async cancelQuestion(id: string): Promise<void> { await this.#call("cancelQuestion", id); }
  async abort(): Promise<void> { await this.#call("abort"); }
  async clear(): Promise<void> { await this.#call("clear"); }
  /** The mirror is refreshed first, so the reload sees what just changed here. */
  async reload(): Promise<void> {
    await workers.sync(this.#worker);
    await this.#call("reload");
  }
  async compact(instructions?: string): Promise<void> { await this.#call("compact", ...(instructions === undefined ? [] : [instructions])); }
  async cancelCompaction(): Promise<void> { await this.#call("cancelCompaction"); }
  async rewind(target: unknown, options?: unknown): Promise<void> { await this.#call("rewind", target, ...(options === undefined ? [] : [options])); }
  /** The fork lives in the worker's store, so the reference only resumes there. */
  async fork(entryId?: string, options?: { cwd?: string }): Promise<string> {
    return await this.#call<string>("fork", entryId, ...(options === undefined ? [] : [options]));
  }
  async continueRun(): Promise<void> { await this.#call("continueRun"); }
  onExit(listener: (unreachable?: RuntimeUnreachableError) => void): () => void {
    this.#exitListeners.add(listener);
    // Lost before anyone listened: still reported, after the caller's setup.
    const lost = this.#lost;
    if (lost) queueMicrotask(() => { if (this.#exitListeners.has(listener)) listener(lost.unreachable); });
    return () => this.#exitListeners.delete(listener);
  }
  async attachmentImage(message: number, image: number): Promise<{ mimeType: string; data: Buffer } | undefined> {
    const result = await this.#call<{ mimeType: string; data: string } | undefined>("attachmentImage", message, image);
    return result ? { mimeType: result.mimeType, data: Buffer.from(result.data, "base64") } : undefined;
  }
  transcript(): TranscriptEntry[] { return this.#transcript; }
  /** Closing a session stops it on the worker; a lost connection does not. */
  dispose(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#link.dispose();
  }
}

/** The adapter a record with `worker` uses: `tool` names the runtime the host runs. */
export function remoteRuntime(tool: string): AgentRuntime {
  return {
    id: tool,
    async start(options: StartOptions): Promise<RuntimeSession> {
      if (!options.worker) throw new Error("A remote session needs a worker.");
      // The session hears its connection before the reply arrives.
      const session = new RemoteRuntimeSession(options.worker);
      await session.attach(await workers.startSession(options.worker, options.huiSessionId ?? "", tool, options, session));
      return session;
    },
  };
}
