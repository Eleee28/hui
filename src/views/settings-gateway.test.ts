import assert from "node:assert/strict";
import { test } from "vitest";
import type { PowerStatus } from "../api/schema/power.ts";
import { lidAwakeNoticeShown } from "./power-notice.ts";
import { renderConnectionPage, type SettingsProps } from "./settings.ts";

function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).join("");
  if (value && typeof value === "object" && "strings" in value && "values" in value) {
    const template = value as { strings: readonly string[]; values: unknown[] };
    return template.strings.map((part, i) => part + text(template.values[i])).join("");
  }
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

const health: SettingsProps["health"] = {
  status: "online", transport: "HTTP + SSE", access: "Full Access", uptimeSeconds: 183840,
  sessions: { registered: 12, running: 2, starting: 0, idle: 10, waiting: 0, error: 0, reconnecting: 0, disconnected: 0, processes: 2 },
};
const render = (overrides: Partial<SettingsProps>) => text(renderConnectionPage({
  healthError: "", ...overrides,
} as SettingsProps));

test("gateway health renders independently of PI configuration", () => {
  const result = render({ health });
  assert.match(result, /gateway-status--ok/);
  assert.match(result, /Connected/);
  assert.match(result, /2d 3h 4m/);
  assert.match(result, /2 active/);
});

test("failed health never presents cached data as connected or live", () => {
  const result = render({ health, healthError: "Network unavailable" });
  assert.match(result, /gateway-status--danger/);
  assert.match(result, /Disconnected/);
  assert.match(result, /Last known values/);
  assert.match(result, /Retry connection/);
  assert.doesNotMatch(result, /gateway-status--ok|>Connected|Live process state/);
});

test("initial loading, initial failure and idle are distinct", () => {
  assert.match(render({}), /Connecting…/);
  const failed = render({ healthError: "Network unavailable" });
  assert.match(failed, /Disconnected/);
  assert.doesNotMatch(failed, /Uptime/);
  assert.match(render({ health: { ...health, sessions: { ...health.sessions, running: 0 } } }), /Idle/);
});

const settings = { power: { keepAwake: true } } as SettingsProps["settings"];
const power: PowerStatus = {
  keepAwake: { state: "active", detail: "" },
  lidAwake: { state: "error", detail: "Administrator approval was cancelled." },
  lidOn: false,
};

test("macOS power shows each choice beside what the gateway holds", () => {
  const result = render({ health, power, settings });
  assert.match(result, /Keep Mac awake/);
  assert.match(result, /settings-status--ok[^>]*>.*Active/s);
  assert.match(result, /settings-status--danger[^>]*>.*Failed/s);
  assert.match(result, /Administrator approval was cancelled\./);
  assert.match(result, /Requires administrator permission/);
  // Not on macOS, or not known yet: no Power section.
  assert.doesNotMatch(render({ health, power: null, settings }), /Keep Mac awake/);
  assert.doesNotMatch(render({ health, power: undefined, settings }), /Keep Mac awake/);
});

test("the top notice shows only while the Mac is actually held awake with the lid closed", () => {
  const lid = (state: PowerStatus["lidAwake"]["state"], lidOn: boolean) => ({ ...power, lidAwake: { state, detail: "" }, lidOn });
  assert.equal(lidAwakeNoticeShown(lid("active", true)), true);
  assert.equal(lidAwakeNoticeShown(lid("pending", true)), false);
  assert.equal(lidAwakeNoticeShown(lid("active", false)), false);
  assert.equal(lidAwakeNoticeShown(null), false);
});
