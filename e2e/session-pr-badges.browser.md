# Session pull request badges browser verification

Verified on 2026-09-25 against the real HUI gateway (Vite, port 5191) and
packaged PI 0.87.1, with `gh` authenticated as the operator for read-only
`gh pr view` lookups of public `cli/cli` pull requests.

## Reproduce

1. Create a fresh `/tmp/hui-pr-badges-*` root and run
   `node e2e/fixtures/session-pr-badges-fixture.mjs <ROOT> node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js`.
   It writes three disposable PI transcripts plus an exclusive HUI registry:
   *Release train* (five `gh pr create` results covering merged, closed, draft
   and open PRs), *README intro* (one merged PR) and *No pull requests*. Every
   transcript also mentions `cli/cli/pull/1` in prose, which must not be detected.
2. Start the gateway with `HOME`, `XDG_CONFIG_HOME`, `PI_AGENT_DIR`,
   `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` under the root,
   `GH_CONFIG_DIR` pointing at the operator's `gh` config, `PI_OFFLINE=1`, and
   `NO_PROXY=127.0.0.1,localhost` when an HTTP proxy is configured.
3. Open `http://localhost:5191/` with the Browser tool at 1440×900.

## Observed

- Before a session is opened its runtime has no transcript, so no badge is
  shown. Opening *Release train* and *README intro* from the sidebar made the
  marks appear on the next three-second refresh; *No pull requests* and the
  prose-only `pull/1` mention never produced one.
- *Release train* listed `cli/cli#14515` closed, `#14355` draft and `#14485`
  open, with the two older merged PRs reachable by scrolling the strip. The accessible names read, for
  example, `Pull request cli/cli#14485, open: chore(deps): bump …`.
- Hovering the merged `cli/cli#14517` mark (README intro) opened the card beside
  the sidebar: `cli/cli#14517`, a purple **Merged** pill, the title, and the
  rendered Markdown description (headings, paragraphs, inline code) with a fade
  at the bounded height. The session hovercard was dismissed instead of stacking.
- Placement (2026-09-25 follow-up): the card now hangs from the hovered mark.
  At 1440×900 the `#14517` mark spanned x 116–144, y 284–320 and the card opened
  at x 104, y 326 (`data-side="bottom"`, 6px gap bridged by a transparent strip).
  Moving the pointer onto the description kept the card open; its body scrolled
  internally (`scrollHeight` 728 vs `clientHeight` 401) to `scrollTop` 200
  without the card moving or closing. Leaving the card closed it.
- At 390×844 inside the drawer the card hung directly below the *Release train*
  mark, clamped within the viewport.
- Scrollable strip (2026-09-25 follow-up): *Release train* renders its five
  marks newest-first in a `row-reverse` strip 43px wide (one and a half 28px
  touch-size marks, `scrollWidth` 144). At rest `scrollLeft` is 0, the open
  `#14485` mark is whole at the trailing edge and the draft `#14355` mark is
  half-visible behind a dimmed leading fade (`data-more-before`).
- Hovering the title narrowed the strip to 28px (the newest mark only) so the
  title and pin/menu actions had room; no session hovercard stacked on it.
- Hovering a mark widens the strip to at most half of the space beside the row
  actions (minus the title's inset/indicator overhead), never below the resting
  one and a half marks. In the 227px touch-layout row the visible title text
  (x 47–83, 36px) and the strip (x 101–144, 43px) split the space before the pin
  at x 145, instead of the strip consuming the whole title.
  A synthetic vertical wheel (`deltaY` 40) scrolled to `scrollLeft` −40 with
  fades on both sides; scrolling past the oldest mark stopped at −84/−101 and
  the next wheel event was not prevented, so the sidebar keeps scrolling.
  `pointerleave` returned the strip to `scrollLeft` 0 immediately.
- Clicking a mark dispatched an undefaulted click on
  `https://github.com/cli/cli/pull/14485` with `target="_blank"` and
  `rel="noopener noreferrer"`; the HUI tab stayed on its session.
- Keyboard: Tab from the session link focused the first visible mark, opened the
  card and set `aria-describedby` to it. Escape closed the card and kept focus
  on the mark.
- At 390×844 with the navigation drawer open, touch rows kept their visible
  pin/menu actions and the same one-and-a-half-mark strip (native swipe scroll),
  with the title still readable.
- No page errors were reported.

## Proof gap

The managed Brave instance reports `(hover: none)` even at desktop sizes, so both
viewports rendered the touch layout (newest mark plus count). The fine-pointer
layout, with three marks that shift left when row actions appear, is covered by
CSS review and the source assertions in `src/views/shell.test.ts`, but it was
not captured in this browser.
