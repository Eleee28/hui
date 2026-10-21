# Who sent each message

Journey for SPEC.md "Chats show who sent each message": a bot's, a session's,
a routine's and a trigger's messages show on the left under their sender, never
as the operator's *You* bubble, and what an agent hands a bot stays in sight as
*Sent to <bot>*.

Run on October 16, 2026 with `e2e/visual-verification.mjs launch --branch
<feature-branch>`, stacked on the bot replies branch (`e2e/bot-agent-replies.browser.md`).
HUI, Pi Durable, OptChat, the gateway's bot, tag, automation, trigger and
subagent routes are real; only the model provider is deterministic
(`E2E_CALL:<base64url JSON>` makes it call the tool it names,
`E2E_MESSAGE_BOT @handle` makes it tag that bot). API calls only set up state;
every message was sent through a visible composer or panel button.

## Reproduce

1. Launch and run doctor. Setup through the guarded API: `POST /__hui/bots` for
   Grace (mint, round, a soul) and Ada (lilac, a soul); two Durable sessions in
   the receipt's workspace, *Implement retry fix* and *Unrelated PR work*; a routine on Ada's chat
   (`POST /__hui/automation/tasks`, *Weekly release digest*) and a trigger
   (`POST /__hui/bots/<ada>/triggers`, *PR merged*).
2. 1440×900, *Implement retry fix*: send `@grace please babysit PR #7.` with an
   `E2E_CALL` for `message_bot` to `@grace` whose message is a Markdown brief.
3. Bots → Grace: her chat shows the brief. Send an `E2E_CALL` for `message_bot`
   to `agent:<Implement retry fix id>`, then `… E2E_MESSAGE_BOT @ada` (Enter
   picks `@ada` from the menu, a second Enter sends).
4. Click *Implement retry fix* under the brief, then *Grace* under her reply in
   the session; both open the chat they name.
5. Bots → Ada: her panel's trigger → **Test**, then Back, the routine →
   **Run now**.
6. *Implement retry fix*: send an `E2E_CALL` for `sessions_spawn` (*Retry tests*),
   then one for `sessions_send` to the child; open the child from the
   *Subagent finished* card.
7. With the session open, `PATCH /__hui/bots/<grace>` her avatar color, then
   back.
8. 390×844 with the same session, and 1440×900 with `themeMode: "light"`.

## Observed

- The session shows *Sent to **Grace*** with her face and the brief's first
  paragraph instead of *Ran 1 command*; it unfolds to the rendered brief.
- Grace's chat shows the brief on the left with a chat icon, rendered Markdown,
  and *Implement retry fix* under it; her own calls show *Sent to Implement
  retry fix* and *Sent to Ada* (Ada's face).
- Grace's reply in the session sits on the left with her face, a mint bubble and
  *Grace* under it, without `[from @grace · hop 2]`; the position rail labels it
  *From @grace*. No Rewind on it.
- Ada's chat shows Grace's tag with Grace's face, the trigger's message with a
  radio icon and *PR merged · test: a sample event*, and the routine's with a
  calendar icon and *Weekly release digest · Routine*.
- The subagent shows its task and the `sessions_send` message under *Implement
  retry fix*, a link back to the parent.
- Grace's face and bubble change color in the open session without a reload.
- At 390×844 the face stays beside the bubble and the name, time and actions
  share one line. Light mode keeps the tint and a readable name.
