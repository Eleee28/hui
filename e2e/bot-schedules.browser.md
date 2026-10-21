# Bot schedules browser verification

Journey for schedules as a CLI and bots that schedule their own routines (HUI-18
item 10; SPEC.md, "Schedules are a CLI, and bots schedule their own routines"):
a bot adds a temporary routine through its `routines` tool, the Routines tab and
Automations show who made it and its limits, the routine's own turn removes it,
the Tools tab lists the tool as a normal switch, and `hui schedule` manages the
same tasks from a terminal, with bots on and off.

Run on 2026-10-07 against a gateway built from `feat/bot-schedules` at `b0483c2`
(`npm run build`, then `node bin/hui.mjs gateway run --host 127.0.0.1 --port
<free port>`, so pages come from the built bundle as in production) and driven
with the Browser tool on an owned headless Brave (disposable profile, CDP 18800).
HUI, the gateway's routes and streams, Pi Durable, OptChat, Automation, the bot
tools' extension and the CLI are real; only the model provider is a fake
(`e2e/fixtures/pi-provider-fixture.mjs`). No operator configuration, transcript,
credential or account is involved.

## Reproduce

1. A temporary root with `HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`,
   `XDG_DATA_HOME`, `XDG_STATE_HOME`, `PI_CODING_AGENT_DIR` and
   `PI_CODING_AGENT_SESSION_DIR` inside it, `PI_OFFLINE=1`, `TZ=Europe/Madrid`;
   every process is started with `env -i` and only those variables (no proxy).
2. Start `e2e/fixtures/pi-provider-fixture.mjs` (`HUI_E2E_PROVIDER_PORT=0`) and point
   `<agent>/models.json` at it (provider `hui-e2e`, model `fixture`).
3. Start the built gateway and set it up through the guarded API (not the
   journey under test): `PUT /__hui/settings` with `themeMode: "dark"`; `POST /__hui/bots` for Ada (title *Release watcher*,
   heart, lilac, a soul); an operator routine *Morning digest* on Ada's chat
   (`0 9 * * 1-5`, Europe/Madrid); an ordinary session *Release notes*. Then
   `hui schedule add --name "Nightly review" … --cron "0 2 * * *" --session
   "Release notes"` from the same environment.
4. The browser opens `http://localhost:<port>/bots/<Ada's id>` (the Browser tool
   refuses `127.0.0.1` by policy) at 1440×900, then 390×844 by resizing the
   viewport (responsive, not touch emulation).
5. The fixture answers a message holding `E2E_ROUTINE_ADD` with a `routines`
   call that adds *Watch #82* (every 5 minutes, until three hours from then, 3
   runs; its prompt carries `E2E_ROUTINE_DONE`), and a turn holding
   `E2E_ROUTINE_DONE` (that routine's own) with a `routines` call that removes
   *Watch #82*.

## Observed

1. **The bot schedules itself.** Typing *E2E_ROUTINE_ADD Keep an eye on PR #82
   every 5 minutes until it's green, for at most three checks.* in Ada's
   composer: the reply reads *routines answered: Added the routine "Watch #82"
   (id …): every 5m, first run …; until …, 3 runs left, then HUI deletes it.* The
   open Routines tab (count 2) lists *Watch #82* first, *Every 5 minutes · next
   …*, with the pills *made by @ada*, *until 16:41* and *3 runs left*, above the
   operator's *Morning digest*, which has none.
2. **Automations** lists *Watch #82* with *Bot · Ada · made by @ada · until 16:41
   · 3 runs left* beside its name, at the description's weight; *Morning digest*
   reads *Bot · Ada* and *Nightly review* *Release notes*, nothing more.
3. **Tools.** Ada's Tools tab lists, in the Bots group after *Message bots*,
   *Manage its own routines* (`routines`, *List, add, change and remove its own
   routines, temporary ones included*), on, without a Powerful badge.
4. **Across a restart, and its own turn removes it.** The gateway was stopped
   (`hui gateway stop`) and started again before the routine's first time; the
   routine kept its limits. At its time the scheduler ran it: Ada's chat shows
   *[routine: Watch #82] E2E_ROUTINE_DONE …* and the reply *routines answered:
   Removed the routine "Watch #82": this turn is its last.* The Routines tab
   dropped it by itself (count 1), and Latest runs shows *Watch #82 · Completed ·
   Scheduled* with that summary. Asked again, Ada added a new *Watch #82* (*until
   16:47 · 3 runs left*).
5. **390×844.** The panel opens as a sheet from *Show the bot panel*; the routine
   card shows its pills on a line of their own under the schedule. Automations' rows stack their
   cells and the facts stay on the name's meta line. The document never got wider
   than the viewport.
6. **The CLI**, from the same environment (`node bin/hui.mjs`, this build's
   `hui`): `schedule list` prints every task with its target (`@ada`, `session
   "Release notes"`) and, for *Watch #82*, *made by @ada · until … · 3 runs left*;
   `schedule show "Watch #82"` its target, schedule, state, end, runs left, maker,
   timeout and last run; `schedules list --bot ada` only Ada's; `schedule add
   … --session "Release notes" --until 2026-10-10T18:00 --runs 24` a temporary
   session schedule; `resume`, `edit --every 2h --runs 12` and `pause` acted on
   it; `hui bot routine list ada` shows the same facts.
7. Page errors: none. The console's errors are the UI's requests that failed
   while the gateway was stopped for the restart, which the gateway's UI
   diagnostics recorded (`ui/request_failed`, three entries).
