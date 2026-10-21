# Visual parity Browser run — 2026-09-23/24

**Implemented-capability E2E checkpoint complete; literal whole-app 100% pixel
parity is not certified.** See the remaining acceptance gate in
`docs/visual-parity-goal.md`.

## Environment and reproducibility

- Source: OpenClaw v2026.9.5, commit
  `ec9c1a13db8938e5a3eaa51fca2e981cde2395a9`.
- HUI: `http://localhost:5173`, Vite with HMR disabled for stable journeys.
- Disposable config root: `/tmp/hui-parity-e2e.lVZlkq`; real PI RPC, isolated
  agent/settings/models/skills/extensions, session directory and Git workspace.
- Deterministic Anthropic-compatible provider: loopback 43127,
  `e2e/fixtures/pi-provider-fixture.mjs`, two zero-cost fixture models.
- Package/skill installation/removal uses `pi-mutation-fixture.mjs`; all other
  runtime commands delegate to the installed real PI. No operator data deleted.
- Browser: managed `openclaw` profile, dedicated Brave directory, CDP 18800,
  stable tab label `hui-parity`.
- Reference servers: read-only loopback 43128 for source styles; 43129 serves
  the shipped WA switch module; 43130 additionally exposes private original
  composer/Effort/textarea renderers from a hash-guarded installed module.
None emulates a Gateway or connects to a real account.
- Viewports: 1440×900, 390×844 (iPhone 13 touch emulation), 844×390.
- Claw light/dark, System following emulated OS, and imported Catppuccin dark.
  Typography/scale/preferences were restored after their tests.

Use the isolated setup in `e2e/chat-composer.browser.md`, adding the cheap
`fixture-mini` model and `e2e/fixtures/question-extension.ts` before starting PI.
Start the source oracle with:

```sh
node e2e/fixtures/reference-style-server.mjs /path/to/pinned-source /path/to/control-ui
node e2e/fixtures/reference-style-server.mjs /path/to/pinned-source /path/to/control-ui 43129
node e2e/fixtures/reference-style-server.mjs /path/to/pinned-source /path/to/control-ui 43130
```

Through Browser `act:evaluate`, import `/e2e/probes/visual-journey-probe.js`.
`auditRoutes(width, height)` opens each destination using the real command
palette, waits for rendered/loading state, asserts the viewport at every route
and measures inner-container overflow. `compareReferenceStyles(selectors)`
and `compareNativeSwitch()` provide two of the comparison methods below.
`auditOriginalComposerStates()` drives five real chat states and calls the
independent original-renderer probe. Run it only on an idle fixture session
with an empty draft. Re-run after resizing in both directions; use desktop
pointer emulation at 1440×900 and iPhone touch emulation for the narrow sizes.
Do not replace UI mutations with HTTP calls or writes to application state.

## Coverage matrix

