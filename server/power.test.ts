import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "vitest";
import { setTimeout as delay } from "node:timers/promises";

import { MacPower } from "./power.ts";

const OSASCRIPT = {
  // Runs the root script as this user, so the real watcher drives the fake pmset.
  approve: `eval "root=\\\${$#}"; exec /bin/sh -c "$root"`,
  cancel: `echo "execution error: User canceled. (-128)" >&2; exit 1`,
  // Waits for the test to "answer" the prompt, then approves it.
  gate: `while [ ! -e "$(dirname "$0")/go" ]; do sleep 0.05; done; echo ran >> "$(dirname "$0")/ran"; eval "root=\\\${$#}"; exec /bin/sh -c "$root"`,
};

/** Fake macOS commands; the fake pmset keeps `SleepDisabled` in a file. */
async function fixture(t: TestContext, { osascript = "approve" as keyof typeof OSASCRIPT, sleepDisabled = "0", pid = process.pid } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "hui-power-"));
  const script = async (name: string, body: string) => {
    await writeFile(join(dir, name), `#!/bin/sh\n${body}\n`);
    await chmod(join(dir, name), 0o755);
    return join(dir, name);
  };
  await writeFile(join(dir, "sleep-disabled"), sleepDisabled);
  const options = {
    caffeinate: await script("caffeinate", `echo "$$ $*" > "${dir}/caffeinate.log"; exec sleep 30`),
    osascript: await script("osascript", `echo $$ >> "${dir}/prompts"; ${OSASCRIPT[osascript]}`),
    pmset: await script("pmset", `if [ "$1" = -g ]; then echo " SleepDisabled		$(cat "${dir}/sleep-disabled")"; else echo "$3" > "${dir}/sleep-disabled"; fi`),
    flagDir: join(dir, "flags"),
    pid,
  };
  const instances: MacPower[] = [];
  const make = (gatewayPid = pid) => { const power = new MacPower({ ...options, pid: gatewayPid }); instances.push(power); return power; };
  t.onTestFinished(async () => { for (const power of instances) power.dispose(); await rm(dir, { recursive: true, force: true }); });
  const read = (name: string) => readFile(join(dir, name), "utf8").then((text) => text.trim(), () => "");
  const prompts = async () => (await read("prompts")).split("\n").filter(Boolean);
  const answer = () => writeFile(join(dir, "go"), "");
  /** Written before the last boot and named with a PID that is live again now. */
  const leaveRebootFlag = async () => {
    const name = `lid-awake-${process.ppid}-left-by-reboot`;
    await mkdir(options.flagDir, { recursive: true });
    await writeFile(join(options.flagDir, name), "");
    await utimes(join(options.flagDir, name), 0, 0);
    return name;
  };
  return { power: make(), make, read, prompts, answer, leaveRebootFlag, flagDir: options.flagDir };
}

async function eventually(check: () => Promise<boolean> | boolean, timeoutMs = 10_000): Promise<void> {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await delay(50)) {
    if (await check()) return;
  }
  assert.fail("condition was not reached");
}


const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("keep awake holds caffeinate -i on the gateway pid until turned off, and reports an unexpected exit", async (t) => {
  const { power, read } = await fixture(t);
  power.setKeepAwake(true);
  await eventually(() => power.status().keepAwake.state === "active");
  await eventually(async () => Boolean(await read("caffeinate.log")));
  const [pid, ...args] = (await read("caffeinate.log")).split(" ");
  assert.deepEqual(args, ["-i", "-w", String(process.pid)]);

  power.setKeepAwake(false);
  assert.deepEqual(power.status().keepAwake, { state: "off", detail: "" });
  await eventually(() => !alive(Number(pid)));

  power.setKeepAwake(true);
  await eventually(async () => (await read("caffeinate.log")).split(" ")[0] !== pid);
  process.kill(Number((await read("caffeinate.log")).split(" ")[0]), "SIGKILL");
  await eventually(() => power.status().keepAwake.state === "error");
  assert.match(power.status().keepAwake.detail, /SIGKILL/);
});

