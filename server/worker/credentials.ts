/**
 * Credential stores for runtimes on a remote worker host. Reads and writes go
 * to the connected gateway: in the host process through its gateway
 * connection (`setCredentialTransport`), in a PI worker it spawned over the
 * IPC channel the host relays (`relayCredentials`). An OAuth refresh runs on
 * the remote while the gateway holds its own file lock, so a rotated token is
 * written exactly once, on the gateway. Without a gateway the remote's own PI
 * login is used.
 */
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileCredentialStore, setCredentialStoreFactory, type CredentialStore } from "../pi/provider-accounts.ts";

type Credential = Awaited<ReturnType<CredentialStore["read"]>>;
type Modifier = (current: Credential) => Promise<Credential>;

export class OfflineError extends Error {}

/** Carries one credential operation to a gateway; rejects with OfflineError without one. */
export type CredentialTransport = (op: string, store: string, providerId: string | undefined, modify?: Modifier) => Promise<unknown>;

let transport: CredentialTransport | undefined;

/** In the host process: send credential operations over its gateway connection. */
export function setCredentialTransport(value: CredentialTransport | undefined): void {
  transport = value;
}

const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
const modifiers = new Map<string, Modifier>();
let next = 0;
let listening = false;

function listen(): void {
  if (listening) return;
  listening = true;
  process.on("message", (raw: unknown) => {
    if (!raw || typeof raw !== "object") return;
    const message = raw as Record<string, unknown>;
    const id = typeof message["id"] === "string" ? message["id"] : "";
    if (message["type"] === "credential-result") {
      const request = pending.get(id);
      if (!request) return;
      pending.delete(id);
      if (message["ok"] === true) request.resolve(message["result"]);
      else request.reject(message["offline"] === true ? new OfflineError("HUI is not connected.") : new Error(String(message["error"] ?? "Credential request failed.")));
      return;
    }
    if (message["type"] === "credential-step") {
      const modify = modifiers.get(id);
      const reply = (body: Record<string, unknown>) => process.send?.({ version: 1, type: "credential-step-result", step: message["step"], ...body });
      if (!modify) { reply({ ok: false, error: "That credential update is no longer pending." }); return; }
      modify(message["current"] as Credential).then(
        (value) => reply({ ok: true, ...(value === undefined ? {} : { next: value }) }),
        (error: unknown) => reply({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      );
    }
  });
}

function call(op: string, store: string, providerId?: string, modify?: Modifier): Promise<unknown> {
  if (transport) return transport(op, store, providerId, modify);
  listen();
  if (!process.send) return Promise.reject(new OfflineError("No worker host."));
  const id = `c${++next}`;
  if (modify) modifiers.set(id, modify);
  return new Promise<unknown>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    process.send!({ version: 1, type: "credential", id, op, store, ...(providerId ? { providerId } : {}) });
  }).finally(() => modifiers.delete(id));
}

export function brokeredStore(store: string, fallback: () => CredentialStore): CredentialStore {
  let local: CredentialStore | undefined;
  const offline = () => (local ??= fallback());
  const attempt = async <T>(remote: () => Promise<T>, fallbackCall: (store: CredentialStore) => Promise<T>): Promise<T> => {
    try { return await remote(); } catch (error) {
      if (error instanceof OfflineError) return fallbackCall(offline());
      throw error;
    }
  };
  return {
    read: (providerId, options) => attempt(() => call("read", store, providerId) as Promise<Credential>, (s) => s.read(providerId, options)),
    list: (options) => attempt(async () => (await call("list", store)) as Awaited<ReturnType<CredentialStore["list"]>>, (s) => s.list(options)),
    delete: (providerId, options) => attempt(async () => { await call("delete", store, providerId); }, (s) => s.delete(providerId, options)),
    modify: (providerId, fn, options) => attempt(() => call("modify", store, providerId, fn) as Promise<Credential>, (s) => s.modify(providerId, fn, options)),
  };
}

