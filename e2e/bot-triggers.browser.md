# Bot triggers browser verification

Journey for triggers (HUI-18 item 13; SPEC.md, "Listeners are the only
triggers"): the Triggers section of a bot's Routines tab, with a listener played
by `curl` reporting to a trigger's URL, at 1440×900 and 390×844, and
`hui doctor` on the state older versions' trigger kinds leave.

Run on 2026-10-13 against `dani.fernandez/listener-triggers` through
[hui-visual-verification](../.agents/skills/hui-visual-verification/SKILL.md):
an isolated instance of the committed checkout, its fixture provider, and its
fake `gh` (`--github-fixture`), which answers for synthetic accounts but can't
read a pull request, so a linked one shows as *gh could not read it*. Reading
linked pull requests into a delivery is proved by
`server/routes/bot-triggers.test.ts` against `e2e/fixtures/github-triggers-fixture.mjs`.
No operator configuration, transcript, credential or account is involved.

## Compact steering journey

Use the same isolated launcher with the deterministic provider. Create a bot
with an existing soul through fixture setup, then open its Triggers page.

1. In Add trigger, choose a name, prompt and cooldown None. Select **Steer the
   current turn with summaries and PR links only** and add it. The card names
   the mode. Keep its revealed URL in the local fixture only.
2. Send `E2E_REPLAY` through the bot's composer and wait for the provider's
   `/control/wait-replay-ready`. This holds a real Durable turn open.
3. Play the listener with a report linking a synthetic PR and carrying a long
   details sentinel. The live queue must contain the notice as steering, no
   extra follow-up. Its summary and PR link remain; the sentinel and fetched
   PR diff do not. The active turn is not aborted.
4. Release the provider through `/control/release-replay`. The bot takes the
   notice in its current run. An ordinary operator follow-up already queued
   remains separate and runs afterward, not as part of this notice.
5. Report a second event while idle and observe a new normal turn. An
   unselected trigger retains the existing full-context follow-up behavior.
6. Repeat the form interaction at 390×844. Inspect the selected mode and short
   notification without horizontal overflow. Check page errors and run doctor
   before final desktop/mobile captures, then clean up.

Verified locally on October 19, 2026 with real Durable conversations and the
launcher provider. The desktop form saved compact steering and named it on the
card. A held turn received a PR notice as steering while an ordinary operator
follow-up remained separately queued; after release the notice ran before that
follow-up. An idle notice started normally. At 390×844 the same form created a
second compact trigger and its Test action delivered a sample. No page errors
were observed; only existing Lit development/update warnings appeared. Doctor
passed before and after, and cleanup confirmed the isolated ports closed.

The executable security and delivery proof belongs to
`server/bot-trigger-routes.test.ts`: a real gateway and Durable runtime against
the fixture provider, including a steered trigger's inability to rename the bot,
rewrite its soul or add/update schedules. Tests also cover default delivery,
mode persistence and template preservation. This journey does not prove a live
model's delegation choices or GitHub fixes.

## Reproduce

1. `node e2e/visual-verification.mjs launch --branch <branch> --github-fixture`,
   then `doctor` with its receipt. The Browser tool opens the instance at
   1440×900.
2. **New bot** makes one with the fixture model.
3. The bot's panel → **Routines**: the Triggers section and its add form.
4. A shell plays the listener: `curl -sS -X POST "$URL" -H 'content-type:
   application/json' -d '<report>'` with the URL the form showed.
5. `hui doctor` runs against a temporary `HOME` and `XDG_CONFIG_HOME` holding a
   `bot-triggers.json` with a GitHub and a Slack trigger beside a listener's,
   and the `bot-trigger-cursors.json`, `bot-trigger-slack.json` and `slack.json`
   older versions wrote (`npm run build` first; `node bin/hui.mjs doctor`, then
   `doctor --fix`; no gateway runs on that state).

## Observed

1. **No triggers yet**: the section says a trigger wakes the bot when a listener
   you run reports something, and the add form is open. It has no choice of
   source: Name, what a listener does, *Only events where (optional)* (field,
   equals or contains, value), *Only events that link a GitHub pull request*,
   *Also events it marks as from outside your organization*, *Also events it
   marks as from bots and apps*, Prompt and Cooldown.
2. **Add trigger** *Reviews* (`fields.channel` equals `G01M4T1JFLK`, PR links
   only, cooldown None, a prompt): its URL shows once, *Reviews: its URL*, with
   what to send it, Copy and Done. Its card: the filter (`fields.channel equals
   "G01M4T1JFLK" · PR links only`), *Never fired · cooldown none*, *No report
   from the listener since the gateway started.* as a problem, the URL's first
   characters, Test, New URL and Delete.
3. **A check-in** (`{"events":[]}`) answers 202 `ignored`; the card says
   *Listener reported just now* and the problem is gone. Nothing reaches the
   bot.
4. **A report** with a matching review ping linking a pull request, the same
   ping from another channel and one marked `"bot": true` answers 202 `fired`.
   The bot's chat shows one `[trigger: Reviews · …] <prompt>` message with the
   ping's details and a line for the linked pull request (*gh could not read
   it*, from this fake), then the fixture's reply. The card says *Last fired just now*; the run is *Fired*.
5. **The same report again** answers 202 `ignored`; the chat still has one
   delivery. A report without an `id` answers 400 with what to fix. A report
   with `"error"` shows that problem on the card.
6. **Test** delivers *[trigger: Reviews · test: a sample event]* and says *Sent
   a test event to <bot>'s chat.*
7. **New URL** shows a new URL once; the old one answers 404.
8. **Settings → Integrations** lists Jira and GitHub; Slack is gone.
9. **390×844**: the panel sheet shows the card, the URL box and the form
   without horizontal overflow.
10. **`hui doctor`** reports the GitHub and Slack triggers and the three files
    as left by the kinds HUI no longer has, with what `--fix` does and that
    deleting `slack.json` doesn't revoke its token, and exits 1. **`--fix`**
    deletes them and their runs; the listener trigger stays, and `hui doctor`
    then reports nothing left and exits 0.
11. Page errors: none.
