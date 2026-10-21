/**
 * Subscription usage for the providers that report it (Anthropic, OpenAI Codex, OpenCode Go). It calls each
 * provider's fixed first-party usage endpoint and normalizes the reply into labelled usage windows, reporting
 * only what the provider said rather than inferring billing state from stored credentials.
 */
import { providerEmail } from "./provider-identity.ts";
import type { ProviderQuota } from "../api/providers.ts";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function displayText(value: unknown): string | undefined {
  return typeof value === "string" && /^[\p{L}\p{N} _().-]{1,80}$/u.test(value) ? value.replaceAll("_", " ") : undefined;
}
function period(seconds: unknown, fallback: string): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return fallback;
  if (seconds === 604800) return "Weekly";
  if (seconds % 86400 === 0) return `${seconds / 86400} days`;
  if (seconds % 3600 === 0) return `${seconds / 3600} hours`;
  return `${seconds / 60} minutes`;
}
function ratio(used: unknown, limit: unknown): number | undefined {
  return typeof used === "number" && Number.isFinite(used) && used >= 0 && typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? used / limit * 100 : undefined;
}
export function parseProviderQuota(provider: string, raw: unknown, checkedAt = Date.now()): ProviderQuota {
  const data = record(raw);
  const windows: ProviderQuota["windows"] = [];
  let partial = false;
  const append = (label: string, percent: unknown, reset: unknown, scope: ProviderQuota["windows"][number]["scope"]) => {
    if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0) { partial = true; return; }
    const resetAt = typeof reset === "number" ? reset * 1000 : typeof reset === "string" ? Date.parse(reset) : NaN;
    windows.push({ label, usedPercent: percent, scope, ...(Number.isFinite(resetAt) && resetAt > 0 && resetAt <= 8.64e15 ? { resetAt } : {}) });
  };
  let plan: string | undefined;
  let access: ProviderQuota["access"];
  let message: string | undefined;
  if (provider === "anthropic") {
    const labels: Record<string, string> = { five_hour: "5 hours", seven_day: "Weekly", seven_day_sonnet: "Sonnet weekly", seven_day_opus: "Opus weekly", seven_day_oauth_apps: "OAuth apps weekly", seven_day_cowork: "Cowork weekly", seven_day_routines: "Routines weekly", monthly: "Monthly", thirty_day: "30 days" };
    for (const [key, value] of Object.entries(data)) {
      // Preserve additional reported periods without forwarding arbitrary response fields.
      if (!Object.hasOwn(labels, key) && !/^(?:five_hour|seven_day|thirty_day|monthly)(?:_[a-z0-9_]+)?$/.test(key)) continue;
      if (value == null) continue;
      const window = record(value);
      append(labels[key] ?? key.replaceAll("_", " "), window["utilization"], window["resets_at"], ["five_hour", "seven_day", "thirty_day", "monthly"].includes(key) ? "account" : "scoped");
    }
    if (Array.isArray(data["limits"])) for (const value of data["limits"]) {
      const limit = record(value);
      if (limit["is_active"] === false) continue;
      const model = record(record(limit["scope"])["model"]);
      const name = displayText(model["display_name"]) ?? displayText(model["id"]);
      const label = displayText(limit["group"]) ?? displayText(limit["kind"]) ?? "Additional limit";
      append(name ? `${name} · ${label}` : label, limit["percent"], limit["resets_at"], "scoped");
    }
    const extra = record(data["extra_usage"]);
    if (extra["is_enabled"] === true) append("Monthly extra usage", extra["utilization"] ?? ratio(extra["used_credits"], extra["monthly_limit"]), extra["resets_at"], "spend");
    else if (extra["is_enabled"] === false) message = "Extra usage is disabled.";
  } else if (provider === "opencode-go") {
    const usage = record(data["usage"]);
    for (const [key, label] of [["rolling", "5 hours"], ["weekly", "Weekly"], ["monthly", "Monthly"]] as const) {
      const window = record(usage[key]);
      append(label, window["percent"], window["resetsAt"], "account");
    }
  } else if (provider === "openai-codex") {
    plan = displayText(data["plan_type"]);
    const rate = record(data["rate_limit"]);
    if (rate["allowed"] === false || rate["limit_reached"] === true) access = "limited";
    else if (rate["allowed"] === true) access = "available";
    const addRate = (rate: Record<string, unknown>, prefix: string, scope: "account" | "scoped") => {
      for (const [key, value] of Object.entries(rate)) {
        if (!key.endsWith("_window") || value == null) continue;
        const window = record(value);
        const label = period(window["limit_window_seconds"], key.replaceAll("_", " "));
        append(prefix ? `${prefix} · ${label}` : label, window["used_percent"], window["reset_at"], scope);
      }
    };
    addRate(rate, "", "account");
    addRate(record(data["code_review_rate_limit"]), "Code review", "scoped");
    if (Array.isArray(data["additional_rate_limits"])) for (const value of data["additional_rate_limits"]) {
      const limit = record(value);
      addRate(record(limit["rate_limit"]), displayText(limit["limit_name"]) ?? displayText(limit["metered_feature"]) ?? "Additional limit", "scoped");
    }
    const spend = record(data["spend_control"] ?? data["spendControl"]);
    const individual = data["individual_limit"] ?? data["individualLimit"] ?? rate["individual_limit"] ?? rate["individualLimit"] ?? spend["individual_limit"] ?? spend["individualLimit"];
    if (individual != null) {
      const limit = record(individual);
      const remaining = limit["remaining_percent"] ?? limit["remainingPercent"];
      const percent = typeof remaining === "number" && Number.isFinite(remaining) && remaining >= 0 && remaining <= 100 ? 100 - remaining : ratio(limit["used"], limit["limit"]);
      append("Monthly credits", percent, limit["reset_at"] ?? limit["resets_at"] ?? limit["resetsAt"], "spend");
    }
  }
  if (windows.some((window) => window.scope === "account" && window.usedPercent >= 100 && (!window.resetAt || window.resetAt > checkedAt))) access = "limited";
  // No inferred billing status, renewal date, or availability from stored credentials.
  const notes = [message, partial ? "Some reported limits could not be read." : undefined, !windows.length ? "The provider did not report readable usage windows." : undefined].filter(Boolean);
  return { status: windows.length ? "available" : "unavailable", checkedAt, windows, ...(plan ? { plan } : {}), ...(access ? { access } : {}), ...(notes.length ? { message: notes.join(" ") } : {}) };
}

