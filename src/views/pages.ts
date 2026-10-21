/**
 * The renderer of each routed page that is not part of a surface family (PI, observability, HUI-owned): one entry
 * per dedicated page id, given the shell's props for it on demand.
 */
import { html, type TemplateResult } from "lit";
import type { HuiPageId } from "../lib/pages.ts";
import { renderAutomationSurface } from "./automation.ts";
import { renderNewSession, type HomeProps } from "./home.ts";
import { renderSessionsPage, type SessionsPageProps } from "./sessions.ts";
import type { AutomationProps } from "./settings-automation.ts";

export type DedicatedPageProps = {
  home: () => HomeProps;
  automation: () => AutomationProps;
  sessions: () => SessionsPageProps;
  onOpenSettings: () => void;
  onOpenSession: (id: string) => void;
};

export const PAGE_RENDERERS = {
  "new-session": (props) => renderNewSession(props.home()),
  cron: (props) => renderAutomationSurface(props.automation(), "Automations"),
  tasks: (props) => renderAutomationSurface(props.automation(), "Tasks"),
  sessions: (props) => renderSessionsPage(props.sessions()),
  contributions: (props) => html`<hui-contributions-page .onOpenSettings=${props.onOpenSettings}
    .onOpenSession=${props.onOpenSession}></hui-contributions-page>`,
} satisfies Partial<Record<HuiPageId, (props: DedicatedPageProps) => TemplateResult>>;

export function dedicatedPageRenderer(id: string): ((props: DedicatedPageProps) => TemplateResult) | undefined {
  return Object.hasOwn(PAGE_RENDERERS, id) ? PAGE_RENDERERS[id as keyof typeof PAGE_RENDERERS] : undefined;
}
