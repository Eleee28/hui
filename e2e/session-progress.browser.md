# Session-list progress — Browser proof

Historical proof of the initial approximation. Its sidebar rendering and mobile
progress button are superseded by the [original component port](session-hovercard.browser.md).

Verified 2026-09-25 with the real PI RPC runtime and the repository's local
`e2e/fixtures/pi-provider-fixture.mjs`, without external API requests or credentials.

## Setup

Follow `chat-composer.browser.md` with a disposable directory containing isolated
XDG configuration, PI agent settings and transcripts, and workspace. This run
used provider port 43217 and gateway `http://localhost:5174`. The model/provider
configuration uses the existing `hui-e2e` / `fixture` fixture model. Start the
provider with `HUI_E2E_WORKSPACE`, `HUI_E2E_PROVIDER_LOG` and
`HUI_E2E_PROVIDER_PORT`; start `npm run dev` with the isolated `XDG_CONFIG_HOME`,
`PI_AGENT_DIR`, `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR` and `PI_OFFLINE=1`.
Keep fresh screenshots outside Git and include them in the PR description.

## Observed journey

1. From Home, choose the disposable workspace, enter `E2E_PROGRESS`, and start
   the session using the visible button. The real PI `progress_card` call renders
   `Verify presentation` and `1/2` in the sidebar, even after the runtime is idle.
2. Hover the session row. Its popover shows the completed `Read fixture` step,
   current `Verify presentation` step and Markdown agent notes.
3. Go to Home without opening the session again. The same progress remains in
   the session list. In a second browser tab, open that session and submit
   `E2E_CLEAR_PROGRESS` through the composer. Focus Home in the first tab: its
   periodic list refresh removes the progress summary/button without navigation.
   Submit `E2E_PROGRESS` again in the second tab; the first tab restores it.
4. At 390 × 844, open navigation and tap `Progress for E2E_PROGRESS`. The details
   open without selecting the chat or closing the drawer. The card is within
   the viewport, with no horizontal document overflow. Escape dismisses it.
   Pin remains available through the row's existing action menu on mobile.
5. At 1400 × 900, click the progress control and press Shift+Tab. The session
   link receives keyboard focus and its progress details remain visible.
6. A development-server restart occurred during source edits. Reloading and
   reopening the session restored the persisted progress from PI's transcript.

## Checks and limits

- `npm test -- src/lib/progress-card.test.ts src/views/shell.test.ts` passed.
- Final `npm test`: 435 passed; `npm run typecheck` and `npm run build` passed.
- A clean export of the staged index (excluding pre-existing checkout edits)
  also passed all 433 tests, typecheck and build.
- Browser runtime errors: none. Console recorded three resource connection
  refusals during Vite's source-triggered server restart; explicit reload
  recovered the app. Lit development-mode/update warnings were also present.
- Completed, pending and notes-only summaries are covered by unit tests. The
  browser fixture exercises an active plan, explicit clearing, background-list
  updates, hover, keyboard and narrow-screen interaction.
- After a gateway restart, unopened sessions have no progress projection until
  their runtime restores the transcript; no duplicate registry state is added.

## Current-main integration

The original shared checkout predates the split-pane application. The published
change was reapplied in an isolated worktree on current `main`, preserving its
status stream, session appearance and pane layout. The shared sidebar polls only
in the outer app; embedded panes retain their existing SSE transcript ownership.

A second isolated Browser run used the default PI SDK backend and provider port
43217, with the gateway on port 5176. From Home, the visible launch form created
`E2E_PROGRESS`. The shared sidebar displayed its step/count and hover details;
submitting `E2E_CLEAR_PROGRESS` removed them, and a subsequent `E2E_PROGRESS`
restored them. Desktop/mobile captures are attached to the conversation.
The current-main suite passed 573 tests, typecheck and the complete server/web
build. The build reports the existing large-chunk advisory for rich renderers.

After integrating the concurrent transcript-thumbnail update, the final combined
suite passed 576 tests, typecheck and build. The Browser-tool mobile drawer and
progress button were rechecked at 390 × 844; no runtime exceptions were recorded.
