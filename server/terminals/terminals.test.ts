import assert from "node:assert/strict";
import { test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IPty, spawn } from "@lydell/node-pty";
import { TerminalService, TERMINAL_BUFFER_BYTES, terminalSize, type TerminalStreamEvent } from "./terminals.ts";

function fixture() {
  const written: string[] = [];
  const sizes: number[][] = [];
  let data!: (value: string) => void;
  let exit!: (value: { exitCode: number }) => void;
  const pty = { pid: -1, write: (value: string) => written.push(value), resize: (cols: number, rows: number) => sizes.push([cols, rows]), kill: () => exit({ exitCode: 0 }), onData: (fn: typeof data) => { data = fn; }, onExit: (fn: typeof exit) => { exit = fn; } } as unknown as IPty;
  const service = new TerminalService((() => pty) as typeof spawn);
  return { service, written, sizes, data: (value: string) => data(value), exit: (exitCode: number) => exit({ exitCode }) };
}

test("shared terminals scope IDs to the owner and preserve exact input", () => {
  const f = fixture();
  const terminal = f.service.create("alpha", "/tmp");
  assert.deepEqual(f.service.list("beta"), []);
  for (const action of ["read", "input", "resize", "close"]) assert.throws(() => f.service.tool("beta", { action, sessionId: terminal.id, data: "no", cols: 80, rows: 24 }), /not found/);
  f.service.tool("alpha", { action: "input", sessionId: terminal.id, data: "echo shared\r\u0003" });
  assert.deepEqual(f.written, ["echo shared\r\u0003"]);
  assert.throws(() => f.service.input("alpha", terminal.id, "é".repeat(8193)), /16384/);
  assert.throws(() => f.service.input("alpha", terminal.id, ""), /input/);
  assert.throws(() => f.service.tool("alpha", { action: "create" }), /sessionId/);
  f.service.dispose();
});

test("reconnect replays atomically, detach keeps PTY, bounded UTF-8 output is explicit", () => {
  const f = fixture();
  const terminal = f.service.create("alpha", "/tmp");
  const events: TerminalStreamEvent[] = [];
  const off = f.service.subscribe("alpha", terminal.id, (event) => events.push(event));
  assert.equal(events[0]?.type, "snapshot");
  f.data("first");
  off();
  f.data(" while detached");
  assert.equal(f.service.activeCount, 1);
  assert.equal(events.length, 2);
  const replay: TerminalStreamEvent[] = [];
  f.service.subscribe("alpha", terminal.id, (event) => replay.push(event));
  assert.equal(replay[0]?.type === "snapshot" && replay[0].replay.toString(), "first while detached");
  assert.equal(f.service.read("alpha", terminal.id).data, "first while detached", "HTTP and tool reads see the same replay as text");
  f.data("é");
  const live = replay.at(-1);
  assert.ok(live?.type === "data" && Buffer.isBuffer(live.data), "subscribers receive output as UTF-8 bytes");
  assert.deepEqual(live.type === "data" && [...live.data], [0xc3, 0xa9]);
  assert.equal(live.type === "data" && live.sequence, 3);
  f.data("😀".repeat(TERMINAL_BUFFER_BYTES));
  const snapshot = f.service.read("alpha", terminal.id);
  assert.equal(snapshot.truncated, true);
  assert.ok(Buffer.byteLength(snapshot.data) <= TERMINAL_BUFFER_BYTES);
  assert.ok(!snapshot.data.includes("�"));
  assert.equal(snapshot.sequence, 4);
  f.service.dispose();
});

test("resize, natural exit, explicit end and resource limits have distinct semantics", () => {
  const f = fixture();
  const terminal = f.service.create("alpha", "/tmp");
  f.service.resize("alpha", terminal.id, 120, 40);
  f.service.resize("alpha", terminal.id, 120, 40);
  assert.deepEqual(f.sizes, [[120, 40]]);
  for (const size of [[1, 24], [80, 0], [501, 30], [80, 301], [NaN, 10], [80.5, 24]]) assert.throws(() => terminalSize(size[0], size[1]));
  f.exit(7);
  assert.equal(f.service.read("alpha", terminal.id).terminal.exitCode, 7);
  assert.equal(f.service.activeCount, 0);
  assert.throws(() => f.service.input("alpha", terminal.id, "hi"), /exited/);
  assert.throws(() => f.service.resize("alpha", terminal.id, 80, 24), /exited/);
  f.service.close("alpha", terminal.id);
  assert.throws(() => f.service.read("alpha", terminal.id), /not found/);
  for (let i = 0; i < 8; i++) f.service.create("alpha", "/tmp");
  assert.throws(() => f.service.create("alpha", "/tmp"), /limit/);
  f.service.closeOwner("alpha");
  assert.deepEqual(f.service.list("alpha"), []);
});

test("real PTY supports shell state, Unicode, resize and Ctrl+C without terminating the shell", { timeout: 12_000 }, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "hui-pty-test-"));
  const previousShell = process.env["SHELL"];
  process.env["SHELL"] = "/bin/sh";
  const service = new TerminalService();
  const terminal = service.create("real", cwd);
  if (previousShell === undefined) delete process.env["SHELL"]; else process.env["SHELL"] = previousShell;
  t.onTestFinished(async () => { service.dispose(); await rm(cwd, { recursive: true, force: true }); });
  const waitOutput = (expected: string, from = 0) => new Promise<void>((resolve, reject) => {
    let off: (() => void) | undefined;
    const timeout = setTimeout(() => { off?.(); reject(new Error(`Missing terminal output: ${expected}`)); }, 5000);
    const check = () => {
      if (!service.read("real", terminal.id).data.slice(from).includes(expected)) return;
      clearTimeout(timeout); off?.(); resolve();
    };
    off = service.subscribe("real", terminal.id, check);
    check();
  });
  service.input("real", terminal.id, "shared=retained; printf '%s%s\\n' READY _PTY; pwd\r");
  await waitOutput("READY_PTY");
  await waitOutput(cwd);
  service.resize("real", terminal.id, 123, 37);
  service.input("real", terminal.id, "stty size; printf '%s%s\\n' VALUE_ \"$shared\"; printf '%s%s\\n' UNICODE_ 'é雪'\r");
  await waitOutput("37 123");
  await waitOutput("VALUE_retained");
  await waitOutput("UNICODE_é雪");
  // The child emits readiness after becoming the foreground job. After SIGINT,
  // wait for the shell's new prompt: input sent sooner can be flushed by the
  // terminal driver. Split marker literals so command echo cannot satisfy it.
  service.input("real", terminal.id, "PS1='HUI_''READY> '; sh -c \"printf '%s%s\\n' WAIT _START; exec sleep 60\"\r");
  await waitOutput("WAIT_START");
  const interruptOffset = service.read("real", terminal.id).data.length;
  service.input("real", terminal.id, "\u0003");
  await waitOutput("HUI_READY> ", interruptOffset);
  service.input("real", terminal.id, "printf '%s%s\\n' AFTER _INTERRUPT\r");
  await waitOutput("AFTER_INTERRUPT");
  assert.equal(service.read("real", terminal.id).terminal.status, "running");
});
