/**
 * Interactive shells the operator opens inside a conversation. Owns the PTY processes, their bounded replay
 * buffers (server/terminals/replay.ts), the byte stream subscribers receive and the per-session and global limits,
 * and lets that conversation's agent use the same terminals through the terminal tool. Terminals live only in this
 * gateway process; closing one kills its whole process tree.
 */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";
import { stripVTControlCharacters } from "node:util";
import { spawn, type IPty } from "@lydell/node-pty";
import type { TerminalSnapshot, TerminalView, TerminalOperationResponse } from "../api/terminals.ts";
import { ReplayBuffer } from "./replay.ts";

export type { TerminalSnapshot, TerminalView } from "../api/terminals.ts";

export const TERMINAL_BUFFER_BYTES = 256 * 1024;
export const TERMINAL_INPUT_BYTES = 16 * 1024;
const PER_SESSION_LIMIT = 8;
const TOTAL_LIMIT = 32;

export class TerminalError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

export function terminalSize(cols: unknown, rows: unknown): { cols: number; rows: number } {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || (cols as number) < 2 || (cols as number) > 500 || (rows as number) < 1 || (rows as number) > 300) {
    throw new TerminalError("Terminal size must be 2–500 columns and 1–300 rows.");
  }
  return { cols: cols as number, rows: rows as number };
}

/** What a subscriber receives. Output is UTF-8 bytes, encoded once per PTY chunk and shared by every subscriber
 * and the replay buffer; never mutate it. `sequence` counts output chunks. */
export type TerminalStreamEvent =
  | { type: "snapshot"; terminal: TerminalView; replay: Buffer; sequence: number; truncated: boolean }
  | { type: "data"; data: Buffer; sequence: number }
  | { type: "state"; terminal: TerminalView };

type Entry = {
  view: TerminalView;
  pty: IPty;
  replay: ReplayBuffer;
  sequence: number;
  listeners: Set<(event: TerminalStreamEvent) => void>;
};

/** PTYs have job-control process groups: killing only the shell's group can
 * leave a foreground job behind. Snapshot descendants before killing the tree. */
function killTree(pty: IPty): void {
  if (process.platform !== "win32") {
    try {
      const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", timeout: 2_000, maxBuffer: 4 * 1024 * 1024 })
        .trim().split("\n").map((row) => row.trim().split(/\s+/u).map(Number));
      const children: number[] = [];
      const visit = (parent: number) => {
        for (const [pid, ppid] of rows) if (ppid === parent && pid && pid !== parent && !children.includes(pid)) { children.push(pid); visit(pid); }
      };
      visit(pty.pid);
      for (const pid of children.reverse()) { try { process.kill(pid, "SIGKILL"); } catch { /* Already exited. */ } }
    } catch { /* The PTY hangup remains available if ps is unavailable. */ }
  }
  try { pty.kill(); } catch { /* Already exited. */ }
}

export class TerminalService {
  private readonly entries = new Map<string, Entry>();
  private readonly spawnPty: typeof spawn;
  constructor(spawnPty: typeof spawn = spawn) { this.spawnPty = spawnPty; }

  get activeCount(): number { return [...this.entries.values()].filter(({ view }) => view.status === "running").length; }

  list(ownerSessionId: string): TerminalView[] {
    return [...this.entries.values()].filter(({ view }) => view.ownerSessionId === ownerSessionId).map(({ view }) => ({ ...view }));
  }

