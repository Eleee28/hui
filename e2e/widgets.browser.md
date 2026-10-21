# Agent widgets browser check

Verified 2026-10-06 against the default launcher (real HUI and Pi Durable, the
deterministic provider) in an owned headless Brave driven through the OpenClaw
Browser tool, and again against the production gateway (`hui gateway start`) on
the same isolated state. No operator transcript or credential was read or
changed.

## Fixture

`e2e/fixtures/pi-provider-fixture.mjs` calls the real `show_widget` tool:

- `E2E_SHOW_WIDGET`: the workspace's `widget.html`, titled by `widget-title.txt`,
  or a built-in counter. Copy any fragment there after launch, for example the
  bot-face prototype from OpenClaw's chat.
- `E2E_WIDGET_PROBE`: `e2e/fixtures/widget-probe.html`, which tries to leave the sandbox
  and lists each attempt as Blocked or ALLOWED.
- `E2E_WIDGET_SYNTAX`: a counter whose script has a syntax error, then the
  fixed counter once HUI rejects the first call.

## Journey

1. `node e2e/visual-verification.mjs launch --branch <branch>`; put the fragment
   in the receipt's workspace as `widget.html` with its title in `widget-title.txt`.
2. In New Session type `E2E_SHOW_WIDGET` and start the session. Wait for the card
   to report *Interactive widget · sandboxed*.
3. Inside the widget click a state, a shape and a color, toggle *Reduce motion*
   on and off, and move the pointer over the face's stage.
4. Switch HUI to the other color scheme and inspect the widget.
5. Open full screen, press Escape; open again, click inside the widget and press
   Escape there.
6. Send `E2E_WIDGET_PROBE`. Read the probe's rows; click its example.com link.
7. In a new session send `E2E_WIDGET_SYNTAX`; open the failed `show_widget` row.
8. Reload; move between the sessions with Back and Forward; stop the launcher,
   start `hui gateway` on the same state, open both sessions, run
   `hui gateway restart` and reload.
9. Repeat 2–5 at 390×844.

## Observed

- The bot-face fragment rendered in its card at 1440×900 (frame fitted to
  476 px, stacked to 878 px at 390×844) with no page errors. Real clicks
  changed state, shape and color; Reduce motion set and cleared the widget's
  own flag; the pointer moved the gaze (`translate(-3.78px,-2.04px)` toward the
  upper left, `translate(3.78px,2.72px)` toward the lower right).
- Switching to dark re-themed the widget in place, keeping its state, with a
  transparent frame; the widget reported `color-scheme: dark` and HUI's tokens.
- Full screen filled 1440×900 as a modal dialog in the top layer with focus on
  its control; both Escapes returned it inline and restored focus. The widget
  kept its state throughout.
- The probe blocked all ten attempts: fetch `/__hui/settings` with x-hui
  (connect-src), cookies and localStorage (SecurityError, no
  allow-same-origin), `top.document` (cross-origin), top navigation, `window.open`
  (null), a script and an image from example.com (script-src-elem, img-src), a
  WebSocket (connect-src); its origin was `null`. The card showed the
  connect-src violation as a notice. The link opened https://example.com/ in a
  new tab with `window.opener === null` and no referrer; HUI and both widgets
  stayed in place.
- The syntax fixture's first call failed with `widget_code has a JavaScript
  syntax error in inline script 1 at line 9, column 12: Unexpected token ';'.
  Offending line: count += ;` and the fixed counter rendered after it.
- Every widget came back after a reload, Back/Forward, a production gateway
  start on the launcher's state and `hui gateway restart`, and stayed
  interactive.
- `/__hui/widget-sandbox` answered without x-hui; opened directly it ran in
  origin `null`, built no frame and logged nothing. A page with only the counter
  logged no console errors (the probe's deliberate violations do).

## Automated coverage

- Validation, positions and the tool result: `server/runtimes/widget-code.test.ts`.
- The sandbox page, its headers and route, the policy and the canonical
  document: `server/agent-tools/widget-sandbox.test.ts`.
- Client projection, frame messages, link and height rules:
  `src/lib/widgets.test.ts`; sandbox attributes: `src/components/widget-card.test.ts`.
- Transcript row: `src/views/chat/projection.test.ts`. Prompt and registration:
  `server/runtimes/pi-sdk.test.ts`.
