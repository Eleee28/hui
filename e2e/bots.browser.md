# Bots tab browser verification

Date: 2026-10-05. `feat/bots-ui` rebased onto `feat/bots` at `dfde0e8`, where
OptChat memory is wired: the memory routes answer for real, a same-origin link
opens the memory page and `""` clears a bot's model and thinking. The full
journey below ran at `d3cecb3` and again, with the screenshots kept for review,
at the commit that adds this record (documentation only since `d3cecb3`). Both
runs were launched with `e2e/visual-verification.mjs` and driven with the
Browser tool (OpenClaw's managed profile on a headless Brave that another
agent's labeled tab shared; that tab was left alone). Only the model provider is
mocked (`e2e/fixtures/pi-provider-fixture.mjs`): every turn answers "Fixture response.",
and OptChat's compactor gets one short line per summary, `<kind>:
FIXTURE_MEMORY <first E2E_/OPT_ marker>`, held while the message carries
`E2E_HOLD_MEMORY` until `POST /control/release-replay` on the fixture. HUI, the
gateway's `/__hui/bots` routes and event stream, Pi Durable, OptChat,
Automation and the browser are real. No operator transcript, credential or
account was used.

The first version of this journey (at `093f1a9`, before OptChat was wired) saw
the Memory tab only as the gateway's 503 text; this one supersedes it.

Since 2026-10-07 the New bot and Edit dialogs these steps use are gone: + creates
a bot at once and **Edit bot…** opens the bot's Settings tab
([bot-setup.browser.md](bot-setup.browser.md)).

## Reproduce

1. From the checkout: `node e2e/visual-verification.mjs launch --branch
   feat/bots-ui`, then `doctor` on the receipt (before and after the Browser
   work). On a host whose environment sends HTTP through a proxy
   (`HTTP_PROXY` with `NODE_USE_ENV_PROXY=1`), unset those variables for the
   launcher: its ownership check talks to its own loopback instance.
2. Open the receipt's `browserUrl` at 1440×900. The fresh instance had the
   Bots tab off then. Since 2026-10-20 bots are always on, so the Settings →
   Sessions → *Show the Bots tab* steps below are history: the Agents | Bots
   switch is there from the start.
3. Messages over 512 bytes are summarized by a compactor call; shorter ones are
   their own summary lines. The long message below (667 characters) is
   "OPT_NOTES Notes for later, keep them word for word: ", then "the blue door
   opens at nine and the archive closes at five; " ten times, then
   `E2E_HOLD_MEMORY`.
4. Browser-tool notes: in code mode the snapshot text does not reach the cell,
   so refs come from a labeled snapshot's `annotations` and actions use role
   selectors (`role=button[name='Create bot']`). The Settings switch is a
   `wa-switch`; click its host (`wa-switch:has-text('Show the Bots tab')`),
   whose inner input reports as covered.

## Observed (1440×900 unless noted)

1. Before the switch the sidebar toolbar reads SESSIONS with Filter & sort and
   New group, as before, and no tab strip renders.
2. Settings → Sessions → Bots → **Show the Bots tab** on; the footer read
   "Settings saved locally".
3. The toolbar became the **Sessions | Bots** tablist; Bots → "No bots yet",
   the explanation and a New bot button.
4. The toolbar's + opened **New bot**: its Model and Thinking pickers start on
   *Gateway default*. Scout, 🔭, Research assistant and instructions (a field
   removed on 2026-10-06, below) were typed, Model *HUI SDK Fixture* and Thinking *High* picked; Create bot closed
   the dialog once the gateway answered and opened `/bots/<id>`: "Scout ·
   Research assistant · Idle", "Say hi to Scout" and the Routines panel.
5. "Hi Scout, what can you do?" from the composer: "Fixture response." streamed
   in, signed "Scout".
6. Routines: Inbox digest, "Summarize my inbox in three lines.", Daily at 08:00
   → Add routine listed "Daily at 08:00 · next …". **Run now** put "[routine:
   Inbox digest] Summarize my inbox in three lines." and its reply in the chat;
   Latest runs read "Inbox digest · Completed · Run now · … · Fixture
   response.".
7. **Memory**: Messages 4, View 0.1/128 KB, Lines 4, Pending summaries 0,
   "Summarizer since the gateway started: No model calls yet" (short messages
   are their own lines), and the view's four `id+1` lines, e.g. "2+1 user:
   [routine: Inbox digest] Summarize my inbox in three lines.".
8. With the Memory tab open, the long message was sent. Without Refresh, the
   panel moved to 6 messages and 6 lines with pending summaries and
   "(not summarized yet: zoom it)" lines. "Anything new today?" then waited
   for its memory: *Summarizing memory…* in the panel, in the header ("Research
   assistant · Summarizing memory…") and in the roster row. Releasing the held
   compactor reply (fixture control) let that turn answer, and the panel moved
   by itself to 8 messages, 8 lines, 0 pending, "1 call · 1 token in, 1 out",
   with line 4+1 reading "user: FIXTURE_MEMORY OPT_NOTES".
9. Clicking 4+1 expanded it (`aria-expanded="true"`) to "message 4" with the
   whole original message, word for word, ending in `E2E_HOLD_MEMORY`.
10. **Open memory page** opened a new tab at `/__hui/bots/<id>/memory/html`:
    "OptChat memory of Scout" with "View · 8 lines", "ROOT · 8 messages" and
    each tree level; no 403.
11. With the Memory tab open and the bot idle, the browser's network log showed
    no memory read for 9 s: nothing polls it.
12. A second bot, Ledger (Bookkeeper, no emoji), showed its initial on a
    palette color; the roster orders by latest activity.
13. Row menu → **Edit bot…** on Scout showed Model *HUI SDK Fixture* and
    Thinking *High*; both set to *Gateway default* → Save closed the dialog
    after the PATCH and the roster read "Saved Scout."; `GET /__hui/bots/scout`
    then had neither `model` nor `thinking`, and Edit opened on *Gateway
    default* for both.
14. Row menu → **Hide** on Ledger: "Show hidden (1)" listed it with a Hidden
    tag; **Unhide** returned it and the toggle went away.
15. Sessions tab: "No sessions yet."; session search "Scout": "No matching
    sessions.".
16. Row menu → **Archive…** on Scout: the confirmation (focus on Cancel) →
    Archive removed it from the roster, showed the "Archived “Scout”" toast and
    **Show archived (1)**. Turned on, it listed Scout (avatar, role) with
    **Restore**; Restore brought Scout back to the roster with "Restored Scout.
    Its routines stay paused until you turn them on.", dismissed the toast and
    removed the toggle; `GET /__hui/automation` showed the routine disabled.
17. Automations: the routine's row read "Inbox digest · Bot · Scout · Daily at
    08:00".
18. With Ledger archived, loading its `/bots/<id>` address showed "Ledger is
    archived. Its chat and memory are kept; restore it to open the chat again."
    with Restore, and neither its chat nor the panel; Restore opened its chat.
19. 390×844: the bot chat's header has the navigation button, avatar, name and
    role; the drawer shows the tab strip and roster with the main region inert;
    the panel toggle opens the Memory tab as a 380 px sheet with focus on the
    selected tab; the New bot dialog fits the width and scrolls. 844×390: the
    sheet docks on the right and its body scrolls. The document never got wider
    than the viewport.
20. Browser page errors: none. Console errors: none.

## Soul and the first conversation (2026-10-06)

Instructions became SOUL.md plus a first conversation. To reproduce, after the
steps above (any model; the fixture answers a kickoff with "Hi, I'm new here.
What would you like me to look after for you?" and `E2E_WRITE_SOUL` with a
`write_soul` call):

1. **New bot**: no Instructions field; the subtitle says the bot starts by
   asking what you expect from it. Create *Nova* without a model.
2. Its chat opens on the note *Nova was created* (a centered divider, no user
   bubble), then its opening question streams in by itself; the roster row
   previews the question, never the kickoff.
3. Panel → **Soul** (the third tab; arrow keys and End reach it, and it is
   remembered): *Nova writes its soul in your first conversation* with
   **Write it yourself**.
4. Answer with `E2E_WRITE_SOUL …`: the reply says SOUL.md was written, and the
   open Soul tab shows it as Markdown by itself, with **Edit**.
5. **Edit**: a textarea with the count against 20,000 characters, Save and
   Cancel; Escape cancels without closing a mobile sheet; a refusal (over the
   limit) shows inline and keeps the text. Saving it empty brings the empty
   state back.
6. Dark and light themes, 1440×900 and 390×844 (the panel as a sheet).
7. **Delete…** from a roster row's ⋯ menu, or from the chat header's ⋯ menu,
   on an active bot: the confirmation says its chat leaves HUI and its
   routines, memory and folder go; Delete returns home and the bot is gone
   from the roster, its folder too.

The run with real models on the preview, and its screenshots, are in PR #69.

## Tools and skills (2026-10-07)

Every tool and skill is on until the operator turns it off. The run below used a
built gateway of `feat/bot-tools` with `HOME` and `XDG_CONFIG_HOME` in a
temporary directory, the fixture provider (`E2E_REQUEST_ACCESS` makes the bot
call `request_access` for `bash` and then reply with the tool's answer), seven
skills in the temporary PI agent directory beside HUI's two bundled ones, and a
PI extension registering `weather_forecast`. Headless Chromium through CDP in
dark mode (`prefers-color-scheme` emulated), 1440×900 with a fine pointer and
390×844 with touch.

1. A bot created through `POST /__hui/bots` with `disabledTools` `bash`,
   `terminal`, `sessions_spawn` and `disabledSkills` `travel-planner`: panel →
   **Tools** (the fourth tab) shows *3 of 19 tools and 1 of 9 skills are off*,
   the groups Files, Shell, HUI, *Extension user · auto · weather.js* and Bots,
   powerful tools labelled, the turned-off rows dimmed with their switches off.
2. Send "Can you run the test suite and tell me whether it passes?
   E2E_REQUEST_ACCESS": the chat shows the question *Allow access to bash
   (powerful)?* with the bot's reason and Allow/Deny, the roster says *Waiting
   for your answer*, and the Tools tab shows the same request at its top. A
   reload keeps both.
3. **Allow** in the Tools tab (desktop) or Allow + Submit in the chat's card
   (mobile): the bot replies that it now has bash, the request goes, the Tools
   tab shows bash on (*2 of 19 tools*), `bots.json` follows, and the provider's
   next request offers 22 tools instead of 21, bash among them, without
   `travel-planner` in its prompt.
4. Switching **Browser** off and searching the skills for "notes" then switching
   **meeting-notes** off each sends one `PATCH` with the whole list; the summary
   follows (*3 of 19 tools and 2 of 9 skills*).
5. `hui bot tools scout` and `hui bot skills scout --allow meeting-notes`
   against the same gateway print the same state.
6. A light-theme pass of the Tools tab at 1440×900.

Screenshots of this run are in the pull request.

### Stacked on the bot setup, with a bot on a worker (2026-10-07)

After merging `feat/bot-setup` (#81, with #79's bots on workers), the same
journey ran again on a built gateway of `feat/bot-tools` with a local worker
*devbox*: a second temporary home reached through `env … sh -s`, with the built
release installed there beforehand, as #79's and #81's runs did. Same fixture
provider, skills and extension (mirrored to the worker when it connected), and the
same drivers (dark, 1440×900 and 390×844).

1. The panel's tabs sit on their own row under the bot's name: *Routines |
   Memory | Soul | Tools | Settings*. Five tabs fit at 390×844 with no overflow,
   and Tools opens on *3 of 19 tools and 1 of 9 skills are off* for a bot here.
2. A bot created on devbox through `POST /__hui/bots` with `worker`,
   `disabledTools` `bash`, `write` and `disabledSkills` `meeting-notes` stores
   that skill by its path on the worker
   (`…/remote/.local/share/hui-worker/mirror/agent/skills/meeting-notes/SKILL.md`).
   Its Tools tab reads from the worker: *2 of 16 tools*, the extension's tool,
   and every skill under `~/.local/share/hui-worker/mirror/agent/skills`,
   *meeting-notes* off. The terminal, the browser and watchers aren't listed:
   they stay on this machine, so its chat there isn't offered them. (The first
   run, at `067db29`, showed *Shared terminal* switched on among 18 tools; the
   review caught it, and the counts here are from the run after the fix.)
3. "Run the checks on devbox and report back. E2E_REQUEST_ACCESS": the question
   from the chat on the worker shows in the chat and at the top of its Tools tab.
   **Allow** there: the bot replies that it has bash, the tab shows *1 of 16
   tools*, and `bots.json` already holds `["write"]`, from the worker's report.
   The provider's requests from the chat on devbox carry none of the three (19
   tools, then 20 with bash). Creating a bot on devbox with `disabledTools:
   ["terminal", "bash"]` is 400: *terminal stays on this machine, so a bot on
   devbox can't use it and there is nothing to turn off: leave it out.*
4. With devbox disconnected, the Tools tab says *devbox, where this bot runs, is
   offline: HUI is not connected to it. Connect it in Settings → Workers, then try
   again.* with Retry, and `GET …/catalog` answers 503 with that message, as
   does `hui bot skills rover`. Reconnected, `hui bot skills rover --deny
   travel-planner` turns the mirrored skill off on the worker.

Screenshots of this run are in the pull request.

## Evidence

Screenshots of the final run (desktop 1440×900, mobile 390×844 and landscape
844×390: roster with two bots, chat with a reply and a routine run beside the
Routines panel, Memory with its stats and a line zoomed to its message, the
memory page, the New bot dialog, the Settings switch, Show archived, drawer and
sheets) were captured from the running instance and inspected; they are kept
outside the repository and are not committed.

## Limits and gaps

- A view keeps one line per message until it outgrows its 128 KB budget, so the
  browser zoomed a message line straight to its message. Opening a summary of
  several messages into its two halves is covered by
  `src/lib/bot-memory.test.ts` (parsing) and `server/routes/bots.test.ts` (the
  route), not by this journey.
- The fixture reports one token each way and no cost, so the cost the panel
  shows once a provider reports one is unit-tested only.
- A reconnect's cached first frame (`isNewBotsFrame`) is unit-tested; no
  reconnect was forced in the browser.
- Headless Brave reports no hover, so touch-sized controls show; touch input
  itself was not emulated.
- The provider is deterministic; no real model or compactor model was used.

## Agents | Bots at the top (2026-10-06)

The owner asked for Hermes's layout, then for the switch above everything
else, because the two tabs give the sidebar different contents. At `9492644`
it moved from the sessions toolbar to just under the header buttons and its
first tab was renamed Agents; at `8d1a1b5` it became the first thing in the
sidebar, a full-width tab bar over a divider, in sentence case. Checked at
`8d1a1b5` on the launcher with `--pi-sessions` (doctor before and after;
cleanup closed every port), with two bots created through `POST /__hui/bots`
(Scout 🔭, Ledger) and one session started from Home's composer, in headless
Chromium through CDP: one browser with a fine, hovering pointer at 1440×900
and a separate touch-like one at 390×844.

1. Agents, the default: the tab bar is the sidebar's first element (two
   119×36 px tabs at 14 px over the divider), then the header buttons (New
   session, *Search sessions*, Collapse sidebar), the navigation, the SESSIONS
   toolbar and the session list.
2. Bots: no navigation and no New session; the header keeps *Search bots* and
   Collapse sidebar, then a BOTS header with its **+** (New bot) and the
   roster (Ledger, Scout). The lists are one tab panel, labelled by the
   selected tab.
3. A bot's page keeps the Bots tab. ArrowLeft on the focused tab selects
   Agents and moves focus to it; ArrowRight goes back to Bots.
4. 390×844: the drawer opens on the same tab bar with 44 px tabs; a tapped
   tab keeps no hover tint; the document stays 390 px wide.
5. With *Show the Bots tab* off, no tab bar renders and the sidebar starts
   with its header buttons, as on `main`.
6. Browser page errors: none. Console errors: none.

## The collapse toggle in one place (2026-10-06)

The owner reported that the restore control sat on top of a bot's avatar and
that toggling the sidebar meant moving the mouse a long way. He also asked to
drop the header's New session and Search buttons, which he never uses.

Measured first on the preview at `d344ad4` (headless Chromium through CDP, fine
pointer, 1440×900). The collapse toggle sat at (217, 54) and the restore control
at (10, 10), a 207 px left and 44 px up move. On a bot page the restore control
covered the bot's 28 px avatar: the bot chat runs in an embedded pane app, so
the session header's collapsed padding never reached it.

Checked at `4480d18` on the launcher with `--pi-sessions` (doctor before and after;
cleanup closed every port), with two bots created through `POST /__hui/bots`
(Ledger, and Scout 🔭) and one session started from Home's composer:

1. The sidebar's top row is Collapse sidebar, then the Agents | Bots tabs: one
   48 px row whose labels share the chat header's centre line. The header has
   no other control.
2. Every route was checked: Home, the session, both bots, Contributions,
   Automations, Kanban, Plugins and Skills. On each, the toggle and the restore
   control both sit at (10, 10), 28×28, so there is no mouse travel. Nothing
   visible lies under the restore control, it is the topmost element at its
   centre, and a second click on the same spot re-expands the sidebar.
3. Focus moves to Expand sidebar on collapse and back to Collapse sidebar on
   expand.
4. With the Bots tab off the top row holds only Collapse sidebar, at the same
   spot, with the same results on every route.
5. 390×844, in a separate touch-like browser: the drawer opens on the tab bar,
   without the toggle. With the Bots tab off it starts with the navigation at
   the drawer's top padding (fixed in `4da7cb3` and checked on a fresh launcher
   at that commit). The document stays 390 px wide.
6. Browser page errors: none. Console errors: none.

## The panel as a profile (2026-10-16)

The owner asked for a panel that can grow and drops what he called useless
(the Soul and Memory tabs), after looking at how Grok Bot, OpenAI's Dots,
OpenDots and Hermes lay theirs out (SPEC.md, "The bot panel is a profile you can
resize and expand"). He chose the profile overview with pages from three
clickable mockups.

Checked on the launcher (default fixture: deterministic provider, real gateway
bot routes, Durable chat, OptChat and Automation), one bot made with the empty roster's New bot. Only the provider is
mocked.

1. The bot's chat opens beside the overview at 344 px: its face (88 px), name
   and *Idle*, Edit; ROUTINES and TRIGGERS with + and their empty lines;
   ACTIVITY's empty line; SETUP with Model *Gateway default*, Tools & skills
   *Everything on*, Calls *Cove · Auto* and Workspace *Its own folder*. No
   Memory, no Soul, no tabs.
2. Routines' + opened the Routines page (Back, *Routines*, Expand, Close) on
   its open add form with the focus in Name. *Inbox digest* / *Summarize my
   inbox in three lines.* → Add routine listed it; Run now put `[routine: Inbox
   digest] …` and *Fixture response.* in the chat. Back: the overview listed
   the routine (*Daily at 08:00 · next …*, its switch) and ACTIVITY *Inbox digest
   · Completed · just now · Fixture response.*
3. Calls opened Settings; Back returned the focus to the Calls row. Model
   opened Settings with the focus on its MODEL heading. Tools & skills opened
   its page; turning Shell off changed the row to *1 tool off*. Triggers' +
   opened the Triggers page on its open form, the focus in Name.
4. The edge, focused: Shift+← four times widened the panel to 664 px, End to
   762 px (the chat kept 420 px), where the overview split into two columns
   (profile and setup left; routines, triggers and activity right). A reload
   kept 762 px. Home went back to 320 px. A drag through CDP with real mouse
   events (headless Chrome, its own profile) moved it from 344 to 494 px, saved
   `{"open":true,"width":494}` and set `aria-valuenow` to 494; dragging past
   the minimum stopped at 320.
5. Expand filled the bot's view with the overview in two columns; Escape (and
   Show the chat beside the panel) brought the chat back as it was, the focus on
   Expand. With the sidebar collapsed, the expanded header's Back sits clear of
   the restore control.
6. ⇧⌘, on Settings closed the panel; again, it opened on Settings.
7. Leaving for Automations and opening the bot again from the roster showed
   its overview, docked.
8. 390×844: the panel opens as the sheet, without Expand or the edge, on the
   page it showed; Back led to the overview. 844×390: the sheet's body scrolls.
9. Console: Lit's development-mode warnings only.

Not covered: calls (no ChatGPT login in the fixture), so Call in the profile
and Expand's absence during a call were read in code, not seen.
