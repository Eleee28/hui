/**
 * The browser Work view kind: the conversation's managed-browser live view, drawn by `<hui-browser-pane>`. A
 * conversation has at most one (its key is constant), and it is view-only: the agent drives the browser. The browser
 * itself belongs to the gateway (`server/browser/`).
 */
import { html, svg } from "lit";
import type { WorkViewKind } from "../../lib/work-pane.ts";
import { WORK_SHORTCUTS } from "../../lib/work-shortcuts.ts";

export type BrowserWorkViewRef = { kind: "browser" };

export type BrowserWorkViewEnvironment = {
  /** Settings → Tools → Browser is on. */
  enabled(): boolean;
};

export const BROWSER_WORK_VIEW_SHORTCUT = WORK_SHORTCUTS.browser;

/** Lucide globe, the shape of `icons.globe`, at 16px. */
export const browserWorkViewIcon = html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${svg`<circle cx="12" cy="12" r="10" /><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" /><path d="M2 12h20" />`}</svg>`;

export function browserWorkViewKind(env: BrowserWorkViewEnvironment): WorkViewKind<BrowserWorkViewRef> {
  return {
    kind: "browser",
    label: "Browser",
    icon: browserWorkViewIcon,
    shortcut: BROWSER_WORK_VIEW_SHORTCUT,
    unavailable: () => env.enabled() ? undefined : "The managed browser is off in Settings → Tools → Browser.",
    settingsLink: () => env.enabled() ? undefined : { label: "Open Settings → Tools → Browser", page: "tools", section: "browser" },
    single: true,
    create: () => ({ kind: "browser" }),
    key: () => "browser",
    title: () => "Browser",
    render: (_ref, ctx) => html`<hui-browser-pane
      .ownerSessionId=${ctx.sessionId}
      .enabled=${env.enabled()}
      .visible=${ctx.visible}
    ></hui-browser-pane>`,
  };
}