  create(ownerSessionId: string, cwd: string, params: Record<string, unknown> = {}): TerminalView {
    if (this.entries.size >= TOTAL_LIMIT || this.list(ownerSessionId).length >= PER_SESSION_LIMIT) throw new TerminalError("Terminal limit reached. End an unused terminal first.", 409);
    const size = terminalSize(params["cols"] ?? 100, params["rows"] ?? 28);
    const title = params["title"];
    if (title !== undefined && (typeof title !== "string" || !title.trim() || title.length > 80 || /[\p{Cc}]/u.test(title))) throw new TerminalError("Invalid terminal title.");
    const shell = process.platform === "win32" ? process.env["COMSPEC"] || "cmd.exe" : process.env["SHELL"] || userInfo().shell || "/bin/sh";
    const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !key.startsWith("HUI_AGENT_"))) as Record<string, string>;
    const pty = this.spawnPty(shell, process.platform === "win32" ? [] : ["-i"], { cwd, ...size, name: "xterm-256color", env: { ...env, TERM: "xterm-256color", COLORTERM: "truecolor" } });
    const view: TerminalView = { id: randomUUID(), ownerSessionId, title: typeof title === "string" ? title.trim() : `Terminal ${this.list(ownerSessionId).length + 1}`, cwd, ...size, status: "running", createdAt: new Date().toISOString() };
    const entry: Entry = { view, pty, replay: new ReplayBuffer(TERMINAL_BUFFER_BYTES), sequence: 0, listeners: new Set() };
    this.entries.set(view.id, entry);
    pty.onData((data) => {
      // node-pty emits whole code points, so each chunk can be trimmed and replayed on its own.
      const bytes = Buffer.from(data, "utf8");
      if (!bytes.length) return;
      entry.replay.append(bytes);
      this.emit(entry, { type: "data", data: bytes, sequence: ++entry.sequence });
    });
    pty.onExit(({ exitCode }) => {
      entry.view = { ...entry.view, status: "exited", exitCode };
      this.emit(entry, { type: "state", terminal: { ...entry.view } });
    });
    return { ...view };
  }

  private get(owner: string, id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry || entry.view.ownerSessionId !== owner) throw new TerminalError("Terminal not found in this conversation.", 404);
    return entry;
  }

  read(owner: string, id: string): TerminalSnapshot {
    const entry = this.get(owner, id);
    return { terminal: { ...entry.view }, data: entry.replay.text(), sequence: entry.sequence, truncated: entry.replay.truncated };
  }

  input(owner: string, id: string, data: unknown): void {
    const entry = this.get(owner, id);
    if (entry.view.status !== "running") throw new TerminalError("Terminal has exited.", 409);
    if (typeof data !== "string" || !data || Buffer.byteLength(data) > TERMINAL_INPUT_BYTES) throw new TerminalError("Terminal input must contain 1–16384 bytes.");
    entry.pty.write(data);
  }

  resize(owner: string, id: string, cols: unknown, rows: unknown): TerminalView {
    const entry = this.get(owner, id);
    const size = terminalSize(cols, rows);
    if (entry.view.status !== "running") throw new TerminalError("Terminal has exited.", 409);
    if (entry.view.cols !== size.cols || entry.view.rows !== size.rows) {
      entry.pty.resize(size.cols, size.rows);
      entry.view = { ...entry.view, ...size };
      this.emit(entry, { type: "state", terminal: { ...entry.view } });
    }
    return { ...entry.view };
  }

  close(owner: string, id: string): void {
    const entry = this.get(owner, id);
    this.entries.delete(id);
    if (entry.view.status === "running") killTree(entry.pty);
    entry.view = { ...entry.view, status: "exited" };
    this.emit(entry, { type: "state", terminal: { ...entry.view } });
    entry.listeners.clear();
  }

  subscribe(owner: string, id: string, listener: (event: TerminalStreamEvent) => void): () => void {
    const entry = this.get(owner, id);
    entry.listeners.add(listener);
    // No await between subscribing and replay: a reconnect cannot miss output.
    listener({ type: "snapshot", terminal: { ...entry.view }, replay: entry.replay.bytes(), sequence: entry.sequence, truncated: entry.replay.truncated });
    return () => { entry.listeners.delete(listener); };
  }

  private emit(entry: Entry, event: TerminalStreamEvent): void {
    for (const listener of entry.listeners) listener(event);
  }

  closeOwner(owner: string): void { for (const terminal of this.list(owner)) this.close(owner, terminal.id); }
  dispose(): void { for (const { view } of this.entries.values()) this.close(view.ownerSessionId, view.id); }

  /** Same actions/terminal sessionId as OpenClaw. Only operator-created PTYs in
   * the authenticated caller's conversation are visible, not sibling chats. */
  tool(owner: string, params: Record<string, unknown>): TerminalOperationResponse {
    if (params["action"] === "list") return { terminals: this.list(owner) };
    const id = params["sessionId"];
    if (typeof id !== "string" || !id) throw new TerminalError("sessionId must identify a shared terminal returned by list.");
    switch (params["action"]) {
      case "read": {
        const snapshot = this.read(owner, id);
        return { ...snapshot, data: stripVTControlCharacters(snapshot.data), format: "ansi-stripped replay (not a screen grid)" };
      }
      case "input": this.input(owner, id, params["data"]); return { accepted: true, terminal: this.read(owner, id).terminal };
      case "resize": return { terminal: this.resize(owner, id, params["cols"], params["rows"]) };
      case "close": this.close(owner, id); return { closed: true };
      default: throw new TerminalError("Unknown terminal action.");
    }
  }
}

export const terminals = new TerminalService();
