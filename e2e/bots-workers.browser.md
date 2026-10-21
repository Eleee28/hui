# Bots on a worker browser verification

Journey for bots on remote workers (part 7 of the bots stack): the roster's
**+** menu that creates a bot on Local or on a worker, a bot on a worker
answering in its chat, the machine in its header and roster row, its Memory
panel read from the worker, the read-only machine in Edit, and an offline
worker, in dark mode at 1440×900 (fine pointer) and 390×844 (touch), plus a
light-mode close-up. Run against a gateway built from the branch (`node
bin/hui.mjs gateway run`) in a temporary HOME and XDG directories, with a local
worker: its connect command is `env HOME=<temp>/remote SHELL=/bin/sh`, so the
"remote" is a separate home on the same machine, with the built worker release
pre-installed (no network). HUI, the worker host, Pi Durable and OptChat are
real; the model provider (`e2e/fixtures/pi-provider-fixture.mjs`) is the deterministic
fake. Driven through CDP in headless Chromium. No operator transcript,
credential or account is used.

Since 2026-10-07 the bot dialog is gone: + creates *New Bot* without a name
(still on Local or on the worker chosen), and **Runs on** and the worker's
folders are in the bot's Settings tab, Workspace
([bot-setup.browser.md](bot-setup.browser.md)); step 3 below describes the old
dialog.

## Reproduce

1. `npm run build`. In a temporary root: a PI agent directory under its
   `home/.pi/agent` (models.json with the fixture provider and two models,
   `fixture` and `utility`; an auth.json key the fixture requires), HUI settings
   `{"models":{"utility":"fx/utility"}}`, and the worker
   release written into `<root>/remote/.local/share/hui-worker/releases/<id>/`
   from `build/server/worker/release.js`'s `workerRelease()`, with `node_modules`
   linked and `.ready` written.
2. `env -i PATH=… HOME=<root>/home XDG_CONFIG_HOME=<root>/config
   XDG_STATE_HOME=<root>/state XDG_DATA_HOME=<root>/data node bin/hui.mjs gateway
   run --host 127.0.0.1 --port <port>`, with `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`
   (any case) and `NODE_USE_ENV_PROXY` unset.
3. Setup through HUI's guarded API (not the journey under test): `POST
   /__hui/workers {"name":"devbox","command":"env -u XDG_CONFIG_HOME -u
   XDG_STATE_HOME -u XDG_DATA_HOME HOME=<root>/remote SHELL=/bin/sh"}` and its
   `connect`; a local bot, Ledger, with one exchange.
4. Desktop: Chromium at 1440×900 with
   `--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2`;
   phone: a separate Chromium at 390×844 with touch emulation. Both with
   `Emulation.setEmulatedMedia` `prefers-color-scheme: dark` (light for the one
   close-up).

## Observed (2026-10-06, `c93b9fa`; no console errors)

1. Bots tab → **+** opens a menu: *New bot on Local* (a terminal icon) and *New
   bot on devbox* (a globe), in the menu's own type, not the toolbar's small caps.
2. *New bot on devbox* creates the bot at once and opens its chat: *New bot*,
   "Say hi to New bot", its header "🌐 devbox · Idle", its roster row "🌐 devbox ·
   No messages yet".
3. Edit bot…: renamed to Rover with a title and instructions; beside the
   workspace, **Runs on** shows 🌐 devbox read-only ("A bot stays on the machine
   it was created on…", and the tools it can't use there); the workspace is the
   bot's folder on devbox and its hint says so. Save: "Saved Rover."
4. A typed message gets "Fixture response." from the chat running on the
   worker. The header reads "Field explorer · 🌐 devbox · Idle"; Rover's row
   shows the devbox tag before its preview; Ledger, local, has none.
5. Memory tab: 2 messages, 2 lines, the view's lines from the worker's memory,
   and "Summarizer since HUI started on devbox".
6. Phone: the drawer's + menu, the roster row with the tag, the chat header and
   the Memory sheet as on desktop.
7. `POST /__hui/workers/:id/disconnect`: the chat shows "Disconnected from
   devbox" (header, banner with Reconnect, composer) and the face goes offline;
   Refresh in the Memory panel says "devbox, where this bot runs, is offline:
   HUI is not connected to it. Connect it in Settings → Workers, then try
   again."; the + menu lists "New bot on devbox · disconnected", and choosing it
   shows "HUI is not connected to devbox. Connect it in Settings → Workers, then
   create the bot again." in the roster. Through the API: the memory route and a
   message answer 503 with those reasons, and `GET /__hui/bots` answers in about
   1 ms with the bot *disconnected*, no memory and its newest message.
   Reconnect brings it back (memory 200).
8. Light mode: the header and roster close-up keep the tag and the globe
   legible on the light tokens.

## Soul on workers (2026-10-07, `0be94df`, after merging SOUL.md; no console errors)

Same setup (the fixture provider's `models.json` base URL without `/v1`: its
client adds that itself), desktop only, dark mode.

1. Bots tab → **+** → *New bot on devbox*: *New Bot* opens with the note "New
   Bot was created" and its opener, "Hi, I'm new here. What would you like me to
   look after for you?", from the turn HUI started through its remote session.
   The header reads "🌐 devbox · Idle"; the row previews the opener.
2. "Call yourself Echo, please. E2E_SET_PROFILE": "set_profile answered: Saved:
   you are Echo (@echo), Fixture tester." The header and row follow.
3. "Keep my trail notes tidy and short. E2E_WRITE_SOUL": "I wrote my SOUL.md."
   On disk, `<root>/remote/.local/share/hui-worker/bots/<id>/SOUL.md` (0600, in a
   0700 home) holds "# Who I am / E2E_SOUL_TEXT: a terse fixture bot."; the
   gateway's configuration has no `bots/` folder at all. The Soul tab shows it.
4. ⋯ → Delete… while devbox is connected: the dialog names "its folder on
   devbox"; after Delete the home (SOUL.md and a `notes.md` put there) and the
   bot's OptChat memory are gone from the worker, and no clean-up was queued.
5. A second bot on devbox, a file put in its home, then `POST
   /__hui/workers/:id/disconnect`: the dialog adds "HUI is not connected to
   devbox now, so those go there when it reconnects". Delete closed it in 232 ms
   and the roster was empty; `~/.config/hui/bot-cleanup.json` held its worker,
   id, reference and folder, and the home was still on devbox. `POST …/connect`:
   the home and the memory went, and the clean-up file's list was empty.

## Not covered here

A GPT-Live call with a bot on a worker (the call path itself runs in the
gateway, and the helper's memory view and the call's record go through the
worker's ports, which `server/bot-workers.test.ts` exercises); a real SSH
worker on another machine (the container E2E of workers covers the real
install path).
