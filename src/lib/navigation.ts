/**
 * HUI's client-side routes: parsing a browser path into a navigation target, building canonical paths and the
 * Settings return rules. Unknown or malformed paths resolve to Home rather than an error page.
 */
import { HUI_PAGES, type HuiPage } from "./pages.ts";

export const ROUTABLE_SETTINGS_PAGES = [
  "appearance",
  "connection",
  "integrations",
  "workers",
  "worktrees",
  "models",
  "tools",
  "skills",
  "automation",
  "plugins",
  "memory",
  "security",
  "diagnostics",
] as const;

export type RoutableSettingsPage = (typeof ROUTABLE_SETTINGS_PAGES)[number];

export type NavigationTarget =
  | { kind: "home" }
  | { kind: "kanban" }
  | { kind: "page"; page: HuiPage }
  | { kind: "settings"; page: RoutableSettingsPage }
  | { kind: "session"; id: string }
  /** A bot's one permanent chat, opened from the sidebar's Bots tab. */
  | { kind: "bot"; id: string };

export type NavigationResolution = {
  target: NavigationTarget;
  /** Canonical path for replaceState when the input is invalid or non-canonical. */
  path: string;
};

const ROUTABLE_PAGES = new Map(HUI_PAGES.map((page) => [page.id, page]));
const SETTINGS_PAGES = new Set<string>(ROUTABLE_SETTINGS_PAGES);

function decodeSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/** Parse a browser pathname; anything unknown resolves to Home. */
export function resolveNavigation(pathname: string): NavigationResolution {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) {
    return { target: { kind: "home" }, path: "/" };
  }

  if (segments.length === 1 && segments[0] === "kanban") {
    return { target: { kind: "kanban" }, path: "/kanban" };
  }

  // Worktrees moved into Settings; keep old links working.
  if (segments.length === 1 && segments[0] === "worktrees") {
    return { target: { kind: "settings", page: "worktrees" }, path: "/settings/worktrees" };
  }

  if (segments.length === 2 && segments[0] === "settings" && segments[1] === "sessions") {
    return resolveNavigation("/sessions");
  }

  if (segments.length === 1) {
    const page = ROUTABLE_PAGES.get(decodeSegment(segments[0] ?? "") ?? "");
    return page
      ? { target: { kind: "page", page }, path: navigationPath({ kind: "page", page }) }
      : { target: { kind: "home" }, path: "/" };
  }

  const value = segments.length === 2 ? decodeSegment(segments[1] ?? "") : undefined;
  if (!value) {
    return { target: { kind: "home" }, path: "/" };
  }

  if (segments[0] === "settings" && SETTINGS_PAGES.has(value)) {
    const page = value as RoutableSettingsPage;
    return { target: { kind: "settings", page }, path: navigationPath({ kind: "settings", page }) };
  }

  if (segments[0] === "sessions") {
    return { target: { kind: "session", id: value }, path: navigationPath({ kind: "session", id: value }) };
  }

  if (segments[0] === "bots") {
    return { target: { kind: "bot", id: value }, path: navigationPath({ kind: "bot", id: value }) };
  }

  return { target: { kind: "home" }, path: "/" };
}

export function navigationPath(target: NavigationTarget): string {
  switch (target.kind) {
    case "home":
      return "/";
    case "kanban":
      return "/kanban";
    case "page":
      return `/${encodeURIComponent(target.page.id)}`;
    case "settings":
      return `/settings/${encodeURIComponent(target.page)}`;
    case "session":
      return `/sessions/${encodeURIComponent(target.id)}`;
    case "bot":
      return `/bots/${encodeURIComponent(target.id)}`;
  }
}

/** Matches by stable id so a structurally equal page from an older HMR module still routes. */
export function isRoutablePage(page: HuiPage): boolean {
  return ROUTABLE_PAGES.has(page.id);
}

/** Settings opened from the app returns to that route; a direct Settings URL has no origin. */
export function settingsReturnTarget(current: NavigationTarget): NavigationTarget {
  return current.kind === "settings" ? { kind: "home" } : current;
}

/** Closing Settings consumes its history entry, so Back does not reopen it. */
export function settingsCloseNavigation(returnTarget: NavigationTarget): {
  target: NavigationTarget;
  replace: true;
} {
  return { target: returnTarget, replace: true };
}
