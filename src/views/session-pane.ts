/**
 * One chat pane of the split workspace: an embedded `<hui-app>` bound to its pane's session, presentation and the
 * shell callbacks it reports to (close, split, Work views, navigation, the session registry and drafts). Terminals and
 * the browser view live in the Work pane.
 */
import { html } from "lit";
import type { Attachment, SessionGroup, SessionView } from "../api/sessions.ts";
import type { BotView } from "../lib/bots/bots.ts";
import type { SessionPane, SplitDirection } from "../lib/session/multiplexer.ts";
import type { PanePresentation } from "../components/session-multiplexer.ts";

export type SessionPaneProps = {
  pane: SessionPane;
  state: PanePresentation;
  session: SessionView | undefined;
  listed: SessionView | undefined;
  groups: readonly SessionGroup[] | undefined;
  mobileNav: boolean;
  bots: readonly BotView[];
  onClose: (() => void) | undefined;
  onSplit: ((direction: SplitDirection) => void) | undefined;
  onTerminal: () => Promise<void>;
  onBrowser: () => void;
  onNavigate: (id: string) => void;
  onRegistryChange: () => Promise<void>;
  onUpdate: (text: string, attachments: readonly Attachment[]) => boolean;
  onDraftChange: (sessionId: string, hasDraft: boolean) => void;
  onOpenBot: (id: string) => void;
};

export const renderSessionPane = (props: SessionPaneProps) => html`
    <hui-app
      class="chat-split-view__pane hui-session-pane-app"
      embedded-pane
      pane-session-id=${props.pane.sessionId}
      .paneSession=${props.session}
      .paneId=${props.pane.id}
      .paneActive=${props.state.active}
      .paneVisible=${props.state.visible}
      .paneNarrow=${props.state.narrow}
      .paneMobileNav=${props.mobileNav}
      .onPaneClose=${props.onClose}
      .onPaneSplit=${props.onSplit}
      .onPaneTerminal=${props.onTerminal}
      .onPaneBrowser=${props.onBrowser}
      .onPaneNavigate=${props.onNavigate}
      .onPaneRegistryChange=${props.onRegistryChange}
      .paneCreating=${props.listed?.creating}
      .paneCreationError=${props.listed?.creationError}
      .paneUnsentPrompt=${props.listed?.initialPrompt}
      .paneGroups=${props.groups}
      .onPaneUpdate=${props.onUpdate}
      .onPaneDraftChange=${props.onDraftChange}
      .paneBots=${props.bots}
      .onPaneOpenBot=${props.onOpenBot}
    ></hui-app>`;
