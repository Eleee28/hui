import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import * as sessionsApi from "./api/sessions.ts";
import type { RuntimeCompaction, SessionGroup, SessionView } from "./api/sessions.ts";
import type { ComposerController } from "./controllers/composer-controller.ts";
import type { ConversationController } from "./controllers/conversation-controller.ts";
import type { SessionsController } from "./controllers/sessions-controller.ts";
import type { WorkLayoutController } from "./controllers/work-layout-controller.ts";
import type { PanePresentation } from "./components/session-multiplexer.ts";
import { NEW_SESSION_DRAFT_KEY, sessionDraftKey } from "./lib/composer/drafts.ts";
import { singleSessionLayout, type SessionPane } from "./lib/session/multiplexer.ts";
import type { HomeProps } from "./views/home.ts";
import { closeDrawerOnEscape } from "./views/shell.ts";
import { HuiApp } from "./hui-app.ts";

const api = vi.hoisted(() => ({ calls: [] as unknown[][] }));
const textarea = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock("./api/sessions.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("./api/sessions.ts")>(),
  renameSession: async (...args: unknown[]) => {
    api.calls.push(["renameSession", ...args]);
    return new Promise(() => {});
  },
  resumeSession: async (...args: unknown[]) => {
    api.calls.push(["resumeSession", ...args]);
    return new Promise(() => {});
  },
}));

vi.mock("./lib/composer/textarea.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("./lib/composer/textarea.ts")>(),
  observeTextareaOverflow: (element: { id: string }) => textarea.calls.push(`observe ${element.id}`),
  disconnectTextareaOverflowObserver: (element: { id: string }) => textarea.calls.push(`disconnect ${element.id}`),
  scheduleTextareaHeightAdjustment: (element: { id: string }) => textarea.calls.push(`measure ${element.id}`),
}));

type Shell = {
  embeddedPane: boolean;
  paneSession: SessionView | undefined;
  paneMobileNav: boolean;
  paneActive: boolean;
  onPaneDraftChange: ((sessionId: string, hasDraft: boolean) => void) | undefined;
  onPaneNavigate: ((id: string) => void) | undefined;
  renderRoot: { querySelector: (selector: string) => unknown };
  settingsOpen: boolean;
  pendingSessionId: string;
  renamingFor: string;
  autoFollow: boolean;
  groupAction: unknown;
  composer: ComposerController;
  conversation: ConversationController;
  sessions: SessionsController;
  work: WorkLayoutController;
  connectedCallback: () => void;
  scheduleUpdate: () => void;
  updated: (changed: Map<string, unknown>) => void;
  render: () => unknown;
  renderSessionPane: (pane: SessionPane, state: PanePresentation) => unknown;
  renderSessionMultiplex: () => unknown;
  renderGroupActionDialog: () => unknown;
  homeProps: () => HomeProps;
  navigate: (target: { kind: "session"; id: string }) => void;
  applyNavigation: (target: { kind: "session"; id: string }) => void;
  openPendingSession: () => void;
  activateSession: (session: SessionView) => void;
  activePaneApp: () => { handleGlobalEscape: (event: KeyboardEvent) => void } | undefined;
  onGlobalKeyDown: (event: KeyboardEvent) => void;
  handleGlobalEscape: (event: KeyboardEvent) => void;
  closeSettings: () => void;
  scrollToBottom: () => void;
  continueRun: () => void;
  rename: (title: string) => void;
};

const shell = () => new HuiApp() as unknown as Shell;
const session = (id: string, extra: Partial<SessionView> = {}) => ({ id, title: "Build", status: "idle", ...extra }) as SessionView;
const pane = { id: "pane-1", sessionId: "s1" };
const presented = { active: true, visible: true, narrow: false, split: true };

function bindings(template: unknown): Map<string, unknown> {
  const { strings, values } = template as { strings: readonly string[]; values: unknown[] };
  return new Map(values.map((value, i) => [strings[i]!.match(/(\S+)=$/u)?.[1] ?? `\${${i}}`, value]));
}

