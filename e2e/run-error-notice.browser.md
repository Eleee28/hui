# Run error notice browser verification

Verified on 2026-09-25 with HUI's real Vite gateway, the installed PI 0.73.1 RPC
runtime and `e2e/fixtures/pi-provider-fixture.mjs`. `HOME`, `XDG_CONFIG_HOME`, both PI
agent-directory variables and PI's session directory pointed at a disposable
`/tmp/hui-e2e-runerr.*` root. Setup follows `chat-composer.browser.md`.

On hosts with `HTTP(S)_PROXY` plus `NODE_USE_ENV_PROXY`, also export
`NO_PROXY=127.0.0.1,localhost` for the gateway. Otherwise PI's calls to the
loopback fixture fail with `Connection error.` instead of the fixture's 500.

## Journey

1. Started a session from **New session** with the prompt `E2E_ERROR provider
   check`. PI received the fixture's 500 and the session returned to Idle. The
   inline error stayed inside the collapsed **Run details** disclosure, and a
   `role=alert` card appeared above the composer:
   `500 {"type":"error",...,"message":"fixture provider error"}` with **Copy
   error**, **Continue** and **Dismiss error**.
2. Reloaded the session URL. The card came back from PI's durable transcript.
   (This step was observed on an earlier session in the same root that failed
   with `Connection error.` before `NO_PROXY` was set; step 4 repeats the
   reload check against the fixture's 500.)
3. Clicked **Continue**. HUI sent `Continue from where you left off.` as a
   normal user turn, the fixture answered `Fixture response.`, and the card was
   gone.
4. Sent `E2E_ERROR again` from the composer. The card reappeared. **Dismiss
   error** removed it for the current page; reloading brought it back.
5. Repeated at 390×844. The actions wrapped under the message inside the card.
   `innerWidth`, `body.scrollWidth` and `documentElement.scrollWidth` were all
   390.

The Browser tool reported no page errors.
