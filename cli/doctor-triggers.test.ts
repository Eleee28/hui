import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";

// HUI's directory resolves at import time: never the operator's own.
const root = await mkdtemp(join(tmpdir(), "hui-doctor-triggers-"));
const config = join(root, "config", "hui");
process.env["HOME"] = root;
process.env["XDG_CONFIG_HOME"] = join(root, "config");
afterAll(() => rm(root, { recursive: true, force: true }));
const { formatDoctorReport, runDoctor } = await import("./doctor.ts");
const { triggersCheck } = await import("./doctor-triggers.ts");

const TIME = "2026-10-01T10:00:00.000Z";
const LEFT = ["bot-trigger-cursors.json", "bot-trigger-slack.json", "slack.json"];
const doctor = (fix = false) => runDoctor({ fix, checks: [triggersCheck], gatewayStatus: async () => ({ status: "stopped" }), lock: (operation) => operation() });
const trigger = (id: string, source: string, extra: Record<string, unknown> = {}) => ({
  id, botId: "bot-1", name: id, source, filter: {}, enabled: true, cooldownSeconds: 0, createdBy: "operator", createdAt: TIME, updatedAt: TIME, ...extra,
});
const run = (id: string, triggerId: string) => ({ id, triggerId, triggerName: triggerId, at: TIME, status: "fired", events: 1, summary: "an event" });

test("nothing to report reads only, and creates no file", async () => {
  assert.deepEqual(await doctor(true), { ok: true, checks: [{ id: "triggers", title: "Triggers", status: "ok", summary: "nothing left of GitHub, Sessions, Webhook or Slack triggers", items: [], notes: [] }] });
  assert.equal(existsSync(config), false);
});

test("triggers of removed kinds and the files they left are reported, then deleted with their runs and nothing else", async () => {
  await mkdir(config, { recursive: true });
  await writeFile(join(config, "bots.json"), JSON.stringify({ version: 1, bots: [{ id: "bot-1", handle: "ada", name: "Ada", cwd: root, sessionId: "session-1", createdAt: TIME, updatedAt: TIME }] }));
  await writeFile(join(config, "bot-triggers.json"), JSON.stringify({
    version: 1,
    triggers: [
      trigger("reviews", "listener", { tokenHash: "a".repeat(64), tokenHint: "abcd" }),
      trigger("ci", "github", { filter: { repos: ["acme/web"], events: ["checks_failed"] } }),
      trigger("pings", "slack", { filter: { events: ["mention"] } }),
      { id: "broken" },
    ],
    runs: [run("r1", "reviews"), run("r2", "ci"), run("r3", "broken")], pending: {}, deliveries: {}, seen: { reviews: ["event-1"] },
  }));
  for (const name of LEFT) await writeFile(join(config, name), "{}");
  const before = await readFile(join(config, "bot-triggers.json"), "utf8");

  const report = await doctor();
  assert.equal(report.ok, false);
  assert.deepEqual(report.checks[0]!.items.map(({ label, status }) => [label, status]), [
    ["\"ci\", GitHub, of @ada", "issue"],
    ["\"pings\", Slack, of @ada", "issue"],
    ["GitHub triggers' poll positions (bot-trigger-cursors.json)", "issue"],
    ["Slack triggers' poll position (bot-trigger-slack.json)", "issue"],
    ["HUI's Slack connection, with its token (slack.json)", "issue"],
  ]);
  assert.match(formatDoctorReport(report), /^✗ Triggers: 2 triggers and 3 files left by the kinds HUI no longer has$/mu);
  assert.match(report.checks[0]!.notes.join("\n"), /deletes these while the gateway is stopped, keeping no copy[\s\S]*doesn't revoke its token/u);
  assert.equal(await readFile(join(config, "bot-triggers.json"), "utf8"), before, "a report changes nothing");

  const fixed = await doctor(true);
  assert.deepEqual([fixed.ok, fixed.checks[0]!.status, fixed.checks[0]!.summary], [true, "fixed", "deleted 2 triggers and 3 files left by the kinds HUI no longer has"]);
  const stored = JSON.parse(await readFile(join(config, "bot-triggers.json"), "utf8")) as { triggers: { id: string }[]; runs: { id: string }[]; seen: unknown };
  assert.deepEqual(stored.triggers.map(({ id }) => id), ["reviews", "broken"], "the listener's trigger stays, and so does a record HUI can't read for another reason");
  assert.deepEqual(stored.runs.map(({ id }) => id), ["r1", "r3"], "a deleted trigger's runs go with it, and only those");
  assert.deepEqual(stored.seen, { reviews: ["event-1"] });
  for (const name of LEFT) assert.equal(existsSync(join(config, name)), false, `${name} is deleted`);
  assert.equal((await doctor()).checks[0]!.status, "ok");
});

test("only slack.json brings its token's note; a broken bots.json costs only the bots' names; an unreadable bot-triggers.json is reported, never changed, and stops nothing else", async () => {
  // What the test above left: the listener's trigger and a broken record. Now only the Slack poller's position is left.
  await writeFile(join(config, "bot-trigger-slack.json"), "{}");
  const slackOnly = (await doctor()).checks[0]!;
  assert.deepEqual(slackOnly.items.map(({ label }) => label), ["Slack triggers' poll position (bot-trigger-slack.json)"]);
  assert.doesNotMatch(slackOnly.notes.join("\n"), /revoke/u, "no Slack connection, no token to revoke");
  await writeFile(join(config, "bots.json"), "{not json");
  const stored = JSON.parse(await readFile(join(config, "bot-triggers.json"), "utf8")) as { triggers: unknown[] };
  await writeFile(join(config, "bot-triggers.json"), JSON.stringify({ ...stored, triggers: [...stored.triggers, trigger("deploys", "webhook", { tokenHash: "c".repeat(64) })] }));
  assert.equal((await doctor()).checks[0]!.items[0]!.label, "\"deploys\", Webhook", "no bot named, nothing thrown");
  await writeFile(join(config, "bot-triggers.json"), "{not json");
  const unreadable = await doctor(true);
  const [check] = unreadable.checks;
  assert.deepEqual(check!.items.map(({ label, status }) => [label, status]), [["Slack triggers' poll position (bot-trigger-slack.json)", "fixed"], ["bot-triggers.json", "blocked"]]);
  assert.match(check!.items[1]!.detail ?? "", /is not valid JSON\. Fix or move it; HUI will not overwrite it\./u);
  assert.deepEqual([unreadable.ok, check!.status, check!.summary], [false, "issue", "deleted 1 file left by the kinds HUI no longer has; bot-triggers.json can't be read"]);
  assert.equal(await readFile(join(config, "bot-triggers.json"), "utf8"), "{not json", "left as it was");
  assert.equal(existsSync(join(config, "bot-trigger-slack.json")), false);
});
