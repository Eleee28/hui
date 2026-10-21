# Web Awesome migration — Browser verification, 2026-09-24

## Scope and reference

The project owner explicitly authorized adding `@awesome.me/webawesome@3.12.0` after the
previous checkpoint requested dependency approval. npm now pins that version.
Only the used components and default theme are imported locally; no CDN or
all-components loader is used. No API route or persisted format changed.

Reference: OpenClaw 2026.9.5, source commit
`ec9c1a13db8938e5a3eaa51fca2e981cde2395a9`, with the corresponding installed
Control UI assets. The original picker, anchored-popup helper and hub tabs were
ported. Switches, Automation selects/task menus and sidebar action menus use WA.
HUI retains PI callbacks, navigation, persistence and accessible menu labels.

This is a continuation of [the earlier checkpoint](visual-parity-2026-09-24.browser.md),
not a replacement for its real PI transcript/tool evidence.

## Environment and reproduction

- Browser tool, managed `openclaw` profile, disposable headless Chromium/Brave.
- Real Vite app at `http://localhost:5173`, using isolated XDG configuration,
  PI agent/session directories and the existing E2E workspace/provider fixture.
- Viewports: 1440×900, 390×844 and 844×390. These are viewport tests, not a claim
  about physical phone hardware or every coarse-pointer platform.
- The read-only original asset server ran on loopback port 43130:

  ```sh
  node e2e/fixtures/reference-style-server.mjs "$OPENCLAW_SOURCE" "$CONTROL_UI_ASSETS" 43130
  ```

- The app used its real Vite configuration with HMR disabled during comparisons
  so a source edit could not reload the inspected document mid-measurement:

  ```sh
  XDG_CONFIG_HOME="$TEST_ROOT/xdg" \
  PI_AGENT_DIR="$TEST_ROOT/pi-agent" \
  PI_CODING_AGENT_DIR="$TEST_ROOT/pi-agent" \
  PI_CODING_AGENT_SESSION_DIR="$TEST_ROOT/pi-sessions" \
  PI_OFFLINE=1 node --input-type=module -e \
    'import { createServer } from "vite"; const server = await createServer({ server: { hmr: false } }); await server.listen(); server.printUrls();'
  ```

Use the isolated fixture setup from the earlier report, not operator PI data.
`visual-journey-probe.js` navigates actual command-palette controls. The new
`webawesome-controls-probe.js` loads original renderers/runtime in a disposable
iframe; it does not import HUI renderers into the reference or mutate app state.

## Real UI journeys

| Surface | Observed behavior |
| --- | --- |
| Typeface | Open picker; keyboard typeahead `s`, Enter → System; preference survives reload. Home/Enter restores Instrument Sans. |
| Chat preferences | Message width changes to Wide and persists; restored to Comfortable. Collapse progress toggles by visible control and Space; persisted value verified and restored to false. |
| Appearance themes | Claw Light/Dark and imported Rosé render correctly in the recorded comparison states. Language remains deliberately disabled. Claw/Dark restored. |
| Hub tabs | ArrowRight focuses Worktrees without navigating; Enter activates it and the destination tab reclaims focus. Clicking Sessions returns to its route. Tablist has the Sessions pages label. |
| Sidebar menus | Rename/Pin/Delete and four group actions have labeled menus. Pin/unpin persists. Group Rename opens the existing dialog; Cancel restores trigger focus. End/arrows/Enter and Escape exercised. |
| Mobile drawer | Escape closes an inner menu first, keeping main inert and returning focus to its trigger. A second Escape closes navigation, releases inert and focuses Open navigation. |
| Automation form | Session + Once selected through WA controls; real FormData submission creates `WA control verification`, scheduled for 2099. Successful submission clears inputs/session and resets schedule to Cron. Edit rehydrates session/schedule; description update persists. |
| Automation controls | Task switch pauses the task. Menu Edit/Delete use existing callbacks. Schedule keyboard selection switches to Repeat interval and shows its fields. Escape closes the schedule selector without exiting Settings. |
| Labs | Clicking Dense observability's row enables it once; Space on its WA switch disables it once. Persisted flags verified false afterward. |
| Cleanup | Created task deleted through its menu; zero fixture tasks remain. Run history remains at its original two entries, so this task never ran. Claw/Dark, Instrument Sans, Comfortable, collapse=false and Labs flags=false restored. Parity chat unpinned again. |

