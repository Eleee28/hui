/** Isolated SDK host. PI owns JSONL, sessions and the agent loop; HUI owns
 * composition and a versioned, bounded inspection channel over Node IPC. */
import { createHash } from "node:crypto";
import { Console } from "node:console";
import { createSessionModelRuntime, PROVIDERS_DIR } from "./hui-models.ts";
import { installBrokeredCredentials, setSecretEnv } from "../worker/credentials.ts";
import { basename } from "node:path";
import {
  createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices,
  runRpcMode, SessionManager, SettingsManager,
  type CreateAgentSessionOptions, type AgentSession, type CompactionEntry, type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { huiToolDefinitions } from "./hui-tools.ts";
import { lowestThinkingLevel, withUpstreamThinkingMap } from "./thinking-level.ts";
import { HUI_DEFAULT_PROMPT, HUI_PROMPT_REVISION, huiPromptExtension } from "./hui-prompt.ts";
import { PI_SDK_VERSION } from "./pi-backend.ts";
import { safeSourceLabel } from "../pi/source-label.ts";
import skillPolicyExtension, { disabledSkillsFrom } from "./skill-policy-extension.mjs";
import { createPolicySettingsManager } from "./resource-policy.ts";
import type { RuntimeInspection } from "./types.ts";

type Launch = {
  cwd: string; agentDir: string; sessionFile?: string; model?: string;
  thinking?: CreateAgentSessionOptions["thinkingLevel"]; noSession?: boolean; safeProbe?: boolean;
  /** Utility calls: the cheapest reasoning level the model is actually sent. */
  lowestThinking?: boolean;
  disabledPluginIds?: string[];
  bundledSkillPaths?: string[];
  /** Settings → Tools → Browser; absent means the default (on). */
  browserTool?: boolean;
};

// Extensions sometimes log during initialization, before runRpcMode redirects
// stdout. Reserve stdout exclusively for the RPC transport from process start.
globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });

/** PI's compaction applies only while its entry is on the active branch, so a
 * rewind behind it drops the summary even inside the window PI kept verbatim.
 * The summary covers only entries before that window: when they all still lead
 * to the new leaf, append it again instead of compacting the same history twice. */
function keepCompaction(session: AgentSession, before: readonly SessionEntry[]): void {
  const after = new Set(session.sessionManager.getBranch().map((entry) => entry.id));
  const index = (id: string | null) => before.findIndex((entry) => entry.id === id);
  const leaf = index(session.sessionManager.getLeafId());
  const kept = before.findLast((entry): entry is CompactionEntry => entry.type === "compaction" && !after.has(entry.id)
    && index(entry.firstKeptEntryId) >= 0 && leaf >= index(entry.firstKeptEntryId) - 1);
  // ponytail: a summary HUI already re-appended has its firstKeptEntryId off its
  // own branch and is not re-applied again; the browser only rewinds to a user
  // message's parent, which never needs that.
  if (leaf < 0 || !kept) return;
  session.sessionManager.appendCompaction(kept.summary, kept.firstKeptEntryId, kept.tokensBefore, kept.details, kept.fromHook);
  session.refreshContext();
}

