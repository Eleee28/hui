import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";
import { UPDATE_CHECK_INTERVAL_MS, type UpdateCheck } from "../cli/releases.ts";
import { expectSchema } from "./test-support/api-schema.ts";
import { UpdateSnapshot } from "./api/updates.ts";

// HUI's directory resolves at import time and hui.ts reads it as it loads: never the operator's own.
const home = await mkdtemp(join(tmpdir(), "hui-updates-home-"));
process.env["HOME"] = home;
process.env["XDG_CONFIG_HOME"] = join(home, "config");
process.env["PI_CODING_AGENT_DIR"] = join(home, "agent");
afterAll(() => rm(home, { recursive: true, force: true }));
const { createUpdates, UpdateConflict } = await import("./updates.ts");
const { middleware } = await import("./hui.ts");

test("development mode reports source ownership and cannot start an updater", async () => {
  const service = createUpdates();
  assert.equal((await service.status()).job, null);
  const result = await service.check();
  expectSchema(UpdateSnapshot, result);
  assert.equal(result.check?.canInstall, false);
  assert.match(result.check!.message, /development server/u);
  await assert.rejects(service.start("0.2.0"), UpdateConflict);
});

test("update routes keep the local-client guard, narrow arguments and method contract", async (t) => {
  const server = createServer((req, res) => middleware(req, res, () => res.writeHead(404).end()));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.onTestFinished(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/__hui/update`;
  assert.equal((await fetch(url)).status, 403);
  assert.equal((await fetch(url, { method: "OPTIONS", headers: { "x-hui": "1" } })).status, 403);
  assert.equal((await fetch(url, { method: "DELETE", headers: { "x-hui": "1" } })).status, 405);
  assert.equal((await fetch(`${url}/check`)).status, 403);
  const background = await fetch(`${url}/check`, { headers: { "x-hui": "1" } });
  assert.equal(background.status, 200);
  assert.equal((await background.json()).check.canInstall, false);
  const post = (body: unknown) => fetch(url, { method: "POST", headers: { "x-hui": "1", "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await fetch(url, { method: "POST", headers: { "x-hui": "1" }, body: "{" })).status, 400);
  for (const body of [null, {}, { version: "latest" }, { version: "1.0.0", force: true }, { version: "1.0.0", from: "https://evil.example" }]) assert.equal((await post(body)).status, 400);
  assert.equal((await post({ version: "1.0.0" })).status, 409);
});

test("background checks share a gateway cache; explicit checks bypass freshness and requests coalesce", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hui-update-cache-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  for (const [file, value] of Object.entries({ "package.json": JSON.stringify({ name: "hui", version: "0.1.1" }),
    "build/release.json": JSON.stringify({ format: 1, version: "0.1.1" }), "dist/index.html": "",
    "build/cli/main.js": "", "build/cli/gateway-run.js": "", "build/server/runtimes/pi-sdk-worker.js": "" })) {
    const path = join(root, file);
    await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, value);
  }
  let time = 1000;
  let calls = 0;
  let result: UpdateCheck = { currentVersion: "0.1.1", latest: null, status: "unavailable", canInstall: false, message: "No access" };
  const service = createUpdates({ installationRoot: root, packageRoot: root }, {
    now: () => time,
    checkRelease: async () => { calls++; return result; },
  });
  assert.equal((await service.check(true)).check?.status, "unavailable");
  time += UPDATE_CHECK_INTERVAL_MS - 1;
  await service.check(true);
  assert.equal(calls, 1, "unavailable results are also cached");
  time++;
  await service.check(true);
  assert.equal(calls, 2);
  result = { ...result, status: "available", canInstall: true,
    latest: { version: "0.1.2", tag: "v0.1.2", url: "https://github.com/DaniFdz/hui/releases/tag/v0.1.2" } };
  await service.check();
  assert.equal(calls, 3, "manual checks bypass cache");
  assert.equal((await service.check(true)).check?.status, "available");
  assert.equal(calls, 3, "manual result refreshes the shared cache");

  let resolve!: (value: UpdateCheck) => void;
  const coalesced = createUpdates({ installationRoot: root, packageRoot: root }, {
    checkRelease: () => { calls++; return new Promise((done) => { resolve = done; }); },
  });
  const first = coalesced.check();
  const second = coalesced.check();
  assert.equal(calls, 4);
  resolve(result);
  assert.equal((await first).check?.status, "available");
  assert.deepEqual(await first, await second);
});