| Surface / capability | Browser actions and observed result |
|---|---|
| Route entry / palette | All 25 retained catalogue routes and eleven Settings pages visited at all three sizes; 108 visits, no overflow/alerts. Four placeholders flagged, never counted as working capability pages. Native command shortcut/search/keyboard navigation/escape exercised. |
| Navigation history | Direct session reload, Back/Forward, rejected Agents route → Home, Settings return to Logs; Back after Exit did not reopen Settings. |
| App and Settings drawers | Open/close by selection and Escape; obscured main inert, focus returned; resizing an open drawer to desktop cleared inert. Settings opens focus in its search. Shared upstream browser breakpoint is 900 px plus short landscape. |
| Sidebar / footer / menus | Session links, active/hover/focus/run/attention anatomy; Settings fills 221 px of the 237 px footer with 8 px side insets. Session menu ArrowDown/End focused Rename/Delete; Escape dismissed it. Group menu had all four actions and stayed in bounds. |
| New Session | Real PI create → ready → initial prompt. Model fixture → fixture-mini verified in provider requests; effort keyboard preview/commit keeps popup open. Real Git worktree created from isolated repo, correct cwd and branch. |
| Chat lifecycle | Streamed reply, Stop, steering and follow-up queue, reconnect during a turn and final replay suffix. PI history refresh restored durable transcript. |
| Mobile queue gesture | Actual CDP touchStart held until Browser observed Enqueue, touchEnd on the same connection, native Enqueue click: PI follow-up queue contained the text and draft cleared. Stopped the fixture turn afterward. |
| Questions | Fresh PI runtime: select by digit, custom answer, confirm, input, editor with prefill, submit and skip. Composer-docked question measured at mobile width; hidden input was not focused. |
| Transcript / tools / copy | Real read output, expanded input/output detail, ENOENT tool failure and provider failure; thinking/Markdown subset, fenced code copy and response copy reached confirmed Copied state. Tool body now uses original card blocks, not custom section/pre spacing. |
| Progress | Real progress_card 1/2 state, expanded/collapsed projection, preference persistence and explicit clear through PI removed the card. |
| Composer / popovers | Send disabled empty and enabled with content; same SVG/geometry, focus/hover, textarea growth/scroll follow, Scroll to latest. Effort, model, context and attachment popovers within 390 px viewport. |
| Original composer runtime | Five states × three viewports: idle, focused draft, active Stop, active follow-up, Effort open. Eleven regions per closed state and sixteen with Effort open: 180 matched component records. Original Lit/WA renderers and textarea observer run in a separate iframe, not cloned HUI markup. |
| Textarea resize / scroll | Portrait → desktop → landscape recalculates height; 24-line draft scrolls without jumping back, clears to 36 px desktop. Source editing-fade and observer disposal logic retained. |
| Attachments | Text drop → remove → re-add → send; native image file input preview and real provider request contained image/png. Photo/camera/file picker affordances present; no physical phone camera hardware is claimed tested. |
| Appearance | Font keyboard choice and restoration; mode Light/Dark/System; text scale; Catppuccin/custom accent/reset; valid Amethyst Haze import and invalid import alert. Chat preferences changed rapidly, survived reload and affected the actual transcript/composer. Enter-newline and modifier-Enter send verified. |
| Settings navigation | All eleven pages loaded real scoped data. Search filtered to Skills; Escape cleared search; clicking the ESC hint exited. Narrow Escape closed the drawer, cleared inert and returned focus. |
| Skills | URL installation through cheap PI fixture, successful post-install discovery; repeated install correctly refused when no new skill appeared. No simulated removal control. |
| Plugins / Plugin | Catalog install, inventory/details, removal Cancel then confirmed exact-source removal through PI fixture. |
| Remove confirmation styles | Final pass removes a text-color-only danger approximation and redundant nested action wrapper; source `btn danger` and direct `settings-row__control` match in capability/Settings, desktop/narrow. Cancel preserves the fixture; confirmation removes only the installed fixture package. |
| Models / Config / Connection / Tools / Security | Read-only PI/HUI projections loaded; process/catalog/default/Full Access data visible, no credentials or fake policy writes. |
| Memory / Worktrees / Workshop | Existing read-only projections and discovery loaded; worktree creation proven separately. No import/publication/cleanup action invented. |
| Sessions / groups | Search empty/one result, row open, rename/regroup/pin; group create/rename/defaults/remove. Delete-session Cancel/Confirm removed only a fixture HUI row/runtime; its PI JSONL remained. |
| Automation / Cron / Tasks | Empty-name validation; create/edit/pause, manual real PI run to Completed, cancel active run, delete fixture task; run history retained. Cron/every/at forms show only their real schedule fields. |
| Activity / Logs / Debug / Usage / Diagnostics | Refresh/filter/entry detail and actual diagnostics download. Export is the existing redacted operational metadata contract, not prompts or tool output. |
| About / Labs / Profile | Runtime information plus persisted flag/profile changes and restoration. Rapid flag writes no longer clobber each other. |

