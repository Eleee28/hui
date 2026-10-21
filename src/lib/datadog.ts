/** Labels for the Datadog integration: what a chat card says instead of a graph, an org's name, a widget's time range
 * and the Settings status line. */
import type { DatadogConnection, DatadogOrg, DatadogPreviewResult } from "../api/schema/datadog.ts";
import type { DatadogRef } from "./markdown/datadog-links.ts";

/** What a card says instead of a graph. */
export function datadogPreviewMessage(ref: DatadogRef, result: DatadogPreviewResult): string {
  switch (result.error) {
    case "no_org": return `Add a Datadog org for ${ref.host} in Settings → Integrations to preview it.`;
    case "signed_out": return `Sign in to ${datadogOrgLabel(result.signIn)} to preview it.`;
    case "not_found": return ref.kind === "share" ? "This share link is not available." : `Not found in your Datadog orgs for ${ref.host}.`;
    case "cli_missing": return "The Datadog CLI (pup) is required for previews.";
    case "unavailable": return "Datadog preview unavailable.";
    default: return result.preview?.kind === "widget" && !result.preview.image ? "Datadog could not draw this widget." : "";
  }
}

export function datadogOrgLabel(org: DatadogOrg | undefined): string {
  if (!org) return "your Datadog org";
  return org.name || `pup's default session for ${org.site}`;
}

/** A widget's time range in local time: "Oct 16, 10:20 – 11:20", or "Past 1 hour" for links without one. */
export function formatDatadogRange(from: number, to: number, relative = false): string {
  if (relative) return "Past 1 hour";
  const day = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
  const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
  const start = new Date(from);
  const end = new Date(to);
  const sameDay = start.toDateString() === end.toDateString();
  return `${day.format(start)}, ${time.format(start)} – ${sameDay ? "" : `${day.format(end)}, `}${time.format(end)}`;
}

/** Status line shown under the Datadog heading. */
export function datadogStatusLabel(connection: DatadogConnection | undefined): { kind: "ok" | "warn" | "danger" | "accent" | "muted"; label: string } {
  if (!connection) return { kind: "muted", label: "Checking…" };
  if (!connection.cli.installed) return { kind: "danger", label: "pup required" };
  if (connection.login.phase === "pending") return { kind: "accent", label: "Waiting for sign-in…" };
  if (!connection.orgs.length) return { kind: "muted", label: "No orgs" };
  const signedOut = connection.orgs.filter((org) => org.status === "signed_out").length;
  if (!signedOut) return { kind: "ok", label: "Connected" };
  return { kind: "warn", label: `${signedOut} ${signedOut === 1 ? "org needs" : "orgs need"} sign-in` };
}
