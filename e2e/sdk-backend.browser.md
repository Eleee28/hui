# HUI-owned PI SDK backend — browser proof

Date: 2026-09-24. SDK: `@earendil-works/pi-coding-agent@0.87.1`.

## Reproduce

1. `npm ci`, then `npm run e2e:sdk` (port 43128, override with `HUI_E2E_PORT`).
2. Open `http://localhost:43128` with the Browser tool. The launcher prints the
   disposable workspace, config and provider paths; choose that workspace when
   starting a chat. It never changes `HOME` or operator PI/HUI configuration.
3. Start without sessions: Settings → Tools → inspect the default catalog and
   expand the HUI base prompt. There are 14 shipped tools: six HUI definitions,
   eight PI built-ins; ten are active by default in the fixture.
4. Return to Home, select the fixture workspace and start a session. Send
   `E2E_RICH`: observe the real SDK read tool, thinking and rendered response.
5. Submit `/hui-e2e-question` (command selection may require a second Enter or
   Send), answer the inline form, and verify the returned notice and idle state.
6. Send `E2E_SUBAGENTS_START`; observe the child and automatic completion.
   Send `E2E_SUBAGENTS_COORDINATE`; the parent lists sessions, reads child history,
   and receives a cross-session reply. All model traffic uses the local fixture.
7. Send `E2E_PROGRESS`: a real HUI tool call updates the task progress card.
8. Settings → Tools → select that session. Verify 10 active / 14 registered,
   expand `progress_card` to inspect its JSON schema, and expand the effective
   prompt. After a turn, it explicitly identifies the last-turn composition and
   includes HUI's active-tool guidance.
9. Reload/restart the fixture gateway and inspect the now-cold session before
   opening it: Refresh does not start a worker. Open the chat to resume its
   persisted transcript, then inspect again. An initialized prompt is labeled
   separately from the last prompt observed by the current worker.
10. Repeat global/live selection at 390×844. Exercise the native selector,
    Refresh and disclosure controls; confirm document width remains 390px.
11. Settings → Skills → disable `sdk-fixture`. Open a cold session and submit
    `/skill:sdk-fixture`: the UI reports that the skill is disabled and remains
    idle. Send a normal message, then inspect its effective prompt in Tools:
    the disabled skill is absent and HUI's tool guidance remains present.

## Observed

- Browser-tool navigation, form submission, selects and disclosure interactions
  passed at 1440×1100 and 390×844. Tool execution, extension question/answer,
  subagent coordination, progress card and persisted history were observed in UI.
- After rebasing the SDK work onto the skill controls, the mobile browser toggle
  and blocked direct command passed against the real SDK worker.
- Global catalog works with no chat; cold inspection remains cold. API boundary
  checks returned 403 without `x-hui`, 404 for an unknown session, 405 for POST to
  the read-only catalog.
- Provider-bound schema/prompt assertions, late registration, overrides, load
  failures, models/thinking, attachments, abort, queue draining, compaction,
  worker death, resume, and HUI-only skill disablement (without changing PI files)
  are covered by `server/runtimes/pi-sdk.test.ts`.
- Synthetic CLI → SDK → CLI transcript round trips passed with both the bundled
  0.87.1 CLI and the separately installed 0.73.1 CLI. No real transcripts were
  opened by those tests.
- Browser screenshot wrapper intermittently timed out while other Browser
  operations worked. The same real page was inspected through
  `e2e/probes/capture-rendered.mjs`; no archived image is required to repeat this journey.
- During development, a Vite restart interrupted CSS/module requests and caused
  a temporary blank page. A fresh navigation recovered. No application runtime
  exceptions were reported; development-mode Lit warnings remain.

## Limits

This is local deterministic-provider proof, not certification of every third-party
extension, remote MCP server, provider OAuth flow or historic transcript. Terminal
`ui.custom()` components are not web widgets. Tests cover SDK compaction and
resume; there is no new manual-compaction UI. No personal configuration or
installed third-party package was modified to manufacture parity.
