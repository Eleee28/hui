/**
 * The remote worker host. One long-lived daemon per remote user runs HUI's own
 * runtime adapters (Pi Durable in-process, PI's SDK worker as a child), so a
 * conversation keeps going while no gateway is attached (a laptop asleep, a
 * gateway restart, a dropped SSH connection).
 *
 * Gateways reach it through a Unix socket that `main.ts connect` bridges to
 * the stdio of whatever command reached this machine, and drive each session
 * through the generic RuntimeSession contract (`session.*` frames). Sessions
 * are keyed by HUI session id; reopening a key reattaches to the running one,
 * whose pending questions travel in its state. Credentials and HUI agent
 * tools are served by whichever gateway is connected; credentials are kept in
 * memory until they expire, and literal models.json header values until the
 * host stops, never on disk. The one secret written here is the answer to a
 * session's `secret_request`, in a private file its agent reads (SecretFiles).
 * A bot whose chat runs here keeps its conversation and memory in this host's
 * store (`host-bots.ts`); its `bots` prompt section comes from the connected
 * gateway, which owns the roster.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { chmod, lstat, mkdir, readdir, readFile, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { BotTurnOrigin } from "../runtimes/turn-origins.ts";
import { registerAgentToolHandler, stopAgentToolBridge } from "../agent-tools/bridge.ts";
import { operatorName } from "../bots/souls.ts";
import { readHuiSettings } from "../hui-settings.ts";
import { SECRET_REQUEST_TIMEOUT_MS, SecretFiles, type SecretAnswer } from "../agent-tools/secret-requests.ts";
import { QUESTIONNAIRE_WAIT_MS } from "../agent-tools/questionnaires.ts";
import { agentsWaitTransportMs } from "../runtimes/agent-tools-extension.mjs";
import { DurableHost } from "../runtimes/durable-host.ts";
import { durableConversationId, startDurable } from "../runtimes/durable.ts";
import { piRuntime } from "../runtimes/pi.ts";
import { searchTranscripts } from "../runtimes/transcript-search.ts";
import type { RuntimeSession, TranscriptEntry } from "../runtimes/types.ts";
import { installBrokeredCredentials, OfflineError, setCredentialTransport, setSecretEnv } from "./credentials.ts";
import { completeWorkingDirectories, resolveWorkingDirectory } from "../git/working-directories.ts";
import { attachPeer, isRecord, PROTOCOL_VERSION, type HostInfo, type Peer, type RemoteLaunch, type RemoteState } from "./protocol.ts";
import { BOT_FACTS_FEATURE, BOT_ACCESS_FEATURE, BOT_ACCESS_FRAME, BOT_SKILL_FILES_FEATURE, BOT_SKILLS_FEATURE, BOTS_FEATURE, hostBots } from "./host-bots.ts";
import { GATEWAY_ONLY_TOOLS } from "./gateway-tools.ts";
import { PACKAGE_ROOT } from "./release.ts";
import { applySync, planSync, putSyncFiles, writeAtomic, type SyncCommit } from "./sync-apply.ts";
import type { WorkerPaths } from "./paths.ts";

/** Detached, idle sessions are stopped after this; their transcript stays on disk. */
const DETACHED_IDLE_MS = 10 * 60_000;
/** A detached worker waiting on a question keeps it this long for someone to answer. */
const DETACHED_QUESTION_MS = 24 * 60 * 60_000;
const ATTACHMENT_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** A host with nothing to do exits after this, unless Durable work remains. */
const HOST_IDLE_MS = 30 * 60_000;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
/** A transcript larger than this is fetched in pages instead of riding along
 * with a frame, which could exceed the frame limit or hold up other sessions. */
const TRANSCRIPT_PAGE_BYTES = 8 * 1024 * 1024;
/** How long a bot chat's model request waits for its `bots` section from the gateway before going without it. */
const BOT_SECTION_TIMEOUT_MS = 10_000;

/** The runtime methods a gateway may call; anything else is refused. */
const CALLS = new Set(["prompt", "steer", "followUp", "abort", "setModel", "setThinking", "setFast", "respondQuestion", "cancelQuestion",
  "clear", "reload", "compact", "cancelCompaction", "rewind", "fork", "continueRun", "listModels", "listCommands", "inspect", "attachmentImage", "waitForTrackedPrompt", "cancelTrackedPrompt"]);
