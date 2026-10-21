import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import {
  type DrawerMediaQuery,
  APP_SHELL_DRAWER_MEDIA,
  filterSessionGroups,
  isSessionGroupCollapsed,
  normalizeCustomSessionIcon,
  PRIMARY_NAV,
  sessionAccessibleName,
  sessionMoveGroupOptions,
  setNavigationDrawer,
  SHELL_DRAWER_DEFAULT_OPEN,
  SHELL_NARROW_MEDIA,
} from "./shell.ts";
import {
  adaptedSettingsCopy,
  filterSettingsPages,
  piSettingsState,
  setSettingsDrawer,
  SETTINGS_DRAWER_DEFAULT_OPEN,
  SETTINGS_PAGES,
} from "./settings.ts";
import type { SessionGroup, SessionView } from "../api/sessions.ts";

function session(
  id: string,
  title: string,
  group: string,
  overrides: Partial<SessionView> = {},
): SessionView {
  return {
    id,
    title,
    group,
    cwd: `/work/${group}`,
    tool: "pi",
    status: "idle",
    displayCwd: "",
    createdAt: "2026-09-22T00:00:00.000Z",
    updatedAt: "2026-09-22T00:00:00.000Z",
    ...overrides,
  } as SessionView;
}

const SESSION_GROUPS: SessionGroup[] = [
  {
    label: "Frontend",
    sessions: [
      session("one", "Fix navigation", "Frontend"),
      session("two", "Review styles", "Frontend", { tool: "codex", cwd: "/repo/web" }),
    ],
  },
  {
    label: "Runtime",
    sessions: [session("three", "Resume gateway", "Runtime", { cwd: "/repo/server" })],
  },
];

function controlledMedia(initialMatches = true) {
  let matches = initialMatches;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const media = {
    get matches() {
      return matches;
    },
    addEventListener(_type: "change", listener: (event: MediaQueryListEvent) => void) {
      listeners.add(listener);
    },
    removeEventListener(_type: "change", listener: (event: MediaQueryListEvent) => void) {
      listeners.delete(listener);
    },
  } as DrawerMediaQuery;
  return {
    media,
    listenerCount: () => listeners.size,
    setMatches(next: boolean) {
      matches = next;
      const event = { matches: next } as MediaQueryListEvent;
      for (const listener of [...listeners]) {
        listener(event);
      }
    },
  };
}

test("the primary sidebar lists work destinations and ends with Settings", () => {
  assert.deepEqual(PRIMARY_NAV.map((item) => item.id), ["contributions", "sessions"]);
  const source = readFileSync(new URL("./shell.ts", import.meta.url), "utf8");
  const nav = source.slice(source.indexOf('<nav class="sidebar-nav"'), source.indexOf("</nav>", source.indexOf('<nav class="sidebar-nav"')));
  assert.doesNotMatch(nav, /(?<![A-Z_])NAV\.map|icons\.home/u);
  // Kanban is a HUI route rendered directly below Contributions.
  assert.match(nav, /item\.id === "contributions" \? kanbanNavItem\(props\)/u);
  assert.match(nav, /sidebar-nav__settings[\s\S]*props\.onOpenSettings\(\)[\s\S]*>Settings<\/span>\s*<\/a>\s*$/u);
});

test("settings navigation contains only the thirteen accepted regions", () => {
  assert.deepEqual(
    SETTINGS_PAGES.map((page) => page.id),
    [
      "appearance",
      "connection",
      "integrations",
      "workers",
      "models",
      "plugins",
      "skills",
      "tools",
      "memory",
      "automation",
      "security",
      "worktrees",
      "diagnostics",
    ],
  );
});

test("settings exit is direct and Escape is handled from navigation and content", () => {
  const source = readFileSync(new URL("settings.ts", import.meta.url), "utf8");
  assert.match(source, /class="settings-sidebar__back settings-nav__back"\s+@click=\$\{props\.onClose\}/u);
  assert.match(source, /class="content settings-main" @keydown=\$\{\(event: KeyboardEvent\) => handleSettingsEscape\(event, props\)\}/u);
  assert.match(source, /class="shell-nav settings-sidebar settings-nav"[^>]*@keydown=\$\{\(event: KeyboardEvent\) => handleSettingsEscape\(event, props\)\}/u);
});

test("settings search is case-insensitive and also matches group names", () => {
  assert.deepEqual(filterSettingsPages("  MODEL  ").map((page) => page.id), ["models"]);
  assert.deepEqual(
    filterSettingsPages("agents & tools").map((page) => page.id),
    ["models", "plugins", "skills", "tools", "memory", "automation"],
  );
  assert.deepEqual(filterSettingsPages("does not exist"), []);
  assert.equal(filterSettingsPages("").length, SETTINGS_PAGES.length);
});

