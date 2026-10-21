/**
 * The gateway's end of the SDK worker's private IPC channel: inspection, abort, rewind, continue and reload
 * requests, each matched to its reply by ID. A turn's prompts and events travel over PI's RPC stream, not here.
 */
import type { ChildProcess } from "node:child_process";
import type { RuntimeInspection } from "./types.ts";
import type { RuntimeRewindTarget } from "./types.ts";

function validInspection(value: unknown): value is RuntimeInspection {
  if (!value || typeof value !== "object") return false;
  const data = value as RuntimeInspection;
  return data.status === "live" && data.backend === "sdk" && typeof data.version === "string"
    && typeof data.revision === "string" && typeof data.prompt === "string" && typeof data.promptSource === "string"
    && ["initialized", "current-turn", "last-turn"].includes(data.promptPhase)
    && Array.isArray(data.diagnostics) && data.diagnostics.every((item) => typeof item === "string")
    && Array.isArray(data.tools) && data.tools.every((tool) => tool && typeof tool.name === "string"
      && typeof tool.description === "string" && typeof tool.source === "string" && typeof tool.active === "boolean"
      && typeof tool.parameters === "object" && tool.parameters !== null)
    && Buffer.byteLength(JSON.stringify(data)) <= 2_010_000;
}

type Request = "abort" | "rewind" | "continue" | "reload";

/** Every request has a deadline and is released on process exit/disposal. */
export class SdkInspector {
  #child: ChildProcess;
  #next = 0;
  #pending = new Map<string, { type: "inspect" | Request; resolve(value: unknown): void; reject(error: Error): void }>();
  #closed = false;

  constructor(child: ChildProcess, onFatal: (message: string) => void) {
    this.#child = child;
    child.on("message", (raw: unknown) => {
      if (!raw || typeof raw !== "object") { onFatal("Malformed HUI worker message."); return; }
      const msg = raw as Record<string, unknown>;
      if (msg["version"] !== 1) { onFatal("Unsupported HUI worker protocol version."); return; }
      if (msg["type"] === "fatal") { onFatal(String(msg["error"] ?? "SDK worker failed.")); return; }
      const pending = typeof msg["id"] === "string" ? this.#pending.get(msg["id"]) : undefined;
      if (!pending) return;
      if (pending.type === "inspect" && msg["type"] === "inspection" && validInspection(msg["data"])) pending.resolve(msg["data"]);
      else if (pending.type !== "inspect" && msg["type"] === "ok") pending.resolve(undefined);
      else pending.reject(new Error(msg["type"] === "error" && typeof msg["error"] === "string"
        ? msg["error"] : "Malformed SDK worker response."));
    });
  }

  inspect(timeoutMs = 5_000): Promise<RuntimeInspection> {
    if (this.#closed || !this.#child.connected) return Promise.reject(new Error("SDK worker is unavailable."));
    const id = `inspect-${++this.#next}`;
    return new Promise((resolve, reject) => {
      const complete = (error?: Error, data?: RuntimeInspection) => {
        clearTimeout(timer);
        this.#pending.delete(id);
        if (error) reject(error); else resolve(data!);
      };
      const timer = setTimeout(() => complete(new Error("SDK inspection timed out.")), timeoutMs);
      this.#pending.set(id, { type: "inspect", resolve: (data) => complete(undefined, data as RuntimeInspection), reject: (error) => complete(error) });
      this.#child.send!({ version: 1, type: "inspect", id }, (error: Error | null) => { if (error) complete(error); });
    });
  }

  rewind(target: RuntimeRewindTarget, excludeUserMessage = false, timeoutMs = 5_000): Promise<void> {
    return this.#request("rewind", { ...(typeof target === "string" ? { entryId: target } : target), excludeUserMessage }, timeoutMs);
  }

  abort(timeoutMs = 5_000): Promise<void> {
    return this.#request("abort", {}, timeoutMs);
  }

  continueRun(timeoutMs = 5_000): Promise<void> {
    return this.#request("continue", {}, timeoutMs);
  }

  /** Extensions may do real work on session_start, so allow more than a ping. */
  reload(timeoutMs = 60_000): Promise<void> {
    return this.#request("reload", {}, timeoutMs);
  }

  #request(type: Request, data: Record<string, unknown>, timeoutMs: number): Promise<void> {
    if (this.#closed || !this.#child.connected) return Promise.reject(new Error("SDK worker is unavailable."));
    const id = `${type}-${++this.#next}`;
    return new Promise((resolve, reject) => {
      const complete = (error?: Error) => {
        clearTimeout(timer);
        this.#pending.delete(id);
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => complete(new Error(`SDK ${type} timed out.`)), timeoutMs);
      this.#pending.set(id, { type, resolve: () => complete(), reject: (error) => complete(error) });
      this.#child.send!({ version: 1, type, id, ...data }, (error: Error | null) => { if (error) complete(error); });
    });
  }

  close(message: string): void {
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.reject(new Error(message));
    this.#pending.clear();
  }
}
