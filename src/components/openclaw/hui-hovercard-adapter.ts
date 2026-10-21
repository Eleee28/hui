/** HUI data boundary for the pinned OpenClaw view. No Gateway or identity store. */
import { html } from "lit";
import type { SessionView } from "../../api/sessions.ts";
import type { ProgressCard as HuiProgressCard, ProgressStep } from "../../lib/progress-card.ts";

export type ProgressCardStep = ProgressStep;
export type ProgressCard = HuiProgressCard & { updatedAt?: number };
export type SessionRunStatus = "queued" | "running" | "done" | "failed" | "killed" | "timeout";
export type RelativeTimeUnit = "second" | "minute" | "hour" | "day";
export type SessionParticipant = { identity: { type: string; id: string }; label?: string; avatarUrl?: string };
export type SessionCreatedActor = SessionParticipant & { id: string };
export type ControlUiSessionPullRequest = {
  number: number; title: string; url: string; state: "open" | "draft" | "merged" | "closed";
  additions?: number; deletions?: number; checks?: { state: "passing" | "failing" | "pending" };
};
export type ControlUiSessionPullRequestSnapshot = {
  pullRequests: ControlUiSessionPullRequest[];
  branch?: { branch: string; createUrl?: string; additions?: number; deletions?: number };
};
type Machine = { osLabel?: string; os?: string; class?: string; cpu?: number; memoryGb?: number };
export type SidebarSessionHovercardRow = {
  label: string; createdAt?: number; hasActiveRun?: boolean;
  status?: SessionRunStatus; startedAt?: number; updatedAt?: number; endedAt?: number;
  workContext?: { kind: "project" | "workspace"; name: string; path: string };
  lastMessagePreview?: string; boardFace?: string; hasAutomation?: boolean;
  placementProviderId?: string; placementProfileId?: string; placementMachine?: Machine;
  createdActor?: SessionCreatedActor; participants?: SessionParticipant[];
  expandedParticipants?: SessionParticipant[]; participantCount?: number; channelAvatarUrl?: never;
};

export function huiHovercardRow(session: SessionView): SidebarSessionHovercardRow {
  return {
    label: session.title,
    createdAt: Date.parse(session.createdAt),
    hasActiveRun: session.status === "running" || session.status === "starting",
    // Idle does not prove task completion. Keep an unfinished PI plan paused,
    // just as OpenClaw does when a row has no active run or terminal outcome.
    status: session.status === "running" ? "running" : undefined,
    workContext: session.cwd ? {
      kind: "workspace", name: session.cwd.replace(/\/$/, "").split("/").at(-1) || session.cwd, path: session.cwd,
    } : undefined,
  };
}

export const i18n = { getLocale: () => "en" };
const strings: Record<string, string> = {
  "common.justNow": "just now",
  "sessionHovercard.ariaLabel": "Session information",
  "sessionHovercard.agentNotepad": "Agent Notepad",
  "sessionHovercard.projectLabel": "Project", "sessionHovercard.workspaceLabel": "Workspace",
  "sessionHovercard.runsOn": "Runs on {providerId} · {profileId}", "sessionHovercard.machineLabel": "Machine",
  "sessionHovercard.machineCpu": "{cpu} vCPU", "sessionHovercard.machineMemory": "{memory} GB",
  "sessionHovercard.more": "+{count} more", "sessionHovercard.moreParticipantsLabel": "{count} more participants",
  "sessionHovercard.attributionOther": "& {count} other", "sessionHovercard.attributionOthers": "& {count} others",
  "sessionHovercard.pullRequestLabel": "Pull request #{number}, {state}",
  "sessionHovercard.states.open": "Open", "sessionHovercard.states.draft": "Draft",
  "sessionHovercard.states.merged": "Merged", "sessionHovercard.states.closed": "Closed",
  "sessionHovercard.checks.passing": "CI checks passing", "sessionHovercard.checks.failing": "CI checks failing",
  "sessionHovercard.checks.pending": "CI checks running",
  "sessionProgressCard.title": "Progress", "sessionProgressCard.stepLabel": "{step}, {status}",
  "sessionProgressCard.status.inProgress": "in progress", "sessionProgressCard.status.paused": "paused",
  "sessionProgressCard.status.pending": "pending",
  "sessionsView.opensAsDashboard": "Opens as dashboard", "sessionsView.automationAttached": "Automation attached",
  "chat.pullRequests.createPr": "Create PR", "chat.pullRequests.createPrLabel": "Create pull request for {branch}",
  "chat.sessionDiff.title": "Changes",
};
export function t(key: string, values: Record<string, string> = {}): string {
  const label = strings[key] ?? (key.startsWith("sessionsView.colors.") ? key.split(".").at(-1)! : key);
  return label.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);
}
export function asDateTimestampMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
export function shouldHandleNavigationClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey;
}
// HUI has no participant identity routes. The original view receives no actors,
// facepiles, channel avatars, pull requests, placement or dashboard metadata.
export type PersonActivityRouting = undefined;
export function personActivityLink(_id: string | undefined, _routing: PersonActivityRouting, _label?: string): null { return null; }
type PersonActivityLink = { href: string; open: (event: MouseEvent) => void };
function takeGraphemes(value: string, count: number): string {
  return [...new Intl.Segmenter().segment(value)].slice(0, count).map(({ segment }) => segment).join("");
}

export function bucketRelativeTimeMs(durationMs: number): {
  value: number;
  unit: RelativeTimeUnit;
} {
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) {
    return { value: seconds, unit: "second" };
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return { value: minutes, unit: "minute" };
  }
  const hours = Math.round(minutes / 60);
  return hours < 48
    ? { value: hours, unit: "hour" }
    : { value: Math.round(hours / 24), unit: "day" };
}


export function renderPersonName(
  label: string,
  link: PersonActivityLink | null,
  className: string,
) {
  return link
    ? html`<a class="${className} person-activity-link" href=${link.href} @click=${link.open}
        >${label}</a
      >`
    : html`<span class=${className}>${label}</span>`;
}

/**
 * Wraps an avatar that already sits beside its own labelled name link. The twin is hidden
 * from assistive tech and the tab order so one identity never yields two targets; see the
 * focusable filter in session-progress-hovercard.runtime.ts.
 */
export function renderPersonAvatarLink(avatar: unknown, link: PersonActivityLink | null) {
  return link
    ? html`<a
        class="person-activity-avatar-link"
        href=${link.href}
        tabindex="-1"
        aria-hidden="true"
        @click=${link.open}
        >${avatar}</a
      >`
    : avatar;
}


export function sessionOwnerInitials(owner: SessionCreatedActor): string {
  const source = owner.label?.trim() || owner.id?.trim() || "";
  if (!source) {
    return "";
  }
  const parts = source
    .replace(/@.*$/u, "")
    .split(/[\s._-]+/u)
    .filter(Boolean);
  // Grapheme clusters, not UTF-16 units or bare code points: emoji display names
  // must render their complete visible initial (no lone surrogates or split ZWJ sequences).
  const firstChar = (value: string | undefined): string => (value ? takeGraphemes(value, 1) : "");
  const initials = (firstChar(parts[0]) + firstChar(parts[1])).toUpperCase();
  return initials || firstChar(source).toUpperCase();
}


export function sessionMachineParts(machine?: Machine): string[] {
  return [
    machine?.osLabel || machine?.os || "",
    machine?.class || "",
    machine?.cpu ? t("sessionHovercard.machineCpu", { cpu: String(machine.cpu) }) : "",
    machine?.memoryGb
      ? t("sessionHovercard.machineMemory", { memory: String(machine.memoryGb) })
      : "",
  ];
}
