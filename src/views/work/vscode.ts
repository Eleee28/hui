/**
 * The VS Code kind of Work view: its launcher entry (label, icon, shortcut), one view per conversation, and
 * rendering <hui-vscode-view>. The launcher is always available and asks the gateway nothing: VS Code starts, and
 * the view offers its first-open choices (use your VS Code, install a server, set a path), only once it is opened.
 */
import { html } from "lit";
import { vscodeIcon } from "../../components/vscode-view.ts";
import type { WorkViewKind } from "../../lib/work-pane.ts";
import { WORK_SHORTCUTS } from "../../lib/work-shortcuts.ts";

export type VscodeWorkViewRef = { kind: "vscode" };

export const VSCODE_WORK_VIEW_SHORTCUT = WORK_SHORTCUTS.vscode;

export const vscodeWorkViewKind: WorkViewKind<VscodeWorkViewRef> = {
  kind: "vscode",
  label: "VS Code",
  icon: vscodeIcon,
  shortcut: VSCODE_WORK_VIEW_SHORTCUT,
  // One VS Code per conversation: launching it again focuses the open one.
  single: true,
  create: () => ({ kind: "vscode" }),
  key: () => "vscode",
  title: () => "VS Code",
  render: (_ref, ctx) => html`<hui-vscode-view .sessionId=${ctx.sessionId} .visible=${ctx.visible} .narrow=${ctx.narrow}></hui-vscode-view>`,
};
