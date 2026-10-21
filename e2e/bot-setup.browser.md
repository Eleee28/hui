# Bot setup browser verification

Journey for setting bots up like Grok Bot (HUI-18, SPEC.md "Bots are set up
like Grok Bot"): + creates a bot at once, with no form, and its first message
asks what to call it; while a remote worker exists + is a menu, New bot on
Local or on the worker; the bot panel's Settings tab (Profile, Model, Calls,
Workspace) saves each change on its own, and its Workspace shows the machine a
bot runs on and offers only that machine's folders; **Edit bot…** in either ⋯
menu opens that tab; Ctrl+Shift+, toggles it; the panel's tab row holds
Routines, Memory, Soul and Settings (and Tools, which comes later).

Run on 2026-10-07 against gateways built from `feat/bot-setup` (`npm run
build`, then `node bin/hui.mjs gateway run --host 127.0.0.1 --port <port>`, so
pages come from the built bundle as in production) and driven through CDP in
headless Chromium: the steps without a worker at `45f763e`, the steps with one
at `e8c08fe` (which changes only where Runs on shows, so only while a worker
exists). HUI, the gateway's `/__hui/bots` and `/__hui/workers` routes and
streams, Pi Durable, OptChat, the worker host, the soul's first conversation and
`set_profile` are real; only the model provider is a fake
(`e2e/fixtures/pi-provider-fixture.mjs`). No VoiceStudio, ChatGPT login, operator
transcript, credential or account is involved.

## Reproduce

1. A temporary root with `HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`,
   `XDG_DATA_HOME`, `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR`
   inside it, `PI_OFFLINE=1`, and the proxy variables unset; every process is
   started with `env -i` and only those variables.
2. Start `e2e/fixtures/pi-provider-fixture.mjs` (`HUI_E2E_PROVIDER_PORT=0`) and point
   `<agent>/models.json` at it: provider `hui-e2e` with the models `fixture` and
   `fixture-mini`; `<agent>/settings.json` defaults to `hui-e2e/fixture`.
3. Start the built gateway, then set it up through the guarded API (not the
   journey under test): `PUT /__hui/settings` with
   `{"calls":{"voice":"cove"},"models":{"primary":"","fallback":"","utility":"hui-e2e/fixture-mini"}}`
   and `POST /__hui/bots` for Scout (blob, blue, `hui-e2e/fixture`, medium,
   language `es`, call voice `ember`), Pixel (heart, coral) and Owl (🦉).
4. Chromium `--headless=new` with a disposable profile. Desktop runs add
   `--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2`
   (1440×900 and 1280×720); the phone run uses `Emulation.setDeviceMetricsOverride`
   with `mobile: true` and touch emulation at 390×844. Dark theme through
   `Emulation.setEmulatedMedia` (`prefers-color-scheme: dark`).
5. The fixture answers a new bot's kickoff (`[HUI bot created]`) with
   "Hi, I'm new here and I don't have a name yet. What would you like to call
   me?" while the bot's prompt says it has no name yet, and with "Hi, I'm new
   here. What would you like me to look after for you?" otherwise;
   `E2E_SET_PROFILE` makes the bot call `set_profile` with the name Echo and the
   title "Fixture tester".
6. For the worker, as in `e2e/bots-workers.browser.md`: the built worker release
   (`build/server/worker/release.js`'s `workerRelease()`) written into
   `<root>/remote/.local/share/hui-worker/releases/<id>/` with `node_modules`
   linked and `.ready` written, then `POST /__hui/workers` `{"name":"devbox",
   "command":"env -u PI_CODING_AGENT_DIR -u PI_AGENT_DIR -u
   PI_CODING_AGENT_SESSION_DIR -u XDG_CONFIG_HOME -u XDG_CACHE_HOME -u
   XDG_DATA_HOME -u PI_OFFLINE -u HUI_PI_BACKEND HOME=<root>/remote
   SHELL=/bin/sh"}` (each word quoted) and its `connect`. The "remote" is a
   separate home on the same machine; `<root>/remote/project` and
   `<root>/home/proto-local` tell its folders from this machine's.

## Observed without a worker (`45f763e`)

1. **1440×900, Scout's chat, Settings tab**: Profile (Name with @scout, Title,
   Look "Blob · Blue" with Change), Model (*HUI SDK Fixture*, Medium, Utility
   model *Default (HUI Fixture Mini)*, "Applies from its next turn"), Calls
   ("Needs a ChatGPT login" beside the heading; Call voice Ember, Language
   Spanish) and Workspace (Directory), with no Runs on. The tab is 770 px tall
   in an 816 px body: no scrolling. Opening the Look adds Face | Emoji, five
   named shape chips and six named swatches (974 of 816 px, the body scrolls).
2. **+ in the Bots toolbar** is a plain button: one `POST /__hui/bots` with the
   body `{}` (201); no dialog opens. 119 ms later the chat is `/bots/<new id>`,
   "New Bot · Idle", on the note *New Bot was created*, then "Hi, I'm new here
   and I don't have a name yet. What would you like to call me?". The roster
   lists New Bot first; the panel stays on Settings, with Name "New Bot" and
   @new-bot.