/** Serves a spawned PI worker's credential requests through this process's transport. */
export function relayCredentials(child: ChildProcess): void {
  const steps = new Map<string, (message: Record<string, unknown>) => void>();
  let next = 0;
  child.on("message", (raw: unknown) => {
    if (!raw || typeof raw !== "object") return;
    const message = raw as Record<string, unknown>;
    if (message["type"] === "credential-step-result" && typeof message["step"] === "string") {
      steps.get(message["step"])?.(message);
      return;
    }
    if (message["type"] !== "credential" || typeof message["id"] === "undefined") return;
    const id = message["id"];
    const reply = (body: Record<string, unknown>) => { if (child.connected) child.send({ version: 1, type: "credential-result", id, ...body }); };
    // The worker runs PI's refresh callback; this side only carries it.
    const modify: Modifier = (current) => new Promise((resolve, reject) => {
      const step = `s${++next}`;
      steps.set(step, (result) => {
        steps.delete(step);
        if (result["ok"] === true) resolve(result["next"] as Credential);
        else reject(new Error(typeof result["error"] === "string" ? result["error"] : "Credential update failed."));
      });
      child.send({ version: 1, type: "credential-step", id, step, current });
    });
    const op = String(message["op"]);
    call(op, String(message["store"]), typeof message["providerId"] === "string" ? message["providerId"] : undefined, op === "modify" ? modify : undefined).then(
      (result) => reply({ ok: true, result }),
      (error: unknown) => reply(error instanceof OfflineError ? { ok: false, offline: true } : { ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
  });
}

/** Values of literal models.json headers the worker's mirror names as
 * `HUI_SECRET_…` variables. The gateway sends them with each sync; they live
 * in memory only. PI reads them as environment variables, but no spawned
 * process inherits them, agent shells included: they are served by reads of
 * `process.env` and left out of its keys. */
const secrets = new Map<string, string>();
const SECRET_ENV = /^HUI_SECRET_[0-9A-F]{16}$/u;

let served = false;

export function setSecretEnv(values: unknown): void {
  if (!served) {
    served = true;
    process.env = new Proxy(process.env, { get: (env, name) => typeof name === "string" && secrets.has(name) ? secrets.get(name) : Reflect.get(env, name) });
  }
  secrets.clear();
  if (values && typeof values === "object") {
    for (const [name, value] of Object.entries(values)) if (SECRET_ENV.test(name) && typeof value === "string") secrets.set(name, value);
  }
}

/** The served values, for a PI worker this process starts. */
export function secretEnv(): Record<string, string> {
  return Object.fromEntries(secrets);
}

/** HUI provider credential files a gateway serves, relative to its providers dir. */
export const BROKERED_PROVIDER_FILE = /^(?:auth\.json|accounts\/[0-9a-f-]{36}\/auth\.json)$/u;

/** The remote user's own PI login, opened only once it exists: PI's file store
 * creates its file when opened, and HUI leaves files outside its own
 * directory alone. A credential PI itself writes there may create it. */
export function ownLogin(path: string): CredentialStore {
  let file: CredentialStore | undefined;
  const open = () => (file ??= fileCredentialStore(path));
  const exists = () => file !== undefined || existsSync(path);
  return {
    read: async (providerId, options) => exists() ? open().read(providerId, options) : undefined,
    list: async (options) => exists() ? open().list(options) : [],
    delete: async (providerId, options) => { if (exists()) await open().delete(providerId, options); },
    modify: (providerId, fn, options) => open().modify(providerId, fn, options),
  };
}

/** Maps the credential files a PI worker opens to gateway-side store names. */
export function installBrokeredCredentials(options: { agentDir: string; providersDir: string; fallbackAuth: string }): void {
  setCredentialStoreFactory((path) => {
    if (path === join(options.agentDir, "auth.json")) return brokeredStore("pi", () => ownLogin(options.fallbackAuth));
    const rel = relative(options.providersDir, path).split("\\").join("/");
    if (BROKERED_PROVIDER_FILE.test(rel)) return brokeredStore(`hui:${rel}`, () => fileCredentialStore(path));
    return fileCredentialStore(path);
  });
}
