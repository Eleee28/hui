import assert from "node:assert/strict";
import { test } from "vitest";
import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { BotCatalog, BotCatalogTool, BotView } from "../api/schema/bots.ts";
import { botToolsKey } from "../lib/bots/tools.ts";
import { BotToolsController, type BotToolsApi } from "./bot-tools-controller.ts";

const tool = (name: string, group: BotCatalogTool["group"], extra: Partial<BotCatalogTool> = {}): BotCatalogTool => ({
  name, label: name, description: `the ${name} tool`, group, source: group === "extension" ? "user · a.js" : "HUI", powerful: false, enabled: true, ...extra,
});

const CATALOG: BotCatalog = {
  tools: [
    tool("read", "files"), tool("bash", "shell", { powerful: true, enabled: false }), tool("sessions_spawn", "hui", { powerful: true }),
    tool("echo", "extension"), tool("weather", "extension", { source: "user · b.js" }), tool("other", "extension"), tool("message_bot", "bots"),
  ],
  skills: [
    { name: "alpha", path: "/s/alpha/SKILL.md", description: "Writes release notes.", source: "/s", enabled: true },
    { name: "beta", path: "/s/beta/SKILL.md", description: "Triage bugs.", source: "HUI defaults", enabled: false },
  ],
  alwaysOn: [{ name: "write_soul", description: "Rewrite its SOUL.md" }],
  disabledTools: ["bash"],
  disabledSkills: [{ name: "beta", path: "/s/beta/SKILL.md" }],
  live: true,
};

class Host implements ReactiveControllerHost {
  updates = 0;
  controllers: ReactiveController[] = [];
  addController(controller: ReactiveController) { this.controllers.push(controller); }
  removeController() {}
  requestUpdate() { this.updates += 1; }
  get updateComplete() { return Promise.resolve(true); }
}

const BOT = { id: "bot-a", name: "Ada", sessionId: "s-a", status: "idle", updatedAt: "2026-10-07T00:00:00.000Z" } as BotView;

test("the controller reads the catalog for one bot, saves one whole list at a time, and answers the request", async () => {
  const calls: string[] = [];
  let catalog: BotCatalog = { ...CATALOG, request: { id: "q-1", sessionId: "s-a", title: "Allow access to bash (powerful)?", message: "Why." } };
  let release: (() => void) | undefined;
  const api: BotToolsApi = {
    load: async (id) => { calls.push(`load ${id}`); return catalog; },
    save: async (id, change) => {
      calls.push(`save ${id} ${JSON.stringify(change)}`);
      await new Promise<void>((resolve) => { release = resolve; });
      catalog = { ...catalog, disabledTools: change.disabledTools ?? catalog.disabledTools };
    },
    answer: async (sessionId, questionId, value) => { calls.push(`answer ${sessionId} ${questionId} ${value}`); catalog = { ...catalog, disabledTools: [] }; delete catalog.request; },
  };
  const host = new Host();
  const tools = new BotToolsController(host, api);
  assert.equal(host.controllers[0], tools);
  assert.equal(tools.props(BOT).state.loading, true, "nothing read yet");
  await tools.refresh(BOT);
  let props = tools.props(BOT);
  assert.equal(props.state.catalog?.request?.id, "q-1");
  props.onToggleTool("read", false);
  props.onToggleTool("sessions_spawn", false);
  assert.equal(tools.state.saving, true);
  assert.deepEqual(calls, ["load bot-a", "save bot-a {\"disabledTools\":[\"bash\",\"read\"]}"], "no second list while the first is on its way");
  tools.follow({ ...BOT, updatedAt: "later" });
  assert.equal(calls.length, 2, "the stream waits for the save too");
  release!();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.slice(2), ["load bot-a"], "the saved lists are read back");
  assert.deepEqual(tools.state.catalog?.disabledTools, ["bash", "read"]);
  props = tools.props(BOT);
  props.onAnswer("Allow");
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.slice(3), ["answer s-a q-1 Allow", "load bot-a"]);
  assert.equal(tools.state.catalog?.request, undefined);
  // The stream: only a change the catalog shows reads it again.
  tools.follow({ ...BOT, updatedAt: "later" });
  const before = calls.length;
  tools.follow({ ...BOT, updatedAt: "later" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, before, "the same key: nothing to read");
  assert.equal(botToolsKey({ status: "waiting", updatedAt: "x" }), "waiting|x");
  // Another bot starts clean; a failed read keeps what was shown.
  tools.reset("bot-b");
  assert.equal(tools.state.catalog, undefined);
  api.load = async () => { throw new Error("gateway down"); };
  await tools.refresh({ ...BOT, id: "bot-b" });
  assert.equal(tools.state.error, "gateway down");
});