async function main() {
  // Passed out of argv (see startPi); tools and extensions must not inherit it.
  const launch = JSON.parse(process.env["HUI_PI_WORKER_LAUNCH"] ?? "{}") as Launch;
  delete process.env["HUI_PI_WORKER_LAUNCH"];
  if (!launch.cwd || !launch.agentDir || !process.send) throw new Error("Invalid HUI worker launch.");
  // On a remote worker host, credentials come from the connected gateway.
  if (process.env["HUI_WORKER_BROKER"] === "1") {
    installBrokeredCredentials({ agentDir: launch.agentDir, providersDir: PROVIDERS_DIR, fallbackAuth: process.env["HUI_WORKER_FALLBACK_AUTH"] ?? "" });
    setSecretEnv(JSON.parse(process.env["HUI_WORKER_SECRETS"] ?? "{}"));
    for (const name of ["HUI_WORKER_BROKER", "HUI_WORKER_FALLBACK_AUTH", "HUI_PROVIDERS_DIR", "HUI_WORKER_SECRETS"]) delete process.env[name];
  }
  const disabledSkills = new Set((launch.safeProbe ? [] : disabledSkillsFrom(process.env["HUI_DISABLED_SKILLS"])).map((skill) => skill.path));
  const disabledPluginIds = new Set(launch.safeProbe ? [] : launch.disabledPluginIds ?? []);
  // PI clears turn-time prompt overrides when a run settles. Preserve the last
  // assembled turn prompt explicitly instead of presenting the reset base as it.
  const turnPrompts = new WeakMap<AgentSession, string>();
  const runtime = await createAgentSessionRuntime(async (target) => {
    const settingsManager = launch.safeProbe
      ? SettingsManager.inMemory({})
      : createPolicySettingsManager({ cwd: target.cwd, agentDir: target.agentDir, disabledIds: disabledPluginIds });
    const modelRuntime = await createSessionModelRuntime(target.agentDir);
    const services = await createAgentSessionServices({
      modelRuntime,
      cwd: target.cwd, agentDir: target.agentDir,
      // Even a no-extensions loader resolves configured packages. Probe with
      // empty settings as well, so a catalog read cannot install packages.
      settingsManager,
      resourceLoaderOptions: {
        // PI appends additional paths after user/project/package resources,
        // retaining its own first-name-wins override precedence.
        additionalSkillPaths: launch.safeProbe ? [] : launch.bundledSkillPaths ?? [],
        noExtensions: launch.safeProbe, noSkills: launch.safeProbe,
        noContextFiles: launch.safeProbe, noPromptTemplates: launch.safeProbe, noThemes: true,
        systemPromptOverride: (base) => base ?? HUI_DEFAULT_PROMPT,
        skillsOverride: (base) => ({ ...base, skills: base.skills.filter((skill) => !disabledSkills.has(skill.filePath)) }),
        extensionFactories: launch.safeProbe ? [] : [huiPromptExtension, skillPolicyExtension],
      },
    });
    const separator = launch.model?.indexOf("/") ?? -1;
    const configured = launch.model && separator > 0
      ? services.modelRuntime.getModel(launch.model.slice(0, separator), launch.model.slice(separator + 1))
      : undefined;
    if (launch.model && !configured) throw new Error(`Unknown PI model: ${launch.model}`);
    const model = configured && launch.lowestThinking
      ? withUpstreamThinkingMap(configured, (provider, id) => services.modelRuntime.getModel(provider, id))
      : configured;
    const thinking = model && launch.lowestThinking ? lowestThinkingLevel(model) : launch.thinking;
    const result = await createAgentSessionFromServices({
      services, sessionManager: target.sessionManager, sessionStartEvent: target.sessionStartEvent,
      ...(model ? { model } : {}), ...(thinking ? { thinkingLevel: thinking } : {}),
      customTools: launch.safeProbe ? [] : huiToolDefinitions({ browser: launch.browserTool !== false }),
    });
    result.session.subscribe((event) => {
      if (event.type === "turn_start" || event.type === "turn_end") turnPrompts.set(result.session, result.session.systemPrompt);
    });
    return { ...result, services, diagnostics: services.diagnostics };
  }, {
    cwd: launch.cwd, agentDir: launch.agentDir,
    sessionManager: launch.noSession ? SessionManager.inMemory(launch.cwd)
      : launch.sessionFile ? SessionManager.open(launch.sessionFile)
      : SessionManager.create(launch.cwd),
  });

  process.on("message", (raw: unknown) => {
    void handleWorkerMessage(raw);
  });

  async function handleWorkerMessage(raw: unknown) {
    if (!raw || typeof raw !== "object") return;
    const message = raw as Record<string, unknown>;
    if (typeof message["id"] !== "string") return;
    // Credential brokering has its own listener (worker/credentials.ts).
    if (typeof message["type"] === "string" && message["type"].startsWith("credential")) return;
    try {
      if (message["version"] !== 1) throw new Error("Unsupported HUI worker request.");
      const session = runtime.session;
      if (message["type"] === "abort") {
        await session.abort();
        process.send?.({ version: 1, id: message["id"], type: "ok" });
        return;
      }
      if (message["type"] === "reload") {
        // PI's RPC mode has no /reload; this is the SDK call the TUI makes.
        if (session.isStreaming || session.isCompacting) throw new Error("Wait for the current run to finish before reloading.");
        await session.reload();
        process.send?.({ version: 1, id: message["id"], type: "ok" });
        return;
      }
      if (message["type"] === "rewind") {
        if (session.isStreaming || session.isCompacting) throw new Error("Wait for the current run to finish before rewinding.");
        const before = session.sessionManager.getBranch();
        // PI persists a prompt as soon as it accepts it, so the user messages
        // on its own branch end where the browser's do; HUI never hides them.
        const fromEnd = message["userFromEnd"];
        const entryId = typeof fromEnd === "number"
          ? before.filter((entry) => entry.type === "message" && entry.message.role === "user").at(-1 - fromEnd)?.id
          : message["entryId"];
        const entry = typeof entryId === "string" ? session.sessionManager.getEntry(entryId) : undefined;
        if (typeof entryId !== "string" || !entry) {
          throw new Error("That rewind point is no longer available.");
        }
        if (entry.type === "message" && entry.message.role === "user" && message["excludeUserMessage"] !== true) {
          // PI's /tree editor semantics stop before a selected user message.
          // HUI's checkpoint means "after this visible message", so first let
          // PI restore extension/tool state at its parent, then include the
          // already-persisted user entry as the leaf used by Continue.
          if (entry.parentId) await session.navigateTree(entry.parentId);
          session.sessionManager.branch(entryId);
          session.refreshContext();
        } else {
          // PI's native tree editor stops before a selected user entry. This
          // leaves that message out of the active context so HUI can restore
          // its text to the composer for editing, matching OpenClaw rewind.
          await session.navigateTree(entryId);
        }
        keepCompaction(session, before);
        process.send?.({ version: 1, id: message["id"], type: "ok" });
        return;
      }
      if (message["type"] === "continue") {
        if (session.isStreaming || session.isCompacting) throw new Error("That session is already running.");
        // Judge the context the model would continue from, not the raw leaf: PI
        // appends context edits (hiding each attempt it retries), model or
        // thinking changes (on reopen) and compactions after the failed message.
        // Its system messages (prompt and tool loadout changes persisted in
        // front of the request that used them) stay in the context but are not a turn.
        const projection = session.sessionManager.buildSessionProjection();
        const conversation = projection.messages.filter((item) => item.role !== "system");
        const last = conversation.at(-1);
        const failed = last?.role === "assistant" ? last : undefined;
        if (failed && failed.stopReason !== "aborted" && failed.stopReason !== "error") {
          throw new Error("The active branch already ends with a completed assistant response.");
        }
        // Agent.continue() resumes from any other tail: a user message, a tool
        // result or a compaction summary left by a rewind inside its kept window.
        const resumeFrom = conversation.at(failed ? -2 : -1);
        if (!resumeFrom || resumeFrom.role === "assistant") {
          throw new Error("Rewind to a user message or completed tool result before continuing.");
        }
        if (failed) {
          // Hide it as PI hides an attempt it retries. Branching to its parent
          // would also drop everything PI appended after it, such as a compaction.
          const entry = projection.entries.findLast((item) => item.messages.includes(failed));
          if (entry) session.sessionManager.appendContextEdit(entry.sourceEntry.id, null);
          session.refreshContext();
        }
        // Agent.continue() is the SDK's prompt-free continuation primitive. The
        // AgentSession subscriber still persists and emits its ordinary events;
        // HUI acknowledges only after the run has synchronously entered.
        const continuation = session.agent.continue();
        process.send?.({ version: 1, id: message["id"], type: "ok" });
        void continuation.catch((error: unknown) => {
          console.error(error instanceof Error ? error.message : String(error));
        });
        return;
      }
      if (message["type"] !== "inspect") throw new Error("Unsupported HUI worker request.");
      const active = new Set(session.getActiveToolNames());
      const huiNames = new Set(huiToolDefinitions().map((tool) => tool.name));
      const loader = runtime.services.resourceLoader;
      const tools = session.getAllTools().map((tool) => ({
        name: tool.name, description: tool.description,
        source: huiNames.has(tool.name) && tool.sourceInfo.source === "sdk" ? "HUI"
          : tool.sourceInfo.source === "builtin" ? "PI"
          : `${tool.sourceInfo.scope} · ${safeSourceLabel(tool.sourceInfo.source)} · ${safeSourceLabel(tool.sourceInfo.path)}`,
        active: active.has(tool.name), parameters: tool.parameters,
      }));
      const diagnostics = [
        ...runtime.diagnostics.map((item) => item.message),
        ...loader.getExtensions().errors.map((item) => `${basename(item.path)}: ${item.error}`),
        ...(runtime.services.modelRuntime.getError() ? [runtime.services.modelRuntime.getError()!] : []),
        ...(runtime.modelFallbackMessage ? [runtime.modelFallbackMessage] : []),
      ];
      const data = {
        status: "live" as const, backend: "sdk", version: PI_SDK_VERSION, tools,
        prompt: session.isStreaming ? session.systemPrompt : turnPrompts.get(session) ?? session.systemPrompt,
        promptPhase: session.isStreaming ? "current-turn" as const
          : turnPrompts.has(session) ? "last-turn" as const : "initialized" as const,
        promptSource: loader.getSystemPromptSource() ? "SYSTEM.md override" : HUI_PROMPT_REVISION,
        diagnostics,
      };
      const serialized = JSON.stringify(data);
      if (Buffer.byteLength(serialized) > 2_000_000) throw new Error("Runtime inspection exceeds the 2 MB limit.");
      const result: RuntimeInspection = { ...data, revision: createHash("sha256").update(serialized).digest("hex").slice(0, 16) };
      process.send?.({ version: 1, id: message["id"], type: "inspection", data: result });
    } catch (error) {
      process.send?.({ version: 1, id: message["id"], type: "error", error: error instanceof Error ? error.message : "Inspection failed." });
    }
  }
  process.on("disconnect", () => { void runtime.dispose().finally(() => process.exit(0)); });
  await runRpcMode(runtime);
}

void main().catch((error: unknown) => {
  process.send?.({ version: 1, type: "fatal", error: error instanceof Error ? error.message : "SDK startup failed." });
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
  process.disconnect?.();
});