The touch-only gesture used CDP because Browser exposes no press-and-hold action.
All navigation, other input and resulting-state verification used Browser.
The CDP sender retained one WebSocket for touchStart and touchEnd; no application
API/state mutation substituted for the gesture. It is checked in as
`touch-hold-probe.mjs`; the final repeat proved the queue's original five-path
SVG at 14×14 and a real PI follow-up acknowledgement.

## Measured visual evidence

- 32 verbatim source stylesheets and five excerpts; normalized source hashes in
  `src/styles/openclaw-reference/manifest.json`, enforced by a regression test.
- `evidence/2026-09-24-final-verification.json`: latest 108 route visits,
  including oversized-SVG checks; 177 cascade comparisons across 31 pages,
  three additional package-confirmation comparisons, 180 independent original
  composer comparisons and eight actual WA switch-part comparisons. All have
  zero unexpected measured differences.
- `evidence/2026-09-24-final-routes.json` and `2026-09-24-final-styles.json`:
  earlier 108-route and 260-record state checkpoints. 259 applicable records
  passed at that checkpoint; the final composer/icon/controller port is covered
  by the newer file, not silently attributed to this older run.
- The one native `.settings-switch` wrapper comparison is deliberately retained
  as **inapplicable**, not relabelled passed: original CSS has no such wrapper.
  The independent switch sections load the **actual shipped
  Web Awesome switch**, initialized with original bootstrap light/dark classes,
  and compares its control/thumb against HUI in all four light/dark × off/on
  cases. All visible measured properties match.
- The native Settings drawer host similarly is not an original component:
  its child back link/search/active item were measured separately. Full-height
  flex behavior belongs to the HUI drawer transport.
- Desktop Effort 330 px; mobile Effort/model 366 px with 12 px viewport inset.
  Attachment-only menu 176 px follows the corresponding source contract.
- The original Effort renderer unconditionally includes Fast mode. Its measured
  55.59375 px row remains in the oracle; the resulting popup-height difference
  is explicitly labelled as a PI adaptation. No original nodes are deleted to
  manufacture a zero diff.
- 47 shared icons retain source SVG geometry and stroke via hash assertions.
  All 64 file-icon assets match upstream; the original file-icon renderer fixes
  the unbounded document glyph exposed when inline icon sizing was removed.
- Checked resolved fonts/colors/backgrounds, borders, radii/corner shape,
  shadows, padding/gaps, dimensions, alignment and native focus/hover/disabled
  states. Same-DOM comparisons preserve real input/popover state and wait for
  finite transitions and fonts.

### Proof limits — not hidden by the pass count

The stylesheet oracle places **HUI's rendered DOM** under original CSS. It detects
cascade deviations, not independent original DOM equivalence. Native transport
and PI-content substitutions remain explicit adaptations. Composer, Effort,
textarea sizing and switch tests now load actual original runtime functions;
their deterministic props deliberately omit unsupported PI features and unrelated
model controls. The additional independent scope is recorded below; rich
Markdown/media/tools and remaining capability layouts are not independently
original-rendered.
There is no whole-app screenshot pixel-diff certification.

Four catalogue placeholder routes are not functional pages. Actual Chat and
Question are proven within sessions; Permissions/Secrets retain their existing
read-only security boundary. The Markdown renderer still implements its documented
subset: GFM tables, syntax highlighting and the rest of OpenClaw's richer renderer
are not newly claimed. Camera hardware, OpenClaw-only features and unsupported
mutations are outside this run.

## Defects found and fixed in this task

- System preference used as CSS state instead of resolved light/dark.
- Claw preview data overriding its authoritative palette; divergent competing CSS.
- Native range Effort preview destroying Lit child markers; same issue in launch
  group label. Subsequent picker changes now work without runtime exceptions.
