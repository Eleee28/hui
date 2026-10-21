import assert from "node:assert/strict";
import { test } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { waitFor } from "../test-support/wait-for.ts";
import { expectSchema } from "../test-support/api-schema.ts";
import { SessionError, SessionList, SessionOk, SessionResponse } from "../api/sessions.ts";

test("a failed worktree launch stays listed with its prompt until dismissed", { timeout: 20_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hui-worktree-routes-"));
  const notRepository = await mkdtemp(join(tmpdir(), "hui-not-a-repo-"));
  process.env["XDG_CONFIG_HOME"] = dir;
  const { middleware } = await import("../hui.ts");
  const { stopBackend } = await import("../backend.ts");
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404).end(); }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  t.onTestFinished(async () => {
    await stopBackend();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
    await rm(notRepository, { recursive: true, force: true });
  });

  type View = { id: string; title: string; status: string; creating?: unknown; creationError?: string; initialPrompt?: string };
  const route = async (path: string, method = "GET", payload?: unknown) => {
    const response = await fetch(origin + path, {
      method,
      headers: { "x-hui": "1", "content-type": "application/json" },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
    });
    return { status: response.status, body: await response.json() as { session?: View; groups?: { sessions: View[] }[]; error?: string } };
  };
  const listed = async () => {
    const { body } = await route("/__hui/sessions");
    expectSchema(SessionList, body);
    return body.groups.flatMap(({ sessions }) => sessions);
  };

  const started = await route("/__hui/sessions", "POST", {
    cwd: notRepository, title: "Doomed", initialPrompt: "keep this prompt", worktree: true,
  });
  assert.equal(started.status, 200);
  expectSchema(SessionResponse, started.body);
  const id = started.body.session?.id ?? "";
  assert.equal(started.body.session?.status, "starting");
  assert.ok(started.body.session?.creating);

  const failed = await waitFor("the worktree session to fail", async () => (await listed()).find((session) => session.id === id && session.status === "error"), {
    state: listed,
  });
  assert.equal(failed.creating, undefined);
  assert.match(failed.creationError ?? "", /requires a Git repository/);
  assert.equal(failed.initialPrompt, "keep this prompt");
  const opened = await route(`/__hui/sessions/${id}/open`, "POST", {});
  assert.equal(opened.status, 409);
  assert.match(opened.body.error ?? "", /Git/);
  expectSchema(SessionError, opened.body);

  const dismissed = await route(`/__hui/sessions/${id}`, "DELETE");
  assert.equal(dismissed.status, 200);
  expectSchema(SessionOk, dismissed.body);
  assert.deepEqual(await listed(), []);
});
