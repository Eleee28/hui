/**
 * Private loopback bridge used by PI extensions that need HUI-owned state.
 *
 * The browser API intentionally cannot invoke agent coordination tools. Each
 * PI child instead receives a random bearer token and its immutable HUI
 * session id through the environment. The listener binds only to loopback,
 * caps request bodies, and is unref'd so an isolated runtime test can exit.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { BotTurnOrigin } from "../runtimes/turn-origins.ts";

const MAX_BODY_BYTES = 64 * 1024;
const TOKENS = new Map<string, string>();

export type AgentToolInvocation = {
  callerSessionId: string;
  action: string;
  params: Record<string, unknown>;
  /** Aborts when the tool call does: Stop, or a caller that went away. */
  signal?: AbortSignal;
  /** The worker whose connection carried the call (workers.ts); never set from a request body. */
  fromWorker?: string;
  /** From a bot's chat: who brought each input of the run the call is made in, as the Durable host running it saw them
   * (its first message and every one since); absent when that host can't tell. Never set from a request body. */
  runOrigins?: readonly BotTurnOrigin[];
};

type AgentToolHandler = (invocation: AgentToolInvocation) => Promise<unknown>;

let handler: AgentToolHandler | undefined;
let server: Server | undefined;
let bridgeUrl: string | undefined;
let starting: Promise<string> | undefined;

export function registerAgentToolHandler(next: AgentToolHandler): void {
  handler = next;
}

/** In-process runtimes (Durable) call the same handler without the loopback
 * transport. The caller identity comes from the runtime's own session binding,
 * never from tool parameters. */
export async function invokeAgentTool(invocation: AgentToolInvocation): Promise<unknown> {
  const callerSessionId = invocation.callerSessionId.trim();
  const action = invocation.action.trim();
  if (!callerSessionId || !action || !invocation.params || typeof invocation.params !== "object" || Array.isArray(invocation.params)) {
    throw new Error("Agent tool request is missing callerSessionId, action, or params.");
  }
  if (!handler) throw new Error("Agent tools are not ready.");
  return handler({ ...invocation, callerSessionId, action });
}

function sessionForToken(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const received = Buffer.from(value);
  for (const [sessionId, token] of TOKENS) {
    const expected = Buffer.from(token);
    if (expected.byteLength === received.byteLength && timingSafeEqual(expected, received)) {
      return sessionId;
    }
  }
  return undefined;
}

function bodyFrom(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Agent tool request is too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("Agent tool request must be an object.");
        }
        resolve(parsed as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function send(response: import("node:http").ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
}

async function handle(request: IncomingMessage, response: import("node:http").ServerResponse) {
  if (request.method !== "POST" || request.url !== "/invoke") {
    send(response, 404, { ok: false, error: "Unknown agent tool route." });
    return;
  }
  const authorization = request.headers.authorization;
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
  const authenticatedSessionId = sessionForToken(token);
  if (!authenticatedSessionId) {
    send(response, 401, { ok: false, error: "Agent tool authentication failed." });
    return;
  }
  try {
    const body = await bodyFrom(request);
    const callerSessionId =
      typeof body["callerSessionId"] === "string" ? body["callerSessionId"].trim() : "";
    const action = typeof body["action"] === "string" ? body["action"].trim() : "";
    const params = body["params"];
    if (
      !callerSessionId || callerSessionId !== authenticatedSessionId || !action ||
      !params || typeof params !== "object" || Array.isArray(params)
    ) {
      throw new Error("Agent tool request is missing callerSessionId, action, or params.");
    }
    if (!handler) throw new Error("Agent tools are not ready.");
    // A PI child aborts its call by dropping the connection.
    const call = new AbortController();
    response.once("close", () => { if (!response.writableFinished) call.abort(); });
    const result = await handler({
      callerSessionId,
      action,
      params: params as Record<string, unknown>,
      signal: call.signal,
    });
    send(response, 200, { ok: true, result });
  } catch (error) {
    send(response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : "Agent tool request failed.",
    });
  }
}

async function ensureBridge(): Promise<string> {
  if (bridgeUrl) return bridgeUrl;
  if (starting) return starting;
  starting = new Promise<string>((resolve, reject) => {
    const next = createServer((request, response) => {
      void handle(request, response);
    });
    next.once("error", reject);
    next.listen(0, "127.0.0.1", () => {
      const address = next.address();
      if (!address || typeof address === "string") {
        reject(new Error("Agent tool bridge did not receive a loopback port."));
        return;
      }
      server = next;
      bridgeUrl = `http://127.0.0.1:${address.port}`;
      next.unref();
      resolve(bridgeUrl);
    });
  }).finally(() => {
    starting = undefined;
  });
  return starting;
}

export async function agentToolEnvironment(sessionId: string): Promise<Record<string, string>> {
  const url = await ensureBridge();
  let token = TOKENS.get(sessionId);
  if (!token) {
    token = randomBytes(32).toString("base64url");
    TOKENS.set(sessionId, token);
  }
  return {
    HUI_AGENT_BRIDGE_URL: url,
    HUI_AGENT_BRIDGE_TOKEN: token,
    HUI_AGENT_SESSION_ID: sessionId,
  };
}

export function stopAgentToolBridge(): void {
  server?.close();
  server = undefined;
  bridgeUrl = undefined;
  TOKENS.clear();
}