3. Answering `E2E_SET_PROFILE call yourself Echo` from the composer: the bot
   calls `set_profile`, and without a reload the header reads "Echo · Fixture
   tester · Idle", the panel's title Echo, Settings' Name Echo with @echo and
   Title "Fixture tester", and the roster row Echo.
4. **Each change saves on its own**: on Pixel, Thinking → Low with 1.5 s of
   added network latency shows *Saving…* on the Thinking row (`aria-busy`
   true) while the picker already reads Low, then clears; one
   `PATCH {"thinking":"low"}` (200). A directory that does not exist, typed and
   saved with Enter, gets `PATCH {"cwd":…}` 400 and the gateway's "No such
   directory: …" under the field; leaving the field sends nothing more, and
   Escape puts the bot's directory back and drops the error without closing
   the panel. While Pixel runs a held turn (`E2E_REPLAY`) the directory field is
   disabled with "It is working. The directory can change once it is idle.";
   it unlocks when the turn ends.
5. **Edit bot…**: from Scout's chat on Routines, Pixel's row menu (Edit bot…,
   Hide, Archive…, Delete…) → **Edit bot…** opens Pixel's chat on Settings with
   the focus on the Settings tab (stored tab `settings`). From the Soul tab, the
   chat header's ⋯ (Edit bot…, Archive…, Delete…) → **Edit bot…** lands on
   Settings with the same focus.
6. **Tab row**: Routines 90, Memory 88, Soul 65 and Settings 88 px in 343 px;
   with a Tools tab and a routine count of 12 added in the page, 97, 68, 46,
   51 and 69 px, still 343 of 343 (no overflow, nothing clipped). Arrow keys,
   Home and End move through all four tabs and wrap.
7. **Ctrl+Shift+,** on a bot's chat (Memory tab showing): Settings; again:
   the panel closes; again: Settings.
8. **1280×720**: the panel stays 344 px and the chat 678 px; the Settings tab
   scrolls (794 of 636 px).
9. **390×844**: the drawer's Bots list with its plain +; + creates New Bot (body
   `{}`), closes the drawer and shows the note and the name question; the panel
   toggle opens the sheet (380 px, tab row 379 of 379 px) on Settings with Name
   "New Bot" (779 of 752 px, scrolls a little); Escape closes the sheet.

## Observed with devbox (`e8c08fe`)

1. **+ is a menu**: *New bot on Local* (terminal icon) and *New bot on devbox*
   (globe), in the menu's own type. Scout's Settings now says "Runs on Local"
   beside the Workspace heading and is still 770 px in 816: no scrolling. (As a
   row, the machine made it 806 px where 792 px fit, a 14 px scroll; e8c08fe
   moved it beside the heading.)
2. ***New bot on devbox***: one `POST /__hui/bots` with `{"worker":"<devbox's
   id>"}` (201) and no name; 127 ms later the chat opens, "New Bot · 🌐 devbox ·
   Idle", on *New Bot was created* and the name question from the turn HUI
   started through its remote session; its roster row carries the devbox tag.
3. **Its Settings**: "Runs on 🌐 devbox" beside the Workspace heading; the
   Directory says "A folder on devbox. Can change only while it is idle." and
   holds its home on the worker; under the section, #79's hint: "A bot stays on
   the machine it was created on: its chat and memory live there. Terminals,
   the browser and watchers stay on this machine, so it can't use them." The
   tab is 822 px tall: it scrolls by 30 px at 1440×900.
4. **Its folders are devbox's**: typing `~/pro` asks
   `/__hui/directories?…&worker=<devbox's id>` and suggests `~/project/` (the
   worker's home); the same on Scout suggests `~/proto-local/` (this
   machine's). Escape restores the bot's folder; nothing is saved.
5. **Offline**: after `POST /__hui/workers/:id/disconnect` the menu reads
   *New bot on devbox · disconnected*; choosing it gets 503 and the roster says
   "HUI is not connected to devbox. Connect it in Settings → Workers, then
   create the bot again." `connect` brings it back.
6. **390×844**: the drawer's + opens the same menu; the devbox bot's header
   reads "New Bot · 🌐 devbox · Idle", and its Settings sheet ends with "Runs on
   🌐 devbox", the folder on devbox and the hint (831 of 752 px, scrolls).
7. Console and page errors: none, apart from the expected 400 of the refused
   directory and the 503 of the offline worker.

## Limits and gaps

- The model provider is a fixture: a real model's opener, and how it words the
  name question, were not part of this run.
- No VoiceStudio: the Settings tab has no VoiceStudio rows, by design. No
  ChatGPT login: calls were not placed; only their Settings rows were checked.
- The worker is a separate home on the same machine, as in #79's journey, not
  a real SSH worker on another machine.
- Light theme and reduced motion were not captured for this change.
