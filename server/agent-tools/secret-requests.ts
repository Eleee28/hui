/**
 * Secrets an agent asks the operator for with the `secret_request` tool.
 *
 * The value never enters a transcript, a tool result or a HUI store. The
 * operator types it into a masked question card on the gateway
 * (`SecretRequests`, gateway memory like suggestion cards: a restart drops
 * them). `SecretFiles` then writes it to a private temporary file (0600 in its
 * own 0700 directory) on the machine where the session's commands run, the
 * gateway's or a remote worker's, and the agent only learns that file's path.
 * The file is deleted after `SECRET_FILE_TTL_MS` or when its process stops, and
 * its directory names that process's PID, so the next start can remove what a
 * crashed one left.
 */
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** How long the operator has to answer, OpenClaw's default for its secret requests. */
export const SECRET_REQUEST_TIMEOUT_MS = 15 * 60_000;
/** How long the agent can read a delivered secret. */
export const SECRET_FILE_TTL_MS = 10 * 60_000;

/** A pending request as the session's question list carries it. */
export type SecretQuestion = { id: string; method: "secret"; title: string; message: string };

/** The operator's answer; only `SecretFiles.deliver` may hand it on. */
export type SecretAnswer =
  | { status: "provided"; label: string; value: string }
  | { status: "cancelled" | "expired"; label: string };

/** The tool result: where the secret is, never what it is. */
type SecretDelivery =
  | { status: "provided"; label: string; path: string; expiresAt: string }
  | { status: "cancelled" | "expired"; label: string };

type Pending = { sessionId: string; question: SecretQuestion; settle(answer: SecretAnswer): void };

/** Whether a process exists; one owned by another user does too. */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function field(params: Record<string, unknown>, key: string, maximum: number): string {
  const raw = params[key];
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) throw new Error(`${key} must be non-empty text.`);
  if (value.length > maximum) throw new Error(`${key} must be at most ${maximum} characters.`);
  return value;
}

export class SecretRequests {
  #pending = new Map<string, Pending>();
  #onChange: (sessionId: string) => void;

  constructor(options: { onChange?: (sessionId: string) => void } = {}) {
    this.#onChange = options.onChange ?? (() => {});
  }

  questions(sessionId: string): SecretQuestion[] {
    return [...this.#pending.values()].filter((pending) => pending.sessionId === sessionId).map(({ question }) => question);
  }

  /** The tool call: waits until the operator answers or cancels, `signal`
   * aborts (Stop, or the caller went away) or the request expires. */
  async request(sessionId: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<SecretAnswer> {
    const label = field(params, "label", 120);
    const reason = field(params, "reason", 500);
    if (signal?.aborted) return { status: "cancelled", label };
    const id = randomUUID();
    return new Promise<SecretAnswer>((resolve) => {
      const settle = (answer: SecretAnswer) => {
        if (!this.#pending.delete(id)) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        this.#onChange(sessionId);
        resolve(answer);
      };
      const cancel = () => settle({ status: "cancelled", label });
      const timer = setTimeout(() => settle({ status: "expired", label }), SECRET_REQUEST_TIMEOUT_MS);
      timer.unref();
      signal?.addEventListener("abort", cancel, { once: true });
      this.#pending.set(id, { sessionId, question: { id, method: "secret", title: label, message: reason }, settle });
      this.#onChange(sessionId);
    });
  }

  /** Settles one of the session's pending requests from the question route.
   * False when `id` is none of them, so the route asks the runtime instead. */
  answer(sessionId: string, id: string, answer: Record<string, unknown>): boolean {
    const pending = this.#pending.get(id);
    if (pending?.sessionId !== sessionId) return false;
    const label = pending.question.title;
    if (answer["cancelled"] === true) {
      pending.settle({ status: "cancelled", label });
      return true;
    }
    const value = answer["value"];
    if (typeof value !== "string" || !value) throw new Error("Enter the secret, or cancel the request.");
    pending.settle({ status: "provided", label, value });
    return true;
  }

  /** Gateway stop: pending requests end cancelled. */
  dispose(): void {
    for (const { question, settle } of [...this.#pending.values()]) settle({ status: "cancelled", label: question.title });
  }
}

export class SecretFiles {
  /** Removers for delivered files that still exist. */
  #files = new Set<() => void>();
  #root: string;

  constructor(root = tmpdir()) {
    this.#root = root;
  }

  /** A provided answer becomes a file here; the result names it, never the value. */
  async deliver(answer: SecretAnswer): Promise<SecretDelivery> {
    if (answer.status !== "provided") return { status: answer.status, label: answer.label };
    const dir = await mkdtemp(join(this.#root, `hui-secret-${process.pid}-`));
    const remove = () => {
      clearTimeout(timer);
      this.#files.delete(remove);
      rmSync(dir, { recursive: true, force: true });
    };
    const timer = setTimeout(remove, SECRET_FILE_TTL_MS);
    timer.unref();
    this.#files.add(remove);
    const path = join(dir, "secret");
    try {
      await writeFile(path, answer.value, { mode: 0o600, flag: "wx" });
    } catch {
      remove();
      throw new Error("HUI could not hand the secret to the agent; ask for it again.");
    }
    return { status: "provided", label: answer.label, path, expiresAt: new Date(Date.now() + SECRET_FILE_TTL_MS).toISOString() };
  }

  /** Process start: one that crashed left its files without a timer. */
  async sweep(): Promise<void> {
    for (const name of await readdir(this.#root).catch(() => [])) {
      const pid = Number(/^hui-secret-(\d+)-/u.exec(name)?.[1]);
      if (pid && pid !== process.pid && !running(pid)) await rm(join(this.#root, name), { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Process stop: delivered files go. */
  dispose(): void {
    for (const remove of [...this.#files]) remove();
  }
}
