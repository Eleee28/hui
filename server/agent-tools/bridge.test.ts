import assert from "node:assert/strict";
import { afterAll, test } from "vitest";

import {
  agentToolEnvironment,
  registerAgentToolHandler,
  stopAgentToolBridge,
} from "./bridge.ts";
import { invokeHuiBridge } from "../runtimes/bridge-client.mjs";

afterAll(() => stopAgentToolBridge());

test("the agent bridge authenticates a loopback caller and preserves its session identity", async () => {
  registerAgentToolHandler(async (invocation) => ({
    caller: invocation.callerSessionId,
    action: invocation.action,
    value: invocation.params["value"],
  }));
  const environment = await agentToolEnvironment("caller-1");
  const response = await fetch(`${environment["HUI_AGENT_BRIDGE_URL"]}/invoke`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${environment["HUI_AGENT_BRIDGE_TOKEN"]}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      callerSessionId: environment["HUI_AGENT_SESSION_ID"],
      action: "sessions_list",
      params: { value: 42 },
    }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    result: { caller: "caller-1", action: "sessions_list", value: 42 },
  });
});

test("the agent bridge rejects requests without its process-local bearer token", async () => {
  const environment = await agentToolEnvironment("caller-2");
  const response = await fetch(`${environment["HUI_AGENT_BRIDGE_URL"]}/invoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callerSessionId: "caller-2", action: "sessions_list", params: {} }),
  });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "Agent tool authentication failed.",
  });
});

test("a session token cannot impersonate another caller", async () => {
  const caller = await agentToolEnvironment("caller-3");
  const other = await agentToolEnvironment("caller-4");
  const response = await fetch(`${caller["HUI_AGENT_BRIDGE_URL"]}/invoke`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${caller["HUI_AGENT_BRIDGE_TOKEN"]}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      callerSessionId: other["HUI_AGENT_SESSION_ID"],
      action: "sessions_list",
      params: {},
    }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "Agent tool request is missing callerSessionId, action, or params.",
  });
});

test("the PI-side client reaches the handler, and aborting its call aborts the handler's signal", { timeout: 10_000 }, async () => {
  Object.assign(process.env, await agentToolEnvironment("caller-5"));
  registerAgentToolHandler(async (invocation) => ({ caller: invocation.callerSessionId, action: invocation.action }));
  assert.deepEqual(await invokeHuiBridge("sessions_list", {}), { caller: "caller-5", action: "sessions_list" });

  let called!: () => void;
  const started = new Promise<void>((resolve) => { called = resolve; });
  const aborted = new Promise<boolean>((resolve) => {
    registerAgentToolHandler(async (invocation) => {
      called();
      await new Promise((wake) => invocation.signal?.addEventListener("abort", wake, { once: true }));
      resolve(invocation.signal?.aborted === true);
      return {};
    });
  });
  const call = new AbortController();
  const pending = invokeHuiBridge("secret_request", {}, { signal: call.signal });
  await started;
  call.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(await aborted, true);
});