WA's visually hidden switch input was present in the accessibility tree but the
Browser ref-click could not activate it. Verification used its measured visible
control coordinates and real keyboard input instead. A failed ref-click and
its dependent wait are not counted as passing interactions.

## Independent comparison results

**544 part/style records across 19 captures: zero remaining differences in those
captures.** This includes original light-DOM picker and hub-tab renderers,
original switch renderer and original registered WA select/dropdown components
with matched option data. Shadow parts are inspected as well as light DOM.
The migrated Appearance row/section probe was also rerun: 71 records, zero diffs.

The exact matrix is in [control evidence](evidence/2026-09-24-webawesome-controls.json):

- Appearance: desktop dark unchecked/checked, light and light picker-open;
  portrait dark/light and dark picker-open; landscape dark; desktop Rosé dark.
- Automation: desktop schedule/menu open; portrait schedule open.
- Group/session action menus: desktop and portrait open.
- Sessions hub tabs: all three viewports; some menu captures also include tabs.

The oracle independently evaluates theme/accent values. It matches owning row
context, viewport and input data; no resolved HUI property is copied as an
expected value. It waits for component updates, font loading, animations and
observable stable layout. Light-DOM hover/focus selectors are mirrored using
the original declarations, since one pointer cannot hover two documents.
Inline HUI dropdown anchor transport is an explicit adaptation: this measures
menu contents/parts, not equivalence to OpenClaw's separate portal trigger.

**108 route visits** (36 × three viewports) had no container overflow, alert or
oversized shared icon. `/chat`, `/permissions`,
`/question` and `/secrets` retain their existing
explanatory contract pages; the route sweep
does not certify those pages as implemented workflows.
See [route evidence](evidence/2026-09-24-webawesome-routes.json).

## Defects found and resolved

- WA select/dropdown Escape was reaching the enclosing Settings/drawer handler
  before WA's document listener. Nested popup ownership now prevents accidental
  navigation, without consuming Escape when the popup is already closed.
- The group separator inherited native `hr` borders. It now uses the original
  separator div, text wrappers and destructive item variant.
- Sidebar menus now receive upstream's 40 px mobile action rows and separator
  spacing, rather than retaining the former native-menu geometry.
- Group menu foreground now follows the source action-container role.

The [diagnostic artifact](evidence/2026-09-24-webawesome-diagnostics.json) keeps
superseded mismatches. These include genuine separator/foreground defects and
oracle omissions: missing Settings/mobile or cron-control ancestry, asynchronously
stale popup clipping, and unmatched hover/focus. They were corrected and rerun,
not silenced by removing assertions or inserting timing sleeps.

Two additional harness incidents are not app passes: a diagnostic GET used the
wrong local-client header and returned 403; the disposable original asset server
stopped and two comparisons failed with connection-refused. The correct header
and restarted oracle worked afterward. Browser reported **zero uncaught page
errors**; the console retained those 11 harness resource errors, with no new
errors during subsequent final journeys. No blank-console claim is made.

## Automated checks

- Focused view/adapter suite: **93/93**.
- `npm test`: **351/351**, no failures or skipped tests.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `git diff --check`: passed after removing a trailing-whitespace line.
- `npm ls @awesome.me/webawesome`: exactly **3.12.0**.

Five new adapter tests cover open/closed shadow-popup ownership and Escape versus
ordinary navigation keys. Three tests of the removed, unused native-menu position
and keyboard helper functions were retired with those functions; actual WA
navigation/placement is covered by the Browser journeys above. Existing action,
form and persistence assertions remain.

The production JS entry is about 240 kB / 59 kB gzip; the separate HUI app chunk
is about 265 kB / 71 kB gzip. This is the cost of the selected component runtime,
not an all-components bundle. Generated output was only produced by Vite.

## Limits

**This is not 100% whole-app pixel parity.** Remaining tool kinds, capability
layouts and the complete hover/focus/disabled/error matrix still need independent
original proof. The installed npm release also does not automatically include
OpenClaw's downstream lifecycle/submenu patches. Normal open/close, route unmount,
keyboard, form and drawer cases were exercised; unsupported submenu behavior and
every cancellation race are not certified. No node_modules patch was made.

The shared checkout's pre-existing work was preserved. No commit, push or public
deployment was performed. The owned Browser tab, isolated Vite/provider process
and temporary reference server were stopped after verification; fixture directories
and evidence were retained. The broader [visual goal](../docs/visual-parity-goal.md)
remains active.
