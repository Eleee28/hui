/**
 * The gateway process itself: the public HTTP server with its Host allowlist, static app and terminal and
 * live-stream upgrades, and a token-guarded loopback control server that `hui` uses for status and stop. It
 * publishes the gateway state file once listening, removes it on stop, and refuses an unforced stop while
 * sessions, terminals or mutations a restart would interrupt are in flight. Routing the `/__hui/` API belongs
 * to hui.ts.
 */
import { execFile } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { promisify } from "node:util";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { atomicJson, GATEWAY_DIR, removeState, STATE_FILE, type GatewayState } from "../cli/state.ts";
import { packageVersion } from "../cli/installation.ts";
import { allowedHostsFromConfig, tailnetFromStatus } from "./host.ts";
import { liveSessions } from "./sessions/live-sessions.ts";
import { attachLiveStreams, middleware } from "./hui.ts";
import { startBackend, stopBackend } from "./backend.ts";
import { serveStatic } from "./http/static-files.ts";
import { configureUpdates } from "./updates.ts";
import { terminals } from "./terminals/terminals.ts";
import { attachTerminalTransport } from "./terminals/transport.ts";

export type GatewayOptions = { packageRoot: string; installationRoot?: string; host: string; port: number; allowedHosts: string[] };
function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") { reject(new Error("Gateway has no TCP address.")); return; }
      resolve(address.port);
    });
  });
}
function close(server: Server): Promise<void> {
  return new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
}

async function tailnetName(): Promise<string | undefined> {
  try { return tailnetFromStatus((await promisify(execFile)("tailscale", ["status", "--json"], { timeout: 5_000 })).stdout)?.allowedHosts?.[0]; }
  catch { return undefined; }
}

export async function runGateway(options: GatewayOptions): Promise<{ state: GatewayState; closed: Promise<void>; stop(): Promise<void> }> {
  const version = await packageVersion(options.packageRoot);
  configureUpdates({ installationRoot: options.installationRoot ?? options.packageRoot, packageRoot: options.packageRoot });
  const token = randomBytes(32).toString("hex");
  const instance = randomUUID();
  let closing = false;
  let ready = false;
  let inFlightMutations = 0;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  // Configured names stay out of `state.allowedHosts`, so removing one from the
  // file takes effect on the next start instead of being carried forward.
  const configured = await allowedHostsFromConfig(join(GATEWAY_DIR, "config.json"), tailnetName);
  const allowed = new Set(["localhost", "127.0.0.1", "[::1]", options.host.toLowerCase(), ...[...options.allowedHosts, ...configured].map((host) => host.toLowerCase())]);
  const server = createServer((request, response) => {
    let hostname: string;
    try { hostname = new URL(`http://${request.headers.host}`).hostname.toLowerCase(); }
    catch { response.writeHead(400).end(); return; }
    if (!allowed.has(hostname)) { response.writeHead(403).end("Host is not allowed."); return; }
    if (!ready || closing) { response.writeHead(503).end("Gateway is starting or stopping."); return; }
    if (request.url?.startsWith("/__hui/") && request.method !== "GET" && request.method !== "HEAD") {
      inFlightMutations++;
      let finished = false;
      const done = () => { if (!finished) { finished = true; inFlightMutations--; } };
      response.once("finish", done); response.once("close", done);
    }
    middleware(request, response, () => {
      void serveStatic(join(options.packageRoot, "dist"), request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end("Static asset could not be served.");
      });
    });
  });
  let state: GatewayState;
  const detachTerminals = attachTerminalTransport(server, allowed);
  const detachStreams = attachLiveStreams(server, allowed);
  const control = createServer((request, response) => {
    const auth = Buffer.from(request.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) { response.writeHead(403).end(); return; }
    response.setHeader("Content-Type", "application/json");
    if (request.method === "GET" && request.url === "/status") {
      response.end(JSON.stringify({ instance, pid: process.pid, version, activeSessions: liveSessions.activeWorkCount, resumableSessions: liveSessions.resumableWorkCount, activeTerminals: terminals.activeCount, url: state.url }));
    } else if (request.method === "POST" && ["/stop", "/stop?force=1"].includes(request.url ?? "")) {
      if (closing) { response.writeHead(409).end(JSON.stringify({ error: "Gateway is already stopping." })); return; }
      closing = true;
      // Sessions whose runtime resumes its own runs (Pi Durable) continue after
      // the restart, so only work this process alone holds refuses a stop.
      if (request.url !== "/stop?force=1" && (liveSessions.blockingWorkCount > 0 || terminals.activeCount > 0 || inFlightMutations > 0)) {
        closing = false;
        response.writeHead(409).end(JSON.stringify({ error: "The gateway has active sessions, terminals or mutations a restart would interrupt. Wait, or use --force to interrupt them explicitly." }));
        return;
      }
      response.once("finish", () => { void stop(); });
      response.end(JSON.stringify({ ok: true, instance }));
    } else { response.writeHead(404).end(); }
  });
  let stopping: Promise<void> | undefined;
  function stop(): Promise<void> {
    stopping ??= (async () => {
      closing = true;
      detachTerminals();
      detachStreams();
      await stopBackend();
      await Promise.all([close(server), close(control)]);
      await removeState(instance);
      process.off("SIGTERM", onSignal); process.off("SIGINT", onSignal);
      resolveClosed();
    })();
    return stopping;
  }
  const onSignal = () => { void stop(); };
  try {
    await mkdir(GATEWAY_DIR, { recursive: true, mode: 0o700 });
    const port = await listen(server, options.host, options.port);
    const controlPort = await listen(control, "127.0.0.1", 0);
    await startBackend();
    const urlHost = options.host.includes(":") ? `[${options.host}]` : options.host;
    state = {
      format: 1, pid: process.pid, instance, token, version,
      url: `http://${urlHost}:${port}/`, controlUrl: `http://127.0.0.1:${controlPort}/`,
      host: options.host, allowedHosts: options.allowedHosts, port, packageRoot: options.packageRoot,
      startedAt: new Date().toISOString(),
    };
    await atomicJson(STATE_FILE, state);
    ready = true;
    process.on("SIGTERM", onSignal); process.on("SIGINT", onSignal);
    return { state, closed, stop };
  } catch (error) {
    detachTerminals();
    detachStreams();
    await stopBackend(); await Promise.all([close(server), close(control)]); throw error;
  }
}