test("lid awake takes one approval and restores sleep when turned off", async (t) => {
  const { power, read, prompts } = await fixture(t);
  await power.setLidAwake(true);
  assert.deepEqual(power.status().lidAwake, { state: "active", detail: "" });
  assert.equal(power.status().lidOn, true);
  assert.equal(await read("sleep-disabled"), "1");

  await power.setLidAwake(true);
  assert.equal((await prompts()).length, 1);

  await power.setLidAwake(false);
  assert.deepEqual(power.status().lidAwake, { state: "off", detail: "" });
  assert.equal(power.status().lidOn, false);
  assert.equal(await read("sleep-disabled"), "0");
});

test("lid sleep is restored when the gateway stops or its process dies", async (t) => {
  const stopped = await fixture(t);
  await stopped.power.setLidAwake(true);
  stopped.power.dispose();
  await eventually(async () => (await stopped.read("sleep-disabled")) === "0");

  const gateway = spawn("sleep", ["30"]);
  const crashed = await fixture(t, { pid: gateway.pid });
  await crashed.power.setLidAwake(true);
  assert.equal(await crashed.read("sleep-disabled"), "1");
  gateway.kill("SIGKILL");
  await eventually(async () => (await crashed.read("sleep-disabled")) === "0");
});

test("a restarted gateway begins with lid awake off, without prompting, once the previous watcher restored sleep", async (t) => {
  const { power, make, read, prompts } = await fixture(t);
  await power.setLidAwake(true);
  power.dispose();
  const restarted = make();
  await restarted.start(false);
  assert.deepEqual(restarted.status(), {
    keepAwake: { state: "off", detail: "" },
    lidAwake: { state: "off", detail: "" },
    lidOn: false,
  });
  assert.equal((await prompts()).length, 1);
  assert.equal(await read("sleep-disabled"), "0");
});

test("a reboot's leftover shows as on without prompting, and turning it off asks to restore sleep", async (t) => {
  const { power, read, prompts, leaveRebootFlag } = await fixture(t, { sleepDisabled: "1" });
  await leaveRebootFlag();
  await power.start(false);
  assert.equal(power.status().lidOn, true);
  assert.equal(power.status().lidAwake.state, "active");
  assert.match(power.status().lidAwake.detail, /before this Mac restarted/);
  assert.equal((await prompts()).length, 0);

  await power.setLidAwake(false);
  assert.deepEqual(power.status().lidAwake, { state: "off", detail: "" });
  assert.equal(power.status().lidOn, false);
  assert.equal((await prompts()).length, 1);
  assert.equal(await read("sleep-disabled"), "0");
});

test("a declined restore keeps the leftover on, including after a restart", async (t) => {
  const { power, make, prompts, leaveRebootFlag } = await fixture(t, { osascript: "cancel", sleepDisabled: "1" });
  await leaveRebootFlag();
  await power.start(false);
  await power.setLidAwake(false);
  assert.equal(power.status().lidOn, true);
  assert.match(power.status().lidAwake.detail, /before this Mac restarted.*cancelled/);
  power.dispose();
  const restarted = make();
  await restarted.start(false);
  assert.equal(restarted.status().lidOn, true);
  assert.equal((await prompts()).length, 1);
});

test("turning lid awake on while a reboot's leftover holds it shows it on without prompting", async (t) => {
  const { power, prompts, leaveRebootFlag, flagDir } = await fixture(t, { sleepDisabled: "1" });
  const leftover = await leaveRebootFlag();
  void power.start(false);
  await eventually(async () => (await readdir(flagDir)).includes(`${leftover}.stop`));
  await power.setLidAwake(true);
  assert.equal(power.status().lidOn, true);
  assert.match(power.status().lidAwake.detail, /before this Mac restarted/);
  assert.equal((await prompts()).length, 0);
});

