/** HUI-owned account order and cooldowns; PI retains credential locking/refresh. */
import { join } from "node:path";
import { ModelRuntime, readStoredCredential, type CreateModelRuntimeOptions } from "@earendil-works/pi-coding-agent";

export type Account = { id: string; name: string; cooldownUntil?: number };
type Registry = Record<string, Account[]>;
type LockBackend = { withLockAsync<T>(fn: (raw: string | undefined) => Promise<{ result: T; next?: string }>): Promise<T> };
export type CredentialStore = NonNullable<CreateModelRuntimeOptions["credentials"]>;
const storage = await import(new URL("./core/auth-storage.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as {
  AuthStorage: { create(path: string): CredentialStore };
  FileAuthStorageBackend: new(path: string) => LockBackend;
};
export const fileCredentialStore = (path: string): CredentialStore => storage.AuthStorage.create(path);
let storeFor: (path: string) => CredentialStore = fileCredentialStore;
/** Every credential file HUI or PI reads goes through here, so a remote worker
 * can serve them from its gateway instead of the remote disk. */
export const credentialStore = (path: string): CredentialStore => storeFor(path);
export function setCredentialStoreFactory(factory: (path: string) => CredentialStore): void {
  storeFor = factory;
}
export function validAccountId(id: unknown): id is string {
  return typeof id === "string" && (id === "default" || /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id));
}
function parse(raw: string | undefined): Registry {
  const data: unknown = JSON.parse(raw ?? "{}");
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid account registry.");
  for (const accounts of Object.values(data)) {
    if (!Array.isArray(accounts) || accounts.length > 20 || accounts.some((a: Account) => !a || !validAccountId(a.id) || typeof a.name !== "string" || !a.name.trim() || a.name.length > 80 || (a.cooldownUntil !== undefined && (!Number.isFinite(a.cooldownUntil) || a.cooldownUntil < 0))) || new Set(accounts.map((a: Account) => a.id)).size !== accounts.length) throw new Error("Invalid account registry.");
  }
  return data as Registry;
}
export class ProviderAccounts {
  readonly dir: string;
  #backend: LockBackend;
  constructor(dir: string) { this.dir = dir; this.#backend = new storage.FileAuthStorageBackend(join(dir, "accounts.json")); }
  authPath(accountId = "default") {
    if (!validAccountId(accountId)) throw new Error("Invalid account ID.");
    return accountId === "default" ? join(this.dir, "auth.json") : join(this.dir, "accounts", accountId, "auth.json");
  }
  runtime(accountId: string) { return ModelRuntime.create({ authPath: this.authPath(accountId), modelsPath: null, allowModelNetwork: false }); }
  #entries(data: Registry, provider: string): Account[] {
    return Object.hasOwn(data, provider) ? data[provider]! : readStoredCredential(provider, this.authPath()) ? [{ id: "default", name: "Account 1" }] : [];
  }
  async all(): Promise<Registry> {
    const defaults = await credentialStore(this.authPath()).list();
    return this.#backend.withLockAsync(async (raw) => {
      const data = parse(raw);
      for (const { providerId } of defaults) if (!Object.hasOwn(data, providerId)) Object.defineProperty(data, providerId, { value: [{ id: "default", name: "Account 1" }], enumerable: true });
      return { result: data };
    });
  }
  list(provider: string): Promise<Account[]> {
    return this.#backend.withLockAsync(async (raw) => ({ result: this.#entries(parse(raw), provider) }));
  }
  update(provider: string, fn: (accounts: Account[]) => Account[]): Promise<void> {
    return this.#backend.withLockAsync(async (raw) => {
      const data = parse(raw);
      const accounts = fn(this.#entries(data, provider));
      Object.defineProperty(data, provider, { value: accounts, enumerable: true, writable: true, configurable: true });
      const next = JSON.stringify(data, null, 2) + "\n";
      parse(next);
      return { result: undefined, next };
    });
  }
  async cooldown(provider: string, id: string, until: number) {
    await this.update(provider, (accounts) => accounts.map((a) => a.id === id ? { ...a, cooldownUntil: Math.max(a.cooldownUntil ?? 0, until) } : a));
  }
}
