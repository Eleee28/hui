import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import * as schemas from "../api/vscode.ts";
import { expectSchema } from "../test-support/api-schema.ts";

const FAKE = fileURLToPath(new URL("../test-support/fake-vscode-server.mjs", import.meta.url));

test("VS Code routes: x-hui still guards every other route, the cookie opens only the proxy", { timeout: 90_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hui-vscode-routes-"));
  process.env["XDG_CONFIG_HOME"] = dir;
  // An empty PATH and home, so only a VS Code installed system-wide could be found.
  process.env["PATH"] = join(dir, "no-bin");
  process.env["HOME"] = dir;
  process.env["USER"] = "hui-test-nobody";
  await mkdir(join(dir, "hui"));
  await mkdir(join(dir, "repo"));
  const executable = join(dir, "openvscode-server");
  await writeFile(executable, `#!/bin/sh\n"${process.execPath}" "${FAKE}" "$@"\n`);
  await chmod(executable, 0o755);
  const now = new Date().toISOString();
  await writeFile(join(dir, "hui", "sessions.json"), JSON.stringify({ version: 1, sessions: [
    { id: "alpha", title: "Alpha", tool: "pi", cwd: join(dir, "repo"), createdAt: now, updatedAt: now },
    { id: "remote", title: "Remote", tool: "pi", cwd: "/srv/remote", worker: "w1", createdAt: now, updatedAt: now },
    { id: "gone", title: "Gone", tool: "pi", cwd: join(dir, "deleted"), createdAt: now, updatedAt: now },
  ], groups: [] }));
  const { middleware, attachLiveStreams } = await import("../hui.ts");
  const { stopBackend } = await import("../backend.ts");
  const server = createServer((request, response) => middleware(request, response, () => { response.writeHead(404).end(); }));
  const detach = attachLiveStreams(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  t.onTestFinished(async () => {
    detach();
    await stopBackend();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  const api = async (path: string, init: RequestInit = {}): Promise<{ status: number; body: Record<string, any> }> => {
    const response = await fetch(origin + path, { ...init, headers: { "x-hui": "1", "content-type": "application/json", ...init.headers } });
    const body = await response.json() as Record<string, any>;
    if (path === "/__hui/vscode-server" || path.endsWith("/vscode/connect")) {
      expectSchema(response.status >= 400 ? schemas.VscodeFailure : path.endsWith("/vscode/connect") ? schemas.VscodeConnectResponse : schemas.VscodeStatus, body);
    }
    return { status: response.status, body };
  };
  const connect = (id: string) => api(`/__hui/sessions/${id}/vscode/connect`, { method: "POST", body: JSON.stringify({ theme: { background: "#ffffff", panel: "#f4f4f4", elevated: "#eeeeee", text: "#222222", border: "javascript:alert(1)" } }) });

  // Nothing is set up: the status says what this machine offers, an open asks for a choice, and nothing starts.
  assert.equal((await fetch(`${origin}/__hui/vscode-server`)).status, 403);
  const fresh = await api("/__hui/vscode-server");
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body["enabled"], false);
  assert.deepEqual(fresh.body["license"], { accepted: false, acceptedAt: "" });
  assert.equal(fresh.body["install"]["dir"], join(dir, "hui", "vscode-server"), "HUI's own install lives beside its VS Code data");
  // A machine with a VS Code server installed system-wide opens straight away; everywhere else an open asks first.
  if (!fresh.body["active"]) {
    assert.equal(fresh.body["state"], "setup");
    assert.equal(fresh.body["setup"]["needed"], true);
    const refused = await connect("alpha");
    assert.equal(refused.status, 409);
    assert.equal(refused.body["code"], "setup");
    assert.equal((await api("/__hui/vscode-server")).body["instance"], 0, "nothing started");
  }

  // The license acceptance lands in HUI's settings, and revoking clears it.
  const accepted = await api("/__hui/vscode-server", { method: "POST", body: JSON.stringify({ action: "accept-license" }) });
  assert.equal(accepted.body["license"]["accepted"], true);
  assert.ok(!Number.isNaN(Date.parse((await api("/__hui/settings")).body["vscode"]["licenseAcceptedAt"])));
  const revoked = await api("/__hui/vscode-server", { method: "POST", body: JSON.stringify({ action: "revoke-license" }) });
  assert.deepEqual(revoked.body["license"], { accepted: false, acceptedAt: "" });
  assert.equal((await api("/__hui/settings")).body["vscode"]["licenseAcceptedAt"], "");

  // A settings file from the opt-in era keeps working: enabled and a path.
  const saved = await api("/__hui/settings", { method: "PUT", body: JSON.stringify({ vscode: { enabled: true, executable } }) });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body["vscode"], { enabled: true, executable, provider: "auto", licenseAcceptedAt: "" });
  const configured = await api("/__hui/vscode-server");
  assert.equal(configured.body["state"], "stopped");
  assert.equal(configured.body["active"]["kind"], "configured");

  assert.equal((await fetch(`${origin}/__hui/sessions/alpha/vscode/connect`, { method: "POST", body: "{}" })).status, 403, "minting a ticket needs x-hui");
  assert.equal((await api("/__hui/sessions/alpha/vscode/connect")).status, 405);
  assert.equal((await connect("ghost")).status, 404);
  const remote = await connect("remote");
  assert.equal(remote.status, 409);
  assert.equal(remote.body["code"], "remote");
  const gone = await connect("gone");
  assert.equal(gone.status, 409);
  assert.equal(gone.body["code"], "folder");
  assert.equal(gone.body["error"], `The conversation's folder no longer exists: ${join(dir, "deleted")}`);

  const opened = await connect("alpha");
  assert.equal(opened.status, 200);
  assert.match(opened.body["url"], /^\/__hui\/vscode\/enter\?ticket=[\w-]{43}$/u);
  assert.equal(opened.body["folder"], join(dir, "repo"));
  const entered = await fetch(origin + opened.body["url"], { redirect: "manual" });
  assert.equal(entered.status, 303);
  const cookie = (entered.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  assert.match(cookie, /^hui-vscode=/u);
  const page = await fetch(origin + (entered.headers.get("location") ?? ""), { headers: { cookie, accept: "text/html" } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, new RegExp(`fake workbench for ${join(dir, "repo").replaceAll("/", "\\/")}`, "u"));
  assert.match(html, /Default Light Modern/u, "the frame's colors reach VS Code");
  assert.doesNotMatch(html, /javascript:alert/u, "a color that is not #rrggbb is dropped");

  // The cookie is no API credential: every guarded route still wants x-hui.
  for (const [method, path] of [["GET", "/__hui/settings"], ["GET", "/__hui/sessions"], ["GET", "/__hui/vscode-server"], ["POST", "/__hui/sessions/alpha/vscode/connect"], ["GET", "/__hui/browser"]] as const) {
    const response = await fetch(origin + path, { method, headers: { cookie }, ...(method === "POST" ? { body: "{}" } : {}) });
    assert.equal(response.status, 403, `${method} ${path} with only the VS Code cookie`);
  }

  // The WebSocket goes through the same wiring as the gateway's.
  const ws = await new Promise<{ first?: string; status?: number; socket?: WebSocket }>((resolve, reject) => {
    const socket = new WebSocket(`${origin.replace("http:", "ws:")}/__hui/vscode/?reconnectionToken=r`, { headers: { origin, cookie } });
    socket.once("message", (data) => resolve({ first: String(data), socket }));
    socket.once("unexpected-response", (_request, response: IncomingMessage) => { response.resume(); resolve({ status: response.statusCode ?? 0 }); });
    socket.once("error", reject);
  });
  assert.match(ws.first ?? "", /"type":"hello"/u);
  ws.socket?.close();

  // Stopped from Settings, frames get a notice; the view's Retry (a new open) starts it again.
  const stopped = await api("/__hui/vscode-server", { method: "POST", body: JSON.stringify({ action: "stop" }) });
  assert.equal(stopped.body["state"], "stopped");
  assert.equal((await api("/__hui/vscode-server", { method: "POST", body: JSON.stringify({ action: "explode" }) })).status, 400);
  assert.equal((await api("/__hui/vscode-server", { method: "POST", body: JSON.stringify({ action: "cancel-install" }) })).status, 200, "nothing to cancel is no error");
  assert.equal((await fetch(`${origin}/__hui/vscode/echo`, { headers: { cookie } })).status, 503);
  assert.equal((await connect("alpha")).status, 200);
  const restarted = await fetch(`${origin}/__hui/vscode/echo`, { headers: { cookie } });
  assert.equal(restarted.status, 200);
  assert.equal((await api("/__hui/vscode-server")).body["instance"], 2);

  // A path that no longer runs stops the server: frames get a notice and the view asks for setup again.
  await api("/__hui/settings", { method: "PUT", body: JSON.stringify({ vscode: { executable: join(dir, "missing") } }) });
  const after = await fetch(`${origin}/__hui/vscode/echo`, { headers: { cookie } });
  assert.equal(after.status, 503);
  const broken = await api("/__hui/vscode-server");
  assert.equal(broken.body["state"], "setup");
  assert.equal(broken.body["activeError"], `No executable was found at ${join(dir, "missing")}.`);
  assert.equal((await connect("alpha")).body["code"], "setup");
});
