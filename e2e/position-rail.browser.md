# Browser journey: conversation-position rail

Verified on 2026-09-24 against the real HUI gateway and installed PI 0.73.1.
The history is disposable fixture data persisted by PI's own SessionManager;
the streaming check uses the local deterministic provider, not operator secrets.

## Reproduce

1. Create a fresh `/tmp/hui-position-rail-*` root. Configure the fixture provider
   and agent settings as in [chat-composer.browser.md](chat-composer.browser.md).
   Keep `XDG_CONFIG_HOME`, `PI_AGENT_DIR`, `PI_CODING_AGENT_DIR`, and
   `PI_CODING_AGENT_SESSION_DIR` inside that root; set `PI_OFFLINE=1`.
2. Seed history before starting HUI:

   ```bash
   node e2e/fixtures/position-rail-fixture.mjs <ROOT> <PI_PACKAGE>/dist/core/session-manager.js
   ```

   This exclusively creates the fixture HUI registry and two PI conversations:
   **Conversation navigation** (100 prompt/response pairs) and **Short
   conversation** (one pair). It refuses to overwrite an existing registry.
3. Start `e2e/fixtures/pi-provider-fixture.mjs` on port 43127 with its workspace and log
   under the same root, then `npm run dev` with the isolated environment. This
   run used `http://localhost:5173` and a disposable managed Brave/CDP profile.
4. Open Home in the Browser tool and activate **Open Conversation navigation**.
   Wait for Idle and the real resumed transcript. Do not inject app state.

## Verified through visible controls

- At **1440×960**, all **200** messages have markers. The rail is 432px high,
  scrolls through 2400px of marks and retains a single keyboard tab stop.
  The last message is current at the native scroll maximum, accounting for the
  portion of the transcript hidden underneath the composer.
- Hover shows the corresponding role and bounded text preview with the original
  expanding tick geometry. User and assistant previews are available. Preview
  text is plain text, not a separate Markdown renderer or interactive link.
- Click a marker, then Home/End and arrows. Only the rail moves while choosing;
  the preview follows keyboard focus even with a stationary pointer over another
  mark. Enter and Space reveal the chosen message at a 16px inset (or clamp at
  the scroll boundary). Escape removes the preview and returns focus without
  scrolling. Escape also dismisses a mouse-only preview. Tab leaves the rail;
  Shift+Tab can enter it again.
- Send `E2E_REPLAY: keep reading position while streaming.` through Message and
  Enter. With **Replay prefix** visible, jump to the first prompt and release the
  provider barrier via its fixture `/control/release-replay` endpoint. The real
  PI turn completes with **replay suffix**; scrollTop remains **12 → 12**, there
  are **202** markers, and **Scroll to latest** remains available. Activate that
  button to return to the live edge. A click on the last marker while already at
  the bottom also retains auto-follow; it does not require a native scroll event.
- Switch to **Short conversation** through the sidebar. Only its two markers
  remain, the rail scroll position resets, and no previous preview survives.
  Switch back through the mobile navigation drawer, then reload the direct
  session URL: PI history and all 202 markers are restored.
- At **390×844** and **844×390**, the rail is hidden by the original responsive
  rules. Document, transcript and inner content have **0px horizontal overflow**.
  Resizing while a rail marker owns focus returns focus to the transcript and
  clears its preview. Returning to desktop restores working controls.
- Light and dark views were visually inspected. The final Browser error log and
  console error list are both empty.

## Checks and evidence

- Focused model/projection tests: **11 passed**, including 1,200 ordered markers,
  attachment-only/Unicode previews, disclosure filtering and keyboard bounds.
- Full `npm test`: **383 passed**; `npm run typecheck`, `npm run build` and
  `git diff --check`: passed.

The geometry and CSS are the pinned OpenClaw 2026.9.5 presentation already in
HUI. The controller targets HUI's non-virtualized visible message projection;
this is not a claim of parity with OpenClaw's virtualizer or hidden transcript
activity. No API, PI format, HUI persisted format or dependencies were changed.
Stop only the disposable gateway/provider/browser processes and retain the
temporary root for inspection; never clean operator PI/HUI directories.
