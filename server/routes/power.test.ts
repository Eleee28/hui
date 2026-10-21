import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectTypeOf, test } from "vitest";
import { PowerError, PowerResponse, type PowerState, type PowerStatus } from "../api/power.ts";
import { expectSchema } from "../test-support/api-schema.ts";

type OriginalPowerState = { state: "off" | "pending" | "active" | "error"; detail: string };
type OriginalPowerStatus = { keepAwake: OriginalPowerState; lidAwake: OriginalPowerState; lidOn: boolean };

expectTypeOf<PowerState>().toEqualTypeOf<OriginalPowerState>();
expectTypeOf<PowerStatus>().toEqualTypeOf<OriginalPowerStatus>();

test("the power route reports the platform and rejects a malformed lid switch", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hui-power-routes-"));
  process.env["XDG_CONFIG_HOME"] = dir;
  const { middleware } = await import("../hui.ts");
  const { stopBackend } = await import("../backend.ts");
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404).end(); }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/__hui/power`;
  t.onTestFinished(async () => {
    await stopBackend();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  const headers = { "x-hui": "1", "content-type": "application/json" };

  const status = await fetch(url, { headers });
  assert.equal(status.status, 200);
  const payload: unknown = await status.json();
  expectSchema(PowerResponse, payload);
  const { power } = payload;
  if (process.platform === "darwin") assert.equal(power?.lidOn, false);
  else assert.equal(power, null);

  for (const body of ["{}", '{"lidAwake":"yes"}', "[]", "null"]) {
    const response = await fetch(url, { method: "PUT", headers, body });
    assert.equal(response.status, 400, body);
    expectSchema(PowerError, await response.json());
  }
  const response = await fetch(url, { method: "DELETE", headers });
  assert.equal(response.status, 405);
  expectSchema(PowerError, await response.json());
});
