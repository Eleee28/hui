import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test, type TestContext } from "vitest";
import type { WorkerView } from "../server/worker/workers.ts";
import { formatWorkers, workersCommand } from "./workers.ts";

/** A stand-in gateway: the workers routes over an in-memory list, recording each request. */
async function fakeGateway(t: TestContext) {
  const workers: WorkerView[] = [];
  const calls: string[] = [];
  let next = 0;
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = text ? JSON.parse(text) as Record<string, unknown> : undefined;
    calls.push(`${request.method} ${request.url}${body ? ` ${text}` : ""}`);
    const reply = (status: number, value: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    if (request.headers["x-hui"] !== "1") return reply(403, { error: "missing x-hui" });
    if (request.headers.host?.startsWith("localhost")) { response.writeHead(403, { "content-type": "text/plain" }); response.end("Host is not allowed."); return; }
    const [, id, action] = request.url!.match(/^\/__hui\/workers(?:\/([^/]+)(?:\/(\w+))?)?$/u) ?? [];
    const index = workers.findIndex((worker) => worker.id === id);
    if (!id && request.method === "GET") return reply(200, { workers });
    if (!id && request.method === "POST") {
      if (!body?.["command"]) return reply(400, { error: "Connect command is required, for example: ssh devbox" });
      const worker = { id: `00000000-0000-0000-0000-00000000000${++next}`, name: String(body["name"]), command: String(body["command"]), extraPaths: body["extraPaths"] as string[], state: "disconnected" as const };
      workers.push(worker);
      return reply(201, { worker });
    }
    if (index < 0) return reply(404, { error: "No such worker." });
    if (action === "connect") return reply(202, { ok: true });
    if (request.method === "PATCH") { workers[index] = { ...workers[index]!, ...body }; return reply(200, { worker: workers[index] }); }
    if (request.method === "DELETE") { workers.splice(index, 1); return reply(200, { ok: true }); }
    reply(405, { error: "method not allowed" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.onTestFinished(() => new Promise((resolve) => server.close(() => resolve())));
  const address = server.address() as { port: number };
  return { base: `http://127.0.0.1:${address.port}/`, workers, calls };
}

test("workers are added and connected, edited only where asked, and removed by name", async (t) => {
  const gateway = await fakeGateway(t);
  const added = await workersCommand(gateway.base, "add", undefined, { name: "box", command: "ssh -o BatchMode=yes box", "extra-path": ["~/.pi/agent/mcp.json"] }) as WorkerView;
  assert.equal(added.state, "connecting");
  assert.deepEqual(gateway.calls, [
    `POST /__hui/workers ${JSON.stringify({ name: "box", command: "ssh -o BatchMode=yes box", extraPaths: ["~/.pi/agent/mcp.json"] })}`,
    `POST /__hui/workers/${added.id}/connect`,
  ]);

  await workersCommand(gateway.base, "edit", "box", { command: "ssh box" });
  assert.deepEqual(gateway.workers.map(({ name, command, extraPaths }) => ({ name, command, extraPaths })), [{ name: "box", command: "ssh box", extraPaths: ["~/.pi/agent/mcp.json"] }], "fields not given are kept");
  assert.equal(gateway.calls.at(-1), `PATCH /__hui/workers/${added.id} ${JSON.stringify({ command: "ssh box" })}`, "only the given field is sent");
  await workersCommand(gateway.base, "edit", added.id, { name: "renamed", "extra-path": ["~/notes"] });
  assert.deepEqual(gateway.workers.map(({ name, extraPaths }) => ({ name, extraPaths })), [{ name: "renamed", extraPaths: ["~/notes"] }], "an id names the worker too");

  assert.match(formatWorkers(await workersCommand(gateway.base, "list", undefined, {}) as WorkerView[]), /^renamed {2}disconnected {2}ssh box {2}0{8}-/u);
  assert.deepEqual(await workersCommand(gateway.base, "remove", "renamed", {}), { removed: "renamed", id: added.id });
  assert.deepEqual(gateway.workers, []);
  assert.match(formatWorkers([]), /No workers/u);
});

test("an unknown or shared name and a refused request are reported, changing nothing", async (t) => {
  const gateway = await fakeGateway(t);
  await assert.rejects(workersCommand(gateway.base, "remove", "ghost", {}), /No worker named ghost/u);
  await assert.rejects(workersCommand(gateway.base, "add", undefined, { name: "box", command: "" }), /Connect command is required/u);
  for (let i = 0; i < 2; i++) await workersCommand(gateway.base, "add", undefined, { name: "twin", command: "ssh twin" });
  await assert.rejects(workersCommand(gateway.base, "remove", "twin", {}), /2 workers are named twin\. Use an id/u);
  await assert.rejects(workersCommand(gateway.base.replace("127.0.0.1", "localhost"), "list", undefined, {}), /^Error: Host is not allowed\.$/u, "a plain-text refusal reads as itself");
  assert.equal(gateway.workers.length, 2);
});
