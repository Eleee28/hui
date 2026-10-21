# Browser journey: compaction marker and rewind across it

Verified on 2026-10-02 with the PI 0.87.1 SDK worker, HUI's real gateway and the
deterministic local provider, launched by `e2e/visual-verification.mjs`. No
operator PI credentials, sessions or HUI registry were used.

## Setup

New launcher sessions run on Durable, including their PI extensions. Steps
1–8 describe PI-worker compaction semantics: use `launch … --pi-sessions` for
those, and the default launcher for the Durable journey below. The launcher loads `e2e/fixtures/compaction-extension.ts`, whose `fixture-compact`
command runs PI's own summarizer and resolves once the compaction entry is
written, and sets PI's `compaction.keepRecentTokens` to 400 so a few short turns
have something to summarize. The provider answers PI's summarizer request with
`FIXTURE_SUMMARY`; its request log is `artifacts/provider.jsonl`.

## Visible-control journey and observed results

1. Start a session in the printed workspace with `COMPACT_ONE`, then send
   `COMPACT_TWO` and a ~2,000-character `COMPACT_THREE kept kept …`. Each gets
   `Fixture response.`
2. Type `/fixture-compact`, complete it from the command menu and Send. When the
   command settles, a **Context compacted · from N tokens** divider follows the
   last turn; all three turns stay visible above it. **Show summary** expands
   `FIXTURE_SUMMARY`. The divider is a `separator` with that accessible name.
3. Rewind on `COMPACT_THREE` (inside PI's kept window). Its text returns to the
   composer; `COMPACT_ONE`, `COMPACT_TWO` and the divider remain. Send
   `AFTER_KEPT`: the provider request holds the summary and the new prompt only,
   none of the summarized turns.
4. Rewind on `COMPACT_TWO` (summarized). The divider disappears and the text
   returns to the composer. Send `AFTER_CUT`: the provider request holds the
   original `COMPACT_ONE` turn and no summary.

## Live compaction

Turns that mention `E2E_SLOW_COMPACT` make the provider hold PI's summary until
`POST <providerUrl>/control/release-replay` (fixture control, not UI proof).

5. Send `E2E_SLOW_COMPACT first turn`, then a ~2,000-character `LONG kept …`
   turn. `/comp` lists **/compact** among HUI's commands; complete it, add
   `keep the API decisions` and send. A live **Compacting context…** divider
   with the folding glyph replaces the working indicator; the header says
   Running and Stop is offered. The summarizer request carries the focus text.
6. Send `TYPED_DURING_COMPACTION`: it joins the queue above the composer as a
   follow-up instead of failing. Release the hold: the divider becomes the
   **Context compacted** marker and the queued message is sent and answered.
7. Open the context meter and choose **Compact now**: PI has nothing new to
   summarize, so a **Compaction failed** divider shows "Nothing to compact
   (session too small)" while idle. It disappears when the next turn starts.
8. Send `E2E_SLOW_COMPACT again`, another long turn, then `/compact`, and press
   Stop while it is held: **Compaction cancelled**, no marker is written.

## Durable sessions

Verified on 2026-10-04 with Pi Durable 1.0.1, the default launcher and the same
provider. The fixture model's 200k window keeps Durable's background compaction
from starting by itself, so only `/compact` and **Compact now** compact. Durable
sessions keep Durable's semantics: a manual compaction runs beside the
conversation, which stays idle.

1. Start a session with `COMPACT_ONE first turn`, then send `COMPACT_TWO second
   turn` and a ~2,000-character `COMPACT_THREE kept kept …`. The header reads
   `durable · … · Idle`; no divider appears on its own.
2. Send `/compact keep the API decisions`. A **Context compacted · from N
   tokens** divider follows the last turn, all three turns stay above it, and
   **Show summary** expands `FIXTURE_SUMMARY`. The summarizer request carries
   `Additional focus: keep the API decisions` and only `COMPACT_ONE` and
   `COMPACT_TWO`: Durable kept `COMPACT_THREE` verbatim. N is Durable's own
   estimate; the fixture reports two tokens per request.
3. Rewind on `COMPACT_THREE`: its text returns to the composer, `COMPACT_ONE`
   and `COMPACT_TWO` stay, and the divider is gone, because a Durable fork holds
   the history up to that point and not the summary placed after it.
   `AFTER_FORK`'s request holds `COMPACT_ONE`, `COMPACT_TWO` and no summary.
4. In a new session send `E2E_SLOW_COMPACT first turn`, a long turn, then
   `/compact keep the API decisions`: the live **Compacting context…** divider
   with **Cancel compaction**. The header stays `Idle`, the composer reads
   "Send a message…", there is no Stop, and **Compact now** is disabled.
5. Send `SENT_WHILE_COMPACTING`: it is answered at once, and its request holds
   the whole history and no summary. The live divider stays below the new turn.
6. `POST <providerUrl>/control/release-replay`: **Context compacted** follows
   the turn answered meanwhile.
7. Send `E2E_SLOW_COMPACT again` and a long turn, then a bare `/compact` (send
   it with the button; Enter completes the command menu) and press **Cancel
   compaction** while it is held: **Compaction cancelled**, no marker.

## Limits

Automatic threshold and overflow compaction are covered by
`server/runtimes/pi-sdk.test.ts` rather than this journey: the fixture model
reports tiny token counts, and lowering PI's reserve would compact every
launcher session. Durable's background compaction (idle session, survives Stop
and Cancel, dropped by `/clear`) and Stop cancelling a manual compaction are
covered by `server/runtimes/durable.test.ts`.