- Settings save race; rapid UI preferences now preserve newer edits.
- Sidebar button vs anchor layout, false owner avatar, header action sizing,
  missing action wrappers, menu pointer-events and extra item superellipse.
- Stale 1100 px navigation breakpoint and absent original mobile state class.
- Unnecessary desktop nav icon; mobile/desktop focus and resize cleanup.
- Independent tool body spacing replaced with source card header/blocks.
- Copy success feedback, auto-follow using the wrong scroller, question placement,
  options and input focus; confirmation now uses the source question prompt region.
- Native hidden schedule fields, canonical Settings content hierarchy and rows.
- Automation capability routes now use the existing functional scheduler view.
- Mobile composer toolbar modifier/gauge and single primary send/stop wrapper;
  native popover text inherited CanvasText instead of the source text role.
- Shared icon stroke/path geometry, file-card icon sizing, Settings footer icon
  constraints and flex layout, original queued-message SVG.
- Stale inline textarea height after rotation; original resize/overflow controller
  now observes width, preserves transcript end anchoring and cleans up on removal.
- Plugin confirmation now uses source danger backgrounds/borders and one original
  action cluster, not a text-color override inside a second wrapper.

## Failed attempts and recovery

Early runtime failure was the Lit marker bug above. Final error collection
reported **zero new page errors**. Oracle 404s and SSE interruption during local
fixture restarts were setup errors, not product passes.

An earlier viewport sweep was discarded when its viewport changed unexpectedly;
final sweeps assert both dimensions at each route. Selector mistakes, attempts to
use commands before PI settled, and a fill helper that did not focus custom-answer
inputs failed visibly, then were corrected and rerun. The helper now focuses
the editable control.

The first touch sender closed before touchEnd; a second CDP connection could not
release the first one's touch. Only that isolated sender process was stopped,
then the full journey passed on a maintained connection. Initial switch checks
without WA's palette classes were invalid; original bootstrap behavior was
inspected and reproduced before collecting the final evidence.

Original-composer probing initially mixed HUI's development Lit renderer with
production templates; it correctly failed on incompatible directive internals.
The successful probe uses original Lit. Source maps were not installed, so private
function names were resolved from the pinned module and hash-guarded. Capturing
HUI styles before mounting the original avoids lifecycle focus stealing; finite
transitions are synchronized rather than sampled midway. A stale Stop selector,
attempted editing before PI acknowledged a prompt, and assuming the displayed
package source included `npm:` were harness failures, inspected and rerun. No
duplicate package installation was needed. Native Control+End on an already-end
mobile caret did not scroll; PageDown and desktop end navigation then proved
stable scrolling. These failures are not counted as product passes.

## Independent follow-up

Evidence: `evidence/2026-09-24-independent-renderers.json` and
`evidence/2026-09-24-original-palettes.json`.

- 80 combinations of Claw, Rosé, Catppuccin and Amethyst Haze × light/dark ×
  ten accent choices: 4,240 original color/shadow comparisons. The oracle
  consumes raw theme inputs through the original normalizer/accent functions;
  no derived HUI color is copied into the reference. Rosé's native CSS and the
  original 0.179 ink-contrast threshold replaced incorrect approximations.
- Eleven Settings pages × three sizes: 1,506 original shared primitive records;
  three schedule modes × three sizes add 570. Control slot contents remain
  HUI-rendered except the original switch. Fixed missing 0.5em switch label
  spacing, empty description spacing, missing Diagnostics control wrapper and
  incorrectly merged automation field/control containers.
- Two sidebar rows × eleven regions × three sizes: 66 records. The original
  pin action, title-row and marquee are now present. UI pin/unpin persisted,
  and a long title scrolled 226 px on actual pointer hover. Hover/focus matching
  projects only original state selectors to attributes, not declarations.
