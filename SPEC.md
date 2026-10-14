# SPEC — HUI owns the sessions

Specifications for the dashboard, session ownership and installed gateway.

---

# Part 1 — Dashboard shell

Copy OpenClaw's Control UI layout, adapted to operating pi sessions.

## What the layout is

| OpenClaw region | HUI |
|---|---|
| `sidebar-agent-card` — identity card at the top | removed; HUI has no agent identity selector |
| `sidebar-brand` — brand line with actions | new session then session search on the left; collapse on the right |
| `sidebar-nav` — page destinations | Contributions, Automations, Plugins, Skills, then Settings; no Home entry. Other retained pages stay reachable by URL and the command palette; dropped OpenClaw routes are absent |
| `sidebar-online` / session sections — collapsible groups of rows | groups, flattened, with session rows |
| `sidebar-footer-bar` — identity + connection state | removed; Settings is the last sidebar destination |
| main region — header, body, composer | session header, transcript, composer |

## Behaviour

- Transcript messages expose Copy and Reply; Reply appends an editable Markdown
  quote to the existing draft and focuses the composer without sending it.
  Message footers show relative time with an exact-date tooltip. A measured
  completion time takes precedence over the original message creation time.
- Completed model calls expose output tokens and measured duration with a
  disclosure for input/cache tokens and reported cost. Tool blocks show measured
  execution duration. PI usage belongs to the entire model call (including
  reasoning), displayed once on its last text/reasoning block (or last tool call when no text exists). Missing values
  remain absent; HUI never estimates per-fragment tokens or historical duration.
  Live timings survive browser reconnects, not a PI runtime/gateway restart.

- Session search is the field directly below the sidebar header; it filters the
  session list and is not duplicated in the Sessions toolbar or a bottom footer.
  The mobile top bar's Search opens it, and Ctrl+K (⌘K) finds sessions in the
  command palette. The header holds only the collapse toggle, at its top-left,
  where the restore control appears while the sidebar is collapsed, so toggling
  needs no mouse travel (the owner dropped the header's New session and Search
  buttons on 2026-10-06; new sessions start from a group's +). Settings is the
  last primary-navigation destination, not a header button.
- Appearance includes the native OpenClaw Miami palette in light, dark and
  system modes. Theme, accent, interface-font and chat-prose-font preferences
  persist in HUI settings. The two font selectors expose OpenClaw's ten choices
  independently, while code retains its dedicated monospace stack. Choosing
  Miami does not replace a custom preference.
- Gateway settings shows labeled green/red connection states and an amber
  initial loading state. Health refreshes every three seconds while that page
  is visible. Failed checks label cached runtime values as last known; retry
  and subsequent successful checks restore the connected state. Uptime uses
  compact days/hours/minutes (seconds only below one minute).
- On macOS, Gateway settings adds **Power**, bounded by the gateway process:
  **Keep Mac awake** (a saved choice, on by default, like `caffeinate -i`) and
  **Stay awake with the lid closed** (like `sudo pmset -a disablesleep 1`),
  marked as needing administrator permission. The lid switch is never saved:
  every gateway start begins with it off and without a password prompt; turning
  it on asks for a password; turning it off, stopping the gateway or a gateway
  crash restores normal sleep. After a reboot left it on, it starts on with a
  note until turned off, which asks to restore sleep. While the Mac is held awake
  with the lid closed, a top notice says so and offers **Turn off**; dismissing
  it lasts until it turns on again or the page reloads. Each switch shows what
  the gateway actually holds (Off, Pending, Active, Failed with its reason).
- Groups are flat: one label per group.
- Groups collapse; the choice is remembered in the browser.
- The group menu's **New session defaults** stores directory, runtime and optional
  Git environment/base ref. A detected repo defaults to **Branch** and its default
  branch; **New worktree** applies to each new session independently. The suffix
  is chosen at launch, never shared by the group. Saving defaults does not mutate
  Git. New sessions opened from the group inherit them, but choosing a different
  directory resets Git choices; legacy groups need no migration.
- In custom-group mode, sessions can be moved between groups by dragging a row
  onto a group or with the row menu's keyboard-accessible **Move to group**
  submenu. The row menu follows OpenClaw's action hierarchy: pin, rename,
  unread, archive, icon, group placement, copy, open and delete. Archived
  sessions leave the sidebar and remain restorable from Sessions, whose table
  opens on **All** (then Active, Archived) and whose filter popover narrows by
  live status and groups rows by custom group or project directory; these are
  browser-only view choices. Row checkboxes (and a select-all for the rows
  shown) select sessions for one confirmed bulk delete of their trees; the
  confirmation can also remove worktrees used only by deleted sessions, never
  forcing past local changes or a worktree HUI did not create. While the row
  menu is open, its displayed P/R/U/A/D keys activate their actions immediately
  rather than using typeahead (D still opens the delete confirmation). Modified
  shortcuts, held-key repeats, text inputs and nested submenus retain native
  keyboard behavior. Successful archiving shows a dismissible toast with Restore,
  which restores the session tree through the existing archive API. The toast
  expires after 15 seconds of inactivity, pauses on hover/focus, and retains a
  retryable error if restoration fails. No toast is shown before archive succeeds;
  those flags
  and appearance choices are HUI metadata and never modify PI's transcript.
  The appearance picker includes OpenClaw's preset grid and custom-emoji entry;
  custom values use the same bounded session-icon metadata contract.
  Project grouping remains a read-only projection and never becomes a drop target.
- OpenClaw's **Assign to** is absent because PI has no multi-user ownership
  model. **Fork conversation** is absent from the row menu: a Pi Durable session
  forks from a reply in its transcript instead (below). A session still on PI
  never forks; HUI never copies or rewrites PI's JSONL to imitate a fork.
- In custom-group mode, custom groups are reordered by dragging a group header
  above or below another group, or with the group menu's keyboard-accessible
  **Move group up** / **Move group down** actions. The order persists in the HUI
  registry; OTHER always stays last and is not draggable.
- The Sessions toolbar always exposes **New group**, including an empty registry
  or a list containing only ungrouped sessions. Group labels display in uppercase;
  the ungrouped section is **OTHER**, after custom groups in their saved order. Stored labels remain
  unchanged, including their original casing.
- **Filter & sort** groups sessions by custom group, project directory or not at
  all; sorts by creation time, last update, name or development stage
  (Investigation to Done, recency breaking ties); filters by live HUI status;
  and hides empty groups always, never or only while filtering. Pinned sessions
  remain first. These browser-local preferences do not mutate the registry.
  Project groups are directory projections, not editable custom groups. Only
  HUI-backed options are shown; owner and archive filters are not simulated.
- `⌘K` / `Ctrl+K` opens a keyboard-navigable command palette over retained
  routes, Settings areas and HUI sessions.
- Session rows use the reference's title/text/aside hierarchy. Running sessions
  show its animated glyph; waiting and error sessions show attention indicators.
  Ownerless idle PI sessions do not invent an avatar or status decoration.
  Live health is process-owned and never persisted in the registry; unread
  state is persisted so it survives a gateway restart. A settled background
  session shows the reference accent-colored unread dot until its conversation
  is opened.
- A session that created GitHub pull requests shows one state-colored pull
  request mark per PR beside its title (open green, draft gray, merged purple,
  closed red). The marks form a strip whose newest mark sits at the trailing
  edge; when more exist, the next one shows half-visible and faded to signal
  that the strip scrolls. Hovering the title narrows the strip to the newest
  mark so the title and row actions have room; hovering or focusing the strip
  widens it to at most half of the space beside the row actions, so the title
  keeps the other half, and the mouse wheel (or a swipe on touch) scrolls through every PR.
  It returns to the newest mark once pointer and focus leave. Hover or keyboard focus
  opens a card directly below the mark (above it near the viewport bottom) with
  `owner/repo#number`, the state, title and the Markdown description. The
  pointer can move from the mark onto the card and scroll a long description
  without it closing; activating the mark opens the PR on GitHub in a new tab. PRs are
  detected only from a `gh pr create` (or create-pull-request tool) result in
  the live transcript; state and text come from the shared GitHub previews (`gh api`), cached
  in memory and never persisted. Unconfirmed PRs render neutral, never guessed.
- Sessions linked to Jira Cloud work items show a Jira mark in the leading status
  column (aligned with child status glyphs; live attention/running status wins),
  colored by status category. Hover opens a card with the key, type, status,
  summary and a scrollable Markdown description; clicking opens Jira. The
  session menu offers "Create Jira work item…": the default project from
  Settings → Integrations → Jira is preselected but changeable, the parent defaults to the
  utility model's pick from open parent-level items, and the summary and
  description are drafted by the utility model; new items are assigned to the
  connected account by default. Edits are never overwritten by
  the draft. "Link Jira work item…" links an existing item: it lists recently
  viewed work items and searches Jira by key, pasted URL or summary text.
  Once a session is linked, those two items are hidden; the sidebar menu's
  "Open in" and "Copy" submenus gain the latest linked item, and the Kanban card
  menu offers "Open in Jira" and "Copy Jira link".
  Settings → Integrations → Jira walks the operator through creating an Atlassian
  API token; HUI verifies it and keeps it server-side only.
- Agents record bugs or problems found along the way with `suggest_task`
  instead of fixing them inline or burying them in prose, and when the operator
  asks for one ("let's add a follow-up for this"). Unlike OpenClaw's
  instruction prompt, a card describes the problem (what happens, where,
  evidence) and a proposed fix only when one is known; otherwise the fix reads
  "Not known yet". The open session shows a *Suggested task · in <directory>*
  card in the transcript's top-right gutter (OpenClaw's task suggestion design,
  stacked with a position counter when there are several): title, problem
  preview, collapsible directory with Markdown Problem / Proposed fix, Copy and
  Dismiss. *Start in a new session* creates a session in that directory whose
  first turn is the problem plus the fix, or a request to confirm the root
  cause first; its arrow menu, as in OpenClaw, also offers *Start in a new
  worktree* (same, in a fresh Git worktree) and *Start in this session*; *Create Jira task* opens the Jira dialog prefilled from the card. Either action resolves the card. Cards live only in gateway memory
  and disappear on restart.
- Settings → Integrations → GitHub shows the gateway's GitHub CLI account.
  *Connect GitHub* runs `gh auth login --web` on the HUI machine and shows the
  one-time code (with Copy) and a link to `github.com/login/device`, following
  OpenClaw's device-code layout; once GitHub confirms, the section turns
  Connected. Without `gh` on the gateway's PATH it shows "GitHub CLI required"
  with an install link instead of a sign-in button. The token stays in gh.
- Contributions (first sidebar destination) has two tabs, *GitHub* (default)
  and *Calendar*; the browser remembers the choice, and GitHub is read only
  once its tab is shown. The GitHub tab charts the GitHub activity of every
  account signed in to `gh` on the HUI machine: a GitHub-style calendar (a
  square per local day, month and Mon/Wed/Fri labels, Less→More legend, hover
  for the day's count) and a bar per week (hover for the week's count). One *Commits* / *Pull requests*
  switch (default commits) drives both charts: commits authored on default
  branches, as GitHub search indexes them, or pull requests opened. An *Account*
  picker narrows both to one login (default *All accounts*). The browser
  remembers both choices; a remembered login that is no longer signed in shows
  *All accounts* until it returns. GitHub's year list
  beside the charts (a scrolling row on narrow screens) picks *Last 12 months*
  (default) or a calendar year, from this year back to the oldest account's
  creation; the current year leaves its future days blank.
  Data comes from GitHub search, not the contribution calendar API,
  which is empty for Enterprise Managed Users. Accounts other than the active
  one are read with their own `gh` token, used only on the gateway. Results are
  cached for 15 minutes; *Refresh* reads again. Reaching GitHub's search rate
  limit waits about a minute instead of failing. An account that fails shows
  its error above the charts while the others still render, and a year that
  fails to load leaves the previous one selected; with no account, the page
  links to Settings → Integrations.