/** PI calls that start a run, recorded before they reach the runtime. */
const RUN_CALLS = new Set(["prompt", "continueRun"]);
/** Calls after which the gateway re-reads the whole transcript. */
const TRANSCRIPT_CALLS = new Set(["clear", "rewind", "reload", "abort", "continueRun"]);
/** Events after which the gateway re-reads the whole transcript. */
const TRANSCRIPT_EVENTS = new Set(["settled", "compaction_end"]);

type Hosted = {
  key: string;
  tool: string;
  runtime: RuntimeSession;
  /** A PI runtime started where the last one stopped mid-run: HUI recovers that
   * run, as it would locally, until this one runs again. */
  interrupted: boolean;
  peer?: Peer;
  lastActive: number;
  stop: () => void;
  /** Stamps every frame and reply sent, so the gateway can drop a reply
   * that arrives after newer events. */
  seq: number;
  /** Transcripts too large for their frame, as they were when it was sent,
   * by its sequence, until the gateway has read them in pages. */
  paged: Map<number, TranscriptEntry[]>;
};

/** Cached gateway credential answers; memory only, dropped at expiry. */
type Cached = { value: unknown; until: number };

const logPiRuns = (error: unknown) => console.error(`Could not record PI runs: ${error instanceof Error ? error.message : String(error)}`);

function expiry(value: unknown): number {
  const expires = isRecord(value) ? value["expires"] : undefined;
  return typeof expires === "number" ? expires : Infinity;
}

export class WorkerHost {
  readonly paths: WorkerPaths;
  readonly releaseDir = PACKAGE_ROOT;
  #release = basename(PACKAGE_ROOT);
  #sessions = new Map<string, Hosted>();
  #peers = new Set<Peer>();
  /** Starts in progress, so concurrent opens share one runtime. */
  #starting = new Map<string, Promise<Hosted>>();
  #server: Server | undefined;
  #timer: NodeJS.Timeout | undefined;
  #lastActivity = Date.now();
  #pruned = 0;
  #durable: DurableHost;
  /** Durable conversation → HUI session, kept across host restarts. */
  #callers = new Map<string, string>();
  #callersFile: string;
  /** HUI sessions whose PI run started and has not been seen settling, kept
   * across host restarts. Any other PI run finished while nobody watched. */
  #piRuns = new Set<string>();
  #piRunsFile: string;
  /** Host state writes, one at a time so an older one never lands last. */
  #writes: Promise<void> = Promise.resolve();
  #credentials = new Map<string, Cached>();
  #modifiers = new Map<string, (current: unknown) => Promise<unknown>>();
  #nextStep = 0;
  #secretFiles = new SecretFiles();
  #bots: ReturnType<typeof hostBots>;

