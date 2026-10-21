# Browser procedure

## OpenClaw adapter

1. Check `browser(action="status")` and `browser(action="tabs")`. Reuse only a tab
   owned by this run, or open the receipt URL with a unique label. Record its
   `suggestedTargetId`/stable tab ID and use it for every later call.
2. `snapshot` with `refs="aria"` produces current accessible controls. If a compact
   snapshot misses controls, request a full snapshot before declaring a blank UI.
3. Use `act` with `kind="click"`, `type`, `press`, `select` or `resize` and the
   observed refs. After a state-changing action, snapshot again. Retry a stale ref
   only after observing the same tab again. If refreshed refs remain unbound after
   SPA navigation and there is no unsaved input, navigate the owned tab to its
   current URL once and take a fresh full snapshot after the app renders. This
   also checks that the fixture state survives reload. Do not reuse refs across tabs.
4. Wait for the expected visible state. A wait is bounded and conditions on text,
   a selector or state; elapsed time alone is never the assertion.
5. `act(kind="resize", width=1440, height=900)` and then 390×844 gives responsive
   checks. `emulate(device=...)` additionally changes touch/DPR; record which was
   used. Do not change theme or mocked data merely to hide the defect.
6. Read `errors` and error-level `console` entries on the owned tab. Inspect the
   main panel and any changed inner scroll container as well as document width.
7. `screenshot` on the same target returns a real PNG/media path. Inspect it with
   the image viewer, copy it outside the repo only if needed for delivery, and
   attach it. A screenshot call succeeding is not a visual inspection.

Example tool arguments (replace values with actual observed receipt/refs):

```json
{"action":"open","targetUrl":"http://localhost:<receipt-port>","label":"hui-verify-<branch>"}
{"action":"snapshot","targetId":"<owned-tab>","refs":"aria"}
{"action":"act","kind":"resize","targetId":"<owned-tab>","width":1440,"height":900}
{"action":"screenshot","targetId":"<owned-tab>","type":"png"}
```

## Headless hosts

If status says `attachOnly` and the configured CDP endpoint is not running,
start an owned headless Chromium-family process with a disposable browser profile
on the configured CDP port **only after confirming the port is free**. Keep it in
a persistent exec session, record its process handle, then call Browser `tabs`
and open a new labeled tab. This uses the normal Browser tool; it does not change
OpenClaw config or restart its gateway.

```sh
# Example when Browser status explicitly reports CDP port 18800:
ss -ltn 'sport = :18800'  # require no listener
HUI_BROWSER_PROFILE="$(mktemp -d "${TMPDIR:-/tmp}/hui-browser.XXXXXX")"
brave --headless=new --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=18800 --user-data-dir="$HUI_BROWSER_PROFILE" \
  --window-size=1440,900 --no-first-run about:blank
```

Use an installed binary (`brave`, `chromium`, etc.); do not assume one exists.
If another process owns the endpoint, do not kill it or hijack its tabs. If the
Browser tool denies access by policy, report the blocker; do not bypass the guard
with raw CDP. Browser unavailability is an explicit proof gap.

For a broken screenshot wrapper only, `e2e/probes/capture-rendered.mjs` is an existing
local fallback for an already-observed owned tab on CDP port 18800. It matches a
URL prefix: use the full unique fixture URL and ensure it identifies exactly one
owned tab before running it. State that capture used this fallback; it cannot
replace the Browser interaction proof. Never use it to evade a policy denial.

## Other agent hosts

The skill's contract is editor-independent: use equivalent browser tools that
provide owned tabs, accessibility snapshots, real input, viewport control, errors
and screenshots. Keep the same branch/fixture/evidence checks. If that host cannot
provide real browser interaction, report the missing capability rather than
substituting a DOM mock or saying the UI passed.
