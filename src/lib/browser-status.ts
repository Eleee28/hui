/**
 * Operator-facing labels for the managed browser's status in Settings. Pure presentation over the gateway's
 * `BrowserStatus`; it never queries or controls the browser.
 */
import type { BrowserState, BrowserStatus } from "../api/schema/browser.ts";

const STATES = new Set<BrowserState>(["stopped", "starting", "running", "stopping"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, maximum = 4_096): string {
  return typeof value === "string" ? value.slice(0, maximum) : "";
}


export function normalizeBrowserStatus(raw: unknown): BrowserStatus {
  const source = isRecord(raw) ? raw : {};
  const executable = isRecord(source["executable"]) && typeof source["executable"]["path"] === "string"
    ? {
        path: text(source["executable"]["path"]),
        name: text(source["executable"]["name"], 80) || "Browser",
        source: source["executable"]["source"] === "configured" ? "configured" as const : "detected" as const,
      }
    : null;
  const state = typeof source["state"] === "string" && STATES.has(source["state"] as BrowserState)
    ? source["state"] as BrowserState
    : "stopped";
  const tabs = Array.isArray(source["tabs"])
    ? source["tabs"].filter(isRecord).flatMap((tab) => typeof tab["id"] === "string" && typeof tab["ownerSessionId"] === "string"
      ? [{
          id: text(tab["id"], 16),
          ownerSessionId: text(tab["ownerSessionId"], 200),
          ownerTitle: text(tab["ownerTitle"], 200),
          title: text(tab["title"], 300),
          url: text(tab["url"], 2_048),
        }]
      : [])
    : [];
  return {
    enabled: source["enabled"] !== false,
    headless: source["headless"] !== false,
    executablePath: text(source["executablePath"]),
    executable,
    executableError: text(source["executableError"], 1_000),
    state,
    ...(source["mode"] === "headless" || source["mode"] === "windowed" ? { mode: source["mode"] } : {}),
    ...(typeof source["version"] === "string" ? { version: text(source["version"], 200) } : {}),
    ...(typeof source["startedAt"] === "string" ? { startedAt: text(source["startedAt"], 64) } : {}),
    profileDir: text(source["profileDir"]),
    lastError: text(source["lastError"], 1_000),
    tabs,
  };
}

export type BrowserStatusKind = "ok" | "warn" | "danger" | "accent" | "muted";

/** One pill for the Browser section header; states are mutually exclusive and
 * checked in order of what the operator must act on first. */
export function browserStatusLabel(status: BrowserStatus | undefined): { kind: BrowserStatusKind; label: string } {
  if (!status) return { kind: "muted", label: "Checking…" };
  if (!status.enabled) return { kind: "muted", label: "Off" };
  if (status.state === "starting") return { kind: "accent", label: "Starting…" };
  if (status.state === "stopping") return { kind: "accent", label: "Stopping…" };
  if (status.state === "running") return { kind: "ok", label: status.mode === "windowed" ? "Running · visible window" : "Running · headless" };
  if (!status.executable) return { kind: "danger", label: "Browser not found" };
  if (status.lastError) return { kind: "warn", label: "Stopped after an error" };
  return { kind: "muted", label: "Stopped" };
}

/** "Brave · Chrome/153.0.8010.53" without repeating a name the version already carries. */
export function browserVersionLabel(status: BrowserStatus): string {
  const name = status.executable?.name ?? "Browser";
  if (!status.version) return name;
  return status.version.toLowerCase().startsWith(name.toLowerCase()) ? status.version : `${name} · ${status.version}`;
}
