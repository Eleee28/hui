# Bot tagging browser verification

Journey for tagging bots by `@handle` (HUI-18, SPEC.md "Agents and bots tag
bots by @handle"): a bot's Settings page has a Tagging section (*When to tag
it*, its description, and *Who can tag it*), which its panel's Setup lists
first as *Tagging*, every session lists the bots it
may tag and has `message_bot`, the composer's `@`
suggests bots before files, and a bot that takes tags only when mentioned is
refused a tag the operator's message doesn't name.

Run on 2026-10-16 at `ff332c9`, and again in the Browser tool on the merge with
the panel as a profile (`54db9be`, steps 2, 4, 5 and 8), with
`e2e/visual-verification.mjs launch` (doctor passed before and after on a clean
checkout). HUI, the gateway's bot and session routes, Pi Durable, OptChat and
the agent-tool handler are real; only the model provider is mocked
(`e2e/fixtures/pi-provider-fixture.mjs`): `E2E_MESSAGE_BOT @handle` makes it call
`message_bot({ to: "@handle", message: "hello from the fixture" })`, and
`E2E_CALL:<base64url JSON>` makes it call the tool it names. No operator
transcript, credential or account was used.

The early steps ran in the Browser tool: the Settings tab, the picker, `@`
suggestions in a new-session composer and in a session pane, Enter choosing a
bot without sending, and a session's tag reaching Ada. On that loaded machine
its tabs kept closing a few seconds after opening, so the screenshots that
document the journey come from the same steps driven through CDP in a headless
Chrome of its own (fresh profile, real mouse and key events, reads only through
`Runtime.evaluate`), as [bot-setup.browser.md](bot-setup.browser.md) was.

## Reproduce

1. Launch, then setup through the API: `POST /__hui/bots` for Ada (*Release manager*, a soul so
   no kickoff runs) and Dee (*Finance*); `POST /__hui/sessions` for a Durable
   session titled *Release prep for PR 7* in the receipt's workspace.
2. 1440×900. Ada's chat → her panel's Setup → **Tagging** → *When to tag it*:
   type "Writes and publishes release notes. Tag her when a pull request merges
   or a release needs its notes." and press Enter.
3. Dee's chat → **Who can tag it** → *Only when @mentioned*.
4. The session's composer: type `@`, press Enter, type "please write the
   release notes for PR 7. E2E_MESSAGE_BOT @ada " and Enter.
5. Ada's chat.
6. The session: send "Ask Dee for the Q3 numbers. `E2E_CALL:…`" (a
   `message_bot` call to `dee`), then "@dee the Q3 numbers, please.
   `E2E_CALL:…`" (the same call).
7. 390×844 (touch emulation): the session's composer with `@`; Ada's panel as
   a sheet on **Settings** → **Tagging**.
8. On the merge: Ada set to *Only when @mentioned*, then **Back**; 390×844, her
   panel's overview and Setup → **Tagging**; the session sends "@ada please
   draft the release notes for PR 7. E2E_MESSAGE_BOT @ada".

## Observed

1. Ada's description saved on Enter (`GET /__hui/bots/ada` returned it); the
   section reads *TAGGING · @ada from any chat*, the description in a
   paragraph-wide field, and *Who can tag it: Anyone — Agents and bots, when a
   task fits*.
2. The picker offers *Anyone*, *Only when @mentioned* (*When your message tags
   it*) and *Nobody* (*Only you, in its chat*); the choice saved
   `tagging: "mention"` and the row's hint followed it.
3. `@` listed **@ada** (Ada · Release manager) and **@dee** (Dee · Finance)
   with their faces, then `fixture.txt`; Enter left `@ada ` in the composer
   and sent nothing. The message went out once typed; the turn called
   `message_bot` (*Completed*) and answered "message_bot answered: Queued for
   @ada." The provider log shows that request's system prompt with the
   session's `<bots>` section: Ada under *Bots you can tag, when a task fits
   what they do* with her description, Dee under *Only when the user's message
   tags them*, and `message_bot` the only bot tool offered.
4. Ada's chat shows "[from agent: Release prep for PR 7] hello from the
   fixture" and her reply.
5. The unmentioned tag answered "@dee takes a tag only when the operator's
   message names it (@dee). Ask them instead."; the mentioned one "Queued for
   @dee.", and Dee's roster row moved to her reply.
6. At 390×844 the menu stays inside the viewport (9–381 px of 390) with bots
   first; the sheet's Tagging section fits its group (field 36–365 px, group
   23–378 px). No page errors at either size.
7. On the merge, Setup → *Tagging* (reading *Anyone*) opened the Settings page
   at its Tagging section; after the choice and **Back** the row read *Only
   when @mentioned* with the focus on it, at 1440×900 and in the 390×844
   sheet. The session's mentioned tag reached mention-only Ada as "[from
   agent: Release prep for PR 7] hello from the fixture".
