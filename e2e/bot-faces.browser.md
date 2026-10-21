# Bot faces browser verification

Journey for the bots' animated faces (part 5 of the bots stack, after OpenAI's
Dots): the roster's faces and states, a bot chat's header and empty-chat face,
the dialog's Look, light and dark themes, 390×844, reduced motion,
accessibility and cost. Run against `e2e/visual-verification.mjs launch
--branch feat/bot-faces --pi-sessions` in headless Chromium driven through CDP
(the Browser tool's headless Brave hangs on screenshots on this host). HUI, the
gateway's `/__hui/bots` routes and stream, Pi Durable and OptChat are real; the
model provider (`e2e/fixtures/pi-provider-fixture.mjs`) is a deterministic fake. No
operator transcript, credential or account is used.

Since 2026-10-07 the Look is a row of the bot's Settings tab rather than a
dialog ([bot-setup.browser.md](bot-setup.browser.md)); step 5 below describes
the old dialog.

## Reproduce

1. From the checkout, with `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` (any case) and
   `NODE_USE_ENV_PROXY` unset: `node e2e/visual-verification.mjs launch --branch
   feat/bot-faces --pi-sessions`, then `doctor` on the receipt
   before and after the browser work, and `cleanup` at the end.
2. Setup through HUI's guarded API (not the journey under test): `POST
   /__hui/bots` for ten bots: Scout (blob, blue), Coach (heart, magenta), Atlas
   (round, mint), Pixel (cookie, coral), Tri (triangle, yellow), Juno (heart, lilac), Moss (cookie,
   mint), Owl (🦉), and Ledger and Nova with no look (their ids pick it); an
   eleventh, Old, archived. States come from messages
   (`POST /__hui/bots/:id/messages`): `E2E_REPLAY` holds a streaming reply
   (thinking), `E2E_COMMAND_RUNNING` holds a tool (working in the chat), a
   667-character message ending in `E2E_HOLD_MEMORY` and then a short one hold
   a memory summary (memory), `E2E_ERROR` fails a turn (error in the chat), and
   `/hui-e2e-question confirm` asks a question (waiting).
   `POST <providerUrl>/control/release-replay` releases every hold.
3. Desktop runs use `--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2`
   at 1440×900; phones a separate browser at 390×844 with touch emulation.
   Themes through `Emulation.setEmulatedMedia` (`prefers-color-scheme`), and
   reduced motion through `prefers-reduced-motion: reduce`.

## Observed (2026-10-06, `805aab5`, clean checkout; doctor passed before and after)

1. Roster (light and dark): each bot shows its face with its activity badge and
   preview. Scout blob *thinking* ("Replay prefix —"), Moss cookie *thinking*
   (a held tool; the roster only knows the chat runs), Atlas round *memory*
   (sleepy eyes, thought dots, "Summarizing memory…"), Coach heart *waiting*
   (tilted, the hand badge, "Waiting for your answer"), the others *idle*,
   Owl's 🦉 on a tile of its id's color. Ledger and Nova show the faces their ids
   pick, the same after reloads and in every place they appear.
2. An empty chat (Tri, Nova, Juno): the 112 px face above *Say hi to …*; the
   header's 36 px face beside the name and "role · Idle". Moving the pointer
   250 px right of it turned the eyes from `translate(0px, 0px)` to
   `translate(5.9px, -1.68px)` and leaned the body `rotate(2.72deg)`.
3. Pixel's failed turn: its chat header's face reads *error* (muted body,
   brows) while the run-error notice shows; the roster row is idle.
4. A message typed in Tri's composer (later Ledger's) with
   `E2E_COMMAND_RUNNING`: the header face goes *working* (bobbing) while the
   tool runs and the roster row *thinking*; releasing it plays *done* (happy
   eyes, a hop) and then *idle*.
5. Row menu → **Edit bot…** on Ledger: the Look opens on **Face** with the
   shape and color its id picked checked. From the keyboard, the checked shape
   radio and ArrowRight twice, then Tab and ArrowRight: the preview turned to
   Heart in Mint (light run; Blob in Coral in the dark run) with a visible ring
   on the focused swatch; **Save** stored them (`GET` shows `avatar: { color,
   shape }`) and the row updated. Owl's dialog opened on **Emoji**; **Face** →
   Save cleared its emoji (`avatar` absent) and the row showed its id's face.
6. 390×844: the drawer's roster, an empty chat with its face, and the Look in
   the dialog fit the width (`scrollWidth` 390; the card 366 px); swatches are
   28 px and chips 32 px tall.
7. Reduced motion: no face animation runs (`getAnimations()` 0 of 12 faces,
   `animation-name: none`), no blink or glance in 8 s, and the pointer moves
   neither eyes nor body; each state keeps its still expression.
8. Accessibility: every `hui-bot-face` is `aria-hidden` and none of its 22–24
   nodes is in the accessibility tree; names and statuses stay in text.
9. Cost: with 11–12 faces on screen (57–65 running keyframe animations), a
   `longtask` observer saw no long task in 10 s.
10. Browser page errors: none. Console errors: none (Lit's development-mode
    warnings, as on the base branch).

That run also checked the face on a call, through a VoiceStudio fixture HUI no
longer has. On GPT-Live calls the face listens with the microphone's level and
speaks with the bot's audio: `src/lib/bots/face.test.ts`,
`src/controllers/voice-controller.test.ts` and `src/lib/voice/live-call.test.ts` check it, as
did the real calls of the calls pull request.

## More shapes and ears (2026-10-08, `f2a2753`, clean checkout; doctor passed before and after)

`visual-verification.mjs launch --pi-sessions`, nine bots through
`POST /__hui/bots`: Nova (star, bunny), Petal (flower, sprout), Nimbus (cloud,
bear), Dew (drop), Boo (ghost, horns), Capsule (pill, cat), Cubo (block,
antenna), Hex (hexagon) and Plain (no look). The Browser tool's headless Chrome
kept losing its tabs on the bot pages, so the journey ran in an owned headless
Chrome driven through CDP (clicks on the real controls, no DOM changes), and the
Browser tool only opened the captures to inspect them.

1. Roster: every new shape draws with its ears; Plain shows the face its id
   picked on `main` too (heart, yellow: `defaultBotLook` on both).
2. Hex's Settings → **Look**: labelled **Shape** (13 plain chips) and **Ears**
   (No ears and six, on the current shape) rows. **Bunny ears**, then **Star**:
   the summary read *Hexagon · Bunny ears · Mint*, then *Star · Bunny ears ·
   Mint*; `GET /__hui/bots/hex` stored `{ shape: "star", ears: "bunny" }`, and
   the roster, header and empty-chat faces followed at once.
3. Memory state (a 667-character message ending in `E2E_HOLD_MEMORY`, then a
   short one): Cubo (antenna) shows its thought dots beside the antenna; Boo
   (horns, a pair) shows sleepy eyes without them.
4. 390×844 (mobile emulation, DPR 2): the empty chat's face, and the Look in the
   sheet (`scrollWidth` 390, the card 353 px).
5. Console: Lit's development-mode warnings only, as on `main`.

`set_profile` changing the look is covered by `server/bots/service.test.ts` and
`server/bots/durable.test.ts`; no browser run had the model call it.

## Sleeping, working and done (2026-10-19, `66a873d`, clean checkout; doctor passed before and after)

`visual-verification.mjs launch` (default fixture), seven
bots through `POST /__hui/bots` with a `soul` so no first turn runs: Ada,
Master (cat ears), Grace, Pedro, Sherlock, Luisma and Maria. Grace, Luisma,
Maria and Sherlock each got one message with `wait: true`, so their turns ended
with nobody reading them.

1. Bots tab: the four that answered show a green dot and open eyes; Ada, Master
   and Pedro, never spoken to, sleep with closed eyes and a *z* badge. Row
   names read *Grace, done, unread* and *Ada, sleeping*.
2. Clicking Sherlock, then Maria, then Luisma: the open row has no badge and
   open eyes (*Luisma, idle*; the header and panel say *Idle*), and each bot
   left behind sleeps (*Sherlock, sleeping*).
3. `E2E_REPLAY` on Ada, a held memory summary on Master and
   `/hui-e2e-question confirm` on Pedro: Ada thinks and Master shows
   *Summarizing memory…*, both without a badge; Pedro shows the hand.
4. `POST <providerUrl>/control/release-replay`: Ada and Master turn green,
   awake. A second headless Chrome on the same instance logged Ada's face and
   badge from a MutationObserver (observation only): *thinking* with no badge,
   then the done badge and the hop in the same frame as the status stream's
   *idle* and *unread*, then *idle* 1.15 s later; never *sleeping*. Earlier
   runs of the same probe on the branch, before the status stream's unread
   marks won over the bot list, caught a list frame read before the unread
   write putting a finished bot to sleep for about a second.
5. 390×844: the drawer's roster shows the same badges. Dark theme: the green
   dot and the *z* badge stay legible.
6. Console: Lit's development-mode warnings only.

## Limits and gaps

- A roster row knows only the bot's status: a running tool reads *thinking*
  there and *working* only in the open chat; a failed turn reads *error* only
  in the chat (the roster shows *error* when the session itself fails).
- The *offline* face for an unreachable bot is unit-tested; the archived list
  shows it, but no disconnect was forced.
- Headless Chromium; screenshots cannot show motion, so motion is asserted
  through transforms and animation state, plus a screencast kept with the PR.
- A row that moves while its bot hops (another bot had newer activity) ends
  the hop; it shows the green dot at once.