test("session search indexes title, tool, cwd and group label without mutating groups", () => {
  assert.deepEqual(filterSessionGroups(SESSION_GROUPS, "NAVIGATION").map((group) =>
    group.sessions.map((item) => item.id)), [["one"]]);
  assert.deepEqual(filterSessionGroups(SESSION_GROUPS, "codex").map((group) =>
    group.sessions.map((item) => item.id)), [["two"]]);
  assert.deepEqual(filterSessionGroups(SESSION_GROUPS, "server").map((group) =>
    group.sessions.map((item) => item.id)), [["three"]]);
  assert.deepEqual(filterSessionGroups(SESSION_GROUPS, "frontend").map((group) =>
    group.sessions.map((item) => item.id)), [["one", "two"]]);
  assert.deepEqual(SESSION_GROUPS.map((group) => group.sessions.map((item) => item.id)), [
    ["one", "two"],
    ["three"],
  ]);
});

test("session accessible names expose live status, tool and pinned state", () => {
  const base = session("one", "Fix navigation", "Frontend", { status: "running" });
  assert.equal(sessionAccessibleName(base), "Fix navigation, status running, tool pi");
  assert.equal(
    sessionAccessibleName({ ...base, pinned: true, unread: true }),
    "Fix navigation, status running, tool pi, pinned, unread",
  );
  assert.equal(
    sessionAccessibleName({ ...base, status: "idle", background: true }),
    "Fix navigation, status idle, watcher or subagent running, tool pi",
  );
});

test("session move targets always include OTHER once and preserve stored group labels", () => {
  assert.deepEqual(sessionMoveGroupOptions(SESSION_GROUPS), [
    { label: "OTHER", value: "" },
    { label: "FRONTEND", value: "Frontend" },
    { label: "RUNTIME", value: "Runtime" },
  ]);
  assert.deepEqual(sessionMoveGroupOptions([{ label: "ungrouped", sessions: [] }]), [
    { label: "OTHER", value: "" },
  ]);
});

