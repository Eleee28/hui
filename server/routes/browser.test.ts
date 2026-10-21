import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { resolveBrowserExecutable } from "../browser/executable.ts";
import { BrowserError, BrowserPreview, BrowserStatus, BrowserViewConnection } from "../api/browser.ts";
import { expectSchema } from "../test-support/api-schema.ts";

const detected = await resolveBrowserExecutable("");

test("browser routes are guarded and the agent bridge drives conversation-scoped tabs", { timeout: 90_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hui-browser-routes-"));
  process.env["XDG_CONFIG_HOME"] = dir;
  await mkdir(join(dir, "hui"));
  const now = new Date().toISOString();
  await writeFile(join(dir, "hui", "sessions.json"), JSON.stringify({ version: 1, sessions: [
    { id: "alpha", title: "Alpha", tool: "pi", cwd: dir, createdAt: now, updatedAt: now },
    { id: "beta", title: "Beta", tool: "pi", cwd: dir, createdAt: now, updatedAt: now },
  ], groups: [] }));
  const { middleware } = await import("../hui.ts");
  const { stopBackend } = await import("../backend.ts");
  const { agentToolEnvironment } = await import("../agent-tools/bridge.ts");
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404).end(); }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const pages = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>Route page</title><h1>Route page</h1>");
  }).listen(0, "127.0.0.1");
  await once(pages, "listening");
  const address = server.address();
  const pagesAddress = pages.address();
  assert.ok(address && typeof address !== "string" && pagesAddress && typeof pagesAddress !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  t.onTestFinished(async () => {
    await stopBackend();
    server.closeAllConnections();
    pages.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  const api = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(origin + path, { ...init, headers: { "x-hui": "1", "content-type": "application/json", ...init.headers } });
    const body = await response.json() as Record<string, any>;
    if (path.includes("/browser")) {
      expectSchema(response.status >= 400 ? BrowserError : path.endsWith("/connect") ? BrowserViewConnection : path.endsWith("/preview") ? BrowserPreview : BrowserStatus, body as unknown);
    }
    return { status: response.status, body };
  };
  const tool = async (session: string, params: Record<string, unknown>) => {
    const env = await agentToolEnvironment(session);
    const response = await fetch(`${env["HUI_AGENT_BRIDGE_URL"]}/invoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${env["HUI_AGENT_BRIDGE_TOKEN"]}`, "content-type": "application/json" },
      body: JSON.stringify({ callerSessionId: session, action: "browser", params }),
    });
    return { status: response.status, body: await response.json() as { ok: boolean; result?: { text: string; details: Record<string, any> }; error?: string } };
  };
  const saveBrowser = (browser: Record<string, unknown>) => api("/__hui/settings", { method: "PUT", body: JSON.stringify({ browser }) });

  assert.equal((await fetch(`${origin}/__hui/browser`)).status, 403);
  const initial = await api("/__hui/browser");
  assert.equal(initial.status, 200);
  assert.equal(initial.body["enabled"], true);
  assert.equal(initial.body["headless"], true);
  assert.equal(initial.body["state"], "stopped");
  assert.equal(initial.body["profileDir"], join(dir, "hui", "browser", "profile"));
  assert.deepEqual(initial.body["tabs"], []);
  assert.equal((await api("/__hui/browser", { method: "PUT", body: "{}" })).status, 405);
  const invalid = await api("/__hui/browser", { method: "POST", body: JSON.stringify({ action: "explode" }) });
  assert.equal(invalid.status, 400);
  assert.match(invalid.body["error"], /start or stop/u);
  assert.equal((await api("/__hui/browser/tabs/t1/preview")).status, 404);
  assert.equal((await fetch(`${origin}/__hui/sessions/alpha/browser/connect`, { method: "POST" })).status, 403);
  assert.equal((await api("/__hui/sessions/alpha/browser/connect")).status, 405);
  assert.equal((await api("/__hui/sessions/ghost/browser/connect", { method: "POST", body: "{}" })).status, 404);
  const viewTicket = await api("/__hui/sessions/alpha/browser/connect", { method: "POST", body: "{}" });
  assert.equal(viewTicket.status, 200);
  assert.match(viewTicket.body["url"], /^\/__hui\/browser-stream\?ticket=[\w-]{43}$/u);

  const status = await tool("alpha", { action: "status" });
  assert.equal(status.status, 200);
  assert.match(status.body.result?.text ?? "", /stopped; open starts it headless/u);
  const ghost = await tool("ghost", { action: "status" });
  assert.equal(ghost.status, 400);
  assert.match(ghost.body.error ?? "", /Conversation no longer exists/u);

  await saveBrowser({ enabled: false });
  assert.equal((await api("/__hui/browser")).body["enabled"], false);
  assert.match((await tool("alpha", { action: "status" })).body.error ?? "", /turned off in HUI Settings → Tools → Browser/u);
  assert.equal((await api("/__hui/browser", { method: "POST", body: JSON.stringify({ action: "start" }) })).status, 409);
  await saveBrowser({ enabled: true });

  if (!detected.executable) {
    console.log("No Chromium-family browser is installed; skipped the live tab checks.");
    return;
  }
  const opened = await tool("alpha", { action: "open", url: `http://127.0.0.1:${pagesAddress.port}/` });
  assert.equal(opened.status, 200, opened.body.error ?? "open failed");
  assert.match(opened.body.result?.text ?? "", /^Opened tab t1\.\nTab t1 · Route page/u);
  assert.deepEqual(opened.body.result?.details["tab"], { id: "t1", title: "Route page", url: `http://127.0.0.1:${pagesAddress.port}/` });
  const running = await api("/__hui/browser");
  assert.equal(running.body["state"], "running");
  assert.equal(running.body["mode"], "headless");
  assert.deepEqual(running.body["tabs"], [{ id: "t1", ownerSessionId: "alpha", ownerTitle: "Alpha", title: "Route page", url: `http://127.0.0.1:${pagesAddress.port}/` }]);
  const preview = await api("/__hui/browser/tabs/t1/preview");
  assert.equal(preview.status, 200);
  assert.match(preview.body["image"], /^data:image\/jpeg;base64,\/9j\//u);
  assert.match((await tool("beta", { action: "tabs" })).body.result?.text ?? "", /No tabs are open/u);

  // Deleting a conversation closes its tabs, and the last tab takes the process with it.
  assert.equal((await api("/__hui/sessions/alpha", { method: "DELETE" })).status, 200);
  assert.deepEqual((await api("/__hui/browser")).body["tabs"], []);
  const deadline = Date.now() + 10_000;
  while ((await api("/__hui/browser")).body["state"] !== "stopped") {
    assert.ok(Date.now() < deadline, "the browser stops once no tab is left");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // A Settings start runs without tabs; a new mode stops it.
  const start = () => api("/__hui/browser", { method: "POST", body: JSON.stringify({ action: "start" }) });
  assert.equal((await start()).body["state"], "running");
  await saveBrowser({ enabled: true, headless: false });
  assert.equal((await api("/__hui/browser")).body["state"], "stopped");
  await saveBrowser({ enabled: true, headless: true });
  const started = await start();
  assert.equal(started.status, 200, String(started.body["error"]));
  assert.equal(started.body["state"], "running");
  const stopped = await api("/__hui/browser", { method: "POST", body: JSON.stringify({ action: "stop" }) });
  assert.equal(stopped.body["state"], "stopped");
});