function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).join("");
  if (value && typeof value === "object" && "strings" in value && "values" in value) {
    const template = value as { strings: readonly string[]; values: unknown[] };
    return template.strings.map((part, i) => part + text(template.values[i])).join("");
  }
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function template(value: unknown, marker: string): unknown {
  if (Array.isArray(value)) return value.map((item) => template(item, marker)).find(Boolean);
  if (!value || typeof value !== "object" || !("strings" in value) || !("values" in value)) return undefined;
  const { strings, values } = value as { strings: readonly string[]; values: unknown[] };
  return strings.join("").includes(marker) ? value : values.map((item) => template(item, marker)).find(Boolean);
}

function escape() {
  const event = { key: "Escape", defaultPrevented: false, isComposing: false, composedPath: () => [], preventDefault: () => { event.defaultPrevented = true; } };
  return event as unknown as KeyboardEvent & { defaultPrevented: boolean };
}

beforeEach(() => {
  api.calls = [];
  textarea.calls = [];
  vi.stubGlobal("document", { querySelector: () => null });
  vi.stubGlobal("HTMLDialogElement", class {});
});

test("the shell hands a split pane its registry entry, so the pane opens without its own fetch", () => {
  const app = shell();
  const listed = session("s1");
  app.sessions.groups = [{ name: "Frontend", sessions: [listed] } as unknown as SessionGroup];
  assert.equal(bindings(app.renderSessionPane(pane, presented)).get(".paneSession"), listed);
});

test("a pane opens its session from the entry the shell handed it", () => {
  const app = shell();
  const opened: SessionView[] = [];
  app.activateSession = (target) => opened.push(target);
  app.embeddedPane = true;
  app.paneSession = session("s1");
  app.pendingSessionId = "s1";
  app.openPendingSession();
  assert.deepEqual(opened, [app.paneSession]);
});

test("the shell marks a split pane's reported draft on its own sidebar", () => {
  const app = shell();
  (bindings(app.renderSessionPane(pane, presented)).get(".onPaneDraftChange") as (sessionId: string, hasDraft: boolean) => void)("s1", true);
  assert.deepEqual([...app.composer.draftSessionIds], ["s1"]);
});

test("only an embedded pane reports its drafts to the shell that owns the sidebar", async () => {
  for (const embeddedPane of [true, false]) {
    const app = shell();
    const reported: string[] = [];
    app.embeddedPane = embeddedPane;
    app.onPaneDraftChange = (sessionId, hasDraft) => reported.push(`${sessionId}:${hasDraft}`);
    await app.composer.persistDraft(sessionDraftKey("s1"), "draft", []);
    assert.deepEqual(reported, embeddedPane ? ["s1:true"] : []);
  }
});

test("returning to the still-selected session restores its composer draft key", () => {
  // New session keeps `selected` but switches the composer to the new-session
  // draft. Without this, typing after returning persisted under the wrong key
  // and the row never showed its pencil. The restored draft is composer-controller.test.ts's.
  const app = shell();
  app.conversation.select(session("s1"));
  app.composer.switchDraft(NEW_SESSION_DRAFT_KEY);
  app.applyNavigation({ kind: "session", id: "s1" });
  assert.equal(app.composer.draftKey, sessionDraftKey("s1"));
  assert.equal(app.pendingSessionId, "");
});

test("Escape on the shell's frame closes the mobile drawer", () => {
  const app = shell();
  app.renderRoot = { querySelector: () => null };
  assert.equal(bindings(template(app.render(), 'class="shell app-shell')).get("@keydown"), closeDrawerOnEscape);
});

test("document-level Escape closes Settings or stops the running turn", () => {
  const app = shell();
  let closed = 0;
  app.closeSettings = () => { closed += 1; };
  app.settingsOpen = true;
  const event = escape();
  app.onGlobalKeyDown(event);
  assert.equal(closed, 1);
  assert.equal(event.defaultPrevented, true);

  const embedded = shell();
  let aborted = 0;
  embedded.composer.abort = () => { aborted += 1; };
  embedded.embeddedPane = true;
  embedded.conversation.select(session("s1"));
  embedded.conversation.streaming = true;
  const stop = escape();
  embedded.handleGlobalEscape(stop);
  assert.equal(aborted, 1);
  assert.equal(stop.defaultPrevented, true);
  embedded.conversation.stopping = true;
  embedded.handleGlobalEscape(escape());
  assert.equal(aborted, 1);
});