- The Calendar tab opens on one week (Monday first, *Previous week* / *This
  week* / *Next week*, never past the current week, and *Refresh*) of the
  operator's HUI sessions: subagent sessions are left out, archived ones
  included. Selecting a non-future date heading opens that day as one
  full-width column. *Previous day* / *Today* / *Next day* navigate days,
  never past the current activity day; *Back to week* shows the week containing
  the selected day. Grouping is retained, as is item focus when that item has
  activity in the new period. Titles, counts, totals, session breakdowns and
  card totals refer only to the selected day or week; the *Hours per day*
  chart appears only in Week. Loading disables date navigation; a failed
  request keeps the previous period and shows the error. The date/view is not
  saved between visits. A session was worked on from one message to the next until 30
  minutes pass without one. *Group by* (remembered by the browser) chooses what
  the grid draws as one color: *Project* (default), the Git repository a session
  ran in, which its worktrees and subdirectories share (`~` for the home
  directory, a folder's own name outside Git); *Group*, the sidebar group
  (*Other* when ungrouped); or *Session*. A project's or group's sessions merge
  visually into one block wherever they are at most 30 minutes apart. The
  recorded activity totals remain unions of the original session blocks;
  visual joining never adds idle time, and grouping never changes the total.
  A day runs from
  5 AM to 5 AM, so late-night work stays in the column of the day it began; the
  hour axis covers 9 AM to 6 PM and every block. Colors come from the session
  palette, then the same colors shaded, busiest in the selected period first, repeating after sixteen.
  Overlapping blocks share their day in side-by-side lanes and widen into lanes
  nothing beside them uses; a block too narrow for its name shows only its
  color, and a one-message block is drawn 30 minutes tall.
  Today's column is tinted with a line at the current time. Activating a block
  opens a card beside it (below it on narrow screens) with its name, day,
  start–end and recorded activity for that day's part, and its total for the selected day or week.
  Under *Session* it shows the
  session's project, group and model, the operator's first message in the block
  and *Open session*; under *Project* or *Group* it lists the block's sessions,
  most time first, with their recorded time in that day's part and first message,
  in a scrollable list, each opening its session. Escape or a click elsewhere closes it. The
  heading shows the week, how many sessions and blocks it had and, when more
  than one, the most sessions running at once. Beside the grid (below it on
  narrow screens), the total working time counts parallel sessions once
  ("29h 25m across 5 projects", a bar split by color, and the summed session
  time); every project, group or session follows with its time, most first.
  Hovering one dims the others' blocks; activating it focuses the grid on only
  that item, with full-width day blocks, and, for a project or group, lists its
  sessions with their time, each opening its session. *Show all* or activating
  the same item again restores the overview. *Hours per day* charts each day's working
  time and labels the busiest. Only Durable conversations are read; sessions
  still on PI's worker appear once `hui doctor --fix` moves them. A rewind
  continues the session on a copy of the history before that point, so the
  time spent on the abandoned branch leaves the calendar.
- Chat messages unfurl GitHub repositories, pull requests and issues (URLs or
  `owner/repo#N`) as cards after the message, at most three per message like
  Slack: PRs show state, title, description snippet, author and diff stats;
  issues show state, labels and comments; repositories show description,
  language, stars and forks. Facts come from the same `gh` login as PR badges;
  without it the card still links to GitHub and says why there is no preview.
  Hovering a PR card shows its full description in the PR badge hovercard.
  Settings → Appearance → Chat → *GitHub link previews* turns embeds off.
- The session multiplexer follows OpenClaw 2026.9.5: columns contain vertically
  stacked panes. Drag a sidebar session to any pane's left/right edge to add a
  column, top/bottom edge to add a row, or center to replace that pane's session.
  The preview uses the original 30% edge bands and half-pane indicator. Same-
  session splits are allowed. **Open split view**, **Split down**, **Split right**
  and **Close session pane** operate on the focused pane; keyboard-accessible
  menus remain available. Pointer or keyboard focus selects the pane and route.
  Each view retains its transcript, composer, draft, queue and detailed stream.
  Column and row dividers support pointer resizing, arrow keys (2%, Shift 5%)
  and Home/End (15%/85%). Layout, focus and weights are browser-local, not registry
  data; the URL identifies the active session. Below 1100px only the active pane
  is visible, with the other panes still mounted; sidebar selection changes focus.
  Any pane can close without stopping its runtime or remounting survivors.
- Existing chat panes can be repositioned by dragging their header
  or move handle. Edges relocate the pane into a column or stack; center drops
  swap both panes. Self-drops and cancellation do nothing. Pane identity,
  cached views, drafts, scroll and streams survive moves;
  the moved pane keeps focus. Arrow keys on **Move panel** provide a keyboard
  path beside neighboring panes. The layout persists in the existing browser
  format. Moving is desktop-only, like edge splitting; narrow screens retain
  the active-pane presentation and do not expose an unusable drag handle.
- The **Work pane** (after AgentsInTheCloud's) sits to the right of the chat
  panes and shows the Work views of the focused conversation: its terminals and
  its browser view, its Files views (see *Files*), its VS Code view (see
  *VS Code*) and its Diff views (see *Diff*), each a kind registered through one contract
  (`src/lib/work-pane.ts`). Each conversation has its own pane; moving
  focus to another chat pane or conversation switches the contents. One view is
  visible at a time, chosen from a tab strip (icon, title, close; drag or
  Alt+Shift+Arrow to reorder, Arrow/Home/End to move, Delete to close). The **+**
  menu launches views (Ctrl+Alt+Shift+T / ⌥⇧⌘T new terminal, Ctrl+Alt+Shift+B /
  ⌥⇧⌘B browser, Ctrl+Alt+Shift+F / ⌥⇧⌘F a new Files view, Ctrl+Alt+Shift+C /
  ⌥⇧⌘C VS Code, Ctrl+Alt+Shift+D / ⌥⇧⌘D a new Diff view)
  and reopens running terminals whose tab was closed; with nothing open the pane
  lists the same launchers with their shortcuts. A launcher that cannot act says
  why in visible text (the browser tool turned off, a conversation on a remote
  worker has no local terminal) and, when a setting changes that, links to its
  Settings section, which opens scrolled to it with a little room (`--space-6`)
  above its heading. The VS Code launcher is always available; its view explains
  what it needs on first open (see *VS Code*). Closing the last view (its tab's close button or Delete, or a view
  that removes itself, such as a terminal ended from its menu) hides the pane just as **Hide Work pane** does: the
  chat returns to full width, a maximized pane is restored, narrow screens return to the chat and focus left in the
  pane moves to the composer; showing the pane again lists the launchers. Only that removal hides it: a pane loaded,
  restored or switched to without views stays as it was. **Hide Work pane** (Ctrl+Alt+Shift+P / ⌥⇧⌘P) collapses it to a rail
  with one button per open view; its left edge resizes with the pointer or the
  arrow keys (Shift for larger steps, Home/End for the limits), keeping at least
  420px for each chat column side by side: the pane yields width down to its own
  320px minimum, and when even that does not fit (say three split chats) it shows
  as its rail until the operator expands it anyway or a view is opened, then at
  its minimum with the chat columns narrower. While the pane is open the chat
  splitter keeps the same 420px per column: the columns share the room by their
  weights above it (closing a column rebalances the survivors rather than leaving
  one at 320px), the divider stops where a column would drop below it, and when
  420px each does not fit the columns share the room equally, down to the usual
  320px. **Maximize Work pane** (header button beside **+**, Ctrl+Alt+Shift+M / ⌥⇧⌘M) lets the pane take the
  whole content area beside the sidebar, for a full-size terminal, browser, Files editor or VS Code: the chat
  columns are hidden but stay mounted (streams, scroll and drafts survive; no view is re-created and no terminal
  replays) and the views refit to the new size. While maximized, the narrow layout's panel selector shows above the
  pane, listing the chat panes, the open Work views and the launchers: choosing a chat pane restores the chat beside
  the pane, choosing a view switches to it. **Restore Work pane** (the same button and shortcut) or hiding the pane
  also restores. Escape is not bound to restoring: it keeps going to the terminal or VS Code that has focus, and
  elsewhere in the pane moves focus to the panel selector (it never stops the hidden chat's turn). Maximized is per
  conversation and desktop only; narrow screens, already one panel at a time, ignore it. Escape inside the pane returns focus to the chat and never
  stops the agent's turn. Below 1100px the pane is a full-screen destination: the
  panel selector lists the chat panes, the open Work views and the launchers, and
  **Back to chat** or Ctrl+Alt+Shift+P returns. Hidden views stay mounted, so terminals
  and pages keep their state across tab switches, collapsing and focus changes,
  for the three most recently focused conversations that have views; a view of
  an older one reconnects (a terminal replays its snapshot) when shown again.
  Open/closed and maximized state, width, views and the active view are browser-local
  (`localStorage` `hui.work-pane.v1`, keyed by session id); unknown kinds and
  malformed records are dropped on load, and a removed conversation's record
  goes with it. Layouts saved before the Work pane load without loss: their
  terminal and browser panes move into their conversation's Work pane and the
  chat panes, splits and tabs stay as they were.
- **Work pane shortcuts** are one scheme: Mod+Alt+Shift plus the initial of what
  they open (⌥⇧⌘ on macOS, Ctrl+Alt+Shift elsewhere): **T** new terminal, **B**
  browser, **F** Files, **C** VS Code ("Code": ⌥⇧⌘V is Paste and Match Style), **D** Diff,
  **P** to show or hide the pane and **M** to maximize or restore it. They are listened for on the document in
  the capture phase, so they work from the composer, inside a terminal and inside
  the Files editor (CodeMirror's own Alt chords, ⌥⌘G go to line and ⌥⌘\ indent,
  never include Shift). The VS Code view is a cross-origin frame: while focus is
  inside it every key, these included, belongs to VS Code; click the tab strip
  or the chat to use them again. Each one is shown where it acts (launchers,
  **+** menu, rail and toggle tooltips, `aria-keyshortcuts`). The table and the chords it avoids live
  in `src/lib/work-shortcuts.ts`, whose test fails if a binding lands on one.
  Plain ⌥⌘/Ctrl+Alt letters are not used: Apple's standard keys take ⌥⌘T
  (toolbar), ⌥⌘F (search field), ⌥⌘V (apply style), ⌥⌘W (close all windows;
  Safari: Close Other Tabs) and ⌥⌘C/D/H/I/M; Chrome takes ⌥⌘B (Bookmark Manager),
  ⌥⌘F (search the web), ⌥⌘I/J/U/P/N; Safari ⌥⌘B (Edit Bookmarks) and ⌥⌘L/U;
  Firefox ⌥⌘F/R/U and its developer tools ⌥⌘I/K/C/E/M/J/Z, and Ctrl+Alt+R/X/Z
  on Linux and Windows; GNOME takes Ctrl+Alt+T before the page sees it, KDE and
  Xfce Ctrl+Alt+L. With Shift only ⌥⇧⌘Q (log out) and ⌥⇧⌘V (Paste and Match
  Style) are standard on macOS, so the scheme skips Q and V; W stays out because
  Safari's Close All Windows is ⌥⇧⌘W. Terminal programs bind no Ctrl+Alt+Shift
  letters (Emacs and readline use Ctrl+Alt letters, which reach a terminal as
  Meta+Ctrl).
  Chrome lets a page cancel every accelerator except new/close tab or window,
  reopening a tab and tab switching (`IsReservedCommandOrKey`); Firefox reserves
  only its `reserved="true"` keys. On Windows layouts with AltGr, Ctrl+Alt is
  AltGr: a chord that types a character there (AltGr+E → €) stays text, one that
  types nothing is the shortcut. Sources: Apple HIG *Keyboards*
  (developer.apple.com/design/human-interface-guidelines/keyboards), Chrome
  keyboard shortcuts (support.google.com/chrome/answer/157179) and
  `chrome/browser/ui/browser_command_controller.cc`, Safari shortcuts
  (support.apple.com/guide/safari/cpsh003, ibrw1039, ibrw3ceda9e7), Firefox
  `browser/base/content/browser-sets.inc` with `browserSets.ftl` and the
  DevTools shortcut list (firefox-source-docs.mozilla.org/devtools-user/keyboard_shortcuts),
  GNOME/Ubuntu keyboard settings (help.gnome.org/gnome-help/keyboard-shortcuts-set.html).
- Settled user messages expose copying in the original context-menu position
  (right-click or keyboard context key/Shift+F10), not an extra footer action.
  Assistant responses retain the footer copy button. Settled user-message
  footers reveal **Rewind** on hover or keyboard focus, matching OpenClaw; the
  session header does not duplicate that action. Rewind remains available while
  a turn is running and stops that work before changing branches. Activating it
  acts immediately: HUI resolves that visible message against PI's real append-only
  entry tree, moves the active leaf to the point before the selected user
  message, removes that message from the active transcript and restores its
  full text to the focused composer for editing. The abandoned branch remains
  recoverable from PI's tree. The transcript is the whole active branch (PI's,
  or a Durable conversation's history since its latest `/clear`): a
  compaction appears as a divider with its expandable summary and never hides
  earlier messages. On PI, rewinding inside the window the summary kept
  verbatim keeps that summary on the new branch instead of compacting again,
  and while it compacts the divider shows it live in place of the working
  indicator, messages sent wait in the queue until it ends, and Stop cancels
  it. A Durable session keeps Durable's semantics: its manual and background
  compactions run beside the conversation, which stays idle, so messages are
  sent at once and a run carries on below the live divider; a manual one has
  its own Cancel on that divider, and a fork holds only the history up to its
  point. A failure or cancellation stays visible with its reason until the
  next turn. `/compact [focus]` and the
  context meter's Compact now start one. Continue invokes PI's native
  prompt-free continuation primitive; only when the branch already ends with a
  completed assistant response does HUI send an explicit continuation prompt.
  A finished reply in a Durable session offers **Fork from here**, which first
  asks where the fork works. In a Git checkout the dialog offers **New worktree**
  (the default: a separate checkout on a new branch from the checkout's HEAD,
  suffix `<title>-fork` unless typed; uncommitted changes stay behind) or
  **Same checkout** (both sessions edit the same files). Outside Git, or on a
  remote worker, it forks into the same folder. Durable then copies the history
  up to that reply into a new conversation, which opens at once as a new session
  in the same group, titled `<title> (fork)`, on the source's model and
  reasoning. The source keeps its history and any run in flight. The copy starts
  unpinned and read, without an icon, Jira links, a Kanban stage or OptChat. A
  failure keeps the dialog open with its reason and removes a worktree it had
  made. A reply followed by its tool calls, a bot's chat and sessions still on
  PI offer no fork.
- Markdown code fences retain the reference's reveal and word-wrap controls;
  copying remains a confirmed clipboard operation with a retryable failure. All
  HUI copy actions prefer the Clipboard API and fall back to a temporary native
  selection when HTTP/LAN origins cannot access it. The latest assistant copy
  action remains directly reachable on touch layouts without a preparatory tap.
- Markdown pipe tables render semantic column headers and inline formatting,
  honor column alignment, and scroll horizontally inside a keyboard-focusable
  viewport on narrow screens. Fenced Markdown remains literal code.
- Bare `http(s)`, `www` and email references render as safe links without
  consuming sentence punctuation or adjacent CJK text. GFM task-list items use
  read-only checkbox controls; inline code and fenced code remain literal. The
  transcript renderer follows OpenClaw's `markdown-it` stack for CommonMark
  nesting, block quotes, strikethrough, pipe tables and disclosure blocks. Raw
  author HTML is escaped, remote images remain click-to-open placeholders and
  inline data images are the only image sources rendered directly.
- Fenced `mermaid` blocks render as isolated diagrams through a lazy-loaded
  parser configured with strict security. Fenced `chart` blocks render bounded,
  self-contained Vega-Lite JSON with inline data only; external URL/href fields
  are rejected. Inline `$…$` and delimiter-line `$$…$$` math use lazy-loaded
  KaTeX, while GitHub-style NOTE/TIP/IMPORTANT/WARNING/CAUTION blockquotes become
  semantic callouts. Invalid rich blocks fail inside their own surface and never
  replace the surrounding response. An isolated
  bare HTTPS X/Twitter status URL becomes a rich-post facade; it contacts X only
  after explicit user consent. Labeled links, inline URLs and unsupported X URLs
  remain ordinary safe links. An isolated canonical HTTPS Slack message or
  channel permalink becomes a static link card in either participant's message;
  HUI neither authenticates to Slack nor reads private content. Raw SVG and
  generic iframes remain escaped.
- Transcript images (inline data images, image attachments and presented
  images) and rendered Mermaid diagrams or charts open in a full-screen viewer
  on click, Enter/Space or the embed's expand control. The viewer zooms with the
  wheel, pinch, buttons or `+`/`-`/`0`/`1`, pans by drag or arrow keys, and
  offers Copy image (PNG), Save (the original image, or SVG for diagrams) and
  Copy source for diagrams. Modified clicks keep native link behavior.
- Read and command activity rows use the original manual disclosure anatomy.
  Commands retain their full input in the expanded terminal while the row uses
  the original bounded, shell-aware preview. Tool output copying uses the
  context menu; HUI does not fabricate a workspace-file or side-panel action.
- A `codemode` call is one card: its row names the tools the script called
  (`read ×3, bash`), with a **failed** badge for a failed script or **N failed**
  for calls that failed in a script that completed, and the wall time once it
  ends. Expanded, it shows the script with JavaScript colours, one row per call
  in call order (status, tool, one-line arguments, duration, error under it)
  and the output the model got, without PI's "Script completed / Wall time"
  header, script errors in error colour and a **Full output** file reference
  when PI cut the output. The calls fill in live while the script runs and
  never appear as tool rows of their own. Settings → Tools → Codemode turns the
  tool off for every session from its next request; it is on by default.
- The desktop transcript has OpenClaw's left conversation-position rail: one
  marker per visible user/assistant message, a bounded text preview, current and
  visible-position feedback, and click/keyboard jumps. Collapsed activity is not
  indexed. Arrow keys and Home/End browse without scrolling the conversation;
  Enter/Space jump, Escape returns focus, and Tab leaves the rail. Long rails
  scroll independently without dropping markers. Jumps pause live auto-follow;
  **Scroll to latest** restores it. The rail is hidden when the transcript is
  too narrow/short or lacks the original left gutter, including mobile layouts.
  This is browser-only presentation; PI transcripts and the API are unchanged.

---

# Part 2 — Session ownership

**HUI owns the sessions.** The OpenClaw shape is a
gateway that owns sessions plus a UI that talks to it; HUI is both.

## Why this is now possible

pi ships an SDK, and its own docs name the use case: *"Build a custom UI (web,
desktop, mobile)"*.

```ts
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

const { session } = await createAgentSession({ sessionManager: SessionManager.inMemory() });
session.subscribe((event) => { /* text_delta, tool_execution_start, … */ });
await session.prompt("…");
session.steer(text);      // queue while streaming
session.followUp(text);   // deliver when it stops
session.messages;         // history
session.isStreaming;
session.sessionFile;
```

There is also `pi --mode rpc`, a JSONL protocol over stdin/stdout described as
being "for embedding the agent in other applications, IDEs, or custom UIs".

So a session no longer has to be a tmux pane running a TUI. It can be an object
HUI holds, with events HUI streams to the browser.

## Installed gateway

HUI ships a local npm archive with compiled CLI/server/SDK worker, built web
assets, themes and its lockfile as `build/package-lock.json`, which remote workers
install from. npm installs the archive from `package.json` alone, ignoring that
lockfile, so `package.json` pins every PI package at its locked version; other
dependencies resolve within their ranges.
Production uses Node directly;
Vite and the desktop launcher remain source-development tools. `hui gateway`
provides start/stop/restart/status/logs and foreground run; `hui ui` opens or
prints the existing gateway URL without starting another process. The default
binding is `127.0.0.1:4173`. `HUI_GATEWAY_HOST` and `HUI_GATEWAY_PORT` configure
startup/restart defaults (also inherited by the desktop shell); explicit CLI flags
win. Invalid environment defaults are rejected before stopping a gateway.
`--allow-host <name>`, repeatable, and `HUI_GATEWAY_ALLOWED_HOSTS` list the extra
host names accepted in the `Host` header, which is what a reverse proxy fronting
the loopback gateway needs. Both are persisted with the binding while a gateway
is restarted or updated. `allowHosts` in `gateway/config.json` is read on every
start, with `"tailnet"` resolved to the Tailscale DNS name; a malformed file
refuses startup. Without
configured defaults, restart retains the previous binding. A specific IP or Tailscale binding is explicit;
wildcard exposure is refused. The UI still has Full Access and no login.

Lifecycle control uses a separate loopback socket with a random private token,
instance identity and serialized CLI operations. State/logs live in HUI's
`gateway/` config subdirectory. A stored PID alone is never enough to authorize
a signal. Normal stop/restart refuses work a restart would lose: active turns
and questions of sessions on PI's SDK worker, booting runtimes, follow-ups HUI
still holds, open terminals and in-flight mutations; `--force` explicitly
interrupts them. A Pi Durable run does not block: Durable resumes it when the
gateway reopens its store, and a tool call the stop cut short reaches the model
as an interrupted result rather than running twice. Shutdown waits for the
owned process to exit before replacement, preserving the one-writer boundary.
Restart preserves registry/transcript files and Durable's in-flight work.

`hui update --from <trusted local.tgz> [--sha256 <digest>]` stages a managed
release, probes it against disposable HUI/PI state, then selects it atomically
and restarts an idle running gateway. Failure restores the previous selection
and gateway; `--rollback` is handled by the original installed launcher. A
stopped gateway stays stopped. Update metadata and retained releases live under
`$XDG_DATA_HOME/hui/updates/<installation-hash>` (default `~/.local/share`). They
do not change the HUI registry or PI transcript/config formats. Source-linked,
Nix-store and Homebrew installations must use their owning update workflow.
`hui update` resolves the latest stable release in the public GitHub repository
using GitHub's public API, downloads its bounded archive and SHA-256
sidecar, and reuses that transaction. API reads carry the operator's token when
one is available (`GITHUB_TOKEN`, then `GH_TOKEN`, then `gh auth token`), so a
shared network's anonymous 60-an-hour limit does not block updates; the token is
sent only to `api.github.com`, never along a download's storage redirect, and
without one the reads stay anonymous. `--check` is read-only. Releases must have a
matching stable tag, package version and checksum; no automatic downgrade occurs.
Tag-triggered CI validates and publishes the archive and checksum. A missing or
inaccessible release is reported explicitly, never treated as up-to-date.
`hui update --nightly [--check]` uses the rolling `nightly` prerelease instead.
CI runs the full checks on every `main` commit, stamps the package as a
prerelease of the next patch (`X.Y.Z+1-nightly.<UTC commit time>.g<sha7>`) and
replaces that prerelease's single archive and checksum. A nightly installs
whenever it differs from the running build, so asking for it is the explicit
opt-in to leave stable; a plain `hui update` returns to stable once a stable
release is newer than the installed nightly. The browser updater stays on the
stable channel.
While the app is visible and online, HUI checks for releases on opening and
hourly. A non-modal banner announces a confirmed newer stable version and opens
the existing update dialog through **Review update**. Checks never install,
restart or call a model. The gateway shares an hourly in-memory cache across
tabs, including unsuccessful checks; an explicit check bypasses its freshness.
Background failures stay quiet. Dismissing a banner hides only that version
until reload; a different version can appear. No host task or persisted setting
is added, and source-development servers do not query GitHub automatically.
There is no npm publication or boot-service registration in this iteration.
Browser and package proof is in `e2e/package.browser.md` and `e2e/update.browser.md`.

## Ownership

Two stores, with one writer each:

| What | Owner | Where |
|---|---|---|
| Groups, names, which tool, cwd, HUI's own metadata | **HUI** | `~/.config/hui/sessions.json` |
| The conversation itself | **pi** | `~/.pi/agent/sessions/<cwd>/*.jsonl` |

HUI does not reimplement transcripts. It asks pi to resume a session file.

The available model catalog combines HUI-managed built-in connections with PI's
custom providers. Settings → Models starts with **Add provider** and a modal
limited to OpenCode Go, OpenAI and Claude. Each brand groups its available account,
API-key or native CLI login methods. After sign-in, HUI adds the connection with
no models selected (or preserves an existing selection). Added cards load quota
independently and expose multiple models in a collapsed searchable dropdown.
Disconnected cards show only sign-in, not quota or model controls. The model
dropdown shows per-model context/output limits,
and provider-reported subscription quota/reset windows where supported. Built-in
credentials and selections live in the HUI-owned `providers/` directory under
its XDG config root; adding or removing them never rewrites PI configuration.
HUI-managed providers support up to 20 named accounts in explicit priority order.
New logins add accounts; reconnect targets exactly one existing account. Model
selection remains shared by the provider. Each account has its own credentials,
quota display and removal action. Account headings prefer the email reported by
Codex OAuth credentials or Claude’s OAuth profile, falling back to the stored
label when unavailable. Emails are display-only: accounts with the same email
remain separate. OpenCode Go API-key connections show their reported 5-hour,
weekly and monthly limits. Their connection dialog requires a name and explains
below the input that OpenCode does not report an account name or email. Reconnect
prefills the existing label. Subscription/usage status and all reported
hourly, weekly, monthly and model/feature-specific limits stay visible per
account, including reset times. Unknown plan or billing status stays explicitly
not reported; stored credentials do not prove an active subscription. SDK requests use the first ready account;
quota/rate-limit rejection before any output moves to the next account, bounded
by one attempt per account. Partial output, tool calls, aborts and unrelated errors
are not replayed. Cooldowns persist across workers/restarts; reported reset times
or Retry-After are respected, with a one-minute retry cooldown when unavailable.
The highest-priority ready account is reconsidered for every new request.
A HUI selection overrides only the matching provider; an empty HUI model list
selects nothing. Remaining PI models follow the operator's `models.json`
provider/model selection using the `model-name` extension's rules. HUI owns three routes over that catalog: **primary** starts
normal sessions, **fallback** retries a primary failure only when no useful output
or tool activity has occurred, then returns the session to its own model, and **utility** runs cheap, fast, tool-free calls
for concise (3–6 word, at most 60 character) new-session names in the prompt's language, generated worktree branch names and `/btw`. These settings never rewrite PI files.
Missing or malformed PI selection files preserve the normal available catalog; see
`docs/api.md` for empty-list and default-model semantics.

PI is the only session runtime. The native Claude Code CLI runtime was removed;
Claude models remain available through PI's Anthropic provider. Registry records
that still name another runtime fail closed with an error instead of being
resumed as PI.

## Shared terminals

Appearance → Typography includes a separate terminal font with editable local
family names and Nerd Font suggestions. The preference persists as `fontTerminal`
(default: JetBrains Mono), applies to open panes without restarting the shell,
and falls back to a bundled monospace font when unavailable on the browser device.
Nerd Font icons (Private Use Area and IEC power code points) always render from a
bundled Symbols Nerd Font Mono face placed after the chosen font, so prompt icons
work in the browser and the desktop app whether or not the local font matches.


The chat header's **Open terminal** shows the conversation's terminal in its
Work pane: its open terminal tab, else its first running shell, else a new
interactive shell in the session's directory/worktree. Each terminal is its own
tab; **New terminal** in the pane's **+** menu (Ctrl+Alt+Shift+T / ⌥⇧⌘T) creates another.
Closing a tab hides the terminal without ending its process; the **+** menu lists
running terminals without a tab under *Running* to reopen them. **End terminal**
in the view's ⋯ menu explicitly terminates the shell and its descendants and
closes its tab. On narrow screens the panel selector switches between chat and
terminal while preserving hidden views. Opening a terminal does not call PI.

HUI owns these PTYs and their bounded in-memory output, separately from PI's
RPC/SDK and transcripts. Browser reload and disconnection preserve shell state
while the gateway runs. Gateway restart does not: stale panels report unavailable
and require an explicit new terminal. Ordinary gateway stop/restart/update refuses
active terminals; a forced stop cleans them up. Removing a conversation also ends
its terminals. No tmux dependency, automatic shell recreation or durable terminal
log is introduced.

The HUI-owned **terminal** tool follows OpenClaw's `list`, `read`, `input`,
`resize`, `close` contract and shares exactly the operator-opened PTYs of the
calling conversation. Other conversations, including subagents, cannot access
them through this tool. `input` is exact text/control input, not a shell-command
wrapper; successful submission does not mean the command has finished. Reads are
bounded ANSI-stripped output replay, not screenshots or an emulated screen grid.
The existing Full Access contract applies, without a new approval surface.

Gespenst (`@gespenst/core`, Ghostty's VT parser in WebAssembly) renders the
terminal: it parses and paints in a dedicated worker with WebGL2, falling back to
Canvas 2D, so heavy output and scrolling leave the page's main thread free.
`@lydell/node-pty` owns the shell; `ws` carries input/output/size changes.
Output streams as raw binary bytes written straight into the emulator, and the
replay buffer appends in time proportional to each chunk, so heavy output
(builds, logs, full-screen programs) costs neither JSON encoding nor re-copying
the buffer. A terminal view never refits its grid while the Work pane hides it
(a collapsed pane or the narrow chat destination), and it resizes its PTY only
once a measurable size has held for 150 ms and its grid actually changed. Before
a width change reaches the shell, the reflowed line under the cursor (normally
the prompt) is cleared, so the shell's redraw does not leave a broken copy.

The terminal follows HUI's theme: background and text from the pane, the accent
for the cursor and selection, and an ANSI palette readable on that background (a
light palette on light themes). Changing the theme, mode or accent recolors open
terminals at once. Scrollback keeps 10,000 lines; a scrolled-back view keeps its
place while output arrives and offers **Jump to bottom**, typing returns to the
prompt, and a view at the bottom follows new output. OSC 8 hyperlinks and plain
http(s) URLs open in a new browser tab on click; other link schemes are ignored.
Mouse selection copies with ⌘C (Ctrl+Shift+C elsewhere), including over plain
HTTP; ⌘V, Ctrl+Shift+V and, off Apple platforms, Ctrl+V paste (bracketed when
the program asks). On touch screens a drag scrolls (full-screen programs with
mouse reporting receive it as wheel input), a tap focuses the terminal and opens
the soft keyboard, and a key bar adds Esc, Tab, a Ctrl latch (one tap for the
next key, a double tap to lock) and the arrow keys; it also shows below 1100px.
A Work view in the background never takes keyboard focus; a terminal takes it
only when the operator launches it.

These dependencies and the additive browser-local terminal metadata (now the
Work pane record) were authorized with the shared-terminal feature; Gespenst
replaced Ghostty Web with the owner's approval (2026-10-09). PI configuration
and HUI's durable registry format remain unchanged.

## Managed browser

HUI gives agents a dedicated browser through the HUI-owned **browser** tool,
modeled on OpenClaw's managed `openclaw` profile. The gateway launches one
Chromium-family process (Chrome, Brave, Edge or Chromium, auto-detected or an
absolute executable path) with its own user-data directory under
`$XDG_CONFIG_HOME/hui/browser/profile`. It never attaches to, reads or drives the
operator's own browser, windows, cookies or passwords.

It is **headless by default**: no window, Dock icon or focus change, so it never
interrupts the operator. Settings → Tools → Browser can turn the tool off, switch
to a visible window for watching the agent work, set the executable, start or
stop the process, and list open tabs with an on-demand preview captured from the
headless page. Changing the mode or executable stops a running browser; the next
agent action launches it with the new configuration. Turning the tool off removes
it from new or restarted sessions and refuses calls from running ones.

The browser starts lazily on the first page an agent opens and stops once its
last agent tab closes (the next page launches it again), or with the gateway.
HUI drives it over Chrome DevTools Protocol on a private pipe
(`--remote-debugging-pipe`), so no debugging port is opened and the browser exits
when the gateway does. Tabs belong to the conversation that opened them, like
shared terminals; popups join their opener's conversation. Removing a
conversation or stopping its turn closes its tabs, including one an interrupted
call was still opening, and tabs close after 10 minutes without a browser call
from their conversation, so no headless page outlives the work it served.
Agents read pages as accessibility snapshots with
element refs, act on those refs with real input events, and can read text,
console output and screenshots. Page content is untrusted tool output. The
existing Full Access contract applies without a new approval surface; downloads
are disabled and only http, https, file and about:blank URLs open.

While the agent uses the browser, the chat shows a **live preview** under that
browser activity: the agent's current tab as it repaints, its title and URL, a
marker where it clicks and its latest action. Only the conversation's latest
browser activity carries a preview. It streams while the agent's turn runs and
the preview is on screen, then keeps its last frame; a preview that appears idle
(a reopened conversation, a reload) takes one fresh frame of the tab if it is
still open, and nothing is shown when no page is left to show. Selecting the
preview, or the globe button in the conversation header, opens the conversation's
**browser view** in its Work pane (at most one per conversation; also launched
from the pane's **+** menu, Ctrl+Alt+Shift+B / ⌥⇧⌘B): a larger live view beside the chat
that follows the agent's tab or watches another of the conversation's tabs until
Follow agent. Both are
read-only. Frames come from a CDP screencast that runs only while someone
watches and only when the page repaints (at most about ten frames a second).
Headless tabs each get their own window, so conversations never hide each
other's pages.

No new dependency is added: HUI speaks CDP directly. Browser settings are an
additive `browser` block in `settings.json`; the browser view is a
`{ "kind": "browser" }` entry in the browser-local Work pane record (layouts
saved earlier marked it with `browser: true` and load into the Work pane). PI
transcripts and the registry format are unchanged.

## Files

A **Files view** is a Work view (AgentsInTheCloud's term, adopted with the Work
pane) for navigating the conversation's working directory and viewing or
editing a file in it. It combines a collapsible **Files navigator** (a lazily
expanded file tree, a filter, upload, new file or folder) with the selected
file. A conversation may hold several Files views, each with its own selection,
including several views of the same file. **Files** in the Work pane's **+**
menu (Ctrl+Alt+Shift+F / ⌥⇧⌘F) opens a new one; its tab shows the selected file's name
(or *Files*). Closing the tab forgets that view's selection and open folders; a
file's unsaved text stays with its File draft until it is saved.

The root is the conversation's recorded `cwd` (its directory or worktree);
callers cannot name another. Every path resolves through `realpath` inside that
root, so neither `..` nor a symlink reaches outside it: links that point outside
are listed but cannot be opened, and writes never follow them. Git's `.git`
store is not listed. Conversations on a remote worker show **Files are not
available** with the reason, because their files live on that machine; the
gateway never reads its own disk in their place.

Text files up to 2 MB open in a CodeMirror 6 editor themed from HUI's tokens;
it loads on demand, outside the main bundle. Edits save automatically after a
short pause, and the header shows **Saved**, **Saving…**, **Conflict**,
**Not saved: <reason>** (with Retry) or **Read only**. A save names the version it
edited (the content's hash); when the file changed on disk meanwhile — usually
the agent — the save is refused and the view shows the disk version beside a
choice of **Reload from disk** or **Overwrite with mine**, keeping the unsaved
text until then. A failed save keeps it too. The working text and save state of
a file (its **File draft**) are shared by every Files view of that file in the
page, and unsaved text survives a reload in browser storage until it reaches the
disk. Line endings, BOM and a missing final newline are preserved.

Markdown files have a **Markdown display mode**, **Source** or **Rendered**
(HUI's chat Markdown renderer); the mode never decides whether the file is
writable. Images and PDFs show as previews; other binary files and text over
the limit show their size and modification time with **Download**.

The navigator refreshes open folders and the selected file when the
conversation's agent turn ends, when the view becomes visible again and on
**Refresh**. The filter searches paths: Git's tracked and unignored files in a
repository, a bounded walk elsewhere. Uploads go to the selected file's folder
(or a folder row they are dropped on) and replace an existing file only after a
confirmation listing each path. Deleting a file, link or folder asks first,
listing what goes — a folder with everything inside it, unsaved edits, the open
file — and states that it does not use the trash; the gateway deletes a
non-empty folder only with that confirmation, and never the root. On narrow
screens the navigator is a drawer and the editor takes the full width with a
16 px font, so iOS does not zoom.

**File references in the chat.** When the agent names a file in its reply —
an inline code span or a Markdown link whose text or target is a path such as
`src/lib/x.ts`, `./a/b.md`, an absolute path or `~/…`, optionally with
`:line`, `:line:column`, `:line-line` or `#L42` — and that path exists
inside the conversation's Files root, it becomes a link; so does the path
header of a read, edit or write tool card. Prose, fenced code, URLs, user
messages and code that is not a single path (`npm test`, `foo()`, `1.2.3`,
`--flag`, globs) never do, and a path that does not exist, or lies outside
the root, stays plain text. The chat asks the gateway once per render for all
of a conversation's new candidates (`POST …/files/resolve`, the Files routes'
own path rules) and caches the answers in the page; confirming a link changes
only its colour and cursor, so the transcript does not reflow. Missing answers
are asked again after the agent's turn ends. Clicking a link (or Enter on it;
it is a link named *Open src/x.ts at line 42 in Files*) opens that
conversation's Files view in the Work pane — its active Files tab, else its
first, else a new one — expanding a hidden or collapsed pane and, on narrow
screens, switching the panel selector to that view.
A file opens with its folders expanded in the navigator; with a line, the
editor scrolls to it, places the cursor and highlights it (a Markdown file
switches to Source for that). A folder opens expanded in the navigator.
Conversations on a remote worker, and a bot's chat, which has no Work pane,
show no links.

CodeMirror's packages (`@codemirror/*`, `@lezer/highlight`) were authorized
with this feature. The view's selection, open folders and display mode, and
unsaved drafts, are browser-local storage; the HUI registry and PI transcripts
are unchanged.

## Diff

A **Diff view** is a Work view that shows what changed in the conversation's Git
checkout: what the agent just did, and what the branch adds for review. **Diff**
in the Work pane's **+** menu (Ctrl+Alt+Shift+D / ⌥⇧⌘D) opens a new one; like
Files views, a conversation may hold several, each remembering (browser-local,
forgotten when its tab closes) its comparison, picked branch, the *Include
uncommitted* choice, layout and selected file.

The header chooses the comparison:

- **Uncommitted changes**: the working tree and index against HEAD, untracked
  files included (against nothing before the first commit). A view opens on it
  when there are any; otherwise on the previous branch, the default branch, the
  last commit, in that order of availability.
- **Last commit**: HEAD against its first parent.
- **Against the previous branch**: the merge base of HEAD and the branch this one
  is stacked on, for stacked pull requests. HUI looks for it without network
  calls: gh's `gh-merge-base` or git-town's parent for the branch, then its
  upstream when that is another branch than its own remote copy, else the nearest
  local or remote branch whose tip is an ancestor of HEAD (fewest commits
  between), never the branch itself or a remote copy of it. The picked branch and
  how it was found are shown, and a searchable list (ancestors first, with how far
  behind HEAD each is) picks another. Hidden on a detached HEAD or when no branch
  qualifies.
- **Against the default branch**: the merge base of HEAD and `origin/HEAD`'s
  target (else `origin/main`, `origin/master`, `main`, `master`): three dots,
  so commits that reached main later are not shown as removals.

The last two include uncommitted changes while **Include uncommitted** is ticked
(the default). A line under the header names both sides (`merge base with
feature-a 7817169 → feature-b + working tree`) and, when the conversation runs in
a subfolder, that only its changes are shown.

On the left a filterable list of changed files shows each one's status (A, M, D,
R with its old path, C, T, U), its added and removed line counts and the totals;
on the right the selected file's diff, unified, or **Side by side** when the view
is at least 900px wide (narrower, the toggle is disabled and says *Side by side
needs a wider pane*). Lines are coloured with the file's CodeMirror language from
the Files editor, hunk by hunk. A rename reads *old → new*; binary files say so;
a patch over 1,500 lines opens collapsed with **Show diff**; a missing final
newline and, in files that mix them, CRLF endings are marked. Clicking the file's
name (or its open button) opens it in the conversation's Files view at its first
changed line, through the same path as a file named in the chat; a deleted file
says there is nothing to open. The view refreshes when the conversation's agent
turn ends (or, if hidden then, when it is shown again), when it becomes visible,
and on **Refresh**. Below 640px of width, and on narrow screens, the list and the
diff take turns, with **Back to changed files**.

Not a Git repository, a missing directory, and conversations on a remote worker
(their files live on that machine) show why instead. The gateway runs Git
read-only (see docs/api.md, *Diff view API*): argument arrays without a shell,
no external diff or textconv programs, no fsmonitor, `GIT_OPTIONAL_LOCKS=0` so it
never takes the index lock while the agent works, a timeout, and caps per file and
per response that it states. Untracked files enter through a temporary copy of
the index; the repository is never written and no hook runs. A branch a request
names must be one the gateway offered.

## VS Code

The Work pane's **VS Code** view opens the conversation's folder (its directory
or worktree) in a browser VS Code, ported from AgentsInTheCloud's VS Code view.
Its launcher is **always available** in the Work pane (**+** menu, empty pane,
⌥⇧⌘C / Ctrl+Alt+Shift+C), and nothing is probed, started or downloaded until a
view is opened.

HUI runs one of these, in this order of preference (a choice in Settings
overrides the order while that one is available):

1. **A path saved in Settings**: an openvscode-server-compatible server, or VS
   Code's own `code` CLI installed somewhere unusual. A path that does not run
   is reported, never replaced by a detected one.
2. **The installed VS Code desktop**, run as `code serve-web`, Microsoft's own
   web server that ships with VS Code on macOS, Linux and Windows. HUI looks
   for `code` on `PATH` and in the standard install locations (macOS
   `/Applications` and `~/Applications`; Linux `/usr/share/code`, `/usr/bin`,
   `/snap/bin`, `/opt/visual-studio-code`; Windows `bin\code-tunnel.exe` beside
   `code.cmd` under `%LOCALAPPDATA%\Programs` and Program Files) and accepts it
   only when `code --version` names a version and commit and `code serve-web
   --help` lists the flags HUI needs. serve-web is Microsoft-licensed: HUI runs it
   only after the operator accepted the VS Code Server License Terms in the
   view's consent card, records that acceptance in its settings, and passes
   `--accept-server-license-terms` only then; Settings can revoke it, which stops
   a running serve-web. Its first start downloads the VS Code server build
   matching the desktop's commit (about 230 MB for 1.137) from Microsoft into
   HUI's directory, which needs internet once; the view shows the download's
   progress, and a download that stalls fails with a clear reason.
3. **The openvscode-server HUI installed** (Linux only). On a Linux machine
   without VS Code, the view offers to install Gitpod's openvscode-server (MIT),
   pinned to one release whose per-architecture SHA-256 sums are in the code,
   downloaded (x64, arm64, armhf) through the gateway's outbound path and its
   `HTTP(S)_PROXY`, verified, unpacked with the system `tar` into a staging
   directory, checked to run and only then renamed into
   `$XDG_CONFIG_HOME/hui/vscode-server`; it shows progress, can be cancelled, and
   Settings removes it. It is downloaded on request, never bundled.
4. **openvscode-server on `PATH`** (or in the usual package-manager
   directories), or a code-server whose CLI is compatible. A candidate is
   accepted only when its `--help` lists `--server-base-path`,
   `--connection-token-file`, `--server-data-dir` and `--extensions-dir`, so
   code-server (whose CLI uses `--bind-addr`/`--auth`) is detected only to say
   why it does not fit. On NixOS this stays the native path: nixpkgs'
   `openvscode-server` on the service's `PATH` (`services.hui.vscode.package`),
   because the generic downloaded builds run there only with nix-ld.

When nothing can run yet, the first open shows a card with what applies to the
machine: **Use your VS Code** with the license links and **Accept and open**,
**Install VS Code server (≈73 MB for x64)** on Linux, **Download VS Code** where nothing
else applies (macOS or Windows without VS Code), and always **Set a path**,
linking to Settings → Tools → VS Code. Once one is chosen, later opens go
straight in. Settings → Tools → VS Code shows the VS Code in use (name, version,
path), a picker when several are available, problems with the candidates found,
the license consent with **Revoke**, the HUI-installed server with **Install** or
**Remove** (behind a confirmation listing what it deletes and whether it stops a
running VS Code), the custom path, and the server's state with **Stop**.
Conversations on a remote worker are refused with the reason: their files are
not on the gateway's machine.

One server runs per gateway, for every conversation. It starts on the first
open, listens on 127.0.0.1 on a free port behind a random connection token kept
in a mode-600 file and rotated on every start, keeps its data under
`$XDG_CONFIG_HOME/hui/vscode` (serve-web's in its own `serve-web` directory
there, never in the operator's `~/.vscode`), and runs in its own process group
so a stop reaches node, serve-web's server and the extension hosts behind the
launcher script. It stops with the gateway (signalled, never awaited, so a stop
or restart does not wait for it), 15 minutes after its last connection closes,
or when Settings change what an open would run (another provider or path, a
revoked license, a removed install). A server a killed gateway left behind is
stopped before the next one starts. A crash shows in the view with **Retry**;
only an open from HUI starts the server, so a crashed server is not restarted by
its own reconnecting workbench.

The browser reaches it only through the gateway, at `/__hui/vscode/…` for HTTP
and WebSocket. A frame cannot send `x-hui`, so a guarded request mints a
one-use ticket, `/__hui/vscode/enter` trades it for an HttpOnly, SameSite=Strict
cookie scoped to `/__hui/vscode`, and the proxy accepts only that cookie and
adds the connection token upstream. The cookie is no credential anywhere else;
every other route still requires `x-hui`. VS Code's own token cookie never
reaches the browser, and every other cookie VS Code sets, on any response or
WebSocket upgrade, is kept to `/__hui/vscode` (serve-web sets its
secret-storage cookies on `/`).
VS Code's WebSocket handshake carries the token inside its own protocol (the
workbench reads it from its configuration or from the token cookie the browser
never gets), so the proxied workbench page of either provider includes it,
served only behind the cookie. The configuration tag is found by its id
whatever its attribute order, quoting or encoding (a compressed page is decoded
first). A workbench page it cannot be put in is never served as it is, since
that workbench would sit unconnected without a word: the view shows *VS Code
could not open* with the reason and **Retry**, and the gateway log records it.
A refused VS Code WebSocket (wrong origin, no cookie, VS Code's own refusal) is
logged with its cause, at most once a minute per cause.

The workbench takes HUI's colors (dark or light Modern plus HUI's background,
panels, text, borders and accent) as configuration defaults read when a frame
loads, so a theme change applies on the view's **Reload**; the operator's own
VS Code settings still win. Each token is resolved by the page itself before it
is converted, since custom themes (Catppuccin, Dracula, HUI and every tweakcn
import) write them as `light-dark(…)` pairs; a token that cannot be read is left
out, and the gateway refuses a theme whose text does not reach a 3:1 contrast
on its background and panels, so VS Code then keeps its own theme rather than an
unreadable one. Workspace trust prompts, the start page and AI chat
are off by default, as in AgentsInTheCloud: HUI's agents already work in that
folder with full access. **Open in a new tab** opens the same folder through its
own ticket.

Settings gain an additive `vscode: { enabled, executable, provider,
licenseAcceptedAt }` block. `enabled` was the first view's opt-in switch: it is
still read and saved unchanged for compatibility (a file with `enabled: true`
and a path keeps working), but it no longer gates the launcher or anything else.
No registry, transcript or PI format changes; the only new state is the
openvscode-server install directory, which only an explicit install creates.

## Live chat projection

PI's JSONL remains the durable authority, while the gateway owns a temporary
projection of the turn currently streaming. That projection includes text,
thinking, correlated tool calls, queue state and pending extension-UI questions.
Every event stream connection (SSE, or the WebSocket each browser view uses)
begins with one atomic snapshot; reconnecting during a turn therefore cannot
lose the prefix already emitted. At `agent_end`, the
projection is replaced with PI's refreshed transcript rather than persisted by
HUI as a competing conversation store. If that refresh fails, HUI retains the
completed projection and reports the error instead of replacing it with stale
history; PI remains the durable authority for the next successful refresh.

Sessions run independently inside the long-lived gateway. Navigating from one
chat to another never stops its turn, and separate sessions may be running or
waiting at the same time. The browser keeps one lightweight multiplexed status
stream for the whole registry so background rows continue to reflect
`starting`, `running`, `waiting`, `idle`, and `error`. Each mounted chat pane
keeps one detailed session stream for its transcript, tool, model, queue and
question frames. Each pane caches three visited session views (including
the current view), retaining extra views only while they hold an unsaved queue
edit. Cached and narrow-hidden views stay mounted until evicted or
the pane closes. Sessions only listed in the sidebar do not broadcast every
token to the browser. Closing a view releases its subscription, not its runtime.

The Sessions page also projects ephemeral runtime cost: loaded runtime count,
best-effort process-tree RSS, measured startup duration and the heaviest loaded
session. Per-row memory and startup values come from the same gateway sample.
Unsupported or failed measurements remain explicitly unavailable. HUI never
persists process ids or resource telemetry, and cold sessions have no invented
runtime cost.

Before handing a prompt to a runtime, HUI persists a temporary recovery marker
and the originating prompt in its own registry. The journal is necessary because
PI may not create its JSONL until the first turn settles; it is never returned in
session views and a normal settle or explicit Stop clears it. If the process,
gateway or machine disappears first, gateway startup reopens the runtime and
starts a replacement turn with the journaled request. The recovery instruction
requires the agent to inspect transcript and workspace state before acting, so
an unknown tool outcome is verified rather than blindly replayed. Three failed
admissions leave the existing **Continue run** action as an explicit fallback;
the budget resets once a backend turn starts. Raw attachment payloads are not
copied into the journal.

A run that ends on a runtime or provider error keeps the error row in its
activity disclosure, and the composer also raises it as an OpenClaw-style error
card above the input until the next turn starts. The card offers **Continue**,
which sends a plain continuation prompt through the normal prompt path, plus copy
and dismiss. Dismissal lasts only for the page load, so a reload shows the
unresolved error again; the notice comes from PI's refreshed transcript, not
from separate HUI state.

Failed chat actions, including rejected continuation requests, show a dismissible
error toast instead of an inline page note. Session-launch validation remains
inline in its form. Outcomes of sidebar, Kanban, Sessions and bot actions (copying
an ID or link, moving or reordering, Jira create/link, bulk delete, bot changes)
use the same dismissible toast: successes clear after 6 seconds, while failures
and in-progress messages stay until replaced or dismissed.

Busy composer actions are explicit: **Steer** enters PI's steering queue before
the next model call; **Follow up** runs only after the current agent run settles.
On coarse-pointer devices, plain Enter remains a line break, tapping Send steers
by default, and holding Send exposes Follow up as an **Enqueue** action. Desktop
uses plain Enter or Send to steer and Command/Ctrl+Enter to enqueue.
When PI consumes either queue, HUI projects that instruction into the transcript
immediately so a slow response never appears without its causal user message.
A normal prompt remains rejected while busy. PI RPC exposes select, confirm,
input and editor requests, so Question is an adapted PI surface rather than a
disabled OpenClaw placeholder.

An extension question itself acknowledges the originating prompt. PI only
answers that prompt RPC after the extension handler returns, so HUI releases the
HTTP submission when the question appears and uses the delayed response as the
settle signal. This keeps a human-paced dialog from timing out or leaving the
composer permanently busy.

Uploaded files are HUI-owned transport artifacts, not transcript data. They are
validated and written under HUI's config directory with immutable paths. A
rejected prompt/queue operation removes only the files created for that request;
HUI never edits or deletes PI's transcript. Browser and gateway share the same
limits: eight attachments, 12 MB per item, 16 MB decoded total, and safe bounded
display names (including ordinary spaces and Unicode, but never paths or control
characters). PI's RPC image shape has no filename field, so HUI sends a validated,
versioned attachment manifest inside the user message. PI remains the durable
writer; on replay HUI removes that transport marker and restores the original
image/file display names and order.

Image attachments on transcript messages render as bounded thumbnails (about
240 px) that open full size in a new tab and fall back to the file card if the
bytes cannot load. Their `url` is an opaque gateway route that reads the image
from PI's in-memory history; local paths and PI storage are never exposed and
PI's persisted format is unchanged. Optimistic user messages use the local data
URL until PI's history replaces them.

The composer accepts pasted browser images as native model input. PNG, JPEG,
GIF and WebP can form an image-only prompt; every other pasted or selected file,
including video, is an immutable file attachment that requires accompanying
text so the agent can inspect its path with an available tool.

Agent output uses HUI's `present_media` tool instead of raw HTML, local-path
Markdown or base64 model prose. The tool copies up to eight requested local
files into HUI-owned immutable storage and returns opaque same-origin media
capabilities in PI's durable tool result. PNG, JPEG, GIF, WebP and AVIF render
as images; MP4, WebM, OGV and MOV use the browser's native video player; MP3,
WAV, OGG, M4A, AAC and FLAC use its native audio player; every other format is
a download card. Audio/video container recognition does not imply codec support,
so native playback failure remains visible and the original file stays
downloadable. The active tool's prompt guidance states this exact matrix and the
rule that a local path alone is not an attachment. Remote Markdown images remain
click-to-open placeholders.

HUI's turn-time presentation guidance is generated from one compact capability
catalog. It advertises Mermaid, self-contained Vega-Lite charts, KaTeX math,
GitHub-style callouts, the consent-gated X/Twitter facade and static Slack link
cards without describing them as tools. Real PI tools remain a separate, live
list built from PI's
selected names, snippets and deduplicated guidelines. This does not grant network
access or make arbitrary HTML, SVG, scripts or iframes in Markdown renderable;
interactive HTML and SVG go through the `show_widget` tool (Agent widgets, below).

Unsent composer state is scoped per HUI session and stored in browser IndexedDB,
following OpenClaw's durable-draft model. Text and attachments survive navigation
between chats; a successful send retires only that session's draft, while a
rejected send restores its exact payload ahead of any newer draft.

Typing `$` at the beginning of a chat draft searches skills and plugin actions.
Typing `/` opens one grouped menu containing HUI commands, plugin actions,
skills, prompt templates, and absolute filesystem prefixes, with visible section separators.
Selecting a skill/action inserts the same `$name` alias from either menu; name
collisions retain the runtime-qualified skill name. Templates keep `/name`.
The owning runtime resolves a leading alias against its current command catalog,
not an installation path. Unknown dollar tokens and dollar signs inside prose
remain literal; this is leading-command syntax, not inline skill expansion.
Existing slash invocations remain supported. PI remains responsible for skill
expansion and extension execution, including queue and settle behavior.

Arrow keys navigate across groups, Enter/Tab complete without sending, and Escape
dismisses. Catalog and path loading/error/retry states are independent. New
Session lists the enabled skills PI reports for a local launch before any
runtime exists, and offers **Start session & browse commands** for project
skills, prompts and extension commands, preserving the draft without a model
call, alongside available path results.

Settings → Skills, Plugins and Tools (and the standalone Skills and Plugins
pages) carry a search field that narrows the list by name and description;
Cmd/Ctrl+F focuses it, since the desktop app has no find bar. A PI-owned skill
also links to its `SKILL.md` through `vscode://file`, which the desktop app
hands to the OS; HUI's bundled read-only skills have no edit link. HUI does not advertise PI's
terminal-only commands or plugins without callable actions.

Typing `@`, `./`, `../`, `~/`, or an absolute path after whitespace opens the
local-path menu. An explicit nested absolute prefix such as `/home/` uses only
path completion, avoiding command ambiguity. Directories keep navigation open;
files close the menu. New Session resolves relative paths against its selected
project directory. Filesystem results remain bounded and read-only.

HUI does expose `/clear` for an idle active session. It keeps the HUI session
row and its metadata, asks PI to start a fresh native session, and atomically
replaces the stored PI session pointer. The prior PI transcript is not deleted.
The command itself is not written to either transcript, accepts no arguments or
attachments, and is rejected while work, queued follow-ups or questions remain.
The HUI-owned `/update` command is always available, including before a session
exists. Submitting it creates or opens a dedicated **HUI update** session in
**OTHER**, keeps `/update` (or `/update --check`) in that session's composer,
and opens the update dialog without sending a prompt to PI. The draft remains
after the dialog closes, so a failed update can be retried in the same session.
The command is still not added to the PI transcript. `/update --check` is
read-only; `/update` offers an explicit install action for the checked version.
A detached updater verifies and activates the release, then the dialog
reconnects and offers to reload the new web assets. Active work blocks
activation; there is no force option in the chat flow. HUI reserves `/update`
over runtime command-name collisions and rejects invalid arguments/attachments
rather than forwarding them to the model.
Skills/templates can use the existing queue; extension commands run when idle.
An extension that completes without a model turn must also unlock the composer.

`/btw <question>` and its `/side` alias open an ephemeral side rail. HUI sends a
bounded visible transcript snapshot to the configured utility model with tools and
thinking disabled. The question and answer never enter PI's durable session or
the main transcript, so they cannot influence later turns. Examples include
`/btw which file are we editing?` and `/btw summarize the current task in one sentence`.

HUI also supplies PI with a session-scoped `progress_card` presentation tool.
PI persists its ordinary tool call in the transcript; HUI projects only the
latest validated call into a collapsible Task progress card attached above the
composer. An empty call clears the card. HUI never infers plan state from prose.
Session rows retain OpenClaw’s single-line layout. Hover or keyboard focus opens
the ported OpenClaw 2026.9.5 hovercard: session age, workspace, current unfinished
step/count and agent notepad. Idle unfinished plans show the original paused clock;
completed plans have no heads-up. Notes-only cards have no invented percentage.
Touch does not gain an extra progress button absent from the original. Background sessions
refresh while the page is visible. After a gateway restart, progress returns when
the session is reopened and its runtime restores the transcript.

## Agent widgets

An agent or bot shows something the user should see and use, not just read,
with HUI's `show_widget` tool: a title and an HTML or SVG fragment with
optional `<style>` and `<script>`, as OpenClaw's tool of the same name takes.
The tool refuses a full document, a file path, more than 256 KiB, or an inline
classic or module script that does not parse, naming the script, line and
column in the agent's own code so it can fix the call. It stores nothing of its
own: the call's arguments and its result live in the conversation's transcript,
so the widget is shown wherever the transcript is, after a reload, Back/Forward
or a gateway restart, and is gone from HUI with its session.

The chat shows an accepted call as a titled card in the transcript, on a row of
its own that stays visible after the turn's other activity folds away. The
widget runs live in a sandboxed frame (see the decision below) on HUI's current
theme, which it follows as the theme changes; the frame is as tall as the
widget, from 48 to 8,000 px. Expand shows the same widget full screen without
reloading it, and Escape, in HUI or inside the widget, returns. Runtime errors
and blocked loads appear as a notice on the card, for the user. A click on an
http(s) link in the widget opens it in a new tab. While the call runs the card
says it is preparing the widget; a rejected call stays an ordinary failed tool
row with its error.

Agents learn when a widget beats prose from the tool's own guidance and the
bundled `visualize` skill.

## Session-born subagents

HUI supplies regular PI sessions with the OpenClaw-style coordination tools
`sessions_spawn`, `sessions_list`, `sessions_history`, `sessions_send` and
`subagents` (`list`, `steer`, `kill`). A spawn creates an ordinary HUI session
with its own PI process and transcript, plus optional parent/task metadata in
HUI's registry. The child runs independently and its terminal result is sent
back automatically as a marked, non-user completion event (result wrapped as
data, trailing action instructions). Completions are batched until all active
siblings finish and render as a system card, never as a "You" bubble. Delivery
steers an active parent, prompts an idle one, or queues a follow-up if steering
cannot be accepted. This does not abort the parent's current run. At most eight
descendants may be active in one tree.

Visibility is the current session tree, not the whole registry: parent, child
and sibling sessions can exchange bounded messages and history, while unrelated
sessions remain inaccessible. PI reaches this contract through a random-token,
loopback-only bridge inherited by its process; no browser route exposes these
operations. The UI copies OpenClaw's recent background-task rows, opens the real
child transcript on activation, and nests child sessions below their parent in
the sidebar. Each parent with visible children has a separate keyboard-accessible
disclosure button that folds its entire subtree without changing the open session.
Folding is kept in memory for the current page; search and status filters reveal
matches without clearing the fold choices. PI remains the sole transcript writer. HUI persists only lineage,
task lifecycle, bounded summaries/errors and an optional completion-delivery state.
Terminal outcomes are stored atomically with a pending delivery marker. HUI retries
pending events every five seconds and after restart, retaining them through
transport failures. Queue admission is not acknowledgement: delivery is confirmed
only when the task ID appears in the parent transcript. Per-parent single-flight
delivery and transcript IDs suppress ordinary retries and the crash-before-ack
window; this is at-least-once recovery, not exactly-once processing or proof that
the parent completed its work. Legacy terminal tasks without a delivery marker
are not replayed. A gateway restart marks unfinished
subagents interrupted instead of pretending they are still running. After a
task reaches a terminal state and its result has been delivered, HUI closes the
child's live runtime (after its current browser reader leaves, if any) while
retaining its session row and PI transcript; opening that session later resumes
it through the normal hydration path.

Archiving or restoring a session applies to its complete descendant tree in one
registry update, even across session groups. Archiving hides the tree from active
lists but does not cancel running work; later children inherit the archive state.
Deleting a session removes the complete subtree from HUI, closes its live runtimes
and terminals only after persistence succeeds, and leaves all PI transcripts and
worktrees untouched. A failed write rolls back every deletion guard. The delete
dialog states that subagents, including nested ones, are included.

## Background watchers

Some work is a wait, not a task: a pull request needs approval before `/merge`,
a CI run must go green, a deploy must finish. HUI gives sessions a `watcher`
tool that runs those waits as HUI-owned background processes instead of
invisible `nohup` scripts, and lists them in the conversation that started
them.

`watcher` has five actions: `start`, `list`, `stop`, `restart` and `log`.
`start` records the watcher against the calling session — a one-line purpose,
an optional target URL, an optional outcome (`post /merge`) and the shell
command — then runs the command detached, in the conversation's working
directory, in its own process group. HUI appends
the command's output to a HUI-owned log and has the wrapper write the exit
status beside it, so the watcher keeps running after the turn and after the
gateway stops; at most ten watchers live per conversation.

The owning conversation lists its watchers at the end of the transcript in the
same compact rows as background agents: a status icon (the agents' orbit while
running), the purpose, the latest non-empty log line and a one-word state with
its time (phones keep only the purpose and state until a row is opened).
Several watchers collapse into one summary line (*N watchers · M running ·
purpose*); nothing floats over the conversation. State is derived
from reality, never guessed: `running` only while the recorded PID is still the
process HUI started (a reboot that reuses the PID reads dead), `done` or
`failed` from the recorded exit status, `stopped` after an operator stop, and
`dead` when the process is gone with no exit record. Opening a row shows the
target link, the outcome, start and end times, why a watcher failed or died, a
bottom-anchored log tail that follows new output, the PID and log path, and
*Stop* while running or *Restart* and *Dismiss* once settled. The command runs
with the session's own local access; HUI does not sandbox it. The registry
lives in `~/.config/hui/watchers.json` with one log per watcher under
`~/.config/hui/watchers/`; deleting a conversation stops and forgets its
watchers.

The gateway re-reads the registry on start, so a watcher that survived a
restart reappears with its state, and one killed by a reboot is shown dead
instead of silently missing. HUI does not install a launchd agent: a watcher
runs until its command ends or the machine restarts, and *Restart* brings it
back afterwards.

## Secret requests

An agent that needs a secret from the operator (an API key, a token, a
password, a one-time code such as an OAuth `code#state`) asks for it with
HUI's `secret_request` tool instead of asking for it in the chat or a shared
terminal. The call names the secret (`label`) and says why it is needed
(`reason`); both stay in the conversation, so they must not hold the secret.
The call waits for the operator.

The open conversation shows the request in the question dock above the
composer, in OpenClaw's question card: *Secret*, the label, the reason, a line
saying the value stays out of the conversation, a masked field and *Cancel* /
*Submit*. Escape does not cancel it: password managers close their menus over
the field with Escape. Meanwhile the session reads *Waiting*, like a session
with a question. Submitting sends the value to the gateway only. The gateway
writes it, exactly as typed, to a private temporary file (owner-only, in its
own owner-only directory under the system temporary directory) and gives the
agent that file's path; for a session on a remote worker the gateway passes it
over the worker connection and the worker writes the file there, where the
session's commands run. The agent's guidance is to use it in its next command
without printing it (on stdin or in an environment variable, not as a
command-line argument) and to delete it; HUI deletes it after ten minutes, or
when the gateway or the worker host stops (HUI upgrading the host stops it
too). After a crash, the next start removes it.

The value never enters the transcript, a tool result, PI's or Durable's stores,
HUI's registry or its diagnostics: the tool call records the label, the reason,
the outcome and the file path, nothing else. *Cancel*, Stop, a gateway stop or
fifteen minutes without an answer end the request: the card closes, no file is
written and the agent learns the request was cancelled or expired. When a
worker's connection drops, the card closes too and the call fails, as other
HUI tools do there. Pending requests live in gateway memory and do not survive
a restart.

## Structured questions

An agent that cannot go on without decisions from the operator asks for them
with HUI's `ask_user_question` tool: one to four questions in a single call,
each with a short header, the question and two to four options with a label
and a description. A question may allow several answers (`multiSelect`), and
the options of a single-select question may carry a Markdown preview (a
mockup, a snippet, a config) to compare. HUI's tool takes the place of any PI
extension tool of the same name, such as `@juicesharp/rpiv-ask-user-question`,
whose plain select and input dialogs it replaces.

The open conversation shows the questions in one card in the question dock
above the composer, and the session reads *Waiting*. With several questions a
row of header chips leads the card, ticked once answered; one question shows at
a time with its progress (*2/4*). Options are radio rows, or checkbox rows for
a multi-select question, each with its label, description and number; every
question ends with a *Type something…* row for the operator's own answer, which
replaces a single-select choice or adds to a multi-select one. When options
carry previews, the focused option's preview shows beside them, or under them
on a narrow screen. Picks are kept while moving between questions.

The keyboard drives the whole card: number keys choose a row, arrows move
between rows (↑/↓) and questions (←/→), Space toggles a checkbox, Enter moves
to the next question (choosing the focused single-select option first) and on
the last one submits, Ctrl/⌘+Enter always moves on, and Escape cancels the
card (the first Escape in typed text only leaves the field). The pointer does
the same with the chips, rows, *Back*, *Next*, *Submit* and *Cancel*; the
actions stay in reach when the card scrolls. *Submit* needs at least one
answer; a question left blank is left out.

The agent learns each answer as `"question"="answer"` (several joined by
commas, a chosen option's preview after it), or that the operator declined:
*Cancel*, Escape, Stop and a gateway stop all decline. Once answered, the
transcript keeps a short summary of the answers by header in place of the card.
A call the card could not show (more than four questions, a reserved label such
as *Other*, duplicate labels, a header over 16 characters, a preview on a
multi-select question) fails back to the agent with the reason, and no card
opens. Questions from parallel calls show one after another. A reload shows a
pending card again from its first question. Pending questionnaires live in
gateway memory and do not survive a restart.

## Kanban

**Kanban** sits directly below Automations in the sidebar (`/kanban`). It has
five columns: **Backlog**, then the development stages Investigation,
Implementation, Testing and Done.

**Backlog holds backlog items, never sessions.** Items come from two sources:

- Jira work items assigned to the connected account (`assignee =
  currentUser()`) in the To Do status category (To Do, Backlog, …) and not yet
  linked to any session. Their summary, status, type and description are read
  live and cached briefly; HUI stores only their custom group. Without a Jira
  connection, or when Jira cannot be reached, the column shows local tasks and a
  quiet note, never an error wall.
- Local tasks HUI owns (title, problem, optional fix and working directory),
  saved from a suggested-task card with **Add to backlog**. A local task that is
  later filed in or linked to Jira keeps one card, now with its Jira key.

Every backlog item has a custom group (OTHER by default). With Custom groups
lanes it sits in its group's lane; with Project lanes a local task with a
directory sits in that project, everything else in an OTHER lane; with None in
the single lane. Dragging an item to another lane *inside* Backlog only changes
its group. Its ⋯ menu offers **Start session…**, **Move to group**, **Create
Jira task…** and **Link existing Jira work item…** (local tasks without a key;
the existing dialogs, prefilled with title, problem and fix), **Open in Jira**
when linked, **Copy**, and **Remove from backlog…** (local tasks, confirmed).

**Starting work.** Dragging an item onto a stage cell, clicking its title or
choosing **Start session…** (Investigation) opens a dialog that grows step by
step. First it asks only for the folder or repository (with the new-session
page's directory suggestions); Start stays disabled until the folder is
inspected. A folder that is not a Git repository ends the form with a short
note. A Git checkout asks **Branch** (work in the current checkout) or **New
worktree**, with Branch preselected. Both modes share one branch picker,
initialized to the repository default branch as soon as inspection completes.
Changing modes preserves the selected branch or commit. Branch switches the
current checkout to that ref before the session starts. New worktree adds a
**Branch suffix** field, shown as `<branchPrefix><name>`, and creates the new
checkout from the selected ref. The
name is suggested by the utility model from the task (a 2–4 word kebab-case
description without type words, prefix or Jira key; the title's first words
without a utility model or on failure). The suggestion is requested as soon as
the folder is known to be a checkout, shows a loading state while pending,
never replaces a name the operator typed, and a request for an earlier folder
is ignored. Changing the folder resets every later step. Start creates a
session with the item's title, the
target lane's group (Custom groups) or the item's group, an operator placement
in the target column, and a first prompt of the Jira summary and description
or the local problem and proposed fix. A Jira item is linked to the new session
and so leaves the backlog; a local task is removed once the first prompt is
accepted. A failure keeps the item and shows the error in the dialog; Cancel
changes nothing; nothing moves optimistically.

Sessions sit in the stage columns. A session with no stored stage (or a stored
legacy `backlog`) is in Investigation. Within a cell cards are ordered by
session status, top to bottom: Error, Waiting input, Done (a finished run you
have not read), Working (running or starting) and Idle; pins, then recency,
break ties. Session cards show the status, a pull-request count with its state
breakdown (for example `2 PRs · 1 open, 1 merged`) and, when linked, the Jira
key and status with the sidebar's Jira hovercard.

A **View** menu, stored in the browser like the sidebar's Filter & sort,
configures the board: lanes by Project (default), Custom groups or None; sort
by Status (default), Last updated or Created; Active/Archived/All (backlog
items only appear outside Archived); which columns are visible (at least one);
whether subagent sessions are shown (hidden by default); and when empty lanes
are hidden. **Reset view** restores the defaults. A search field filters by
title, path, group, pull request and Jira key. **Refresh** also rereads the
assigned Jira items.

Stages move in three ways, with the precedence in
[docs/api.md#session-stages](docs/api.md#session-stages):

- The operator drags a card to another stage cell, uses the card's ⋯ menu, or
  presses Shift+←/→ on its focused title. Nothing moves until the server
  confirms; the card is inert meanwhile and keeps focus afterwards. An operator
  placement is marked with a pin and wins until **Let the agent decide**.
  Backlog refuses sessions like another project's lane does.
- The session's agent calls the HUI `set_stage` tool as the work changes stage.
- Pull requests advance the card: open or draft → Testing, merged → Done.

Clicking anywhere on a session card (outside its links and menu) opens its
session. Its ⋯ menu also offers **Create Jira work item…**, **Link Jira work
item…** and, when linked, **Open in Jira**. Stages are HUI presentation
metadata; PI never sees them.

With **Custom groups** lanes, dragging a session card into another lane also
moves the session to that group (OTHER clears it), in the same PATCH as any
stage change. The card menu's **Move to group** does the same in every view. A
project lane is the session's working directory, fixed at creation, so other
projects' lanes dim and refuse the card while it is dragged.

Stages share one palette (`--stage-*` in `tokens.css`): Backlog muted,
Investigation green, Implementation blue, Testing yellow, Done purple. Sidebar
session rows show a leading bar in their stage colour; an explicit session
colour keeps its bar, and child rows keep their tree guide.

## Worktrees

Settings → Worktrees (`/settings/worktrees`; the old `/worktrees` link redirects there) lists the linked worktrees (never the main checkout) of the
repositories behind registered sessions and of HUI's own `~/.config/hui/worktrees/` root, in the Sessions table
layout: branch and path, linked sessions, the branch's pull requests with state,
local changes and disk usage. Local changes, size and pull requests (via the
operator's `gh`) are computed in the background and show as pending or
unavailable rather than guessed.

Paths are shown with `~` for the home directory and truncate from the start, so
the distinguishing tail stays visible; a copy button copies the full path.
Worktrees HUI did not create (by hand or another tool) are labelled External.
Branch names and session titles wrap, so the whole table, including each row's
remove button, fits beside the settings navigation from a 1280 px window; a
narrower one (or a phone) scrolls the table sideways.

Any listed worktree can be removed from its row. The button opens an "are you
sure?" modal with the full path that lists every risk: local changes that will be
permanently deleted (or could not be read), a Git lock that will be overridden,
a running linked session that HUI stops first, a missing directory, or a
worktree HUI did not create. The row shows the riskiest one as a hint beside the
button. HUI forces only the risks the user confirmed (`--force`, or `-f -f` for
a lock); a clean, unlocked worktree still goes through Git's normal check, and a
risk that appears after confirming stops the removal. Linked sessions stay in
HUI. **Clean up merged** lists and removes, after one confirmation, only HUI-created
worktrees with a merged pull request, no open or draft one, a clean checkout and
no active session: every linked session must be archived (deleted sessions are
no longer linked). The list is re-read each time the page opens. The local branch is deleted only when a merged
pull request's head is exactly the branch's current commit; otherwise it is
kept. Removals are serialized and each path is re-validated against a fresh
inventory.

Git deletes a large worktree file by file, which can take minutes, so a removal
never holds the page: the confirmation closes at once, the row shows *Removing…*
(or *Queued* while another removal runs) instead of its button, and a status
line names the worktree being removed, its size, how many wait and the total
percentage done: finished worktrees count in full, the one Git is deleting by
how much of its measured size is left, queued ones not yet. Other rows,
*Clean up merged* and the rest of HUI stay usable, and further removals queue.
The rows' last known facts are kept rather than re-read while Git deletes them,
and the page polls until each row is gone; a reload still shows removals the
gateway is running. Deleting sessions with their worktrees from Sessions closes
its dialog once the sessions are deleted and reports the worktrees when they
are removed.

## Git workspace sessions

New Session may explicitly change the selected Git checkout before launch or
create an isolated Git worktree from a branch or commit in the selected
directory's repository. Its checkout picker mirrors the OpenClaw Current
checkout / New worktree flow and offers a bounded branch list without fetching
remotes. In Current checkout mode, choosing a different ref runs Git's normal
checkout operation in the existing repository before the session is registered;
Git rejects dirty checkouts that would lose work. In New worktree mode, HUI
uses the operator's branch name or, when none is given, a short kebab-case name
the utility model writes from the prompt (the first meaningful words of the
title or prompt without a utility model or on failure). New Session returns
as soon as the request is valid: the session appears in the sidebar and opens
at once, so another session can be started while Git works. The session shows
*Naming worktree* while it is chosen, then the Git worktree progress; the
gateway sends the first prompt once the checkout and runtime are ready. It uses the HUI-local
`branchPrefix` setting (`feature/` by default), and places the checkout under
`~/.config/hui/worktrees/`. Session registration and worktree creation form one
operation: if the registry write fails, HUI removes only the new worktree and
branch it just created. Removing a session never removes its worktree or branch;
destructive cleanup remains a separate future contract.
While Git materializes the checkout, the session and its sidebar row show Git's
reported percentage for the active checkout or content-filter phase. Setup and finalization remain
indeterminate rather than presenting a fabricated whole-operation percentage.
If Git fails, the session stays listed in an error state showing Git's error;
deleting it returns its prompt to New Session. A gateway restart forgets an
unfinished session.

## Remote workers

A session can run on another machine. A **worker** is a name and a connect
command: any argv prefix that opens a stdio pipe to a POSIX shell there, such as
`ssh devbox`, `docker exec -i box` or `kubectl exec -i pod --`. HUI never asks
for passwords or keys; the command must work non-interactively. Settings →
Workers adds, connects, re-syncs, disconnects and removes workers and shows
the remote host, sync summary and errors. A worker that sessions still use
cannot be removed. A worker session runs on the same runtime a local one
would (Pi Durable by default, PI with `HUI_SESSION_RUNTIME=pi`), inside the
worker's host; its conversation lives in that worker's own store. `hui doctor`
leaves worker records unchanged.

- **Setup through the command only.** Each step runs `<command> sh -s` with a
  script on stdin. HUI looks for Node.js 22.19+ (Pi Durable needs its
  built-in SQLite) with npm on the remote and, if missing, downloads the
  gateway's own Node version from nodejs.org (curl or wget required). Those
  builds need glibc: on Alpine or another musl system HUI stops with a message
  asking for Node.js 22.19+ from the system's packages. It then uploads its own
  worker code (the same HUI version) and installs the PI SDK, Pi Durable and
  their peers with `npm install`, at the versions HUI's lockfile pins. Everything lives under `~/.local/share/hui-worker` (or
  `$XDG_DATA_HOME/hui-worker`); the remote user's own files are not touched.
- **A durable host.** One per-user host daemon runs HUI's runtime adapters on
  the remote (Pi Durable in-process, PI SDK workers as children); the gateway
  reaches it through the command's stdio and drives each session through the
  same runtime contract as a local one. Losing the connection (laptop asleep,
  gateway restart, network drop) leaves remote sessions running: runs finish,
  follow-ups sent while a run streams there run (they queue on the worker and
  are shown read-only, like steering; while earlier ones wait in HUI's
  editable queue they wait there too, behind them, and run once HUI is back
  and the run has settled), and a Durable run interrupted by a host restart
  resumes when the host starts again. HUI notices a silent connection within
  45 s, reconnects by itself and reopens the sessions the loss interrupted;
  reopening reattaches to the live session, replays its pending questions and
  catches up on its transcript. Meanwhile the header and sidebar show
  "Reconnecting to <worker>…" with one notice, "Connection to <worker> lost —
  the session keeps running there. HUI reconnects automatically.", never a
  failure; the composer keeps the draft, and sending waits for the worker.
  When HUI is not retrying (the worker was disconnected or removed, or after a
  gateway restart could not be reached) the session reads "Disconnected from
  <worker>" with a **Reconnect** action, which connects the worker (explaining
  when it no longer exists); opening the session alone never reconnects it.
  Such sessions hold up a gateway restart or update only while HUI holds
  follow-ups for them. A run that finished meanwhile is not
  "recovered", even once its idle runtime has stopped or the host restarted;
  a PI run cut off mid-way (the host or its runtime stopped) is continued by
  HUI on the next open, as a local one after a gateway restart. Detached idle workers stop after ten minutes, an idle host
  after thirty, unless Durable work still has to run (an
  open store alone keeps nothing alive). A newer gateway replaces an idle older
  host; one that is busy, or that another HUI is connected to, keeps serving.
- **Your PI setup, mirrored.** Before a session starts (at most every 30 s)
  HUI mirrors the user's PI settings, models, context files (`AGENTS.md`,
  `SYSTEM.md`, …), extensions, skills, prompts, `~/.agents/skills`, every local
  path named in PI settings, HUI's settings and provider selections and the
  worker's extra paths. Local paths in settings become absolute mirror paths.
  `npm:` and `git:` packages, and the dependencies of mirrored local packages,
  are installed on the remote. A worker session gets what a local one gets:
  skills (HUI's bundled ones included), context files, prompt templates,
  models including HUI-managed providers, HUI tools and HUI's skill and plugin
  choices, and PI extensions load on both runtimes, as locally. Agent
  shells there do not inherit the host's HUI directories, so a `hui` or `pi`
  run from one uses the remote user's own; only a PI session's shells see
  `PI_CODING_AGENT_DIR` (the mirror), as a local PI worker's see PI's.
  Credentials, transcripts, `node_modules`, `.git` and files over 8 MB are not
  mirrored; files HUI mirrored earlier and no longer sends are removed.
- **Credentials stay on the gateway.** The remote runtimes ask the connected
  gateway for each credential; an OAuth refresh runs on the remote while the
  gateway holds its own credential lock, and the rotated token is written only
  there. The host keeps the answers in memory only, never on disk, so runs
  keep going while the gateway is away; an answer is dropped when its token
  expires. Without a gateway and a cached answer, the remote's own PI login
  is used, read only if its `auth.json` exists; HUI never creates it. Provider keys
  that models.json resolves from environment variables or commands resolve on
  the remote. A key written literally in models.json, or a literal value of a
  header whose name looks like a credential (one of its `-`, `_` or `.`
  separated parts is `auth`, `authorization`, `cookie`, `token`, `secret`,
  `password`, `passphrase`, `passcode`, `credential(s)`, `jwt`, `signature`,
  `bearer` or `csrf`, or it contains `api-key`, `apikey`, `access-key`,
  `private-key` or `secret-key`; `x-max-tokens` or `idempotency-key` do not),
  is never mirrored: the remote's copy
  drops the key, which the gateway serves as that provider's credential when
  its PI login has none (PI's own precedence), and names a `HUI_SECRET_…`
  variable in place of the header value. The gateway sends those values with
  each sync; the host keeps them in memory only, and PI resolves them as
  environment variables whatever the provider's credential, but no process
  the host starts inherits them, agent shells included. Other literal headers
  are configuration and are mirrored. A placeholder key for a proxy the remote
  runs itself works offline only when written as `$NAME` or `!command`. After
  a host restart the header values return with the gateway's next sync; until
  then a model that needs one fails with PI's message naming that variable.
  Without a gateway or a cached answer only the remote's own login applies.
  An invalid models.json is not mirrored at all.
- **Sessions.** New Session's **Run on** picker lists workers. A remote
  directory must be absolute or start with `~/` and is checked when the session
  starts; creating one never waits on a connection. The header shows the worker.
  Subagents of a remote session run on the same worker. HUI agent tools work
  through the gateway; presented media is copied back from the remote. With no
  gateway connected (or when it leaves mid-call) a HUI tool call fails at once
  with a message saying HUI is not connected; it is never replayed.
  Secret requests are answered on the gateway and their file is written on
  the worker. Not yet available remotely: terminals, watchers, the managed
  browser, New worktree and branch checkouts, and multi-account quota rotation
  (the default account is used). Usage totals skip remote transcripts.

## Bots

A **bot** is a named, persistent agent: a role, a persona it writes itself
(SOUL.md), its own model, a working directory and **one chat that never ends**,
whose memory is OptChat (HUI-18). Sessions keep everything they have (worktrees, rewind,
`/compact`); bots are for assistants the operator returns to every day. The
sidebar splits into **Agents | Bots**, and the `hui bot` CLI can do
everything the Bots tab can, through the same routes.

- **A chat is a session.** A bot's chat is an ordinary Durable session on this
  gateway, created through New Session's path, so the chat view, streaming,
  steering, follow-ups, questions and model switching are the session's own.
  Its record names the bot; the bot registry (`bots.json`) holds the rest.
  Chosen when it is created, a bot can run on a remote worker instead, whose
  Durable store then keeps its conversation and memory, and its HUI data
  directory its home folder with SOUL.md (decision below).
- **Before the first word.** OptChat is switched on, and the conversation
  marked as the bot's, in the commit that creates it.
- **A soul, not instructions.** A bot's persona is the SOUL.md in its home
  folder, read on every request. A new bot speaks first: HUI starts its first
  turn, in which it asks the operator what they expect, a question or two at a
  time (their real request always comes first), and then writes SOUL.md itself
  with its `write_soul` tool, which only bots' chats have (no file tools
  needed). It changes SOUL.md when the operator asks, and says so. Only the
  operator's turns (and HUI's kickoff) can rewrite it: SOUL.md steers every
  later turn, so a turn that took a message from a routine, a trigger or
  another bot (the one that started it, or one that joined it while it ran)
  can't, as it can't rename the bot. The operator can also edit it in the
  Soul tab or with `hui bot soul`. A bot without a
  model of its own runs on Settings' primary model, like a new session.
- **Named by talking.** A bot created without a name is *New Bot*; its first
  conversation asks what to call it, and it renames itself with a bot-only
  `set_profile` tool (only in turns the operator started that took no message
  from a routine, a trigger or another bot). A handle derived
  from the old name follows the new one; a chosen handle stays.
- **Forever, until deleted.** Clearing, compacting, rewinding or deleting a bot's chat is
  refused; archiving the bot deletes nothing, disables its routines and stops a
  running turn, and restoring it brings it back with its routines still off.
- **Messages.** A message to a bot is a prompt when it is idle and a follow-up
  when it is busy; a caller may wait for the reply of the turn that answers it,
  and learns at once when that turn asks a question. Every screen and terminal
  on a bot's chat sees a message another one sent (a routine, a bot, the Bots
  tab) before the reply to it.
- **Routines** are Automation tasks aimed at a bot's chat, marked
  `[routine: <name>]`, queued behind a busy bot instead of skipped. A bot
  schedules its own with a `routines` tool, temporary ones included, which end
  by themselves at a time or after a number of runs; `hui schedule` manages
  every scheduled task from a terminal (decision below).
- **Tools and skills.** A bot has every tool and skill a session in its
  directory has, new ones included, until the operator turns some off in its
  panel's Tools tab or with `hui bot tools` / `hui bot skills`. The host that
  runs its chat enforces what is off (a worker's host for a bot on a worker); the
  bot asks for it back with `request_access`, which only the operator answers.
  Tools are the boundary, not a sandbox.
- **Triggers** wake a bot when something happens elsewhere, beside its routines
  (decisions below). HUI reads no other service for them itself: a listener, a
  program the operator runs, watches what it watches and reports to the
  trigger's URL, a secret on the tailnet; each event wakes the bot once, its
  delivery carrying the pull requests it links to, read through the gateway's
  `gh`. Each delivery is `[trigger: <name> · <summary>] <prompt>` in its chat;
  a cooldown coalesces events into one delivery and an hourly cap holds the
  rest. The Routines tab lists them and `hui bot trigger` manages them; only
  the operator adds or changes one, and the bot's `triggers` tool lists and
  removes its own.
- **Bots talk to bots** with a `message_bot` tool only bots' chats have,
  beside a byte-stable list of the other bots in their system prompt. A message
  arrives as `[from @handle] …`; chains stop after three hops and each bot sends
  at most 30 bot messages an hour.
- **Memory** is OptChat's ([docs/optchat.md](docs/optchat.md)): every message
  kept word for word and condensed into a summary tree a fresh turn reads, so
  the chat is never compacted. Bots reach it only through one interface, so its
  engine stays separate; `hui bot memory` and the memory routes show its
  status, its view, any line zoomed down to a message, and a browse page.
- **A preview behind Labs.** Bots are off until Settings → Labs → *Bots*
  turns them on (decision below). Off, they are dormant everywhere and nothing
  is deleted: no screen shows them, the gateway refuses their routes, calls and
  chats, skips their routines and starts none of their turns; turning them on
  brings everything back as it was, without a restart.
- **The Bots tab** comes with them: while Labs → *Bots* (their one switch) is
  on, an **Agents | Bots** switch fills the sidebar's top row after the collapse
  toggle (arrow keys, Home/End; the browser remembers the tab): Agents is the
  sidebar as before, and Bots shows only the roster, without the navigation.
  Bot chats never
  appear in the Sessions list, its search, Kanban, the Sessions page, the
  command palette or session pickers; Automations labels their routines
  *Bot · name* and words
  their schedules as the bot's panel does (*Daily at 08:00*), and shows who
  made a task when a bot did and a temporary one's limits. The roster
  lists bots by latest activity: the bot's animated face (or its emoji), the
  name, the latest message or role, a short time, an activity badge (active,
  waiting for an answer, summarizing memory, failed), an unread dot (also on the
  Bots tab while Agents shows) and a warning while memory summaries keep
  failing. Search matches name, handle and title. The toolbar's + (and an
  empty roster's New bot) creates a bot at once, with no form and no name: the
  gateway calls it *New Bot* until its first conversation asks for one, its
  chat opens once the gateway has created it, everything else starts on the
  defaults, and a refusal shows in the roster's notice. While a remote worker
  exists the toolbar's + is a menu, *New bot on Local* or on each worker, and
  the bot is created on the machine chosen. A row's menu offers
  Edit (the bot's chat on its Settings tab), Hide/Unhide (*Show hidden* while
  any are hidden), Archive, confirmed, with a Restore toast, and Delete…;
  *Show archived* (while any are archived) lists archived bots with Restore and
  Delete (an icon that shows on the row under the pointer or keyboard, and
  always on touch screens). Delete, from either, asks first in a dialog that
  says what goes (its chat leaves HUI; its routines, memory and folder go) and
  what stays (a workspace the operator chose); deleting the open bot returns
  home. An archived bot's chat opens again only once restored. A bot opens at
  `/bots/<id>` as its one chat in the ordinary session pane, its header
  showing face, name, role, the worker it runs on (if any) and status and a ⋯
  menu with Edit bot…, Archive… and Delete…;
  assistant turns carry the bot's name, `/clear`, `/compact`, Compact now and
  rewind are not offered. A new bot speaks first: its chat opens on a small
  centered note, *<name> was created*, where HUI started its first turn, then
  the bot's questions (an empty chat says *Say hi to <name>*). Opening it
  marks it read. A **Routines | Memory | Soul | Tools | Settings** panel docks beside
  the chat (open or closed and the tab are remembered; on narrow screens it
  opens on request as a sheet over the chat); its header names the bot beside
  Close and its tabs fill a row of their own under it. Routines lists the bot's Automation tasks with schedule,
  next run, who made one when the bot did and a temporary one's limits (*made by
  @ada*, *until 18:00*, *3 runs left*), an enable switch, Run now and Delete, adds routines every N
  minutes/hours/days, daily, weekly or once in the browser's time zone, and shows
  the latest runs; under them, Triggers lists the bot's triggers (what they let
  through, last fired, the listener's last report or its silence, cooldown,
  events waiting, an enable switch, Test, New URL and Delete), shows a new
  trigger's URL once with Copy, adds triggers and shows their latest runs, read
  again every few seconds while it shows. Memory shows messages, the view against its 128 KB budget
  (a full view merges back to 64 KB in one batch), its lines, pending summaries, what the summarizer spent since the gateway
  started (calls, tokens, a cost once one is reported), *Summarizing memory…*
  and failures, and lists the view's `id+n|text` lines (a click opens a line
  into its halves, down to a message whole); while open it reads the memory
  again whenever the bots stream reports it changed, with no timer. *Open memory
  page* is a plain link to OptChat's browse page, opened in a new tab. Soul
  shows SOUL.md as Markdown, through the chat's renderer, with **Edit**: a
  textarea with Save and Cancel (Escape), the count against 20,000 characters
  and the gateway's refusal inline; saving it empty removes SOUL.md. Before the
  bot has one it says *<name> writes its soul in your first conversation* and
  offers **Write it yourself**. While open it reads SOUL.md again when the bots
  stream says the bot or HUI may have written it (its soul flag, its
  `updatedAt`, or its latest message once a turn is over), with no timer.
  Tools shows *Available tools*, one switch per tool with what it does, grouped
  as Files, Shell, HUI, each extension by its source and Bots (powerful ones
  labelled), the bot's skills with a search once there are eight or more, what
  is always on, and an access request its chat waits on, with Allow and Deny;
  each switch saves the whole list and waits for it, and the tab reads the
  catalog again when the bots stream shows the bot changed.
  Settings holds the rest of the bot as compact rows: Profile (name with its
  handle, title, and the look, a row that opens into Face or Emoji),
  Model (model, thinking and utility model; *Gateway default* leaves the model
  and thinking level to the gateway, and choosing it clears the bot's own),
  Calls (call voice and language; without a ChatGPT login its head says calls
  need one) and Workspace (the directory, locked while the bot works, with
  folder suggestions from the machine it runs on, and, while a worker exists,
  Runs on, that machine read-only). Each change is its own `PATCH`, sent in
  order, with the row's pending state and refusal inline and no Save button;
  typed text saves on Enter or blur.
  Ctrl+Shift+, (⇧⌘,) shows or hides it on a bot's chat.
- **Calls** talk through GPT-Live (see the decisions below): the header's
  **Call** shows whenever HUI has a ChatGPT login. A bot has a call voice, its
  own or Settings → Models → Calls' default, and a language it speaks on calls
  (its Settings tab, or `--call-voice`/`--language`): one of Whisper's
  languages, never a translation, or Auto to answer in the language spoken. The
  call view takes the bot's color and shows its face listening to the
  microphone and speaking with the bot's audio, a timer, both sides' captions,
  Mute, Speaker and Hang up, and minimizes to a bar; hanging up deletes
  nothing. The microphone opens only for a call and closes with it; HUI stores
  no audio, only the call's card in the chat.
- **Import and export**: + → **Import bot…** makes a bot from another platform's
  template (Grok Bot, OpenClaw, Claude Code, Letta, character cards, CrewAI) or a
  HUI export, after a preview of everything it would get; a bot's ⋯ →
  **Export…** saves it as a zip that import reads back (decision below).

The contract is [docs/api.md#bots](docs/api.md#bots).

## Decisions

### Listeners are the only triggers (2026-10-09)

Asked whether the listener was now the only way to add a trigger, the owner
answered: "It should be the only one". This supersedes the GitHub, session and
webhook sources of [Triggers wake bots on GitHub, session and webhook
events](#triggers-wake-bots-on-github-session-and-webhook-events-2026-10-07) and
all of [Slack triggers wake bots on review
pings](#slack-triggers-wake-bots-on-review-pings-2026-10-08); the rest of the
first stands, and so does the listeners' decision below. A listener can watch
any of those services instead. The contract is
[docs/api.md#triggers](docs/api.md#triggers).

- **What went.** HUI's GitHub pollers, its watch of the sessions a bot started,
  webhook calls, the Slack poller and HUI's Slack connection (Settings →
  Integrations → Slack, `/__hui/slack`, `hui slack`), the add form's choice of
  source and its Review requests preset, and the `triggers` tool's `add` and
  `update`.
- **What stays.** Listener triggers and their URL on the tailnet, their filters,
  each event once, the listener's health on its trigger, cooldowns, the hourly
  cap, catch-ups, the linked pull requests read into a delivery, Test, New URL,
  `hui bot trigger`, and the tool's `list` and `remove`.
- **Only the operator adds or changes a trigger.** Every trigger's URL is a
  secret, and what its listener reports can be the operator's own messages: the
  reasons webhook, Slack and listener triggers were already the operator's.
- **Stored data.** `bot-triggers.json` keeps loading: a trigger of a kind that
  went is a record HUI can't read, kept aside and never run. `hui doctor`
  reports those triggers and the files their kinds left
  (`bot-trigger-cursors.json`, `bot-trigger-slack.json`, and `slack.json` with its
  token); `hui doctor --fix` deletes them, the triggers' runs included. Asked
  whether to keep a copy, the owner chose deleting with none.

### Listeners report what HUI doesn't read itself (2026-10-08)

The owner can't create a Slack app in his organization, so Slack triggers' own
connection is closed to him, while the Slack MCP his job gives him (Claude's
Slack app) reads the same pings. Wiring that MCP into HUI was built and set
aside before it shipped: "this mcp is only related to my job, so what we want to
implement is accepting a kind of 'listener' that would allow us to configure
this mcp". Of the shapes offered he chose a push endpoint, a source any program
can feed rather than one for Slack, and HUI's side first. The contract is
[docs/api.md#triggers](docs/api.md#triggers).

- **A source anyone's program feeds.** A listener trigger has a URL with a secret
  token, made, shown once and replaced like a webhook's and answered by the same
  route on the tailnet. The program (a listener) watches what it watches, as
  often as it likes, and after every check posts `{ events }`: each with its own
  id, one line, details, a time, links and fields. Nothing about any one service
  is in HUI; the work Slack listener lives with the owner's job setup.
- **HUI keeps each event once; the listener keeps its place.** HUI remembers the
  ids a trigger was told in the same write as the delivery they decide, so a
  report sent again (the listener never heard the answer, or restarted) wakes
  nobody, and an event older than the trigger never does. The listener tracks
  what it has read: HUI refusing a report (bots off) records nothing, and the
  listener sends those events again later.
- **Slack's safeguards, when the event says so.** A trigger narrows events by a
  field (`fields.channel`), by a linked pull request, which the delivery carries
  as a Slack trigger's does, and leaves out events the listener marks as a bot's
  or from outside the operator's organization unless it allows them.
- **Silence shows.** An empty report is a check-in: no delivery, no turn. The
  trigger shows the latest report, the problem a listener reported, and that it
  has said nothing for five minutes or since the gateway started, so a listener
  that stopped never looks like one that watches.
- **Not yet.** The work listener itself, and one listener feeding several
  triggers (it reports to each URL instead).

### Bot faces get more shapes and ears, and bots can restyle themselves (2026-10-08)

The owner asked for more kinds of bots, after how others do it. OpenAI's Dots
let you pick a shape, color, eyes, glasses and accessories (makers built on it
add animals through ears); Grok Bot has one round face, or a generated or
uploaded picture; Hermes Agent only text personas and terminal skins. From a
gallery of options he chose "shapes + ears", all eight new shapes, faces that
stay as they are, and bots that change their own look.

- **Shapes.** Star, Flower, Cloud, Drop, Ghost, Pill, Block and Hexagon join the
  five, in the same plush style and expressions.
- **Ears.** `avatar.ears` (optional, no format change: absent means none) puts
  cat, bear or bunny ears, an antenna, a sprout or horns on any shape. They are
  placed from each outline (a pair on the shoulders leaning with it, a single one
  on the top), move with the body and keep the shapes' colors and states; a small
  face's view box grows only as far as tall ears need.
- **Faces stay.** A bot's id still picks among the first five shapes and never
  picks ears, so no bot that was never styled changes.
- **Bots restyle themselves.** `set_profile` takes the look's keys (a color also
  by palette name) under the same rule as a name: only in a run with no input from
  a routine, a trigger or another bot.
- **Later, if wanted:** Dots' accessories (glasses, headphones, hats), eye styles
  and a custom color picker.

### Slack triggers wake bots on review pings (2026-10-08)

The owner: "usually people in my team pings me to review PR's. Getting marked as
reviewer doesn't mean I should review it, but if someone pings me in slack it
does." So the signal is a teammate @-mentioning the operator, or messaging them
directly, in Slack, usually with a pull request link, and nobody has to mention a
bot or change how they work. A Slack trigger wakes a bot on those messages, and
its delivery carries the linked pull requests, so a bot without a shell can
review from it alone. The contract is
[docs/api.md#triggers](docs/api.md#triggers) and
[docs/api.md#slack](docs/api.md#slack).

- **Read as the operator, through search.** The operator creates a Slack app in
  their own workspace from HUI's manifest (user token scopes only, every one
  read-only, no bot user) and connects its User OAuth Token in Settings →
  Integrations → Slack or with `hui slack connect`. The gateway polls
  `search.messages` about every minute: `<@me>` for mentions, `is:dm` for
  direct messages. Only matching messages travel, one token does it, and a poll
  after a gap reads what was missed, which a gateway on a laptop that sleeps
  needs. Socket Mode would need an app-level token as well, a connection held
  open, user events for every kind of conversation and, on every reconnect, a
  catch-up through each conversation's history. `search.messages` is Slack's
  Tier 2 (about 20 requests a minute) and a poll makes one or two. Slack labels
  it legacy and recommends its Real-time Search API, but that API is meant for
  searches a person starts in an AI app, with per-user limits that steady
  polling would run into.
- **Fewest scopes, each for one reason.** `search:read` finds the pings;
  `users:read` names who asked and tells bots, apps and Slack Connect people
  apart; the four `*:history` scopes read the parent of a thread reply, whose
  pull request link often sits in the parent, in each kind of conversation.
  Nothing lets HUI post, react or edit, and no code path tries.
- **Never twice, never an edit, never a flood.** The poller's cursor (when the
  previous poll started, and the messages seen since shortly before) is saved
  before any event goes out; the first poll is a silent baseline, and a trigger
  never takes a message older than itself. A message counts once, and only when
  it is newer than the previous poll, less two minutes for search indexing, so an
  edit that adds a mention or a link never fires. Bots off, nothing is read; when
  they come back on, or the machine wakes, what came meanwhile (a day at most)
  is one catch-up per trigger, through the same cooldown and hourly cap.
- **The token stays home.** It is stored like Jira's (`slack.json`, mode 0600),
  goes only to Slack in an Authorization header, and no route, error, diagnostic
  or log carries it.
- **What a message says is information.** The delivery says it comes from
  outside HUI; a turn it starts is a trigger's turn, which the gated tools
  refuse. Only the operator adds or changes Slack triggers, since they read the
  operator's messages (like webhook triggers, whose URL is a secret). Pull
  requests are read through the gateway's `gh` when the delivery goes out, so
  the bot needs no shell and acts on GitHub as nobody.
- **Not yet, and what the first real run confirms.** Mentions of a user group
  are left for later. Slack documents the method, its tier, the `<@id>` form
  inside `in:` and `from:`, and that results follow the user's search
  preferences; that `<@id>` alone finds mentions, that `is:dm` works in this
  method (Slack documents it for the Real-time Search API), how late search
  indexes a message, and how a match marks edits, threads, bots and Slack
  Connect people are assumptions the operator's first run with a real workspace
  confirms.

### Schedules are a CLI, and bots schedule their own routines (2026-10-07)

With the Bots stack on `main` behind Labs, the owner asked: "Schedules should be a
cli as well, and can be attached to bots, so they can create them themselves."
Schedules are HUI's Automation tasks, so nothing new schedules anything: the
scheduler gains a terminal and bots gain a tool over the same tasks.

- **`hui schedule`** (alias `schedules`) lists, shows, adds, edits, pauses,
  resumes, runs and removes every task through the Automation routes, attached
  to a session (`--session`, by id or exact title) or a bot (`--bot`, which aims
  it at the bot's chat: one of its routines). Edit changes only the flags given,
  and `--bot`/`--session` moves a task. `hui bot routine …` runs on the same
  code. While bots are off, anything that names a bot, its chat or one of its
  routines prints the gateway's refusal and `list` leaves bots' routines out;
  sessions' schedules work regardless.
- **A bot's `routines` tool** lists, adds, changes and removes the routines of
  its own chat, beside `write_soul`, `set_profile` and `request_access` in the
  bot tools' extension. It is a normal switch in the Tools tab, *Manage its own
  routines*, on by default and not powerful: unlike a bot's own tools the
  operator can turn it off, and it schedules nothing but prompts to the bot
  itself.
- **Temporary routines** end by themselves: `until` (an end time) and/or `runs`
  (a run count), after either of which HUI deletes the routine. That is the
  "every 5 minutes until #82 is green" pattern; the bot can also remove the
  routine itself, from that routine's own turn too, which then finishes. Every
  run HUI starts counts, by hand or scheduled, except a skipped one, and a run
  still going at the end finishes on its own. The operator can make temporary
  schedules too (`--until`, `--runs`).
- **Guardrails**, at the gateway, for bots on workers too: only its own chat's
  tasks (another bot's or session's are never seen or touched); at most 20
  enabled routines per bot's chat once it adds or resumes one, and Automation's
  one-minute minimum; and adding or changing one is refused in a turn that took
  a message from another bot (`[from @…]`) or anything but the operator, its
  routines and HUI's kickoff, the one that started it or one that joined it,
  judged by every input of the run as `set_profile` judges it, while the
  operator's turns, its routines' turns and HUI's kickoff may. Listing and
  removing work in any turn, since they never make more work. Changing is
  refused with adding because a change can make a routine more frequent or
  longer-lived; the operator's own routes have no cap.
- **Who made it** (the operator or a bot, by id and handle) and the limits are
  optional fields of the task, so the store keeps its version and tasks from
  before load unchanged; a route body never names a maker. The bot's Routines
  tab and Automations show *made by @bot*, *until 18:00* and *3 runs left*.

### Triggers wake bots on GitHub, session and webhook events (2026-10-07)

Looking at Grok Bot's triggers ("a bot can listen for events from other apps,
watch a Slack thread or a GitHub PR"), the owner asked: "This is nice, and fits
really good some of my use cases. Listening on PR's, listening on slack
messages, etc. Is that possible?" So bots get triggers beside their routines:
what wakes them when something happens, where a routine wakes them on a
schedule. GitHub, session and webhook sources land first; Slack waits until the
owner names a workspace, and its Socket Mode connection fits the same source
contract (events in, matched against a filter, delivered through the same
cooldown and cap), since it needs no public endpoint either.

- **No public endpoint.** HUI runs on the operator's machine behind Tailscale.
  GitHub is polled, never a GitHub webhook; the webhook route answers only
  loopback and Tailscale's addresses, and Tailscale Funnel stays the
  operator's own choice.
- **Per-repo listing, not the notifications API.** Notifications would be one
  request for every repo, but they only cover the threads the operator watches
  or takes part in, under their GitHub notification settings; their reason is
  sticky per thread (one stays `mention` after the first mention), so a new
  mention or review can't be told from an old one; checks come only for
  workflow runs the operator started; and what happened (which check failed,
  who approved, merged or closed) needs a request per thread anyway. A repo's
  pull requests, sorted by their last update, answer most of it in one
  request, the rest only for what the repo's triggers want. Every request
  carries the last ETag, so a quiet repo costs 304s, which GitHub doesn't count
  against the rate limit.
- **Never twice, never a flood.** A repo's first poll is a silent baseline and
  its cursor is saved before any event goes out, so a restart never repeats
  one. Turning bots on again (or a gateway restart) collapses what happened
  while HUI wasn't watching into one catch-up delivery per trigger rather than
  skipping it: the bot learns what it missed in one message. Session events
  while bots are off are skipped (recorded), and webhooks are refused with 409
  so their sender knows.
- **Bounded turns.** Events within a trigger's cooldown (5 minutes by default)
  coalesce into one delivery that lists them; a bot takes at most 12 trigger
  deliveries an hour and at most 20 triggers; what comes past the cap waits
  rather than being dropped.
- **Only the operator widens what wakes a bot.** The bot's `triggers` tool adds
  and changes its own triggers only in turns that took no message from another
  bot or a trigger, neither the one that started them nor one that joined them
  while they ran (a trigger's event is text from outside HUI, a PR comment or a
  webhook body, which must not be able to add more triggers); it can't make
  webhook triggers, whose token would pass through the model. The operator's
  own comments and reviews never wake a bot, since a bot that comments through
  `gh` posts as the operator and would wake itself.
- **Sessions: only the bot's own, for now.** A bot watches the sessions it
  started; the owner is still deciding how far bots may reach into other
  sessions, so that rule is one function (`sessionWatchable`).

### Bots import other platforms' templates and export their own (2026-10-07)

The owner asked: "Would it be possible to import other platform templates, that
would be nice". So **+ → Import bot…** (and `hui bot import`) makes a bot from a
Grok Bot marketplace link, an OpenClaw workspace, a Claude Code subagent, a Letta
agent file, a character card, a CrewAI `agents.yaml` or a HUI export, and a bot's
**⋯ → Export…** (`hui bot export`) saves it as a zip HUI imports again. Every
source becomes one normalized template; the gateway previews what creating it
would do before anything exists, then creates exactly that. The contract is
[docs/api.md#importing-and-exporting-bots](docs/api.md#importing-and-exporting-bots).

- **Imported text is untrusted, so the preview shows all of it** (SOUL.md, the
  first message, every skill and routine prompt) as plain text, and **an import
  never turns on more than a new bot has**: a Claude Code tools list or a HUI
  export's list only turns tools off, routines start disabled, and a model is
  kept only when this gateway resolves it.
- **Memories go into SOUL.md**, under *What you already know*. OptChat's memory is
  the chat's own log, so nothing else can seed it; SOUL.md is read on every
  request and the operator edits it in the Soul tab. What doesn't fit its 20,000
  characters is listed as left out.
- **The opener is the bot's first turn**, a kickoff that asks it to send the
  opener, rather than a message HUI writes into the chat: that would never reach
  OptChat's log, so the bot would not remember saying it. It costs one turn.
- **Skills are the bot's own**: `skills/<name>/SKILL.md` in its home folder, loaded
  only by its chat, beside its directory's skills and listed with them in its
  Tools tab. They are **on**, like every skill of a bot (they are text the operator
  read, they widen no tool, and each can be turned off); routines are the only part
  that acts unattended, so they are the part that starts off.
- **OpenClaw's AGENTS.md is left out**, with the reason in the preview: it is
  OpenClaw's operating manual (memory files, heartbeats, group chats), which
  describes OpenClaw's runtime, not the bot, and would contradict HUI's.
- **Grok Bot pages are read best effort**: the bot is in the page's Next.js
  server-components payload, which x.ai can change. HUI fetches it only when the
  operator asks, from x.ai over https, bounded; when it can't read it, it says so
  and suggests pasting the bot's instructions instead.
- **Export is a zip** (`bot.json`, `SOUL.md`, `skills/`, optionally `memory.md`) rather
  than one JSON file: the soul and skills stay files a person can read and edit,
  as in an OpenClaw workspace, and importing it round-trips. Like everything of
  bots, all of this exists only while Labs → Bots is on.

### Bots stay behind an opt-in Labs setting while they are a preview (2026-10-07)

As the bots stack was about to be squash-merged into `main`, the owner asked:
"make sure that there is an optin config (like a feature flag, but in
settings) for bots while theyre wip". So bots are a preview behind
`settings.labs.bots`, a Bots switch on the Labs page ("Experimental and opt-in
features"), off by default; a settings file from before it has bots off, so
`main` never shows bots unless the operator turns them on.

- **One switch.** Settings → Sessions → *Show the Bots tab*, the sidebar's
  earlier opt-in, folds into Labs → Bots, which the owner asked to be the one
  opt-in: the sidebar's Agents | Bots switch shows exactly while bots are on. A
  settings file where the tab was on and Labs → Bots is absent reads as bots on,
  so nobody who had the tab loses bots, and the next save writes only
  `labs.bots`.

- **Off means dormant everywhere, and nothing is deleted.** The browser shows
  nothing of them: no Agents | Bots switch, `/bots` addresses land home (a
  remembered Bots tab shows Agents meanwhile), no unread marks, no Sessions →
  Bots or Models → Calls settings, no routines in Automations and no bot chats
  in the calendar. The gateway
  refuses every bot route and call and the session routes of a bot's chat, and
  starts none of their turns: messages, routines, `message_bot`, calls'
  hand-offs and a new bot's first turn are refused, and a chat that starts a
  turn anyway (Durable resuming an interrupted run) is stopped. Turning them off
  stops what bots were doing, as archiving does but without archiving them.
- **Turning them on restores everything as it was**, live, without a restart:
  their chats, memory, SOUL.md, routines and settings never changed.
- **409, not 404.** The refusal names the setting: "Bots are off on this
  gateway: they are a preview. Turn them on in Settings → Labs → Bots." It is a
  409 because the gateway's settings refuse the request while the bots exist; a
  404 would read as a bot that is gone, which clients already treat as such.
- **Routines are skipped, never failed or deleted.** A routine's run while bots
  are off ends *Skipped* with that reason. That is the scheduler's existing rule
  for a run its target can't take: the time is not run later, and once bots are
  on the routine runs at its next time.
- **Workers need no flag:** the gateway's refusals cover the bots on them. The
  clean-up queue of bots deleted while their worker was offline and the
  one-time migration of instructions to SOUL.md keep running, since neither
  starts a turn.

### A bot has every tool and skill until the operator turns some off (2026-10-06)

Reviewing the Bots stack, the owner asked to choose which tools and skills a
bot has, so it can use only those, and for the bot to extend them while it
iterates. The first design gave each bot allow-lists: new bots would start with
nothing but their own tools and ask for what they need. Later the same evening
the owner chose the opposite default: an "Available tools" selector with
everything active, powerful tools included. So every bot, new or existing, has
every tool and skill a session in its directory has, and HUI stores only what
the operator turned off. Tools and skills that appear later are on too; the
trade-off, stated in the guide, is that a bot restricted by hand gains newly
installed tools.

The lists live in the chat's `hui.bot` conversation document, so whatever host
runs the conversation (a worker host too) enforces them: its tool offer leaves
out what is off, extension tools included, and its HUI tool bridge refuses a
call to a tool that is off. The prompt lists only the skills that are on, and a
bot with neither `read` nor `bash` loads them with `load_skill`. A bot's own
tools (`write_soul`, `set_profile`, `request_access`, `load_skill`) and OptChat's
memory tools can't be turned off. The bot asks for something that is off with
`request_access`, a session question with Allow and Deny that only the operator
answers; a routine's or another bot's turn may ask too, and the question says who
started it. The bot panel gets a Tools tab between Soul and Settings, and the CLI
`hui bot tools` and `hui bot skills`. A bot on a worker keeps its lists in its
document there, which that worker's host enforces; the gateway reads and writes
them through the host, asks it what can be turned off (skills by their mirrored
paths there), and hears of the grants made there. Its chat there isn't offered the
tools that stay on the gateway's machine (the terminal, the browser, watchers),
which the gateway refuses for every remote session from the same list, so its Tools
tab leaves them out rather than showing switches that could do nothing.

Tools are the boundary, not a sandbox: with `bash` or `read` a bot reaches
whatever the user's account can, and `message_bot` lets it ask a better-equipped
bot to act (turning `message_bot` off prevents that). Isolation means running the
bot on a worker in a container.

### Bots write their own SOUL.md in a first conversation (2026-10-06)

Reviewing the Bots stack, the owner asked for bots to have a SOUL.md "like
OpenClaw", and for the first conversation to be proactive: the bot asks what he
expects from it, instead of an Instructions field. OpenClaw's `SOUL.md` and
`BOOTSTRAP.md` are the model. A bot's persona is its SOUL.md, in a home folder
HUI keeps for every bot (never a directory the operator chose), rendered as the
last prompt section on every request and bounded at 20,000 characters. Without
it, that section is the first conversation: short and conversational, never a
questionnaire, and a ritual rather than a gate, since the operator's request
always comes first. The bot writes the file itself with a `write_soul` tool of
its own (bots may have no file tools), mentions any change it makes, and the
operator can edit or clear it (clearing
brings the first conversation back). Right after a create without a soul HUI
starts the bot's first turn with a kickoff message that clients show as a note,
so the bot's opener is waiting when the operator opens the chat. Name and look
stay in the dialog, so the bot never asks for them. The `instructions` field
and Durable instructions are gone; the gateway turns existing instructions into
SOUL.md once.

Later that day the owner chose Grok-style creation, with no New bot dialog: a
bot created without a name is *New Bot*, asks what to call it in its first
conversation and renames itself with `set_profile` (the no-dialog flow and a
bot Settings tab follow on top of the calls branch). He also asked that
deleting a bot delete its folder ("so SOUL, MEMORY, configs...") and work from
the ⋯ menu on active bots too: delete now stops its turn, clears what HUI owns
of its conversation (the bot document and OptChat, whose files go) and removes
its routines, its chat's session record and its whole home folder, never a
workspace the operator chose. pi-durable cannot delete a conversation, so the
raw log stays in the store, unread.

### Bots are named chats, not an agent selector (2026-10-05)

The owner approved GrokBot/Hermes-style bots on 2026-10-05: a **Sessions | Bots**
sidebar split, bots as named Durable conversations with OptChat memory, `hui bot`
CLI parity with the Bots tab, routines through Automation and voice through
VoiceStudio later. This satisfies the rule against new Agents or Approvals
surfaces without a product decision: a bot is a chat with a name and a persona,
not an Agents page or a global agent identity, and it adds no
approval layer. Bots run with the same Full Access as every session, on this
gateway only (remote workers are a later follow-up).

On 2026-10-06 the owner asked for Hermes's layout: the switch moved to the top
of the sidebar and its first tab is named **Agents**. Agents is the same session
sidebar, not an Agents page or agent selector; Bots shows only the roster.
Later that day he asked for it above everything else, the header buttons
included, because the two tabs work differently: it is now a full-width tab bar
over a divider in the sidebar's top row. He then dropped the header's New
session and Search buttons, which he never used, and asked for the collapse
toggle to stay put: it now starts that top row, and the restore control appears
on the same spot while the sidebar is collapsed.

### Bots have animated faces (2026-10-06)

The owner asked for faces "like OpenAI Dots" instead of letter and emoji
avatars and approved the prototype (`bot-face-prototype.html`, outside the
repository) with "Okay, implement this"; the prototype is the spec. Each bot
gets a plush SVG shape (Blob, Pebble, Triangle, Heart, Cookie) in one of six
colors, with two dot eyes and no mouth, drawn by `<hui-bot-face>` with no new
dependency. Expressions come from the eyes (blinks, glances, squints, closed
arcs) and the body (breathing, sway, squash and stretch, hops), for ten
states: idle, thinking, working (a tool runs), speaking, listening, waiting (a
question), memory (summarizing), error, done (a hop when a turn ends) and
offline (unreachable or archived).

- **Look on the record, defaults from the id.** `avatar` gains `shape` beside
  `emoji` and `color` (no format change: absent keys stay absent). A bot without
  them gets the face its id picks, the same everywhere, a new bot included. The
  emoji stays an alternative: a bot
  with one shows it until someone switches it to its face (clearing the emoji),
  and its tile takes the bot's color. The CLI has `--shape`, `--color` and
  `--emoji ""`, and `hui bot show` prints the look.
- **Real states only.** Roster rows follow the bot's status (a running turn is
  thinking); its open chat adds a running tool, a pending question, memory
  waits and a failed turn; a call listens with the microphone's level and
  speaks with the level of the bot's audio as it plays (analysers on both
  streams, without rerouting the audio). Text badges and status lines stay;
  faces are `aria-hidden`.
- **Cheap.** CSS keyframes carry the motion; small faces only blink and glance
  on timers. Large faces (empty chat, call) also follow
  the pointer and morph on animation frames. Faces pause while hidden or off
  screen, and prefers-reduced-motion leaves a still expression per state.
- **Later, if wanted:** accessories (Dots' glasses, hats), more shapes, a custom
  color picker, and sprite-sheet pets.

### Calls talk through GPT-Live, OpenDots-style (2026-10-06)

The owner asked for calls through GPT-Live over the ChatGPT subscription, with a
section under Settings → Models to select it ("I think GPT-Live via chatgpt
subscription should work, I guess we need settings for bots as well, lets add a
section under models in which we can select this"), and approved the call design
on 2026-10-06 after OpenDots (CopilotKit/OpenDots, MIT): "I like the
implementation of OpenDots, I think it makes the most sense. Giving a hang-up
what happened is the proper way to go, and having a tool to ask the main agent
sounds really good, I would just add that it should use a different model that is
faster."

- **A realtime conversation model with one tool.** GPT-Live
  (`gpt-live-1-codex`) on the route ChatGPT's own voice mode uses, through HUI's
  ChatGPT login: the gateway keeps the credential and sets each call up, the
  browser carries the audio and the call's data channel. GPT-Live's one tool
  (client delegation) asks the bot.
- **The tool runs on a faster model.** A call helper on the bot's utility model,
  at low thinking, answers from the bot's soul (its SOUL.md), its memory and the call
  so far. It never queues behind the bot's own turn. What needs tools goes to the
  bot's chat as a `[call task]` message on the bot's own model; its reply is
  spoken if the call is still up and stays in the chat either way. The limits
  follow OpenDots': 25 s per question (then GPT-Live offers to hand it off), six
  questions and four hand-offs per call, and calls of at most 15 minutes. The
  helper has no tools yet: a restricted tool set would need new runtime
  plumbing, so it hands off anything that needs one.
- **What happened, at hang-up.** No chat message per utterance. When a call
  ends (hang-up, 90 s without a heartbeat, or 15 minutes), the utility model
  writes a summary in the bot's language: what was discussed, confirmed
  decisions, facts to remember and tasks handed off. The chat gets one card with
  the duration, the summary and the whole transcript. The bot's memory logs both,
  so later turns and calls recall the call. A failed summary leaves the
  transcript.
- **Three model roles, in the owner's words.** "The main model should be the
  most clever one, doesn't matter how fast it is; the utility one should be the
  fastest possible and ideally cheap, and for conversation describe that it
  should be model focused on phone calls, that is fast to respond." Settings →
  Models describes the primary and utility models that way, and its Calls section
  GPT-Live, the conversation model, as made for phone calls. A bot's Memory
  model became its **Utility model**. `memoryModel` and `--memory-model` keep
  working. Its default is Settings' utility model, then the bot's own model.

### VoiceStudio is gone: calls are GPT-Live only (2026-10-06)

The owner dropped VoiceStudio on 2026-10-06, before it merged: "Lets remove
VoiceStudio dependency, I don't need that feature, I only want gpt live for
calls", then "delete everything related to VoiceStudio". This supersedes voice
through VoiceStudio in [Bots are named chats](#bots-are-named-chats-not-an-agent-selector-2026-10-05)
and everything built on it.

- **What went.** The VoiceStudio connection (Settings → Integrations →
  VoiceStudio, `/__hui/voice` and its routes, `voicestudio.json`), voice notes and
  their `[voice] ` messages, Read aloud, calls through VoiceStudio's speech
  chain with the choice of conversation model, and a bot's VoiceStudio voice
  and speed. The CLI refuses `--voice` and `--voice-speed` and says what
  replaced them.
- **What stays.** Calls with GPT-Live: the header's Call whenever a ChatGPT
  login is there, the call view and its bar, the bot's call voice (its own,
  else Settings') and language, the call helper, hand-offs and call cards. The
  faces listen and speak on calls.
- **Stored data.** `settings.json` and `bots.json` written while VoiceStudio was
  there keep loading: `calls.engine`, `voice.sendNotesImmediately` and a bot's
  voice `profile` and `speed` are no longer read, and the next write leaves them
  out. A leftover `voicestudio.json` is ignored. No release ever had VoiceStudio,
  so no `hui doctor` check is needed.

### Bots run on remote workers (2026-10-06)

The owner asked: "We should allow running bots in workers". A bot can be created
on a remote worker (Settings → Workers) instead of this machine; its chat is a
session on that worker, as any remote session's.

- **Its store is the worker's.** The bot's conversation and OptChat memory are
  created in the worker's Durable store, in the same one commit as a local
  bot's (`hui.bot` document, OptChat): the worker's host runs the gateway's
  own adapters against its store, not a copy of them. Its home folder, HUI's
  private folder for it, is under HUI's data directory there, and works as its
  folder unless it names one. The registry, routines, the roster and message
  limits stay with the gateway, which also checks models and picks defaults.
- **Its soul is the worker's too** (2026-10-07, merging SOUL.md): SOUL.md is in
  that home on the worker, never in a folder chosen for the bot. The host's
  `soul` section and `write_soul` use the gateway's own resolver there (the
  operator's name from the mirrored Settings, the bot's name from the gateway),
  so a new bot's first turn, started through its remote session, and its
  first conversation run there; the Soul tab and calls read SOUL.md through the
  host; `set_profile` reaches the gateway as the bot's session, whose record
  holds the turn's origin. The migration from instructions skips bots on
  workers, which never had any.
- **Deleting leaves nothing there.** The host forgets the conversation and
  removes the home with everything in it, under the same guard as the
  gateway's (never through a link, only the bots directory's folder for that
  id). With the worker offline the bot still goes at once: those steps wait
  in a small file on the gateway's machine, run at the worker's next
  connection, and are dropped if the worker is removed.
- **Chosen once.** The worker is set at creation, by id or name; an edit naming
  one is refused: "A bot stays on the machine it was created on." Moving a bot
  between machines is out of scope. Creating one needs a live connection to the
  worker. The owner chose Grok-style creation the same day: while a worker
  exists, the roster's **+** is a small menu, *New bot on Local* or on each
  worker, whose choice creates the bot there at once and opens its chat
  (`hui bot add --worker` from a terminal); the machine then shows read-only.
- **One roster.** A bot on a worker gets the same `bots` prompt section from
  the gateway, and `message_bot` crosses between machines both ways through
  the agent-tool bridge. With no gateway attached the section is left out.
- **Never waiting on a worker.** Lists show a remote bot's memory from what the
  worker last reported and its newest message from the live chat or one read
  per connection, so an offline worker never slows or fails the roster. Offline,
  a bot shows its session's state; its memory and messages fail with a reason
  naming the worker; a worker host from before bots is told apart.
- **A remote session's limits.** The terminal, the managed browser and
  watchers act on the gateway's machine, so a bot on a worker has none of them,
  and no worktrees. Its secret requests work as a worker session's: the card is
  answered on the gateway and the worker host writes the file.

### Bots are set up like Grok Bot (2026-10-06)

The owner, reviewing the bots stack: "the modal to configure the model looks
really bad, needing to scroll in a PC is not the best experience tbh, how does
grok bot do this?" The bot dialog held every field (name, look, title,
instructions, model and thinking, utility model, voices, language, workspace)
and was far taller than the screen: 1,381 px at 1440×900 without VoiceStudio,
1,516 px with it. Grok Bot
([bots](https://docs.x.ai/grok-bot/bots),
[overview](https://docs.x.ai/grok-bot/overview),
[chat and collaboration](https://docs.x.ai/grok-bot/chat-and-collaboration),
[design](https://x.ai/news/designing-grok-bot)) creates a bot from its name and
opens it ("Setup is a message, not a workflow builder"), edits name, label,
description and avatar in Edit Profile, and keeps per-bot settings in a Bot
settings panel toggled with Ctrl/Cmd+Shift+, beside the conversation, with
models "beneath the interface".

- **No form.** The owner chose Grok Bot's way outright: + creates a bot at
  once, without a name, and opens its chat; the gateway calls it *New Bot*, and
  its first conversation asks what to call it and renames it with
  `set_profile`. The New bot and Edit dialogs are gone. Everything starts on
  the defaults: the model and thinking level a new session gets, Settings'
  utility model, Settings' call voice, Auto, a private folder and the
  face its id picks. While a remote worker exists, + is the workers' menu (*New
  bot on Local* or on each worker, [above](#bots-run-on-remote-workers-2026-10-06)),
  and the bot is created where it is chosen, still without a name.
- **A Settings tab in the bot's panel** holds the rest, after Grok Bot's Bot
  settings: Profile (name, title and look, edited in place), Model, Calls and
  Workspace (the machine it runs on, read-only while a worker exists, and its
  directory, whose suggestions come from that machine), as Settings-page rows. Every change saves on its own through the
  existing `PATCH /__hui/bots/:id`; the API and CLI do not change. Edit bot…
  in the bot's ⋯ menus opens it, and so does Ctrl+Shift+,. It fits a 1440×900
  screen with its look editor closed.
- **The panel's tabs get a row of their own** under a header with the bot's name
  and Close, as the sidebar's Agents | Bots do, so the soul and tools tabs fit
  in 344 px beside Routines, Memory and Settings.
- **Calls only.** With VoiceStudio gone
  ([above](#voicestudio-is-gone-calls-are-gpt-live-only-2026-10-06)), the
  tab's Calls section is GPT-Live's call voice and the language, and it always
  shows. Without a ChatGPT login its head says calls need one, so the missing
  Call button has a reason; the voice and language still save.

### New sessions run on Pi Durable

New sessions use the `durable` runtime (`@earendil-works/pi-durable` 1.2.0).
One harness per gateway owns their conversations, runs, inbox and crash
recovery in a single SQLite store, `~/.config/hui/durable/harness.sqlite`
(`HUI_DURABLE_DIR` overrides it), locked to one gateway at a time. Every
step is checkpointed: after a gateway crash or restart the harness resumes the
interrupted run by itself. A cut-off model request is sent again. An
interrupted tool call is rerun only when its tool is marked replay-safe: HUI's
read-only `sessions_list` and `sessions_history`, OptChat's memory reads, a
bot's `write_soul`, `set_profile` and `load_skill`, and `request_access`,
which keeps the operator's answer with the call so it is never asked twice.
Every other HUI or coding tool call is reported to the model as interrupted.
HUI therefore never sends its recovery prompt to a Durable session.

PI still owns configuration: the harness reads PI's `settings.json`,
`models.json`, credentials, skills, extensions, `AGENTS.md`/`SYSTEM.md`/
`APPEND_SYSTEM` and prompt templates through PI's SDK, and builds the system
prompt with PI's own section builder plus HUI's sections, as the SDK worker
does. A provider header that interpolates `PI_CLIENT_SESSION_ID` gets a value
per HUI session, as a PI worker gets one in its environment. Durable's own
tools are its read/write/edit/bash tools and HUI's tools, which call the
gateway's agent-tool handler in process as the conversation's bound HUI
session. A rewind forks the conversation, so the abandoned branch stays
stored. Prompt-free Continue is not available on Durable; an aborted run
continues from a new prompt.

Each Durable session also loads the PI extensions its PI worker would: the
packages and extensions PI settings name and the `extensions/` directories,
with HUI's plugin choices applied. Every session gets instances of its own,
started once its history is read and shut down when it closes; `/reload` loads
them again and `/clear` starts new ones. They run in the gateway process through
PI's own extension runner, bound to the conversation:

- Their tools are offered beside Durable's. One named like a coding tool
  replaces it; HUI's tools win over theirs. Inspection names the extension
  behind each tool and lists load errors.
- Their commands appear in the `/` menu and run in the gateway. A command that
  starts no run settles the session when it ends.
- Their handlers see the session's lifecycle, its prompts (`input`, and
  `before_agent_start`, whose messages go to the model as hidden context just
  before the prompt and whose system prompt applies to that run), the model
  context before each request, provider requests and responses, tool calls
  (which they may block or rewrite) and results, and compactions (which they
  may decline or summarize). A run is over once its `agent_end` and
  `agent_settled` handlers ran, or 30 seconds after it ended. Stop while a
  prompt passes its handlers sends nothing.
- Their dialogs are HUI questions and their notifications HUI notices.
  Terminal-only UI (status lines, terminal widgets, custom components,
  shortcuts) is ignored. HUI's own `show_widget` tool is unrelated to it.
- What they store with `appendEntry` and the messages they send are Durable
  entries, so their state survives a restart. Their messages stay out of the
  transcript, as in PI sessions, even one that starts a turn.
- Not available in Durable sessions: registering providers or models,
  replacing or branching the session from a command, turn-boundary entries and
  continuation, replacing a finished message, extra resource paths and nested
  tool calls.
- After a gateway restart, interrupted runs resume once their sessions have
  loaded their extensions again, or after 30 seconds.

An extension that blocks the event loop holds up every session; PI's worker
isolates each session's extensions in a process of its own.

Compaction is Durable's too, with Durable's semantics where they differ from
PI's. `/compact`, **Compact now** and the harness's own compactions (background
ahead of the threshold, blocking at it, and after an overflow) run Durable's
compaction task with PI's `compaction` settings. Only a blocking compaction
holds its run; manual and background ones run beside the conversation, so input
is never held, the session stays idle and the summary lands at the next
boundary. A manual one can be cancelled alone, and Stop during a run cancels it
as `Conversation.abort()` does; a background one keeps running. A rewind forks
the history as it was, without a summary placed later. The transcript keeps the
whole history with each summary in place.

`HUI_SESSION_RUNTIME=pi` starts new sessions on the PI SDK worker instead.
Existing sessions keep the runtime they were created with until
`hui doctor --fix` moves them (below). HUI never edits or deletes PI
transcripts.

### `hui doctor` migrates state an upgrade leaves behind

`hui doctor` runs checks that only read and report what an upgraded HUI needs
changed; `hui doctor --fix` applies their fixes. Fixes run only with the gateway
stopped, confirmed under the lifecycle lock so none starts meanwhile, and a
Durable store held by any gateway refuses them. A change that leaves persisted
state behind ships with a check, so upgrades stay explicit, reviewable and
repeatable rather than happening silently at gateway start.

The first check moves PI sessions to Pi Durable. The PI file is read as text,
never through PI's `SessionManager`, which may rewrite it; PI's pure helpers
upgrade older formats in memory and project each entry as PI sends it. The
active branch becomes the conversation's history in order: pi-ai messages as
Durable user, assistant and tool-result entries, PI's own message kinds as the
user messages PI sends, each compaction as Durable's summary entry headed at
PI's first kept entry, and each context edit as a Durable edit. The next
request therefore carries what PI would have sent, under Durable's system
prompt. The spend HUI totalled for the PI file is written to `pi.usage`. The
conversation, its spend and a `hui.pi-import` index document are written in one
commit, then the registry record switches to `durable:<id>`; a rerun reuses the
copy of an unchanged file. The registry is backed up before its first change.
Sessions with an interrupted run stay on PI so the gateway can recover them,
and entries on abandoned branches stay only in the PI file.

The second check deletes what the trigger kinds that went left behind
([Listeners are the only triggers](#listeners-are-the-only-triggers-2026-10-09)):
their records in `bot-triggers.json`, kept aside by the gateway and never run,
with their runs, through the same serialized store the gateway writes, and the
files `bot-trigger-cursors.json`, `bot-trigger-slack.json` and `slack.json`.
Listener triggers and records HUI can't read for another reason stay. Nothing
is copied first.

### HUI owns an isolated PI SDK backend, not a PI fork

Sessions on the `pi` runtime (sessions created before Durable that
`hui doctor --fix` has not moved, worker sessions, and new ones under
`HUI_SESSION_RUNTIME=pi`)
keep this design. Each active one runs a
Node child with the pinned
`@earendil-works/pi-coding-agent` SDK (1.2.0). HUI owns the versioned default
prompt, HUI tool definitions and runtime inspection; PI still owns its agent
loop, configuration, credentials, resources and JSONL transcript writer. For
these sessions the gateway neither embeds the agent loop nor runs their
extensions; Durable sessions run theirs in the gateway (above).

The worker reuses PI's `runRpcMode` for streaming, queues and extension questions.
HUI's client uses strict newline framing, plus a versioned Node IPC channel for
fresh tool/prompt inspection. Process isolation and the generic runtime contract
are preserved. The trade-off is an additional pinned dependency graph that HUI,
not a PATH CLI upgrade, must maintain.

`HUI_PI_BACKEND=cli` selects the previous CLI adapter for new/reopened runtimes;
`HUI_PI_CLI` can select an explicit binary. There is no automatic retry or backend
switch during a turn. Only one runtime may own a session file at a time.

Tools settings is global and does not require a session. It distinguishes shipped
tools, default activation, configured package sources and the actual registered /
active tools of an already-running session. Reading the global catalog never
resolves packages, runs extensions or creates a transcript. Live inspection also
shows schemas, load diagnostics and the effective prompt; cold inspection does
not start the session. Terminal-only extension UI is not web UI.

The SDK uses HUI's base prompt unless PI resolves a user `SYSTEM.md` override.
PI composes `APPEND_SYSTEM.md`, context files and skills. HUI contributes guidance
for the actual active tool definitions at turn time. The CLI retains its own
prompt. These are behavior defaults, not an approval or sandbox mechanism.

### The server is long-lived

Sessions live in the server process, so closing the window must not stop it. That
is what makes this a replacement rather than a viewer, and it is OpenClaw's own
shape: a gateway that owns sessions, and a UI that talks to it.

Measured: `pi --mode rpc` takes **4.5–5.7 seconds** to become ready, so the UI has
to show that it is starting.

### Agent widgets run in an opaque-origin sandbox

Decided 2026-10-06, at Dani's request for inline, interactive, agent-authored
widgets like OpenClaw's `show_widget`.

**What.** `show_widget({ title, widget_code })` is a HUI tool, offered with the
other HUI tools to every Durable conversation, PI SDK worker sessions and the PI
CLI fallback. Bot chats (the unmerged bots stack, #67–#70) build on the same
Durable tool set, so they get it once rebased. Its validator is
dependency-free and runs where the tool runs. V8 parses each inline classic
script in place and each module script in a short-lived worker
(`vm.SourceTextModule` needs `--experimental-vm-modules`); nothing is
executed or linked. The call's arguments and result (`details.widget`) are the
only record. The chat wraps the accepted fragment at render time in OpenClaw's
canonical document: its theme token names, classless base stylesheet, helper
classes and CDN allowlist, so a fragment renders the same in both hosts.

**Preflight: MCP Apps.** The MCP Apps extension (SEP-1865) renders `ui://`
resources in sandboxed iframes behind a postMessage bridge; `@mcp-ui/client`'s
`AppRenderer` and `@modelcontextprotocol/ext-apps`' `AppBridge` are the
maintained hosts. They were not adopted: they host complete documents served by
MCP servers, which HUI does not have; a web host must run the sandbox proxy on a
second origin with `allow-same-origin`, a new listener and remote-access
mapping; and the renderers are React components and new dependencies. HUI takes
the standard where it fits: the two-frame sandbox proxy and the JSON-RPC
messages `ui/notifications/sandbox-proxy-ready` and `…-resource-ready`,
`ui/notifications/size-changed`, `ui/notifications/host-context-changed`,
`ui/open-link`, `ui/request-display-mode` and `notifications/message`, so a
later MCP Apps host can reuse the frame protocol.

**Threat model.** The fragment is untrusted code from a model that may have read
hostile input. It must not reach HUI's API (`/__hui/*`), read the HUI page's
DOM, cookies or storage, see the rest of the conversation, navigate or replace
the HUI page, or open popups. The boundary:

1. `GET /__hui/widget-sandbox` serves one static page that holds no data, so it
   needs no x-hui header. Its response policy is the widget policy plus
   `sandbox allow-scripts allow-forms` (an opaque origin even when opened
   directly) and `frame-ancestors 'self'` (only HUI may embed it). The page runs
   only when framed by an http(s) page it cannot read; it builds the widget's
   frame (srcdoc, `sandbox="allow-scripts allow-forms"`), which inherits the
   policy, and relays messages, dropping the reserved
   `ui/notifications/sandbox-*` methods from the widget.
2. The policy: `default-src 'none'`; inline scripts and styles; scripts, styles
   and fonts only from the pinned CDNs (cdnjs, jsDelivr, esm.sh, unpkg, Google
   and Bunny fonts); images and media only from `data:` and `blob:`; and
   `connect-src`, `frame-src`, `worker-src`, `object-src`, `base-uri` and
   `form-action` all `'none'`.
3. The chat's frame is `sandbox="allow-scripts allow-forms"`, never with
   `allow-same-origin`, popups, top navigation, modals or downloads. The chat
   accepts messages only from its own frame's window, delivers a widget only to
   a page that posts as the opaque origin `null`, and validates and bounds
   every message (heights 48–8,000 px, three error notices).
4. A widget opens a link only through the chat: a click on an http(s) link,
   while the widget frame holds focus with transient user activation, checked by
   both the sandbox page and the chat, opens a new tab with
   `noopener,noreferrer`. `window.open` and top navigation stay blocked.

`e2e/widget-probe.html` exercises the boundary from inside a widget: a fetch of
`/__hui/settings` with x-hui, cookies, localStorage, the HUI DOM, top
navigation, `window.open`, a script, an image and a WebSocket from an origin
outside the allowlist are all blocked, and its origin is `null`.

**Accepted residuals.** A widget can still send its own content out: by
navigating its own frame (the sandbox page notices the second load, removes the
frame and the card says so, after the request has gone), over WebRTC, or in the
URLs of CDN requests. It holds nothing but its own code and the theme tokens,
and the agent that wrote it could send the same through its own tools. CDN
requests reveal the user's IP to those CDNs, and code loaded from them runs in
the widget. The sandbox page is served from HUI's origin: the frames are opaque,
so relative URLs reach only GET routes that refuse them without x-hui. A
dedicated origin becomes necessary only for MCP Apps that need
`allow-same-origin`. The policy is HUI's current one at render time, so
tightening it also covers older widgets. Cached session views keep their
widgets running.

**Later.** `sendPrompt(text)` does not ship yet: a widget that can write into
the conversation needs a private channel captured before widget code runs,
transient activation, focus, rate limits, refusing slash commands and a visibly
attributed message, which is a change of its own and nothing in this one needs
it. Runtime errors are shown to the user and not yet reported to the agent, and
there is no PNG export.

## Explicitly out of scope

- A global agent identity/selector surface and approval queues. HUI runs the
  installed PI configuration in Full Access, subject only to HUI-owned resource
  enablement; session-born subagents share that runtime configuration and do not
  add an approval interception layer. Bots (above) are named chats under that
  same configuration, not an agent selector.
- Attaching to tmux panes, accounts and MCP plumbing.
- Restoring Git worktrees, or bulk-removing or bulk-forcing worktrees. See
  Worktrees for the confirmed per-row removal HUI does own.

## PI package and skill mutations

PI remains the only writer of its package and skill configuration. HUI may
delegate these explicit operations to PI:

- install a catalog package from a clean `https://pi.dev/packages/<name>` URL
  through `pi install npm:<name>`;
- remove an installed package through `pi remove <exact configured source>`,
  after an inline confirmation;
- install one skill from an HTTPS URL through a short-lived, no-session PI
  agent using minimal thinking and the cheapest available model (or the
  operator's `HUI_SKILL_INSTALL_MODEL` override).

HUI serializes these mutations. Package labels are resolved back to an exact
currently configured PI source on the server. A skill operation is successful
only when a fresh PI inventory discovers a new `SKILL.md`; process exit alone
is not success. HUI never edits PI's settings or skill directories itself.

HUI also ships `create-verification-skill`, a portable generator for project-local
verification workflows, and `git-selective-staging`, which commits only a
session's own hunks when a shared or reused checkout already holds other
uncommitted work, both with the **good practices** tag. Each is available by
default in new SDK and CLI runtimes, not automatically executed. Their read-only
files live in HUI's installed package; no installation agent, provider call or PI
configuration write is needed. Skills and Settings → Skills expose the same
opt-out toggle and document viewer. Opt-out persists in the existing
`disabledSkills` preference under the stable `hui:skill:<name>` identity
(for example `hui:skill:create-verification-skill`), so upgrades and rollback paths do not reset it. A same-name PI user,
project or package skill takes precedence; disabling HUI's fallback does not
disable that independently owned override. Existing live runtimes keep their
loaded resources until the next start; read-only probes do not load the default.

HUI may also disable an installed skill, package or direct extension only for
HUI-owned PI runtimes. Preferences are stored in HUI settings by stable skill
path or opaque configured-source identity; they do not remove resources or
rewrite PI configuration. On the next SDK runtime start, HUI gives PI a filtered
in-memory settings view before resource discovery. Disabled package/extension
code is therefore never imported, and every skill or prompt supplied by a
disabled package is absent. Individual disabled skills are removed before PI
assembles its prompt and command catalog. Already-running sessions are not
restarted implicitly. The explicit CLI fallback refuses to start while a plugin
policy is active because it cannot provide the same pre-load guarantee.

The Skills and Plugins inventories also expose a read-only viewer. Skills render
their inventoried `SKILL.md`; installed packages prefer a top-level README and
fall back to `package.json`; direct extensions show their configured source file.
The browser addresses only opaque inventory ids. The server revalidates each id
against current PI settings, never executes the resource, never accepts a path,
and limits returned text to 256 KiB.

The ordered implementation tasks and accepted capability matrix are in
`docs/implementation-roadmap.md`.

## Desktop distribution

Electron renders the same production UI through the existing HTTP/SSE API, with
an isolated, sandboxed renderer and no filesystem/Node bridge. The desktop shell
uses the installed CLI to start or reuse the identity-checked managed gateway;
it honors release selection and never creates a second lifecycle/state system.
Closing a window or quitting the desktop application leaves gateway jobs alive.
Normal `hui gateway stop` retains its idle-work protections.

Global npm installation on macOS registers a user-owned `~/Applications/HUI.app`
when lifecycle scripts are permitted. `hui install-app` repairs registration.
The bundle has its own name/icon, is ad-hoc signed, depends on the npm/Node
installation, stores no credentials, and never replaces an unrelated app. It
changes no PI/HUI persistence formats. Native macOS behavior remains a release
verification gate until tested on-device.