test("switching lid awake off while it is still settling never prompts", async (t) => {
  const { power, prompts, leaveRebootFlag, flagDir } = await fixture(t);
  const leftover = await leaveRebootFlag();
  void power.setLidAwake(true);
  await eventually(async () => (await readdir(flagDir)).includes(`${leftover}.stop`));
  await power.setLidAwake(false);
  assert.deepEqual(power.status().lidAwake, { state: "off", detail: "" });
  assert.equal((await prompts()).length, 0);
});

test("another live gateway sharing the config dir keeps its lid watcher", async (t) => {
  const gateway = spawn("sleep", ["30"]);
  t.onTestFinished(() => { gateway.kill(); });
  const { make, read } = await fixture(t);
  await make(gateway.pid).setLidAwake(true);
  const other = make();
  await other.start(false);
  assert.deepEqual(other.status().lidAwake, { state: "off", detail: "Still on for this Mac outside HUI." });
  assert.equal(await read("sleep-disabled"), "1");
});

test("stopping the gateway withdraws an open prompt and never prompts for queued changes", async (t) => {
  const { power, read, prompts, answer } = await fixture(t, { osascript: "gate" });
  void power.setLidAwake(true);
  await eventually(async () => (await prompts()).length === 1);
  void power.setLidAwake(false);
  const queued = power.setLidAwake(true);
  power.dispose();
  await answer();
  await queued;
  assert.equal(await read("ran"), "");
  assert.equal((await prompts()).length, 1);
  assert.deepEqual(power.status(), { keepAwake: { state: "off", detail: "" }, lidAwake: { state: "off", detail: "" }, lidOn: false });
});

test("turning lid awake off withdraws an unanswered approval", async (t) => {
  const { power, read, prompts } = await fixture(t, { osascript: "gate" });
  void power.setLidAwake(true);
  await eventually(async () => (await prompts()).length === 1);
  assert.equal(power.status().lidAwake.state, "pending");
  await power.setLidAwake(false);
  assert.deepEqual(power.status().lidAwake, { state: "off", detail: "" });
  await eventually(async () => !alive(Number((await prompts())[0])));
  assert.equal(await read("sleep-disabled"), "0");
});

test("switching lid awake off and on again while its prompt is open asks again", async (t) => {
  const { power, prompts, answer } = await fixture(t, { osascript: "gate" });
  void power.setLidAwake(true);
  await eventually(async () => (await prompts()).length === 1);
  void power.setLidAwake(false);
  const again = power.setLidAwake(true);
  await eventually(async () => (await prompts()).length === 2);
  await answer();
  await again;
  assert.deepEqual(power.status().lidAwake, { state: "active", detail: "" });
});

test("a cancelled approval turns the switch back off and says why", async (t) => {
  const { power, read, prompts } = await fixture(t, { osascript: "cancel" });
  await power.setLidAwake(true);
  assert.deepEqual(power.status().lidAwake, { state: "error", detail: "Administrator approval was cancelled or timed out." });
  assert.equal(power.status().lidOn, false);
  assert.equal(await read("sleep-disabled"), "0");
  await power.setLidAwake(true);
  assert.equal((await prompts()).length, 2);
});

test("a Mac already set outside HUI is left unchanged and still reported", async (t) => {
  const { power, read, prompts } = await fixture(t, { sleepDisabled: "1" });
  await power.setLidAwake(true);
  assert.equal(power.status().lidAwake.state, "active");
  assert.match(power.status().lidAwake.detail, /outside HUI/);
  await power.setLidAwake(false);
  assert.deepEqual(power.status().lidAwake, { state: "off", detail: "Still on for this Mac outside HUI." });
  assert.equal((await prompts()).length, 0);
  assert.equal(await read("sleep-disabled"), "1");
});
