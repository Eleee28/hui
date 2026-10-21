/**
 * The narrow-screen destination chooser: the chat panes of the split workspace, the focused conversation's open Work
 * views and its Work view launchers. It reads what to list and reports a choice; which pane, view or destination is
 * shown stays with the layout's and the Work pane's owner (hui-app).
 */
import { html, nothing, type TemplateResult } from "lit";
import { icons } from "../lib/icons.ts";
import type { SessionPane } from "../lib/session/multiplexer.ts";
import { renderPicker } from "./settings-picker.ts";
import type { PickerOption } from "../lib/picker-options.ts";

type PanelOption = PickerOption & { icon: TemplateResult };

export type PanelSelectorWorkView = { key: string; title: string; icon: TemplateResult };
export type PanelSelectorLauncher = { kind: string; label: string; icon: TemplateResult; unavailable?: string };

export type PanelSelectorProps = {
  panes: readonly SessionPane[];
  activePaneId: string;
  sessionTitle: (sessionId: string) => string | undefined;
  workViews: readonly PanelSelectorWorkView[];
  launchers: readonly PanelSelectorLauncher[];
  /** The Work destination is shown (instead of the chat). */
  workShown: boolean;
  /** The active Work view's key while the Work destination is shown. */
  activeWorkKey?: string;
  onSelectPane: (paneId: string) => void;
  onSelectWork: (key: string) => void;
  /** The empty Work destination (its launchers), when no view is open. */
  onShowWork: () => void;
  onLaunch: (kind: string) => void;
};

/** Option values are prefixed so chat panes, Work views and launchers never collide. */
export function panelSelectorOptions(props: Pick<PanelSelectorProps, "panes" | "sessionTitle" | "workViews" | "launchers">): PanelOption[] {
  const chats = props.panes.filter(({ terminalId, browser }) => !terminalId && !browser);
  return [
    ...chats.map((pane, index) => ({
      value: `pane:${pane.id}`,
      icon: icons.messageSquare,
      label: chats.length > 1 ? `${index + 1} · Chat` : "Chat",
      description: props.sessionTitle(pane.sessionId) ?? "Session",
    })),
    ...props.workViews.map((view) => ({ value: `work:${view.key}`, icon: view.icon, label: view.title, description: "Work" })),
    ...(props.workViews.length ? [] : [{ value: "work:", icon: icons.panelRightOpen, label: "Work", description: "Nothing open" }]),
    ...props.launchers.map((launcher) => ({
      value: `launch:${launcher.kind}`,
      icon: icons.plus,
      label: launcher.label,
      description: launcher.unavailable ?? "Open",
      disabled: Boolean(launcher.unavailable),
    })),
  ];
}

/** Narrow-layout switcher between the chat panes and the Work destination. Hidden on wide screens by CSS. */
export function renderPanelSelector(props: PanelSelectorProps) {
  if (!props.panes.length) return nothing;
  const options = panelSelectorOptions(props);
  const value = props.workShown ? `work:${props.activeWorkKey ?? ""}` : `pane:${props.activePaneId}`;
  return html`<div class="hui-panel-selector">
    ${renderPicker({
      label: "Active panel",
      value: options.some((option) => option.value === value) ? value : options[0]!.value,
      options,
      className: "hui-panel-selector__picker",
      showSelectedDescription: true,
      showOptionTooltips: false,
      renderLeading: (option) => (option as PanelOption).icon,
      onChange: (choice) => {
        if (choice.startsWith("pane:")) props.onSelectPane(choice.slice(5));
        else if (choice === "work:") props.onShowWork();
        else if (choice.startsWith("work:")) props.onSelectWork(choice.slice(5));
        else if (choice.startsWith("launch:")) props.onLaunch(choice.slice(7));
      },
    })}
  </div>`;
}