  constructor(paths: WorkerPaths) {
    this.paths = paths;
    this.#callersFile = join(paths.stateDir, "conversations.json");
    this.#piRunsFile = join(paths.stateDir, "pi-runs.json");
    this.#durable = new DurableHost({
      dir: join(paths.stateDir, "durable"),
      agentDir: paths.agentDir,
      invokeTool: ({ callerSessionId, action, params, signal, runOrigins }) => this.#gatewayTool(callerSessionId, action, params, signal, runOrigins),
      lookupCaller: async (conversationId) => this.#callers.get(String(conversationId)),
      // The gateway's bridge refuses these for every session here; a bot's chat isn't offered them.
      gatewayOnlyTools: GATEWAY_ONLY_TOOLS,
    });
    this.#bots = hostBots({
      durable: this.#durable, home: paths.home, botsDir: join(paths.dataDir, "bots"),
      // A bot without a model of its own starts on Settings' primary model, as on the gateway.
      primaryModel: async () => (await readHuiSettings()).models.primary || undefined,
      // A bot's chat here lists the other bots as the gateway that owns them says, and a session the bots it may tag.
      section: (botId, conversationId) => this.#botSection(botId, conversationId),
      // The operator's name comes from the Settings the gateway mirrors here, as the gateway reads its own.
      operator: async () => operatorName((await readHuiSettings()).profileName),
      // The operator allowed a bot's request here: its lists are already in its document, which this host enforces;
      // every connected gateway hears of them, and the one whose bot it is updates its roster.
      recorded: async (botId, access) => {
        for (const peer of [...this.#peers]) if (!peer.closed) peer.send({ t: BOT_ACCESS_FRAME, botId, access });
      },
    });
  }

  info(): HostInfo {
    return {
      version: PROTOCOL_VERSION, release: this.#release, features: [BOT_FACTS_FEATURE, BOTS_FEATURE, BOT_ACCESS_FEATURE, BOT_SKILLS_FEATURE, BOT_SKILL_FILES_FEATURE], pid: process.pid, hostname: hostname(),
      platform: process.platform, arch: process.arch, node: process.version, home: this.paths.home,
      dataDir: this.paths.dataDir, mirrorDir: this.paths.mirrorDir, agentDir: this.paths.agentDir,
      providersDir: this.paths.providersDir, releaseDir: this.releaseDir,
    };
  }

  async listen(): Promise<void> {
    await mkdir(this.paths.stateDir, { recursive: true, mode: 0o700 });
    await chmod(this.paths.stateDir, 0o700);
    const socketDir = dirname(this.paths.socket);
    if (socketDir !== this.paths.stateDir) {
      await mkdir(socketDir, { recursive: true, mode: 0o700 });
      const info = await lstat(socketDir);
      // A shared /tmp directory must be ours alone.
      if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error(`Refusing to use ${socketDir}: it is not private to this user.`);
    }
    // HUI agent tools of a PI worker started here reach a connected gateway.
    registerAgentToolHandler(({ callerSessionId, action, params, signal }) => this.#gatewayTool(callerSessionId, action, params, signal));
    void this.#secretFiles.sweep();
    installBrokeredCredentials({ agentDir: this.paths.agentDir, providersDir: this.paths.providersDir, fallbackAuth: join(this.paths.fallbackAgentDir, "auth.json") });
    setCredentialTransport((op, store, providerId, modify) => this.#credential(op, store, providerId, modify as ((current: unknown) => Promise<unknown>) | undefined));
    await this.#pruneAttachments();
    try {
      const saved = JSON.parse(await readFile(this.#callersFile, "utf8")) as unknown;
      if (isRecord(saved)) for (const [id, key] of Object.entries(saved)) if (typeof key === "string") this.#callers.set(id, key);
    } catch { /* none yet */ }
    try {
      const saved = JSON.parse(await readFile(this.#piRunsFile, "utf8")) as unknown;
      if (Array.isArray(saved)) for (const key of saved) if (typeof key === "string") this.#piRuns.add(key);
    } catch { /* none yet */ }
    // The host lock (main.ts) already makes this the store's only owner; a
    // store lock left by a killed host may name a pid reused since.
    await rm(join(this.#durable.dir, "harness.lock"), { force: true });
    // Durable runs interrupted by a host restart continue now, with nobody watching.
    if (existsSync(join(this.#durable.dir, "harness.sqlite"))) {
      await this.#durable.open().catch((error: unknown) => console.error(`Durable store did not open: ${error instanceof Error ? error.message : String(error)}`));
    }
    this.#server = createServer((socket) => this.#accept(socket));
    await new Promise<void>((resolveListen, reject) => {
      this.#server!.once("error", reject);
      this.#server!.listen(this.paths.socket, () => { this.#server!.off("error", reject); resolveListen(); });
    });
    await chmod(this.paths.socket, 0o600);
    await writeFile(join(this.paths.stateDir, "release"), this.#release);
    this.#timer = setInterval(() => this.#sweep(), 30_000);
    this.#timer.unref();
  }

  async close(): Promise<void> {
    clearInterval(this.#timer);
    for (const hosted of [...this.#sessions.values()]) this.#stop(hosted);
    this.#bots.close();
    for (const peer of this.#peers) peer.close("Remote worker host stopped.");
    stopAgentToolBridge();
    this.#secretFiles.dispose();
    setCredentialTransport(undefined);
    // Running Durable work is recorded, not lost: it resumes on the next start.
    await this.#durable.close().catch(() => undefined);
    await new Promise<void>((done) => this.#server ? this.#server.close(() => done()) : done());
    await unlink(this.paths.socket).catch(() => undefined);
  }

  /** Another gateway still connected or a PI run that cannot resume blocks
   * an upgrade; Durable work resumes in the new host. */
  busy(): boolean {
    return this.#peers.size > 1 || [...this.#sessions.values()].some((hosted) => hosted.tool !== "durable"
      && (hosted.runtime.isStreaming || (hosted.runtime.pendingQuestions?.().length ?? 0) > 0));
  }

  #accept(socket: Socket): void {
    const peer = attachPeer(socket, socket);
    peer.keepAlive();
    this.#peers.add(peer);
    this.#touch();
    peer.onClose(() => {
      this.#peers.delete(peer);
      for (const hosted of this.#sessions.values()) if (hosted.peer === peer) hosted.peer = undefined;
      socket.destroy();
    });
    peer.handle("hello", () => this.info());
    peer.handle("session.start", (params) => this.#start(peer, params));
    peer.handle("session.call", (params) => this.#call(params));
    peer.handle("session.transcript", (params) => this.#transcriptPage(params));
    peer.handle("session.dispose", (params) => {
      const hosted = this.#sessions.get(String(params["key"] ?? ""));
      if (hosted && hosted.peer === peer) this.#stop(hosted);
      return { ok: true };
    });
    peer.handle("sessions.search", (params, signal) => searchTranscripts(this.#durable,
      Array.isArray(params["sessionFiles"]) ? params["sessionFiles"].filter((file): file is string => typeof file === "string") : [],
      String(params["q"] ?? ""), signal).then((hits) => ({ hits })));
    peer.handle("directories", async (params) => ({ directories: await completeWorkingDirectories(String(params["q"] ?? "~/")) }));
    // Bots whose chats run here: their conversations and memories in this host's store.
    for (const [op, handler] of Object.entries(this.#bots.handlers(peer))) peer.handle(op, handler);
    peer.handle("put-file", (params) => this.#putFile(params));
    peer.handle("get-file", (params) => this.#getFile(params));
    peer.handle("sync-plan", (params) => planSync(this.paths, params["entries"]));
    peer.handle("sync-put", (params) => putSyncFiles(this.paths, params["files"]));
    peer.handle("sync-commit", (params) => {
      // Before the mirrored models.json that names them takes effect.
      setSecretEnv(params["env"]);
      return applySync(this.paths, params as unknown as SyncCommit).then(async (result) => {
        if (this.#durable.isOpen) await this.#durable.refreshModels().catch(() => undefined);
        return result;
      });
    });
    peer.handle("credential-step", async (params) => {
      const modify = this.#modifiers.get(String(params["step"] ?? ""));
      if (!modify) throw new Error("That credential update is no longer pending.");
      const next = await modify(params["current"]);
      return next === undefined ? {} : { next };
    });
    peer.handle("forget", (params) => {
      // A deleted HUI session: stop its runtime even if no gateway is attached.
      const keys = (Array.isArray(params["keys"]) ? params["keys"] : []).filter((key): key is string => typeof key === "string");
      for (const key of keys) {
        const hosted = this.#sessions.get(key);
        if (hosted) this.#stop(hosted);
      }
      if (keys.some((key) => this.#piRuns.delete(key))) this.#savePiRuns().catch(logPiRuns);
      return { ok: true };
    });
    peer.handle("shutdown", () => {
      if (this.busy()) return { stopping: false };
      setImmediate(() => { void this.close().finally(() => process.exit(0)); });
      return { stopping: true };
    });
  }

  /** Starts or reattaches the runtime for one HUI session. */
  async #start(peer: Peer, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const key = typeof params["key"] === "string" ? params["key"] : "";
    const tool = params["tool"];
    if (!/^[A-Za-z0-9_-]{1,80}$/u.test(key) || (tool !== "pi" && tool !== "durable") || !isRecord(params["launch"])) throw new Error("Invalid remote session request.");
    const hosted = await this.#hostedFor(key, tool, params["launch"] as RemoteLaunch);
    // The gateway may have gone while the runtime started; leave it running.
    if (peer.closed) throw new Error("The gateway disconnected.");
    // A second gateway (or a reconnect) takes over; the old view ends.
    if (hosted.peer && hosted.peer !== peer) hosted.peer.send({ t: "session.exit", key, message: "This session was opened from another HUI." });
    hosted.peer = peer;
    hosted.paged.clear();
    this.#touch(hosted);
    const methods = [...CALLS].filter((name) => typeof (hosted.runtime as unknown as Record<string, unknown>)[name] === "function");
    return { ...this.#snapshot(hosted, true), methods };
  }

  async #hostedFor(key: string, tool: string, launch: RemoteLaunch): Promise<Hosted> {
    const current = this.#starting.get(key) ?? this.#sessions.get(key);
    if (current) return current;
    const start = this.#launch(key, tool, launch).finally(() => this.#starting.delete(key));
    this.#starting.set(key, start);
    return start;
  }

  async #launch(key: string, tool: string, launch: RemoteLaunch): Promise<Hosted> {
    const cwd = resolveWorkingDirectory(launch.cwd, this.paths.home);
    const info = await stat(cwd).catch(() => undefined);
    if (!info?.isDirectory()) throw new Error(`No such directory on the remote: ${cwd}`);
    const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    const options = {
      cwd, huiSessionId: key,
      ...(typeof launch["sessionFile"] === "string" ? { sessionFile: launch["sessionFile"] } : {}),
      ...(typeof launch["model"] === "string" ? { model: launch["model"] } : {}),
      ...(typeof launch["thinking"] === "string" ? { thinking: launch["thinking"] } : {}),
      ...(typeof launch["title"] === "string" ? { title: launch["title"] } : {}),
    };
    const runtime: RuntimeSession = tool === "durable" ? await startDurable(options, this.#durable) : await piRuntime.start({
      ...options, agentDir: this.paths.agentDir,
      hostLaunch: {
        disabledSkills: launch.disabledSkills ?? [],
        bundledSkillPaths: strings(launch["bundledSkillPaths"]),
        disabledPluginIds: strings(launch["disabledPluginIds"]),
        // The managed browser runs on the gateway machine.
        browserTool: false,
        fallbackAuth: join(this.paths.fallbackAgentDir, "auth.json"),
      },
    });
    try {
      await this.#remember(key, runtime.sessionFile);
    } catch (error) {
      runtime.dispose();
      throw error;
    }
    const hosted: Hosted = { key, tool, runtime, lastActive: Date.now(), stop: () => undefined, seq: 0, paged: new Map(), interrupted: tool === "pi" && this.#piRuns.has(key) };
    const unsubscribe = runtime.subscribe((event) => {
      this.#touch(hosted);
      this.#trackRun(hosted, event.type === "settled");
      hosted.peer?.send({ t: "session.event", key, event, ...this.#snapshot(hosted, TRANSCRIPT_EVENTS.has(event.type)) });
    });
    const unsubscribeExit = runtime.onExit?.(() => {
      hosted.peer?.send({ t: "session.exit", key, message: "The session's runtime stopped on the remote." });
      this.#stop(hosted);
    });
    hosted.stop = () => { unsubscribe(); unsubscribeExit?.(); runtime.dispose(); };
    this.#sessions.set(key, hosted);
    return hosted;
  }

  /** Durable conversation → HUI session, also after a rewind moved the
   * session to a new conversation, so resumed runs still call tools as it. */
  async #remember(key: string, sessionFile: string | undefined): Promise<void> {
    const conversation = durableConversationId(sessionFile);
    if (conversation === undefined || this.#callers.get(String(conversation)) === key) return;
    this.#callers.set(String(conversation), key);
    await this.#write(this.#callersFile, () => JSON.stringify(Object.fromEntries(this.#callers)));
  }

  /** Records whether a PI run is in progress; Durable keeps its own record. */
  #trackRun(hosted: Hosted, settled = false): void {
    if (hosted.tool !== "pi") return;
    if (hosted.runtime.isStreaming) hosted.interrupted = false;
    const running = hosted.runtime.isStreaming || (this.#piRuns.has(hosted.key) && !settled);
    if (running === this.#piRuns.has(hosted.key)) return;
    if (running) this.#piRuns.add(hosted.key);
    else this.#piRuns.delete(hosted.key);
    this.#savePiRuns().catch(logPiRuns);
  }

  #savePiRuns(): Promise<void> {
    return this.#write(this.#piRunsFile, () => JSON.stringify([...this.#piRuns]));
  }

  /** Writes a host state file atomically, after any write already queued, with
   * the data current when its turn comes. */
  #write(file: string, data: () => string): Promise<void> {
    const write = this.#writes.catch(() => undefined).then(() => writeAtomic(file, `${data()}\n`, 0o600));
    this.#writes = write;
    return write;
  }

  #state(hosted: Hosted): RemoteState {
    const runtime = hosted.runtime;
    const model = runtime.currentModel?.();
    const usage = runtime.currentUsage?.();
    const thinking = runtime.currentThinking?.();
    return {
      sessionId: runtime.sessionId,
      ...(runtime.sessionFile ? { sessionFile: runtime.sessionFile } : {}),
      isStreaming: runtime.isStreaming,
      resumesInterruptedRuns: runtime.resumesInterruptedRuns === true || !hosted.interrupted,
      ...(model ? { model } : {}),
      ...(usage ? { usage } : {}),
      ...(thinking ? { thinking } : {}),
      ...(runtime.currentFast?.() ? { fast: true as const } : {}),
      ...(runtime.pendingQueue ? { queue: runtime.pendingQueue() } : {}),
      ...(runtime.pendingQuestions ? { questions: runtime.pendingQuestions() } : {}),
    };
  }

  /** The state stamped with the next sequence and, when asked, the transcript
   * as it is now; one too large for a frame is kept under that sequence for
   * the gateway to read in pages, so it matches the frame it came with. */
  #snapshot(hosted: Hosted, withTranscript = false): Record<string, unknown> {
    const snapshot = { state: this.#state(hosted), seq: ++hosted.seq };
    if (!withTranscript) return snapshot;
    const transcript = hosted.runtime.transcript();
    if (JSON.stringify(transcript).length <= TRANSCRIPT_PAGE_BYTES) return { ...snapshot, transcript };
    hosted.paged.set(snapshot.seq, transcript);
    return { ...snapshot, transcriptPaged: true };
  }

  /** One page of the transcript kept for the frame with sequence `seq`. */
  #transcriptPage(params: Record<string, unknown>): { entries: TranscriptEntry[]; total: number } {
    const hosted = this.#sessions.get(String(params["key"] ?? ""));
    if (!hosted) throw new Error("That session is not running on this worker.");
    const seq = Number(params["seq"]);
    const transcript = hosted.paged.get(seq);
    if (!transcript) throw new Error("That transcript is no longer available.");
    const offset = typeof params["offset"] === "number" ? params["offset"] : 0;
    const entries: TranscriptEntry[] = [];
    let size = 0;
    for (const entry of transcript.slice(offset)) {
      size += JSON.stringify(entry).length;
      if (entries.length && size > TRANSCRIPT_PAGE_BYTES) break;
      entries.push(entry);
    }
    if (offset + entries.length >= transcript.length) hosted.paged.delete(seq);
    return { entries, total: transcript.length };
  }

  async #call(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const hosted = this.#sessions.get(String(params["key"] ?? ""));
    const requested = String(params["method"] ?? "");
    if (!hosted) throw new Error("That session is not running on this worker.");
    if (!CALLS.has(requested)) throw new Error(`The session cannot ${requested}.`);
    // A follow-up that arrives once the run has settled starts the next one:
    // PI would hold it for some later prompt.
    const method = requested === "followUp" && !hosted.runtime.isStreaming ? "prompt" : requested;
    const fn = (hosted.runtime as unknown as Record<string, unknown>)[method];
    if (typeof fn !== "function") throw new Error(`The session cannot ${requested}.`);
    this.#touch(hosted);
    const args = Array.isArray(params["args"]) ? params["args"] : [];
    // Recorded before the run starts, so a host that dies during it still
    // knows the run was cut off.
    const recorded = hosted.tool === "pi" && RUN_CALLS.has(method) && !this.#piRuns.has(hosted.key);
    let result: unknown;
    try {
      if (recorded) {
        this.#piRuns.add(hosted.key);
        await this.#savePiRuns();
      }
      result = await (fn as (...values: unknown[]) => unknown).apply(hosted.runtime, args);
    } catch (error) {
      if (recorded && !hosted.runtime.isStreaming && this.#piRuns.delete(hosted.key)) this.#savePiRuns().catch(logPiRuns);
      throw error;
    }
    this.#trackRun(hosted);
    await this.#remember(hosted.key, hosted.runtime.sessionFile).catch((error: unknown) => console.error(`Could not record the conversation: ${error instanceof Error ? error.message : String(error)}`));
    if (method === "attachmentImage" && isRecord(result) && Buffer.isBuffer(result["data"])) result = { mimeType: result["mimeType"], data: result["data"].toString("base64") };
    return { ...(result === undefined ? {} : { result }), ...this.#snapshot(hosted, TRANSCRIPT_CALLS.has(method)) };
  }

  /** The gateway preferred for a session: its own, else any connected one. */
  #gateway(key?: string): Peer | undefined {
    const own = key ? this.#sessions.get(key)?.peer : undefined;
    if (own && !own.closed) return own;
    for (const peer of this.#peers) if (!peer.closed) return peer;
    return undefined;
  }

  /** A chat's `bots` section, from a connected gateway: a bot's from the one that owns the bot, a session's (the bots it
   * may tag) from its own. With none attached the section is
   * left out, as message_bot cannot reach a bot then either. Asked before each of the chat's model requests, so a
   * gateway that has gone quiet (before the keep-alive drops it) delays a request by seconds at most. */
  async #botSection(botId: string | undefined, conversationId: ConversationId): Promise<string | undefined> {
    if (botId === undefined) {
      const peer = this.#gateway(this.#callers.get(String(conversationId)));
      const reply = await peer?.request<{ section?: unknown }>("bot.section", {}, BOT_SECTION_TIMEOUT_MS).catch(() => undefined);
      return typeof reply?.section === "string" ? reply.section : undefined;
    }
    for (const peer of [...this.#peers]) {
      if (peer.closed) continue;
      const reply = await peer.request<{ section?: unknown; name?: unknown }>("bot.section", { botId }, BOT_SECTION_TIMEOUT_MS).catch(() => undefined);
      // Its name with it: the soul section asks a bot still called "New Bot" for a real one.
      if (typeof reply?.name === "string") this.#bots.named(botId, reply.name);
      if (typeof reply?.section === "string") return reply.section;
    }
    return undefined;
  }

  /** HUI tools act on the gateway; without one they fail at once, never replayed. A bot's chat sends who brought each
   * input of its run (`runOrigins`), as its live chat here saw them, for the gateway's gated tools. */
  async #gatewayTool(key: string, action: string, params: Record<string, unknown>, signal?: AbortSignal, runOrigins?: readonly BotTurnOrigin[]): Promise<unknown> {
    const peer = this.#gateway(key);
    if (!peer) throw new Error("HUI is not connected to this worker right now; its tools are unavailable until it reconnects.");
    // A questionnaire waits for the operator, possibly for hours, and `agents_wait` for its subagents.
    const timeoutMs = action === "ask_user_question" ? QUESTIONNAIRE_WAIT_MS : action === "agents_wait" ? agentsWaitTransportMs(params) : 170_000;
    if (action !== "secret_request") return peer.request("bridge", { key, action, params, ...(runOrigins ? { runOrigins } : {}) }, timeoutMs, signal);
    // The operator answers on the gateway; the file belongs here, where the
    // session's commands run, and only its path goes on to the agent.
    const answer = await peer.request<SecretAnswer>("secret-request", { key, params }, SECRET_REQUEST_TIMEOUT_MS + 60_000, signal);
    return this.#secretFiles.deliver(answer);
  }

  /** Gateway credentials, cached in memory until they expire so runs keep
   * going while it is away; never written here. */
  async #credential(op: string, store: string, providerId: string | undefined, modify?: (current: unknown) => Promise<unknown>): Promise<unknown> {
    const readKey = `read\0${store}\0${providerId ?? ""}`;
    const cacheKey = op === "list" ? `list\0${store}` : readKey;
    const peer = this.#gateway();
    if (peer) {
      const step = modify ? `s${++this.#nextStep}` : undefined;
      if (step) this.#modifiers.set(step, modify!);
      try {
        const result = await peer.request("credential", { op, store, ...(providerId ? { providerId } : {}), ...(step ? { step } : {}) }, 120_000);
        if (op === "read" || op === "modify") {
          if (result) this.#credentials.set(readKey, { value: result, until: expiry(result) });
          else this.#credentials.delete(readKey);
        } else if (op === "list") this.#credentials.set(cacheKey, { value: result, until: Infinity });
        else if (op === "delete") {
          this.#credentials.delete(readKey);
          this.#credentials.delete(`list\0${store}`);
        }
        return result;
      } catch (error) {
        // A gateway that left mid-request is treated as already gone.
        if (!peer.closed) throw error;
      } finally {
        if (step) this.#modifiers.delete(step);
      }
    }
    const cached = op === "read" || op === "list" ? this.#credentials.get(cacheKey) : undefined;
    if (cached && cached.until > Date.now()) return cached.value;
    if (cached) this.#credentials.delete(cacheKey);
    throw new OfflineError("HUI is not connected.");
  }

  async #pruneAttachments(): Promise<void> {
    this.#pruned = Date.now();
    const cutoff = Date.now() - ATTACHMENT_RETENTION_MS;
    for (const entry of await readdir(this.paths.attachmentsDir).catch(() => [] as string[])) {
      const dir = join(this.paths.attachmentsDir, entry);
      const info = await stat(dir).catch(() => undefined);
      if (info && info.mtimeMs < cutoff) await rm(dir, { recursive: true, force: true });
    }
  }

  /** Uploaded prompt attachments, under a random directory like the gateway's. */
  async #putFile(params: Record<string, unknown>): Promise<{ path: string }> {
    const name = typeof params["name"] === "string" ? params["name"] : "";
    if (!name || name.length > 128 || /[\\/\p{Cc}]/u.test(name) || name === "." || name === "..") throw new Error("Invalid attachment name.");
    if (typeof params["data"] !== "string") throw new Error("Attachment data is missing.");
    const dir = join(this.paths.attachmentsDir, randomUUID());
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, name);
    await writeFile(path, Buffer.from(params["data"], "base64"), { mode: 0o600 });
    return { path };
  }

  async #getFile(params: Record<string, unknown>): Promise<{ path: string; data: string }> {
    if (typeof params["path"] !== "string") throw new Error("A remote path is required.");
    const base = typeof params["cwd"] === "string" ? resolveWorkingDirectory(params["cwd"], this.paths.home) : this.paths.home;
    const raw = params["path"];
    const path = await realpath(isAbsolute(raw) || raw.startsWith("~") ? resolveWorkingDirectory(raw, this.paths.home) : resolve(base, raw));
    const info = await stat(path);
    if (!info.isFile()) throw new Error(`Not a file on the remote: ${path}`);
    if (info.size > MAX_FILE_BYTES) throw new Error(`${basename(path)} is larger than 100 MB.`);
    return { path, data: (await readFile(path)).toString("base64") };
  }

  #stop(hosted: Hosted): void {
    if (this.#sessions.get(hosted.key) !== hosted) return;
    this.#sessions.delete(hosted.key);
    hosted.stop();
  }

  #touch(hosted?: Hosted): void {
    this.#lastActivity = Date.now();
    if (hosted) hosted.lastActive = this.#lastActivity;
  }

  #sweep(): void {
    const now = Date.now();
    for (const hosted of this.#sessions.values()) {
      // A Durable run carries on in the store without a hosted view.
      if (hosted.peer || (hosted.runtime.isStreaming && hosted.tool !== "durable")) continue;
      const waiting = (hosted.runtime.pendingQuestions?.().length ?? 0) > 0;
      if (now - hosted.lastActive > (waiting ? DETACHED_QUESTION_MS : DETACHED_IDLE_MS)) this.#stop(hosted);
    }
    if (now - this.#pruned > 24 * 60 * 60_000) void this.#pruneAttachments();
    if (!this.#idle()) return;
    // Durable work nobody watches (a resumed run, a queued follow-up) keeps the host up.
    void this.#durable.busy().then((busy) => {
      // A gateway may have connected meanwhile.
      if (busy || !this.#idle()) this.#touch();
      else void this.close().finally(() => process.exit(0));
    }, () => this.#touch());
  }

  #idle(): boolean {
    return !this.#sessions.size && !this.#peers.size && !this.#starting.size && Date.now() - this.#lastActivity > HOST_IDLE_MS;
  }
}