test("embedded panes omit global monitors and delegate routing and Escape", () => {
  const app = shell();
  const started: string[] = [];
  app.sessions.start = () => started.push("sessions");
  app.scheduleUpdate = () => {};
  app.embeddedPane = true;
  vi.stubGlobal("window", { addEventListener: () => {} });
  app.connectedCallback();
  assert.deepEqual(started, []);

  const routed: string[] = [];
  app.onPaneNavigate = (id) => routed.push(id);
  app.navigate({ kind: "session", id: "s2" });
  assert.deepEqual(routed, ["s2"]);

  const host = shell();
  const delegated: KeyboardEvent[] = [];
  host.activePaneApp = () => ({ handleGlobalEscape: (event) => delegated.push(event) });
  host.conversation.select(session("s1"));
  const event = escape();
  host.onGlobalKeyDown(event);
  assert.deepEqual(delegated, [event]);

  app.paneMobileNav = true;
  app.paneActive = false;
  assert.equal(app.homeProps().mobileNavLayout, false);
  app.paneActive = true;
  assert.equal(app.homeProps().mobileNavLayout, true);
});

test("the narrow panel selector is the shared HUI picker, not a native select of the shell's", () => {
  const app = shell();
  app.conversation.select(session("s1"));
  app.work.layout = singleSessionLayout("s1");
  const multiplex = text(app.renderSessionMultiplex());
  assert.match(multiplex, /hui-panel-selector/u);
  assert.doesNotMatch(multiplex, /<select/u);
});

test("a group's default directory uses the themed combobox instead of a native datalist", () => {
  const app = shell();
  app.groupAction = { action: "defaults", group: { name: "Frontend", label: "Frontend", sessions: [] } };
  const dialog = text(app.renderGroupActionDialog());
  assert.match(dialog, /id=group-default-cwd [^>]*role="combobox"/u);
  assert.doesNotMatch(dialog, /<datalist/u);
});

test("Configure default prefix opens Settings → Worktrees at the branch prefix", () => {
  const app = shell();
  const opened: unknown[] = [];
  (app as unknown as EventTarget).dispatchEvent = (event: Event) => {
    opened.push((event as CustomEvent).detail);
    return true;
  };
  app.homeProps().onOpenBranchPrefixSettings();
  assert.deepEqual(opened, [{ page: "worktrees", section: "branch-prefix" }]);
});

test("Continue without a prompt resumes the selected session; no rewind checkpoints are loaded", () => {
  const app = shell();
  app.conversation.select(session("s1"));
  app.continueRun();
  assert.deepEqual(api.calls, [["resumeSession", "s1"]]);
  assert.equal("loadSessionCheckpoints" in sessionsApi, false);
});

test("renaming the selected session sends only its new title", () => {
  const app = shell();
  app.conversation.select(session("s1", { title: "Old" }));
  app.renamingFor = "s1";
  app.rename("New");
  assert.deepEqual(api.calls, [["renameSession", "s1", { title: "New" }]]);
});

test("the composer textarea is observed, remeasured when code replaces its draft, and released", () => {
  const app = shell();
  let current: { id: string } | null = { id: "first" };
  app.embeddedPane = true;
  app.renderRoot = { querySelector: (selector) => selector === ".agent-chat__composer-combobox > textarea" ? current : null };
  app.updated(new Map());
  assert.deepEqual(textarea.calls, ["observe first", "measure first"]);
  app.updated(new Map());
  app.composer.setDraft("replaced");
  app.updated(new Map());
  assert.deepEqual(textarea.calls.slice(2), ["measure first"]);
  current = null;
  app.updated(new Map());
  assert.deepEqual(textarea.calls.slice(3), ["disconnect first"]);
});

test("the thread follows the live compaction divider like new transcript rows", () => {
  const app = shell();
  let follows = 0;
  app.scrollToBottom = () => { follows += 1; };
  app.renderRoot = { querySelector: () => null };
  app.updated(new Map());
  const settled = follows;
  app.updated(new Map());
  assert.equal(follows, settled);
  app.conversation.compaction = { status: "running" } as unknown as RuntimeCompaction;
  app.updated(new Map());
  assert.equal(follows, settled + 1);
  app.autoFollow = false;
  app.conversation.compaction = undefined;
  app.updated(new Map());
  assert.equal(follows, settled + 1);
});