test("session rows expose group drag and a keyboard-accessible move menu", () => {
  const source = readFileSync(new URL("./shell.ts", import.meta.url), "utf8");
  assert.match(source, /writeSessionDrag\(event\.dataTransfer, session\)/);
  assert.match(source, /sidebar-recent-sessions__group--session-drop/);
  assert.match(source, />Move to group</);
  assert.match(source, /slot="submenu" value=\$\{`move:/);
  assert.match(source, /group\.kind === "custom"/);
});

test("session menu mirrors the compatible OpenClaw action hierarchy", () => {
  const source = readFileSync(new URL("./shell.ts", import.meta.url), "utf8");
  for (const label of [
    "Pin session", "Rename…", "Mark as unread", "Archive session", "Icon",
    "Move to group", "Copy", "Session link", "Conversation as Markdown", "Session ID",
    "Open in", "New tab", "New window", "Workspace · VS Code", "Delete…",
  ]) assert.match(source, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(source, />Assign to</);
  assert.doesNotMatch(source, />Fork conversation</);
  assert.doesNotMatch(source, /Icon &amp; color|Session color|session-menu__color/);
});

test("session appearance picker centers reset controls and accepts custom emoji", () => {
  const source = readFileSync(new URL("./shell.ts", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../styles/openclaw-shell.css", import.meta.url), "utf8");
  assert.equal(normalizeCustomSessionIcon("  🐧  "), "🐧");
  assert.equal(normalizeCustomSessionIcon("   "), undefined);
  assert.equal(normalizeCustomSessionIcon("x".repeat(33)), undefined);
  assert.match(source, /aria-label="Custom emoji…"/);
  assert.match(source, /class="session-menu__icon-custom-input"/);
  assert.match(source, /\$\{icons\.circleX\}/);
  assert.doesNotMatch(source, /Session color|session-menu__color/);
  assert.doesNotMatch(styles, /session-menu__color/);
  assert.match(styles, /\.session-menu__icon-choice--glyph svg\s*\{\s*width:\s*16px;\s*height:\s*16px;/);
});

test("session rows delegate previews to the pinned OpenClaw provider", () => {
  const source = readFileSync(new URL("./shell.ts", import.meta.url), "utf8");
  assert.match(source, /<hui-session-hovercard-provider \.sessions=/);
  assert.match(source, /data-session-key=\$\{session.id\}/);
  assert.match(source, /openclaw-session-menu-open/);
  assert.doesNotMatch(source, /session-row__tooltip|session-row__progress|session-progress-trigger/);
  assert.match(source, /\$\{icons\.moreHorizontal\}/);
});

test("session rows retain original title marquee and two inline actions", () => {
  const source = readFileSync(new URL("./shell.ts", import.meta.url), "utf8");
  assert.match(source, /sidebar-recent-session__title-row/);
  assert.match(source, /renderHoverMarquee\(session\.title, "sidebar-recent-session__name"\)/);
  assert.match(source, /class="session-action session-action--pin"/);
  assert.match(source, /session-row-host--pinned/);
  assert.doesNotMatch(source, /data-session-row-action-count="1"|class="session-row__pin"/);
});

test("session rows drag to panes and retain an accessible split fallback", () => {
  const source = readFileSync(new URL("./shell.ts", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../styles/openclaw-shell.css", import.meta.url), "utf8");

  assert.match(source, /writeSessionDrag\(event\.dataTransfer, session\)/);
  assert.match(source, /const canDrag = props\.sessionMovePendingId !== session\.id/);
  assert.match(source, /value="split"[\s\S]*?Open in split pane/);
  assert.match(source, /props\.onSplitSession\(session\)/);
  assert.match(source, /!props\.selectedSessionId \|\| selected \|\| splitOpen/);
  assert.match(source, /open in split pane/);
  assert.match(styles, /\.sidebar-recent-session--split/);
});

test("session rows mirror OpenClaw run and attention states", () => {
  const source = readFileSync(new URL("./shell.ts", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../styles/openclaw-shell.css", import.meta.url), "utf8");
  const components = readFileSync(new URL("../styles/openclaw-reference/components.css", import.meta.url), "utf8");

  assert.match(source, /session\.status === "waiting"[\s\S]*?Waiting for your answer/);
  assert.match(source, /session\.status === "error"[\s\S]*?Session failed/);
  // A watcher or a subagent below it keeps an idle session spinning.
  assert.match(source, /const busy = session\.status === "running" \|\| background;/);
  assert.match(source, /busy \|\| session\.creating \? html`<span class="session-glyph session-glyph--running session-glyph--bare"/);
  assert.match(source, /class="session-glyph__ring"/);
  assert.match(components, /\.session-glyph__ring[\s\S]*?animation: session-run-spin 1\.6s linear infinite/);
  assert.match(styles, /\.sidebar-session-attention__icon--question \{ color: var\(--warn\)/);
  assert.match(styles, /\.sidebar-session-attention__icon--error \{ color: var\(--danger\)/);
  // A session out of reach is calm: its own muted mark, labelled by unreachableHost.
  assert.match(source, /away \? \{ label: away\.status, icon: icons\.plug, tone: "away" \}/);
  assert.match(styles, /\.sidebar-session-attention__icon--away \{ color: var\(--status-stopped\)/);
  assert.match(source, /const unread = session\.unread === true && !attention/);
  assert.doesNotMatch(source, /const unread =[^;]*!selected/);
  assert.match(source, /class="sidebar-session-unread-dot"/);
  assert.match(styles, /\.sidebar-session-unread-dot[\s\S]*?background: var\(--accent\)/);
  assert.match(components, /prefers-reduced-motion: reduce[\s\S]*?\.session-glyph__ring/);
  assert.doesNotMatch(source, /session-row__avatar/);
});

test("session rows show state-colored pull request links that open GitHub", () => {
  const source = readFileSync(new URL("./shell.ts", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../styles/openclaw-shell.css", import.meta.url), "utf8");
  assert.match(source, /class="session-pr-badge"[\s\S]*?data-state=\$\{pullRequest\.state \?\? "unknown"\}[\s\S]*?href=\$\{pullRequest\.url\}[\s\S]*?target="_blank"[\s\S]*?rel="noopener noreferrer"/);
  assert.match(source, /aria-label=\$\{pullRequestAccessibleLabel\(pullRequest\)\}/);
  assert.match(source, /installPullRequestHovercard\(\)/);
  assert.match(source, /<hui-pull-request-strip class="session-pr-badges"[\s\S]*?\[\.\.\.pullRequests\]\.reverse\(\)/);
  assert.doesNotMatch(source, /session-pr-badges__more|data-touch-more/);
  assert.match(styles, /\.session-pr-badges \{[\s\S]*?flex-direction: row-reverse;[\s\S]*?max-width: calc\(var\(--pr-badge-size\) \* 1\.5 \+ var\(--pr-badge-gap\)\);[\s\S]*?overflow-x: auto;/);
  assert.match(styles, /\.session-pr-badges\[data-more-before\] \{\s*mask-image: linear-gradient\(to right, var\(--pr-strip-dim\)/);
  assert.match(styles, /:has\(> \.sidebar-recent-session__link:is\(:hover, :focus-visible\)\) > \.session-pr-badges \{\s*max-width: var\(--pr-badge-size\);/);
  assert.match(styles, /> \.session-pr-badges:is\(:hover, :focus-within\) \{[^}]*?max-width: max\([^;]*?calc\(\(100% - var\(--session-row-actions-reserve, 52px\) - var\(--session-title-overhead\)\) \/ 2\)/);
  assert.doesNotMatch(styles, /:has\(> \.session-pr-badges:is\(:hover, :focus-within\)\) > \.sidebar-recent-session__link/);
  assert.match(styles, /\.session-pr-badge\[data-state="open"\] \{ --session-pr-color: var\(--ok\); \}/);
  assert.match(styles, /\.session-pr-badge\[data-state="merged"\] \{ --session-pr-color: var\(--pr-merged\); \}/);
  assert.match(styles, /\.session-pr-badge\[data-state="closed"\] \{ --session-pr-color: var\(--danger\); \}/);
});

test("the persistent draft pencil reserves its slot beside pull request marks", () => {
  const source = readFileSync(new URL("./shell.ts", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../styles/openclaw-shell.css", import.meta.url), "utf8");
  assert.match(source, /\$\{hasDraft \? "sidebar-recent-session--has-draft" : ""\}/);
  assert.match(styles, /\.sidebar-recent-session--has-draft > \.session-pr-badges \{ margin-right: var\(--session-row-draft-reserve\); \}/);
});

test("session links preserve original single-line anatomy and real navigation targets", () => {
  const source = readFileSync(new URL("./shell.ts", import.meta.url), "utf8");
  assert.match(source, /<a\s+href=\$\{navigationPath\(\{ kind: "session", id: session\.id \}\)\}/);
  assert.match(source, /class="sidebar-recent-session__text"/);
  assert.match(source, /class="sidebar-recent-session__aside session-row-aside"/);
  assert.match(source, /class="session-row-actions"/);
  assert.match(source, /sidebar-brand__icon sidebar-brand__header-control/);
});


test("session drafts project a persistent pencil into the action slot", () => {
  const source = readFileSync(new URL("./shell.ts", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../styles/openclaw-shell.css", import.meta.url), "utf8");
  assert.match(source, /props\.draftSessionIds\.has\(session\.id\)/);
  assert.match(source, /session-row__draft-icon[^\n]*\$\{icons\.edit\}/);
  assert.match(styles, /\.session-row__menu-btn--draft\s*\{\s*opacity:\s*1;/);
  assert.match(styles, /\.session-row-wrap:hover \.session-row__menu-btn--draft \.session-row__more-icon/);
});

test("active search reveals matches without changing the collapsed preference", () => {
  const collapsed = new Set(["Frontend"]);
  assert.equal(isSessionGroupCollapsed(collapsed, "Frontend", ""), true);
  assert.equal(isSessionGroupCollapsed(collapsed, "Frontend", "navigation"), false);
  assert.deepEqual([...collapsed], ["Frontend"]);
  assert.equal(isSessionGroupCollapsed(collapsed, "Frontend", "   "), true);
});

test("group menus expose the same four actions as OpenClaw", () => {
  const source = readFileSync(new URL("./shell.ts", import.meta.url), "utf8");
  for (const label of ["New session defaults", "Rename group", "New group", "Delete group"]) {
    assert.match(source, new RegExp(label));
  }
  assert.match(source, /aria-label=\$\{`Group options for \$\{group\.label\}`\}/);
  assert.match(source, /<wa-dropdown class="session-menu sidebar-session-group-menu"/);
  assert.match(source, /<wa-dropdown-item value=\$\{action\}/);
});

test("session group headers do not display session counts", () => {
  const source = readFileSync(new URL("./shell.ts", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../styles/openclaw-shell.css", import.meta.url), "utf8");
  assert.doesNotMatch(source, /session-group__count/);
  assert.doesNotMatch(styles, /session-group__count/);
});

test("narrow navigation drawers start closed and share the reference breakpoint", () => {
  assert.equal(SHELL_DRAWER_DEFAULT_OPEN, false);
  assert.equal(SETTINGS_DRAWER_DEFAULT_OPEN, false);
  assert.match(SHELL_NARROW_MEDIA, /max-width: 768px/);
  assert.match(SHELL_NARROW_MEDIA, /orientation: landscape/);
  assert.equal(APP_SHELL_DRAWER_MEDIA, "(max-width: 900px), (max-width: 932px) and (max-height: 500px) and (orientation: landscape)");
});

test("the floating sidebar restore control matches the in-sidebar collapse control", () => {
  const css = readFileSync(new URL("../styles/openclaw-shell.css", import.meta.url), "utf8");
  const rule = (selector: string) => {
    const start = css.indexOf(`${selector} {`);
    assert.notEqual(start, -1, selector);
    return css.slice(start, css.indexOf("}", start));
  };
  assert.match(rule(".app-shell"), /--shell-chrome-control-size:\s*28px/);
  assert.match(rule(".app-shell .sidebar-brand__icon"), /width:\s*28px[\s\S]*height:\s*28px/);
  const restore = rule(".app-shell .shell-chrome-controls");
  assert.match(restore, /border:\s*0/);
  assert.match(restore, /background:\s*transparent/);
  assert.match(rule(".app-shell .sidebar-brand__icon svg"), /width:\s*16px[\s\S]*height:\s*16px/);
  assert.match(rule(".app-shell .shell-chrome-controls svg"), /width:\s*16px[\s\S]*height:\s*16px/);
  // One spot for both: the toggle opens the sidebar's top row, one row tall below the
  // sidebar's top padding, and the restore control is placed from the same numbers, so
  // collapsing and expanding need no mouse travel.
  assert.match(rule(".app-shell"), /--shell-chrome-controls-inset:\s*10px/);
  // One chat header tall from the very top, so the row lines up with the header beside it.
  assert.match(rule(".app-shell"), /--shell-sidebar-pad-top:\s*0px;\s*--shell-sidebar-top-row-height:\s*48px/);
  assert.match(rule(".app-shell .sidebar-shell"), /--sidebar-pad-x:\s*10px/);
  assert.match(rule(".app-shell .sidebar-shell"), /padding:\s*var\(--shell-sidebar-pad-top\) var\(--sidebar-pad-x\)/);
  assert.match(rule(".app-shell .sidebar-brand"), /min-height:\s*var\(--shell-sidebar-top-row-height\)/);
  assert.match(restore, /top:\s*calc\(var\(--shell-sidebar-pad-top\) \+ \(var\(--shell-sidebar-top-row-height\) - var\(--shell-chrome-control-size\)\) \/ 2\)/);
  assert.match(restore, /left:\s*var\(--shell-chrome-controls-inset\)/);
  // Focus moves to whichever control is now shown, so a second Enter undoes the first.
  const source = readFileSync(new URL("./shell.ts", import.meta.url), "utf8");
  assert.match(source, /const next = collapsed \? "\.shell-chrome-controls" : "\.sidebar-brand__collapse";/);
  assert.match(source, /shell\.querySelector<HTMLElement>\(next\)\?\.focus\(\)/);
  // The touch block grows both controls; the 48px row already fits them.
  assert.match(css, /@media \(hover: none\), \(pointer: coarse\) \{[^@]*\.app-shell \{ --shell-chrome-control-size: 44px; \}[^@]*\.app-shell \.sidebar-brand__icon \{\s*width: 44px;\s*height: 44px;/u);
});

test("the shell retains reference chrome geometry with header utilities", () => {
  const css = readFileSync(new URL("../styles/openclaw-shell.css", import.meta.url), "utf8");
  const source = readFileSync(new URL("./shell.ts", import.meta.url), "utf8");

  assert.match(css, /--shell-nav-expanded-width:\s*258px/);
  assert.match(css, /--shell-topbar-height:\s*58px/);
  assert.match(css, /--shell-chrome-safe-area-left:\s*12px/);
  assert.match(
    css,
    /data-nav-collapsed="true"[^}]*--shell-chrome-safe-area-left:\s*calc\(/s,
  );
  assert.match(
    css,
    /\.app-shell:not\(\.shell--mobile-nav\)\[data-nav-collapsed="true"\] > \.content--chat > \.chat-pane__header\s*\{\s*padding-left:\s*var\(--shell-chrome-safe-area-left\)/,
  );
  // Multiplexed panes nest their header below the content column; the pane
  // at the top-left origin must still clear the floating restore control.
  assert.match(
    css,
    /\.app-shell:not\(\.shell--mobile-nav\)\[data-nav-collapsed="true"\] \.chat-split-view__cell--origin \.chat-pane-cache__pane--visible \.chat-pane__header\s*\{\s*padding-left:\s*var\(--shell-chrome-safe-area-left\)/,
  );
  const multiplexer = readFileSync(new URL("../components/session-multiplexer.ts", import.meta.url), "utf8");
  assert.match(multiplexer, /rect\.left === 0 && rect\.top === 0 \? "chat-split-view__cell--origin"/);
  assert.doesNotMatch(css, /@media \(min-width: 1101px\)/);
  assert.match(css, /width:\s*min\(86vw, 320px\)/);
  assert.match(source, /class="topbar"/);
  assert.match(source, /class="shell-nav"/);
  assert.match(source, /class="sidebar-shell sidebar-drawer__body"/);
  assert.doesNotMatch(source, /sidebar-shell__footer|sidebar-footer-bar|renderFooter/);
  assert.doesNotMatch(source, /sidebar-agent-card|deck-card/);
  // The header's only control is the collapse toggle, first in the top row: New session
  // and search left it on 2026-10-06 (owner). New sessions start from a group's + or
  // the Ctrl+K palette, which also finds sessions; the mobile top bar keeps its search.
  const header = source.slice(source.indexOf('<div class="sidebar-brand">'), source.indexOf('<label class="sidebar-search'));
  assert.match(header, /^<div class="sidebar-brand">\s*<button type="button" class="[^"]*sidebar-brand__collapse"/u);
  assert.deepEqual([...header.matchAll(/aria-label=(?:"([^"]+)"|\$\{(\w+)\})/gu)].map((match) => match[1] ?? match[2]), ["Collapse sidebar"]);
  assert.doesNotMatch(source, /sidebar-brand__(new-thread|search|utilities|actions)/u);
  assert.match(source, /aria-label=\$\{`New session in \$\{sessionGroupLabel\(group\.label\)\}`\}/u);
  assert.match(source, /class="topbar-search" aria-label=\$\{searchLabel\} @click=\$\{focusSessionSearch\}/u);
  assert.match(source, /const searchLabel = botsTab \? "Search bots" : "Search sessions";/);
  assert.doesNotMatch(header, /sidebar-brand__settings|aria-label="Settings"/);
  assert.match(source.slice(source.indexOf('<label class="sidebar-search')), /^<label class="sidebar-search /u);
  assert.doesNotMatch(source.slice(source.indexOf('<div class="sidebar-sessions">')), /aria-label="Search sessions"/);
  assert.doesNotMatch(source, /sidebar-identity-card/);
});

test("the Bots tab's Agents | Bots switch tops the sidebar, and Bots shows only the roster", () => {
  const source = readFileSync(new URL("./shell.ts", import.meta.url), "utf8");
  const css = readFileSync(new URL("../styles/bots.css", import.meta.url), "utf8");
  const tabs = source.slice(source.indexOf("function renderSidebarTabs"), source.indexOf("export function renderSidebar("));
  // Agents keeps the `sessions` id that browsers already remember.
  assert.match(tabs, /\[\["sessions", "Agents"\], \["bots", "Bots"\]\]/u);
  const sidebar = source.slice(source.indexOf("export function renderSidebar("));
  const at = (marker: string) => {
    const index = sidebar.indexOf(marker);
    assert.notEqual(index, -1, marker);
    return index;
  };
  // The top row: the collapse toggle, then the switch. Nothing sits above them, and each
  // tab has a sidebar of its own below.
  const top = sidebar.slice(at('<div class="sidebar-shell sidebar-drawer__body">'), at('<label class="sidebar-search'));
  assert.match(top, /^<div class="sidebar-shell sidebar-drawer__body">\s*<div class="sidebar-brand">\s*<button type="button" class="[^"]*sidebar-brand__collapse"[^>]*>\$\{icons\.panelLeftClose\}<\/button>\s*<div class="sidebar-switch">\$\{renderSidebarTabs\(props\.bots\)\}<\/div>\s*<\/div>\s*$/u);
  assert.ok(at('<label class="sidebar-search') < at('<nav class="sidebar-nav"'));
  assert.equal(sidebar.split("renderSidebarTabs(").length, 2, "one switch, not one per list");
  // Bots: no primary navigation, and the toolbar names the roster.
  assert.match(sidebar, /\$\{botsTab \? nothing : html`<nav class="sidebar-nav"/u);
  assert.match(sidebar, /<span>\$\{botsTab \? "Bots" : "Sessions"\}<\/span>/u);
  // The lists under the header are its tab panel, labelled by the selected tab.
  assert.match(sidebar, /role="tabpanel" aria-labelledby="sidebar-tab-\$\{props\.bots\.tab\}"/u);
  // A full-width tab bar over a divider, unlike the uppercase section labels below it.
  const rule = (selector: string) => {
    const start = css.indexOf(`${selector} {`);
    assert.notEqual(start, -1, selector);
    return css.slice(start, css.indexOf("}", start));
  };
  assert.match(rule(".app-shell .sidebar-brand:has(> .sidebar-switch)"), /border-bottom:\s*1px solid var\(--border\)/u);
  assert.match(rule(".app-shell .sidebar-switch"), /flex:\s*1 1 auto/u);
  assert.match(rule(".app-shell .sidebar-tabs__tab"), /flex:\s*1 1 0/u);
  assert.match(rule(".app-shell .sidebar-tabs__tab"), /height:\s*var\(--shell-sidebar-top-row-height\)/u);
  assert.doesNotMatch(rule(".app-shell .sidebar-switch") + rule(".app-shell .sidebar-tabs__tab"), /text-transform:\s*uppercase/u);
  // Flat tabs: no rounded top, and a hovered tab only brightens its label, so nothing reads as a raised tab.
  assert.match(rule(".app-shell .sidebar-tabs__tab"), /border-radius:\s*0;/u);
  assert.doesNotMatch(rule(".app-shell .sidebar-tabs__tab:hover"), /background/u);
  assert.match(rule(".app-shell .sidebar-brand:has(> .sidebar-switch)"), /margin-block-end:\s*8px/u);
  // The Bots list starts under the tab row, its header aligned with the avatars.
  assert.match(sidebar, /class=\$\{botsTab \? "sidebar-sessions sidebar-sessions--bots" : "sidebar-sessions"\}/u);
  assert.match(rule(".app-shell .sidebar-sessions--bots"), /margin-top:\s*4px/u);
  assert.match(rule(".app-shell .sidebar-sessions--bots > .sidebar-recent-sessions__toolbar"), /padding-inline-start:\s*14px/u);
  assert.doesNotMatch(css, /sidebar-recent-sessions__toolbar \.sidebar-tabs__tab/u, "the tabs no longer sit in the sessions toolbar");
  // The drawer hides the toggle, so the top row shows there only with the switch in it.
  const shellCss = readFileSync(new URL("../styles/openclaw-shell.css", import.meta.url), "utf8");
  assert.match(shellCss, /\.app-shell \.sidebar-brand:not\(:has\(> \.sidebar-switch\)\) \{\s*display: none;/u);
});

test("a collapsed sidebar keeps the bot view's header clear of the restore control", () => {
  const css = readFileSync(new URL("../styles/bots.css", import.meta.url), "utf8");
  const app = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8");
  // The bot view has no content padding, so its headers start right under the control:
  // the placeholder's directly, and the chat's inside the embedded pane app, which only
  // a custom property reaches.
  assert.match(css, /\.app-shell:not\(\.shell--mobile-nav\)\.shell--nav-collapsed \.bot-workspace__header,\s*\.app-shell:not\(\.shell--mobile-nav\)\[data-nav-collapsed="true"\] \.bot-workspace__header \{\s*padding-left: var\(--shell-chrome-safe-area-left\);/u);
  assert.match(css, /\.app-shell:not\(\.shell--mobile-nav\)\.shell--nav-collapsed \.bot-workspace__pane,\s*\.app-shell:not\(\.shell--mobile-nav\)\[data-nav-collapsed="true"\] \.bot-workspace__pane \{\s*--hui-pane-chrome-inset: var\(--shell-chrome-safe-area-left\);/u);
  assert.match(app, /\.hui-embedded-session > \.transcript__head\.chat-pane__header \{ padding-left: var\(--hui-pane-chrome-inset, 12px\); \}/u);
});

test("mobile topbar icons have a fixed glyph size inside their touch target", () => {
  const css = readFileSync(new URL("../styles/openclaw-shell.css", import.meta.url), "utf8");
  assert.match(css, /\.app-shell \.topbar-icon-btn svg,\s*\.app-shell \.topbar-search svg \{\s*width: 20px;\s*height: 20px;/u);
});

test("the active session follows the reference neutral row state", () => {
  const css = readFileSync(new URL("../styles/openclaw-shell.css", import.meta.url), "utf8");
  const source = readFileSync(new URL("./shell.ts", import.meta.url), "utf8");
  assert.match(source, /selected \? "sidebar-recent-session--active"/u);
  assert.match(css, /\.session-row-wrap\.sidebar-recent-session--active\s*\{[^}]*color-mix\(in srgb, var\(--text\) 10%, transparent\)/u);
  assert.doesNotMatch(source, /session-row__active-bar/u);
});

test("the mobile topbar uses PI branding instead of the OpenClaw app icon", () => {
  const source = readFileSync(new URL("./shell.ts", import.meta.url), "utf8");
  assert.match(source, /class="topbar-brand" aria-label="PI"/);
  assert.match(source, /class="topbar-brand__logo" src="\/pi-logo-3d\.png"/);
  assert.doesNotMatch(source, /class="topbar-brand__logo" src="\/apple-touch-icon\.png"/);
});

test("PI-backed settings distinguish loading, failure, empty and ready states", () => {
  assert.equal(piSettingsState({ pi: undefined, piLoading: true, piError: "" }), "loading");
  assert.equal(piSettingsState({ pi: undefined, piLoading: false, piError: "offline" }), "error");
  assert.equal(piSettingsState({ pi: undefined, piLoading: false, piError: "" }), "missing");
  assert.equal(
    piSettingsState({ pi: {} as never, piLoading: false, piError: "" }),
    "ready",
  );
});

test("accepted settings describe implementation status without reopening product decisions", () => {
  const connection = adaptedSettingsCopy("connection");
  assert.match(connection.description, /accepted for adaptation/i);
  assert.match(connection.description, /not implemented yet/i);
  assert.doesNotMatch(`${connection.summary} ${connection.description}`, /approval/i);
});

test("security renders implemented settings instead of placeholders", () => {
  const source = readFileSync(new URL("./settings.ts", import.meta.url), "utf8");

  assert.match(source, /props\.page === "security"\s*\? renderSecurityPage\(props\)/);
  assert.doesNotMatch(source, /sessions: "Session defaults/);
  assert.doesNotMatch(source, /security: "Secrets, audit history/);
});

test("appearance exposes OpenClaw accent presets and a custom color", () => {
  const source = readFileSync(new URL("./settings.ts", import.meta.url), "utf8");

  for (const hex of ["#ff5c5c", "#ff8066", "#f5b942", "#52c99a", "#35b9b0", "#5b9cf6", "#a78bfa", "#f472b6", "#8795a8"]) {
    assert.match(source, new RegExp(hex));
  }
  assert.match(source, /type="color" aria-label="Custom accent color"/);
  assert.match(source, /props\.onSelectAccent\(item\.value\)/);
  assert.match(source, /renderAccentSection\(props\)/);
});

test("app and settings drawers use the same narrow CSS breakpoint", () => {
  const css = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8");
  const settingsSource = readFileSync(new URL("./settings.ts", import.meta.url), "utf8");
  const shellCss = readFileSync(new URL("../styles/openclaw-shell.css", import.meta.url), "utf8");
  const workspaceCss = readFileSync(new URL("../styles/openclaw-workspaces.css", import.meta.url), "utf8");
  assert.ok(shellCss.includes(`@media ${APP_SHELL_DRAWER_MEDIA}`));
  assert.ok(workspaceCss.includes(`@media ${APP_SHELL_DRAWER_MEDIA}`));
  const sharedRule = `@media ${SHELL_NARROW_MEDIA}`;

  assert.equal(css.split(sharedRule).length - 1, 1);
  assert.doesNotMatch(css, /@media \(max-width: 768px\) \{\s*\.settings-shell/);
  assert.equal(settingsSource.split("matchMedia(APP_SHELL_DRAWER_MEDIA)").length - 1, 2);
  assert.doesNotMatch(settingsSource, /matchMedia\("\(max-width: 768px\)"\)/);
});

test("navigation drawer makes main inert and clears it before returning focus", () => {
  const attributes = new Map<string, string>();
  const sequence: string[] = [];
  const trigger = {
    setAttribute(name: string, value: string) {
      attributes.set(name, value);
    },
    focus() {
      sequence.push("focus-trigger");
    },
  };
  const main = {
    toggleAttribute(name: string, force: boolean) {
      sequence.push(`${force ? "set" : "clear"}-${name}`);
      return force;
    },
  };
  const sidebar = {
    dataset: {} as DOMStringMap,
    querySelector(selector: string) {
      return selector === ".topbar" ? trigger : null;
    },
    parentElement: {
      querySelector(selector: string) {
        return selector === ".main" ? main : null;
      },
    },
  } as unknown as HTMLElement;
  const narrow = controlledMedia();

  setNavigationDrawer(sidebar, true, false, narrow.media);
  assert.equal(sidebar.dataset.open, "true");
  assert.equal(attributes.get("aria-expanded"), "true");
  assert.equal(attributes.get("aria-label"), "Close navigation");
  assert.deepEqual(sequence, ["set-inert"]);

  setNavigationDrawer(sidebar, false, true);
  assert.equal(sidebar.dataset.open, "false");
  assert.equal(attributes.get("aria-expanded"), "false");
  assert.equal(attributes.get("aria-label"), "Open navigation");
  assert.deepEqual(sequence, ["set-inert", "clear-inert", "focus-trigger"]);
});

test("settings drawer makes its workspace inert and clears it before returning focus", () => {
  const attributes = new Map<string, string>();
  const sequence: string[] = [];
  const trigger = {
    setAttribute(name: string, value: string) {
      attributes.set(name, value);
    },
    focus() {
      sequence.push("focus-trigger");
    },
  };
  const main = {
    toggleAttribute(name: string, force: boolean) {
      sequence.push(`${force ? "set" : "clear"}-${name}`);
      return force;
    },
  };
  const sidebar = {
    dataset: {} as DOMStringMap,
    querySelector(selector: string) {
      return selector === ".settings-mobile-topbar" ? trigger
        : selector === ".settings-sidebar__search-input" ? { focus: () => sequence.push("focus-search") } : null;
    },
    parentElement: {
      querySelector(selector: string) {
        return selector === ".settings-main" ? main : null;
      },
    },
  } as unknown as HTMLElement;
  const narrow = controlledMedia();

  setSettingsDrawer(sidebar, true, false, narrow.media);
  assert.equal(sidebar.dataset.open, "true");
  assert.equal(attributes.get("aria-expanded"), "true");
  assert.deepEqual(sequence, ["set-inert", "focus-search"]);

  setSettingsDrawer(sidebar, false, true);
  assert.equal(sidebar.dataset.open, "false");
  assert.equal(attributes.get("aria-expanded"), "false");
  assert.deepEqual(sequence, ["set-inert", "focus-search", "clear-inert", "focus-trigger"]);
});

test("app drawer closes and releases its media listener when the layout becomes desktop", () => {
  const attributes = new Map<string, string>();
  const inertStates: boolean[] = [];
  const narrow = controlledMedia();
  const sidebar = {
    dataset: {} as DOMStringMap,
    querySelector() {
      return { setAttribute: (name: string, value: string) => attributes.set(name, value) };
    },
    parentElement: {
      querySelector() {
        return { toggleAttribute: (_name: string, force: boolean) => inertStates.push(force) };
      },
    },
  } as unknown as HTMLElement;

  setNavigationDrawer(sidebar, true, false, narrow.media);
  assert.equal(narrow.listenerCount(), 1);
  narrow.setMatches(false);

  assert.equal(sidebar.dataset.open, "false");
  assert.equal(attributes.get("aria-expanded"), "false");
  assert.deepEqual(inertStates, [true, false]);
  assert.equal(narrow.listenerCount(), 0);
});

test("settings drawer closes and releases its media listener when the layout becomes desktop", () => {
  const attributes = new Map<string, string>();
  const inertStates: boolean[] = [];
  const narrow = controlledMedia();
  const sidebar = {
    dataset: {} as DOMStringMap,
    querySelector(selector: string) {
      return selector === ".settings-mobile-topbar"
        ? { setAttribute: (name: string, value: string) => attributes.set(name, value) }
        : null;
    },
    parentElement: {
      querySelector() {
        return { toggleAttribute: (_name: string, force: boolean) => inertStates.push(force) };
      },
    },
  } as unknown as HTMLElement;

  setSettingsDrawer(sidebar, true, false, narrow.media);
  assert.equal(narrow.listenerCount(), 1);
  narrow.setMatches(false);

  assert.equal(sidebar.dataset.open, "false");
  assert.equal(attributes.get("aria-expanded"), "false");
  assert.deepEqual(inertStates, [true, false]);
  assert.equal(narrow.listenerCount(), 0);
});

test("both mobile drawers make the global update notice inert until closed", () => {
  for (const setDrawer of [setNavigationDrawer, setSettingsDrawer]) {
    const states: boolean[] = [];
    const notice = { toggleAttribute: (_name: string, value: boolean) => states.push(value) };
    const sidebar = {
      dataset: {},
      closest: (selector: string) => selector === ".hui-application" ? { querySelector: () => notice } : null,
      querySelector: () => null,
    } as unknown as HTMLElement;
    const narrow = controlledMedia();
    setDrawer(sidebar, true, false, narrow.media);
    setDrawer(sidebar, false, false);
    assert.deepEqual(states, [true, false]);
  }
});

test("session link names retain upstream single-line navigation semantics", () => {
  const row = session("progress", "Build", "Frontend", { status: "idle", progress: {
    markdown: "Review is pending", steps: [
      { step: "Implement", status: "completed" }, { step: "Review", status: "in_progress" },
    ],
  } });
  assert.equal(sessionAccessibleName(row), "Build, status idle, tool pi");
  assert.equal(sessionAccessibleName({ ...row, stage: "testing" }), "Build, status idle, tool pi, stage testing");
  assert.equal(sessionAccessibleName({ ...row, stage: "investigation" }), "Build, status idle, tool pi, stage investigation");
  // A legacy Backlog stage from an older gateway is not a session stage any more.
  assert.equal(sessionAccessibleName({ ...row, stage: "backlog" as never }), "Build, status idle, tool pi");
});
