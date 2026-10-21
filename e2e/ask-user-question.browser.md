# Structured questions (`ask_user_question`) browser verification

HUI's own `ask_user_question` tool replaces the PI extension
`@juicesharp/rpiv-ask-user-question`, which HUI could only show as a series of
plain select and input dialogs (option lines like `1. Label — description`,
previews folded into the title, multi-select typed as numbers).

Only the model provider is mocked (`e2e/fixtures/pi-provider-fixture.mjs`): a prompt
holding `E2E_ASK_USER:<name>` makes it call `ask_user_question` with the
workspace's `ask-<name>.json` (an array of inputs means parallel calls), and its
next answer quotes every tool result as `tool answered: …`. HUI, the gateway,
Pi Durable or PI's SDK worker, the tool and the browser are real.

## Reproduce

1. From a clean checkout: `node e2e/visual-verification.mjs launch --branch
   <branch>` (Durable), or with `--pi-sessions` (PI's SDK worker); `doctor` on
   the receipt.
2. Stress run: `node e2e/probes/ask-user-question-stress.mjs --receipt <receipt.json>`
   writes the questionnaires (`single`, `full`, `parallel`, `invalid`,
   `stress`) into the workspace, drives a private headless Chrome with real key
   and mouse events and prints one PASS/FAIL line per scenario. Pass scenario
   names (comma-separated) to run some.
3. Browser tool: open the receipt's `browserUrl`, choose the workspace as the
   project directory and send `E2E_ASK_USER:full`. Answer with the keyboard
   and the pointer as below; check 1440×900 and 390×844.
4. Question timeout: in Settings → Tools → Questions set *Question timeout*
   to *5 minutes*, then send `E2E_ASK_USER:decide` with an `ask-decide.json`
   of two questions whose first options end in *(Recommended)*. Leave the card
   unanswered for five minutes; check 1440×900 and 390×844.
5. To prove HUI's tool wins over the extension, add the installed package's
   directory to `packages` in the fixture's `agent/settings.json` and repeat:
   `GET /__hui/sessions/:id/tools` lists one `ask_user_question` with source
   `HUI`, the provider log carries only HUI's description, and the card is
   HUI's.

## Expected

- One card above the composer; the session reads *Waiting for your answer*.
  Four questions show header chips (ticked once answered) and *1/4*; one
  question shows its header as the title.
- Options are radios, or checkboxes with *Choose all that apply.*, each with
  label, description and number, then *Type something…*. Picks and typed text
  are kept while moving between questions.
- A question whose options carry previews shows the focused option's Markdown
  beside the options (under them at 390×844), bounded and scrolling.
- Keyboard: digits choose a row, ↑/↓ move between rows, ←/→ between
  questions, Space toggles a checkbox, Enter moves on (choosing a focused
  radio) and submits on the last question, Ctrl/⌘+Enter always moves on,
  Escape cancels (in typed text the first Escape only leaves the field) and
  never stops the run.
- *Submit* is disabled until something is answered. The model receives
  `"question"="answer"` for each answered question, joined labels for
  multi-select with typed text last, and a chosen option's preview; a blank
  question is left out. The transcript keeps a summary by header.
- *Cancel*, Escape and Stop decline (`User declined to answer questions`);
  Stop leaves the session idle. A reload shows the pending card again from
  its first question.
- Parallel calls show one card after another, the next one focused and fresh.
- A call with a reserved label fails back to the model; no card opens.
- Labels with HTML render as text; Markdown previews are sanitized; long
  words wrap inside the card; the actions stay visible when the card scrolls.
- With the question timeout Off (the default) a card waits as above. Set to
  five minutes, an unanswered card closes after them and the session goes
  idle; the transcript shows *Expired* with *No answer within 5 minutes. The
  agent continued without your answer; reply in the chat to decide.* and each
  question with its options, and the model receives `No answer within 5
  minutes; the operator may be away. …`. Both survive a reload, and the
  composer is free for a reply.

## Observed

Date: 2026-10-09, branch `dani.fernandez/custom-ask-questions-tool`.

- Stress run on Durable: 12 scenarios, 51 checks, all passing on repeated
  runs (keyboard-only, pointer-only, cancel, Escape, Stop, reload, parallel,
  invalid, hostile content, five sessions answered in turn, six rounds of
  random keys/clicks, 390×844). Same on PI's SDK worker. Both again with the
  rpiv package configured: HUI's tool and card won on both runtimes.
- Browser tool, desktop and mobile: see the pull request's screenshots.
- Fixed along the way: answering one card while the next was already showing
  moved focus back to the composer; the first Escape in typed text left focus
  on the page, so a second Escape stopped the run.

Date: 2026-10-17, branch `dani.fernandez/question-timeout`.

- Question timeout on Durable, Browser tool: Settings → Tools → Questions saved
  *5 minutes* (`questions.timeoutMinutes: 5` in the isolated settings file) and
  kept it after a reload; `E2E_ASK_USER:decide` showed its card, which closed
  five minutes later; the transcript showed the expired summary with both
  questions and their options, the fixture quoted the timeout text back, and
  both survived a reload. 1440×900 and 390×844: see the pull request's
  screenshots.

## Limits and gaps

- A remote worker session was not exercised; its only change is the bridge
  timeout for this tool (24 hours instead of 170 seconds).
- A wait longer than the PI worker bridge's former limits was not timed in the
  browser; the bridge client is the same node:http one `secret_request` uses.
- `hui bot chat` only cancels a questionnaire; its output is covered by
  `cli/bots.test.ts`.
- The question timeout was exercised on Durable only. PI's SDK worker, a
  remote worker and a bot's chat reach the same gateway handler
  (`server/services.ts`), which starts the timer; the timer itself and Off waiting
  past a timeout are covered by `server/agent-tools/questionnaires.test.ts`, not in the
  browser.
