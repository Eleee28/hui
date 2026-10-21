import assert from "node:assert/strict";
import { test } from "vitest";
import type { SessionView } from "../api/sessions.ts";
import { renderSessionPane, type SessionPaneProps } from "./session-pane.ts";

function bindings(props: SessionPaneProps): Map<string, unknown> {
  const { strings, values } = renderSessionPane(props) as unknown as { strings: readonly string[]; values: unknown[] };
  return new Map(values.map((value, i) => [strings[i]!.match(/(\S+)=$/u)![1]!, value]));
}

function props(overrides: Partial<SessionPaneProps> = {}): SessionPaneProps {
  const noop = () => {};
  return {
    pane: { id: "pane-2", sessionId: "s1" },
    state: { active: true, visible: true, narrow: false, split: true },
    session: undefined, listed: undefined, groups: undefined, mobileNav: false, bots: [],
    onClose: noop, onSplit: noop, onTerminal: async () => {}, onBrowser: noop, onNavigate: noop,
    onRegistryChange: async () => {}, onUpdate: () => false, onDraftChange: noop, onOpenBot: noop,
    ...overrides,
  };
}

test("a pane is keyed by its pane id and names its session as an attribute", () => {
  const bound = bindings(props());
  assert.equal(bound.get("pane-session-id"), "s1");
  assert.equal(bound.get(".paneId"), "pane-2");
});

test("a pane closes through the shell's control, which exists only while split", () => {
  const close = () => {};
  assert.equal(bindings(props({ onClose: close })).get(".onPaneClose"), close);
  assert.equal(bindings(props({ onClose: undefined })).get(".onPaneClose"), undefined);
});

test("embedded panes open from the shell's registry entry instead of waiting on their own fetch", () => {
  const session = { id: "s1", title: "Build" } as SessionView;
  assert.equal(bindings(props({ session })).get(".paneSession"), session);
});

test("embedded chat panes report draft presence to the shell that owns the sidebar", () => {
  // Each pane is its own hui-app with a private draft set; without this bridge
  // the sidebar only learned about drafts at startup or after a reload.
  const reported: string[] = [];
  const onDraftChange = (sessionId: string, hasDraft: boolean) => reported.push(`${sessionId}:${hasDraft}`);
  const report = bindings(props({ onDraftChange })).get(".onPaneDraftChange") as SessionPaneProps["onDraftChange"];
  report("s1", true);
  assert.deepEqual(reported, ["s1:true"]);
});
