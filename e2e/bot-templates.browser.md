# Bot templates browser verification

Journey for importing bots from other platforms' templates and exporting them
(HUI-18; SPEC.md, "Bots import other platforms' templates and export their
own"): + → **Import bot…** → preview → **Create bot**, a bot's ⋯ → **Export…**,
and `hui bot import`/`export` against the same gateway.

Run on 2026-10-07 against a gateway built from `feat/bot-templates` at `3bf4612`
(`npm run build`, then `node bin/hui.mjs gateway run --host 127.0.0.1 --port
<free port>`, so pages come from the built bundle) and driven with the Browser
tool on its managed headless profile. HUI, the gateway's routes, Pi Durable,
OptChat, Automation and the CLI are real; the model provider is the fixture
(`e2e/fixtures/pi-provider-fixture.mjs`, which answers an imported bot's kickoff with its
opener). Every template is a synthetic sample written for this run, except one
live Grok Bot marketplace link fetched by the gateway to prove the best-effort
reader against x.ai's current page (nothing of it is kept).

## Reproduce

1. A temporary root with `HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`,
   `XDG_DATA_HOME`, `XDG_STATE_HOME`, `PI_CODING_AGENT_DIR` and
   `PI_CODING_AGENT_SESSION_DIR` inside it, `PI_OFFLINE=1`; the provider and the
   gateway are started with `env -i` and only those variables (no proxy).
2. `<agent>/models.json` points provider `hui-e2e` (models `fixture` and
   `claude-sonnet-4-5`) at the fixture; `PUT /__hui/settings` with
   `{"themeMode":"dark"}`.
3. Samples: a Next.js page carrying a Grok Bot payload (pasted and as a file), an
   OpenClaw workspace folder and the same folder zipped by Python's `zipfile`, a
   Claude Code subagent, a Letta agent file, a V2 character card (JSON) and a V3
   card inside a PNG's `ccv3` chunk, a CrewAI `agents.yaml` with two agents, and
   plain text.
4. `hui bot import <sample> --yes` for each (stdin for the pasted page), then
   `hui bot export nova --memory` and `hui bot import nova.hui-bot.zip --yes`.
5. The browser opens `http://localhost:<port>/` at 1440×900, then 390×844 by
   resizing the viewport (responsive, not touch emulation), dark theme.

## Observed

1. **CLI, every format.** Each import printed the whole preview (SOUL.md, first
   message, skills with their instructions, routines with the schedule HUI read,
   integrations mapped or missing, tools turned off, what was left out and
   notes), then *Imported @handle…*. The live link
   `https://x.ai/bot/marketplace/bots/account-research` became a bot with 4 own
   skills and a disabled routine: its instructions are empty and its job is in six
   memories, so its description stands in as the persona and SOUL.md holds them
   (8,466 characters). The OpenClaw zip from Python unpacked like the folder
   (@nova-2). The CrewAI file without `--agent` exited 1 listing both agents;
   `--agent researcher` imported one. The card PNG's bot (@bolt) sent its first
   message.
2. **What was created.** Through the API: Code Reviewer kept only `read` on (19
   tools off) and its `sonnet` hint resolved to `hui-e2e/claude-sonnet-4-5`;
   Companion's Letta model hint resolved to `hui-e2e/fixture`; Nova's
   `weather` skill is its own (*Its own skills*, on) and its heartbeat routine is
   off, every 30 minutes; Trip Planner's routine is off, Mondays at 09:00.
3. **Export and back.** The zip held `bot.json`, `SOUL.md`, `skills/weather/SKILL.md`
   and `memory.md` (Python's `testzip` clean); importing it made @nova-3 with the
   same soul (one *What you already know* section), skill and disabled routine,
   and noted that @nova was taken.
4. **Browser, desktop.** + opens *New bot* and *Import bot…*. The dialog's File
   or folder | Link | Paste tabs, a file chosen (the Weekend Chef page), Preview:
   the heart face in its yellow, @weekend-chef, *From Grok Bot by Sample Author*,
   the untrusted note, the facts row, SOUL.md with *What you already know*, the
   first message, the `shopping-list` skill, *Friday menu · Fridays at 18:00 ·
   "every friday at 6pm"*, *Web search → Browser* and *Google Keep · missing*,
   and the note that the routine starts disabled. Create bot opened its chat: the
   *Weekend Chef was created* note, then the opener as its first message; its
   Routines tab shows *Friday menu* paused and its Tools tab lists
   `shopping-list` under Skills as *Its own skills*, on. Its ⋯ has *Export…*; the
   dialog with *Include its memory* downloaded `weekend-chef.hui-bot.zip`.
6. **Browser, mobile.** The same + menu from the drawer, the dialog at the
   screen's width, the downloaded export imported back (@weekend-chef-2, one
   memory) and the first bot's chat with its opener. No page errors.

## Limits

- Folder picking (`webkitdirectory`) was exercised through the CLI and the route
  tests, not the browser: the Browser tool sets one file on an input.
- Bots on a worker: their own skills go through the worker host's
  `bot.skills.*` requests, proved by `server/worker/host.test.ts` and
  `server/bots/remote.test.ts`; no worker was connected in this run.
- The Grok Bot reader depends on x.ai's page; the live link proves it on
  2026-10-07 only.

## 2026-10-16: export as a reviewed template

Journey for SPEC.md, "Bot exports are templates, reviewed for personal
information": a bot's ⋯ → **Export…** reviews it, the operator moves changes and
reads the files, **Download** saves the template, and importing it asks the new
owner. Run with `node e2e/visual-verification.mjs launch` (real HUI, PI Durable
and Automation; the model is `e2e/fixtures/pi-provider-fixture.mjs`, which answers the
reviewer's requests by flagging *Pat Doe*, *acme/widgets* and *Approve only when CI
is green*, and the imported bot's first turn), driven with the Browser tool,
1440×900 and 390×844 by resizing.

### Reproduce

1. Settings through `PUT /__hui/settings`: utility model
   `hui-e2e/fixture`, profile name *Dani Fernandez*.
2. A bot through `POST /__hui/bots`: Ada, title *Dani's PR review assistant*, a soul
   naming Dani Fernandez, Pat Doe, `acme/widgets`, the approval rule and
   `dani@example.com`; then, in its home folder, a `review` skill with
   `scripts/approve.sh` (naming `acme/widgets`), `scripts/list.sh`, `notes.md`
   (naming Pat Doe) and `.env`; a weekday cron routine in Europe/Madrid naming
   Dani, and a trigger whose filter matches `dani@example.com`.
3. Browser: Bots → Ada's ⋯ → **Export…**.

### Observed

1. **The review** (commits `2891567` and `41e5530`): *Changes 4, Cleaned 5
   automatically, Open points 4 for the new owner, Files 6*; *Removed* Pat Doe
   (becomes *a teammate*), *Asked* acme/widgets (becomes `[ask: the repositories to
   watch]`), *Confirmed* the approval rule, *Scripts* `scripts/approve.sh` set to
   travel for the new owner to check, *What it needs* one line, *Cleaned
   automatically* the name in the profile, soul and routine and the address in the
   soul and the trigger, *Stays behind* the memory and `.env`.
2. **Picks**: moving the approval rule to *Keep as written* moved it under *Kept*
   and made *Open points* 3; moving the script to *Stays behind* made *Files* 5.
   *Files as they will be saved* showed SOUL.md with `{{user}}`, the ask mark and
   *a teammate*.
3. **Download** closed the dialog after `POST /__hui/bots/:id/export` answered 200.
   The same review exported through the route held `bot.json`, `SOUL.md`, the
   skill's SKILL.md, `notes.md` and both scripts, every entry dated 1980-01-01,
   with no *dani*, *Pat Doe* or `example.com` anywhere, the routine's cron without
   its time zone and the trigger without its filter value.
4. **Import**: pasting `bot.json` showed the preview's *Triggers 1, disabled*,
   *What it needs* and the trigger's note (its open points left out, as a manifest
   alone has no soul). The zip, imported by `hui bot import`'s code against the same
   gateway with the profile name changed to *Alex Kim*, printed *Alex Kim's PR review
   assistant*, the soul with *Not agreed yet* and its four points, the skill's files,
   the routine and the disabled trigger. Its chat showed *Ada was created* and the
   fixture's first message going through the first point; its Soul tab showed the
   section, its Routines tab the routine paused and the trigger off. Mobile: the
   dialog full width, pickers under their part, the facts two by two.
5. No console errors on the imported bot's page (Lit's development warnings only).

### Limits

- The Browser tool can't set a file on an input, so the import preview of a whole
  zip was proved through the CLI's code and the route tests; the dialog was driven
  with a pasted manifest.
- The headless browser in this run lost its tabs repeatedly while the machine was
  loaded; the console of the export dialog itself was not read, and the
  imported-bot screens were captured at 1280×800 and 390×844.
- The reviewer is the fixture: what a real utility model flags depends on it; the
  route and unit tests prove how its answers are checked.
- A code review after this run tightened how the zip is built (wording the reviewer
  wrote is checked against the picks, overlapping passages merge, a passage found in
  a script changes the text too, personal skill names stay behind, older workers get
  no first turn). The dialog's controls are unchanged; those rules are proved by
  `server/bots/export.test.ts`, `server/bots/templates/cleanup.test.ts` and
  `server/bots/template-import.test.ts`, not by this browser run.