- Plain user/assistant message groups and their context-copy menu: 69 records
  across three sizes, including nine assertions that settled-user footer copy
  is absent in both apps. The original context handler generated the reference
  menu. Current PI/HUI transcript normalization lacks timestamps; only the
  original timestamp's measured width plus gap (86.015625 px in the fixture)
  is accounted as an adaptation, with its DOM retained. This is not rich
  Markdown or arbitrary transcript content proof.
- Copy was moved to the user message context menu; keyboard opening, confirmed
  write, rejected write and successful retry passed. Clipboard read is denied.
  The write check records the fixture argument while calling the real original
  writeText; the failure case temporarily rejects only that isolated API seam.
- All 180 original composer records and 108 route visits were repeated after
  the palette/sidebar/transcript changes with zero unexpected measured diffs,
  alerts or overflow. No unsupported capability is counted as implemented.

Additional harness failures were exposed and corrected: a missing private
sidebar-module initializer; reference ancestors, row position, wide layout and
offscreen content-visibility context; native focus matching; cached probe
modules; and an ambiguous drawer selector. A previously abandoned assertion
threw on a removed node inside a MutationObserver (01:31:57 UTC). The waiter
now rejects assertion exceptions and disconnects instead of leaking a page
error. None of these failed attempts is counted as a product pass.

## Validation and delivery

- `npm test`: **349/349**, no skipped/failing tests.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `git diff --check`: passed.
- Fresh real rendered screenshots: desktop Settings, desktop chat with Effort,
  mobile chat with Effort, landscape, and full-row Settings hover. Inspected and
  explicitly shared in the conversation; all use Claw dark, Instrument Sans,
  100% scale and isolated test data. Clicking the visible ESC label returned
  to the originating chat.
- Real user PI settings, skills, transcripts and personal workspace files remain
  untouched. Temporary resources are isolated, and the tested state is left
  available for inspection; no recurring automation was created.

## Rich transcript and command follow-up

Evidence: `evidence/2026-09-24-rich-transcript.json`,
`evidence/2026-09-24-read-tool.json` and
`evidence/2026-09-24-command-tools.json`.

- Supported Markdown/code: 180 original-renderer records across the same three
  viewports. Corrected strike/quote structure and the fence viewport. Real
  reveal, wrap, unwrap and clipboard interactions were exercised.
- Compact sent-file cards: 27 records. Restored compact class, filename title
  and the original empty action slot rather than adding unsupported actions.
- Read tools: 102 successful collapsed/expanded records over three sizes and
  38 failed records on desktop. Correct file icon, original neutral header,
  target summary, extra-argument rows, raw output and lowercase failure label.
  Keyboard context-menu copying reached the real clipboard write (41 bytes).
- Commands: 630 records (35 regions × collapsed/expanded × three states ×
  three sizes). Real PI `bash` succeeded, failed and waited on a deterministic
  loopback release signal. Original terminal markup, highlighted tokens and
  compact preview replace generic JSON. Native Enter reopens the disclosure.
- Empty PI content now normalizes to empty output, not a JSON envelope. After
  restarting the isolated backend, Browser verified empty in-flight output,
  the absence of a terminal output block, then the real completed result.
  All 630 command records were repeated against that backend with zero diffs.
- Fresh desktop/mobile screenshots of Markdown/read tools and command terminals
  were inspected and explicitly shared. Command screenshots use 1440×900 and
  390×844; the actual chat scroller has zero horizontal overflow.

Failed harness attempts are not passes: initially curl progress changed while
the live tool was measured; the fixture now uses silent curl and the probe
rejects changed input snapshots. A fixture restart omitted `HUI_E2E_REAL_PI`,
and an overly specific model-selector waiter later timed out despite a ready
session. The wrapper variable and readiness check were corrected before the
successful repeated run. The recovered draft was sent only after PI was ready.

Read/command proof does not certify other tool kinds or full-page pixel parity.
At this checkpoint, reusing original Web Awesome controls was pending explicit
dependency approval. That approval was subsequently granted; the migration and
new verification are in [the Web Awesome follow-up](webawesome-controls.browser.md).
