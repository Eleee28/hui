# Original session hovercard — browser proof

Verified 2026-09-25. Supersedes the approximate sidebar in
[the earlier progress proof](session-progress.browser.md).

## Reproduction

Use the isolated PI fixture setup described in `chat-composer.browser.md`.
This run used `npm run dev` on localhost:5178, a local fixture provider on port
37215, and disposable XDG/PI settings, transcripts and workspace. No user
transcripts or external model requests were used. From Home, select the fixture
workspace and start `E2E_PROGRESS` through the visible launch controls. The real
PI SDK calls `progress_card` with a completed step, an unfinished step and notes.

Start `reference-style-server.mjs` on port 43229 against the installed OpenClaw
2026.9.5 distribution. With the session row focused, import
`/e2e/probes/original-hovercard-probe.js` in the running app and call
`compareOriginalHovercard(sessionId)`. Its optional second argument overrides
the oracle origin. The server exposes an audited, checksum-pinned original
renderer export; the probe renders that independently with original styles.

## Observations

- The single-line row opens the original header/age/workspace/heads-up/notepad
  hierarchy on keyboard focus. Tab/Shift+Tab reopening and Escape dismissal work.
- Independent light and dark comparisons both returned `structuralMatch: true`,
  13 measured regions, and zero computed-style differences.
- At desktop 1280 × 720, the 296px card appears alongside the session row.
- iPhone 13 emulation reported a 390 × 664 layout viewport. Opening navigation
  and tapping the session navigates and closes the drawer without a hovercard.
  Reopening navigation and focusing the row with keyboard focus opens the card
  at x=12, y=265, width=296, height≈166, inside the viewport. No horizontal overflow.
- Browser runtime exceptions and error-level console messages: none.
- Include fresh desktop/mobile screenshots in the PR description, never Git history.

## Checks and explicit limits

- Focused hovercard/shell tests: 40 passed. Typecheck and production build passed.
- Full suite: 579 passed. An initial unrelated terminal PTY interrupt test timed
  out; its isolated retry and the entire rerun passed without changing assertions.
- The browser environment reports `(hover: hover)` false even in desktop
  emulation. Physical mouse-hover activation is therefore unverified; keyboard
  activation is verified. The original hover guard/timing/controller are retained,
  not overridden to manufacture a browser result.
- Running/paused/stale/completed/notes-only semantics and safe progress markup
  are covered by focused tests. This run's browser fixture shows an idle unfinished
  plan. It does not claim actor/PR UI coverage: HUI supplies no such metadata.
- Existing transcript projection, sidebar polling and composer rendering are
  unchanged. This port does not replace PI with the OpenClaw Gateway.

## Current-main integration

Merged the concurrent pane-header and subagent-steering changes from main.
The integrated suite passed all 584 tests, typecheck and production build.
The existing rich-renderer chunk-size advisory remains. In the running merged
app, the mobile session action menu opens and dismisses the hovercard.