/** Fixed first-party origins only. No redirects or arbitrary configured URLs. */
export async function fetchProviderQuota(provider: string, token: string, accountId?: string, fetcher = fetch): Promise<ProviderQuota> {
  const checkedAt = Date.now();
  const url = provider === "anthropic" ? "https://api.anthropic.com/api/oauth/usage"
    : provider === "openai-codex" ? "https://chatgpt.com/backend-api/wham/usage"
    : provider === "opencode-go" ? "https://opencode.ai/zen/go/v1/usage" : undefined;
  if (!url) return { status: "unsupported", checkedAt, windows: [], message: "This provider does not expose a supported subscription quota API." };
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  if (provider === "anthropic") { headers["anthropic-version"] = "2023-06-01"; headers["anthropic-beta"] = "oauth-2025-04-20"; }
  if (provider === "openai-codex" && accountId) headers["ChatGPT-Account-Id"] = accountId;
  const request = async (endpoint: string): Promise<unknown> => {
    const response = await fetcher(endpoint, { headers, redirect: "error", signal: AbortSignal.timeout(8_000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error("Provider request failed."); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("No provider response.");
    const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > 128_000) throw new Error("Oversized provider response."); chunks.push(chunk.value); } }
    finally { await reader.cancel(); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  };
  // Identity failure must not discard usable quotas (or vice versa).
  const identity = provider === "anthropic" ? request("https://api.anthropic.com/api/oauth/profile").then((raw) => {
    const data = record(raw); const account = record(data["account"]);
    return providerEmail(account["email_address"]) ?? providerEmail(account["emailAddress"]) ?? providerEmail(account["email"])
      ?? providerEmail(data["email_address"]) ?? providerEmail(data["emailAddress"]) ?? providerEmail(data["email"]);
  }).catch(() => undefined) : Promise.resolve(undefined);
  let quota: ProviderQuota;
  try { quota = parseProviderQuota(provider, await request(url), checkedAt); }
  catch { quota = { status: "unavailable", checkedAt, windows: [], message: "Quota could not be retrieved. Check your connection or sign in again." }; }
  const email = await identity;
  return email ? { ...quota, email } : quota;
}
